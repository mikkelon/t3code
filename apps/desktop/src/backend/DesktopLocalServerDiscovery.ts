// Decides whether this launch embeds its own backend or adopts a T3 server
// that already owns the T3 home. Two servers on one home share one SQLite
// database and fight over providers, runtime state and tunnels, so a live
// owner always wins and an installed background service is always preferred.
// See docs/internals/remote.md#desktop-and-the-background-service.

import { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { bootServiceBaseDirOf, bootServiceUnitPath } from "@t3tools/shared/bootServiceUnit";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const ENVIRONMENT_DESCRIPTOR_PATH = "/.well-known/t3/environment";
const PROBE_TIMEOUT = Duration.millis(2_500);

// The fields of apps/server/src/serverRuntimeState.ts this module relies on.
const PersistedServerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  origin: Schema.String,
  serviceManaged: Schema.optional(Schema.Boolean),
});
const decodeRuntimeState = Schema.decodeUnknownOption(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

export interface LiveLocalServer {
  readonly httpBaseUrl: URL;
  readonly environmentId: string;
  readonly serverVersion: string;
  readonly serviceManaged: boolean;
}

export type LocalServerDecision =
  | { readonly _tag: "Adopt"; readonly server: LiveLocalServer }
  | { readonly _tag: "StartService" }
  | { readonly _tag: "Embed" };

/**
 * A live server that answers as this home's environment is adopted. Without
 * one, an installed service is started and adopted rather than embedding a
 * second backend next to it. Only a home with neither embeds.
 */
export function decideLocalServer(input: {
  readonly serviceInstalled: boolean;
  readonly live: Option.Option<LiveLocalServer>;
}): LocalServerDecision {
  if (Option.isSome(input.live)) return { _tag: "Adopt", server: input.live.value };
  return input.serviceInstalled ? { _tag: "StartService" } : { _tag: "Embed" };
}

/** Signal 0 only checks that the pid exists; EPERM means it exists for another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** True when this user's background service unit serves `baseDir`. */
export const readServiceInstalled = Effect.fn("desktop.localServer.readServiceInstalled")(
  function* (input: {
    readonly platform: NodeJS.Platform;
    readonly homeDir: string;
    readonly baseDir: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const unitPath = bootServiceUnitPath({ ...input, joinPath: path.join });
    if (unitPath === undefined) return false;
    const unit = yield* fs.readFileString(unitPath).pipe(Effect.option);
    if (Option.isNone(unit)) return false;
    const servedBaseDir = bootServiceBaseDirOf(unit.value);
    return (
      servedBaseDir !== undefined && path.resolve(servedBaseDir) === path.resolve(input.baseDir)
    );
  },
);

const readTrimmed = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((contents) => contents.trim()),
    Effect.option,
  );

const fetchDescriptor = (httpBaseUrl: URL) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(new URL(ENVIRONMENT_DESCRIPTOR_PATH, httpBaseUrl).href),
    );
    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
    );
  }).pipe(Effect.timeout(PROBE_TIMEOUT), Effect.option);

/** The origin the runtime file in `stateDir` names, without checking it. */
export const readRuntimeOrigin = Effect.fn("desktop.localServer.readRuntimeOrigin")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const raw = yield* readTrimmed(path.join(stateDir, "server-runtime.json"));
  return Option.flatMap(raw, decodeRuntimeState).pipe(Option.map((state) => state.origin));
});

/**
 * The server that owns `stateDir`, if one is running. The runtime file alone
 * is not trusted: its pid must be alive and its origin must answer with the
 * environment id stored in the same directory, which rules out a dead
 * server's leftovers and a port since reused by another home's server.
 */
export const probeLiveLocalServer = Effect.fn("desktop.localServer.probeLive")(function* (
  stateDir: string,
  options: { readonly isProcessAlive?: (pid: number) => boolean } = {},
) {
  const path = yield* Path.Path;
  const raw = yield* readTrimmed(path.join(stateDir, "server-runtime.json"));
  const state = Option.flatMap(raw, decodeRuntimeState);
  if (Option.isNone(state)) return Option.none<LiveLocalServer>();
  if (!(options.isProcessAlive ?? isProcessAlive)(state.value.pid)) {
    return Option.none<LiveLocalServer>();
  }
  const httpBaseUrl = yield* Effect.try(() => new URL(state.value.origin)).pipe(Effect.option);
  if (Option.isNone(httpBaseUrl)) return Option.none<LiveLocalServer>();
  const expectedEnvironmentId = yield* readTrimmed(path.join(stateDir, "environment-id"));
  if (Option.isNone(expectedEnvironmentId)) return Option.none<LiveLocalServer>();
  const descriptor = yield* fetchDescriptor(httpBaseUrl.value);
  if (Option.isNone(descriptor) || descriptor.value.environmentId !== expectedEnvironmentId.value) {
    return Option.none<LiveLocalServer>();
  }
  return Option.some<LiveLocalServer>({
    httpBaseUrl: httpBaseUrl.value,
    environmentId: descriptor.value.environmentId,
    serverVersion: descriptor.value.serverVersion,
    serviceManaged: state.value.serviceManaged === true,
  });
});
