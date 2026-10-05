import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  type AuthSessionState,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadBoundedSnapshot,
  type OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import type { HttpClient } from "effect/http";

import {
  BearerConnectionTarget,
  type PreparedConnection,
  type PreparedHttpAuthorization,
} from "../connection/model.ts";
import { type RemoteEnvironmentRequestError } from "../rpc/http.ts";
import * as RpcHttp from "../rpc/http.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { withOrchestrationProtocolHeader } from "./environmentHttpAuth.ts";
import { fetchEnvironmentSessionState } from "./session.ts";
import { fetchEnvironmentShellSnapshot } from "./shellSnapshotHttp.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import { fetchEnvironmentBoundedThreadSnapshot } from "./boundedThreadSnapshotHttp.ts";
import * as BoundedThreadSnapshotHttp from "./boundedThreadSnapshotHttp.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import { v2Projection } from "./orchestrationV2TestFixtures.ts";

const encodeThreadSnapshot = Schema.encodeSync(OrchestrationV2ThreadDetailSnapshot);
const encodeBoundedSnapshot = Schema.encodeSync(OrchestrationV2ThreadBoundedSnapshot);

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});
const ORIGIN = "https://environment.example.test";
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: ORIGIN,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const DIFF = {
  projectId: ProjectId.make("project-1"),
  repository: "owner/repository",
  number: 42,
};
const DIFF_RESULT = { patch: "diff --git a/file.ts b/file.ts", truncated: false, nextCursor: null };
const AUTH = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];
const SESSION = {
  authenticated: true,
  auth: AUTH,
  scopes: ["orchestration:read", "orchestration:operate"],
  sessionMethod: "bearer-access-token",
} satisfies AuthSessionState;
const UNAUTHENTICATED_SESSION = { authenticated: false, auth: AUTH } satisfies AuthSessionState;
const SHELL = {
  schemaVersion: 1,
  snapshotSequence: 1,
  projects: [],
  threads: [],
  archivedThreads: [],
} satisfies OrchestrationV2ShellSnapshot;
const THREAD = {
  snapshotSequence: 2,
  projection: v2Projection,
} satisfies OrchestrationV2ThreadDetailSnapshot;
const BOUNDED_THREAD = {
  ...THREAD,
  historyCursor: "older-page",
  hasMoreHistory: true,
  latestLocalTurnOrdinal: 3,
} satisfies OrchestrationV2ThreadBoundedSnapshot;
const THREAD_HISTORY = {
  snapshotSequence: 2,
  items: [],
  nextCursor: null,
  hasMoreHistory: false,
} satisfies OrchestrationV2ThreadHistoryPage;

function credentialRejectedResponse(reason = "invalid_credential") {
  return Response.json(
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason,
      traceId: "trace-rejected",
    },
    { status: 401 },
  );
}

function makeHarness(reply: (requestNumber: number) => Response | Promise<Response>) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return reply(calls.length);
  };
  return {
    calls,
    input: { prepared: PREPARED },
    httpLayer: RpcHttp.layerRemoteHttpClient(fetchFn),
  };
}

type HttpInput = ReturnType<typeof makeHarness>["input"];
const LOADERS: ReadonlyArray<{
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly response: unknown;
  readonly expected: unknown;
  readonly load: (
    input: HttpInput,
  ) => Effect.Effect<
    unknown,
    RemoteEnvironmentRequestError | PullRequestDiffLoader.PullRequestDiffCredentialRejectedError,
    HttpClient.HttpClient
  >;
}> = [
  {
    name: "PR diff",
    method: "POST",
    path: "/api/pull-requests/diff",
    response: DIFF_RESULT,
    expected: DIFF_RESULT,
    load: (input: HttpInput) =>
      PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({ ...input, diff: DIFF }),
  },
  {
    name: "session permissions",
    method: "GET",
    path: "/api/auth/session",
    response: SESSION,
    expected: SESSION,
    load: fetchEnvironmentSessionState,
  },
  {
    name: "shell snapshot",
    method: "GET",
    path: "/api/orchestration/shell",
    response: SHELL,
    expected: SHELL,
    // Pull request links decode separately; the rows match the response on their own.
    load: (input: HttpInput) =>
      fetchEnvironmentShellSnapshot(input).pipe(
        Effect.map(({ loadPullRequests: _links, ...snapshot }) => snapshot),
      ),
  },
  {
    name: "thread snapshot",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}`,
    response: encodeThreadSnapshot(THREAD),
    expected: THREAD,
    load: (input: HttpInput) =>
      ThreadSnapshotLoader.fetchEnvironmentThreadSnapshot({
        ...input,
        threadId: THREAD.projection.thread.id,
      }),
  },
  {
    name: "bounded thread snapshot",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/bounded`,
    response: encodeBoundedSnapshot(BOUNDED_THREAD),
    expected: BOUNDED_THREAD,
    load: (input: HttpInput) =>
      fetchEnvironmentBoundedThreadSnapshot({ ...input, threadId: THREAD.projection.thread.id }),
  },
  {
    name: "older thread history",
    method: "GET",
    path: `/api/orchestration/threads/${THREAD.projection.thread.id}/history`,
    response: THREAD_HISTORY,
    expected: THREAD_HISTORY,
    load: (input: HttpInput) =>
      fetchEnvironmentThreadHistoryPage({
        ...input,
        threadId: THREAD.projection.thread.id,
        cursor: "older-page",
      }),
  },
];

describe("authenticated environment HTTP requests", () => {
  it.effect.each(LOADERS)("rejects an invalid $name response", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({}));
      const result = yield* loader
        .load(harness.input)
        .pipe(Effect.provide(harness.httpLayer), Effect.asVoid, Effect.flip);
      expect(result._tag).toBe("RemoteEnvironmentAuthInvalidJsonError");
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect("keeps the status of a shell snapshot error that is not a declared error", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json({ error: "bad_gateway" }, { status: 502 }));
      const error = yield* fetchEnvironmentShellSnapshot(harness.input).pipe(
        Effect.provide(harness.httpLayer),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "RemoteEnvironmentAuthUndeclaredStatusError",
        status: 502,
      });
    }),
  );

  it.effect.each(LOADERS)("uses the prepared bearer credential and endpoint for $name", (loader) =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(loader.response));
      const result = yield* loader.load(harness.input).pipe(Effect.provide(harness.httpLayer));

      expect(result).toEqual(loader.expected);
      expect(harness.calls).toHaveLength(1);
      const call = harness.calls[0]!;
      const url = new URL(call.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe(loader.path);
      expect(call.init.method).toBe(loader.method);
      expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer bearer-token");
      expect(call.init.credentials).toBeUndefined();
      if (loader.path.startsWith("/api/orchestration/")) {
        expect(new Headers(call.init.headers).get(ORCHESTRATION_PROTOCOL_HEADER)).toBe(
          ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        );
      }
      if (loader.name === "older thread history") {
        expect(url.searchParams.get("cursor")).toBe("older-page");
      }
    }),
  );

  it.effect("sends the prepared credential from the bounded snapshot loader layer", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(encodeBoundedSnapshot(BOUNDED_THREAD)));
      const layerLoader = BoundedThreadSnapshotHttp.layer.pipe(Layer.provide(harness.httpLayer));
      const loader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader.pipe(
        Effect.provide(layerLoader),
      );
      const result = yield* loader.load(PREPARED, THREAD.projection.thread.id);
      expect(result).toEqual({
        _tag: "present",
        snapshot: { ...THREAD, latestLocalTurnOrdinal: BOUNDED_THREAD.latestLocalTurnOrdinal },
        history: {
          historyCursor: BOUNDED_THREAD.historyCursor,
          hasMoreHistory: true,
          latestLocalTurnOrdinal: BOUNDED_THREAD.latestLocalTurnOrdinal,
        },
      });
      expect(harness.calls).toHaveLength(1);
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer bearer-token",
      );
    }),
  );

  it.effect("sends the prepared credential from the diff loader layer", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => Response.json(DIFF_RESULT));
      const layerLoader = PullRequestDiffLoader.layer.pipe(Layer.provide(harness.httpLayer));
      const loader = yield* PullRequestDiffLoader.PullRequestDiffLoader.pipe(
        Effect.provide(layerLoader),
      );
      const result = yield* loader.load(PREPARED, DIFF);

      expect(result).toEqual(DIFF_RESULT);
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer bearer-token",
      );
    }),
  );

  it.effect("reports a rejected diff credential without retrying", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => credentialRejectedResponse());
      const error = yield* PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({
        ...harness.input,
        diff: DIFF,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error).toMatchObject({
        _tag: "PullRequestDiffCredentialRejectedError",
        traceId: "trace-rejected",
      });
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect.each([
    {
      name: "insufficient scope",
      reply: () =>
        Response.json(
          {
            _tag: "EnvironmentScopeRequiredError",
            code: "insufficient_scope",
            requiredScope: "orchestration:read",
            traceId: "trace-scope",
          },
          { status: 403 },
        ),
      errorTag: "EnvironmentScopeRequiredError",
    },
    {
      name: "missing credential",
      reply: () => credentialRejectedResponse("missing_credential"),
      errorTag: "EnvironmentAuthInvalidError",
    },
    {
      name: "Cloudflare 530",
      reply: () => new Response("error code: 1033", { status: 530 }),
      errorTag: "RemoteEnvironmentAuthUndeclaredStatusError",
    },
    {
      name: "network failure",
      reply: () => Promise.reject(new Error("Network unreachable")),
      errorTag: "RemoteEnvironmentAuthFetchError",
    },
  ])("does not retry on $name", ({ reply, errorTag }) =>
    Effect.gen(function* () {
      const harness = makeHarness(reply);
      const error = yield* PullRequestDiffLoader.fetchEnvironmentPullRequestDiff({
        ...harness.input,
        diff: DIFF,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip);

      expect(error._tag).toBe(errorTag);
      expect(harness.calls).toHaveLength(1);
    }),
  );

  it.effect.each([
    { name: "cookie", authorization: null },
    { name: "bearer", authorization: { _tag: "Bearer", token: "bearer-token" } },
  ] satisfies ReadonlyArray<{ name: string; authorization: PreparedHttpAuthorization | null }>)(
    "returns an unauthenticated $name session as reported",
    ({ authorization }) =>
      Effect.gen(function* () {
        const harness = makeHarness(() => Response.json(UNAUTHENTICATED_SESSION));
        const result = yield* fetchEnvironmentSessionState({
          prepared: { ...PREPARED, httpAuthorization: authorization },
        }).pipe(Effect.provide(harness.httpLayer));

        expect(result).toEqual(UNAUTHENTICATED_SESSION);
        expect(harness.calls).toHaveLength(1);
        expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
          authorization === null ? null : "Bearer bearer-token",
        );
        expect(harness.calls[0]!.init.credentials).toBe(
          authorization === null ? "include" : undefined,
        );
      }),
  );

  it.effect("reports the request URL when the caller's timeout expires during HTTP", () =>
    Effect.gen(function* () {
      const requested = Promise.withResolvers<void>();
      const response = Promise.withResolvers<Response>();
      const harness = makeHarness(() => {
        requested.resolve();
        return response.promise;
      });
      const pending = yield* fetchEnvironmentSessionState({
        ...harness.input,
        timeoutMs: 100,
      }).pipe(Effect.provide(harness.httpLayer), Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => requested.promise);
      yield* TestClock.adjust(100);

      expect(yield* Fiber.join(pending)).toMatchObject({
        _tag: "RemoteEnvironmentAuthTimeoutError",
        requestUrl: `${ORIGIN}/api/auth/session`,
        timeoutMs: 100,
      });
      expect(harness.calls.map((call) => call.url)).toEqual([`${ORIGIN}/api/auth/session`]);
      response.resolve(Response.json(SESSION));
    }),
  );
});

describe("orchestration HTTP compatibility header", () => {
  it("announces the current protocol without replacing bearer authentication", () => {
    expect(
      withOrchestrationProtocolHeader({
        authorization: "Bearer access-token",
      }),
    ).toEqual({
      authorization: "Bearer access-token",
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    });
  });
});
