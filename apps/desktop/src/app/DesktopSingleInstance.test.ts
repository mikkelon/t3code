// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeHttp from "node:http";
import * as NodePath from "@effect/platform-node/NodePath";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { requestSingleInstanceLockMock, releaseSingleInstanceLockMock } = vi.hoisted(() => ({
  requestSingleInstanceLockMock: vi.fn(() => true),
  releaseSingleInstanceLockMock: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: requestSingleInstanceLockMock,
    releaseSingleInstanceLock: releaseSingleInstanceLockMock,
  },
}));

import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopSingleInstance from "./DesktopSingleInstance.ts";

const layerDesktopSingleInstance = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
  shell: ElectronShell.ElectronShell["Service"] = {
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
  },
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    setAsDefaultProtocolClient: (scheme: string) =>
      Effect.sync(() => {
        events.push(`setAsDefaultProtocolClient:${scheme}`);
        return true;
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopSingleInstance.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
  );
};

describe("DesktopSingleInstance", () => {
  beforeEach(() => {
    requestSingleInstanceLockMock.mockReset();
    requestSingleInstanceLockMock.mockReturnValue(true);
    releaseSingleInstanceLockMock.mockReset();
  });

  it.effect("holds the single-instance lock for the layer's lifetime", () => {
    const events: string[] = [];
    requestSingleInstanceLockMock.mockImplementation(() => {
      events.push("requestSingleInstanceLock");
      return true;
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(layerDesktopSingleInstance(true, events, "linux")));

      // The lock both lives in and creates the userData directory, so the
      // real path must be set before it is taken.
      assert.deepEqual(events, [
        "setPath:userData:/tmp/app-data/t3code-dev",
        "requestSingleInstanceLock",
        "setAsDefaultProtocolClient:t3code-dev",
      ]);
      assert.equal(releaseSingleInstanceLockMock.mock.calls.length, 1);
    });
  });

  it.effect("does not take the lock on macOS", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(layerDesktopSingleInstance(false, events, "darwin")));

      assert.equal(requestSingleInstanceLockMock.mock.calls.length, 0);
      assert.equal(releaseSingleInstanceLockMock.mock.calls.length, 0);
      assert.include(events, "setAsDefaultProtocolClient:t3code");
    });
  });

  it.each([
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-v2",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-dev",
    },
  ])(
    "takes the lock before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      requestSingleInstanceLockMock.mockImplementation(() => {
        events.push("requestSingleInstanceLock");
        return true;
      });
      // runSync throws if the layer ever suspends, which would let Electron emit
      // ready before the lock is held. main.ts provides the same FileSystem.
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            layerDesktopSingleInstance(
              isDevelopment,
              events,
              platform,
              DesktopPreReadyFileSystem.layer,
            ),
          ),
        ),
      );

      assert.deepEqual(events.slice(0, 2), [
        `setPath:userData:${userData}`,
        "requestSingleInstanceLock",
      ]);
    },
  );

  it.effect("registers the second-instance handler in the primary instance", () => {
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["open-url", "second-instance"]);
    }).pipe(
      Effect.provide(layerDesktopSingleInstance(true, [], "linux")),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    requestSingleInstanceLockMock.mockReturnValue(false);
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      const exit = yield* Effect.exit(Effect.scoped(singleInstance.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
      // A secondary instance hands its link to the running app and never owns the scheme.
      assert.equal(releaseSingleInstanceLockMock.mock.calls.length, 0);
    }).pipe(
      Effect.provide(layerDesktopSingleInstance(true, [], "linux")),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });
});

it.effect(
  "provider auth deep links navigate and reveal the running desktop and ignore other URLs",
  () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL };
    const electronApp = {
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.some(window)),
      reveal: () => Effect.sync(() => revealed.resolve()),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    return Effect.gen(function* () {
      const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
      yield* singleInstance.configure;
      const event = { preventDefault: vi.fn() };
      listeners.get("open-url")!(event, "t3code-dev://app/auth/callback?code=other-code");
      listeners.get("open-url")!(event, "t3code://app/welcome");
      assert.equal(loadURL.mock.calls.length, 0);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      listeners.get("second-instance")!({}, [
        "t3",
        "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => revealed.promise);
      assert.deepEqual(loadURL.mock.calls, [
        ["t3code-dev://app/settings/providers?instanceId=work"],
      ]);
      listeners.get("open-url")!(event, "t3code-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopSingleInstance()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  },
);

it.effect.each(["startup", "open-url"] as const)(
  "receives hosted web sign-in through the desktop %s handler",
  (entry) =>
    Effect.gen(function* () {
      const port = yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      });
      const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
      authorize.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const request = {
        authorizationUrl: authorize.toString(),
        returnUrl: "http://localhost:5733/welcome#agents:remote-one",
        environmentId: EnvironmentId.make("remote-one"),
        instanceId: ProviderInstanceId.make("work"),
        flowId: "flow-one",
      };
      const link = codexAuthHandoffUrl(request, true);
      const delivered = Promise.withResolvers<string>();
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (value) =>
          Effect.promise(async () => {
            const url = new URL(String(value));
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.search = new URLSearchParams({
              state: url.searchParams.get("state")!,
              code: "test-code",
              client_id: "oaiapp_test",
            }).toString();
            const response = await fetch(callback, { redirect: "manual" });
            delivered.resolve(response.headers.get("location")!);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const electronApp = {
        whenReady: Effect.void,
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      yield* Effect.gen(function* () {
        const singleInstance = yield* DesktopSingleInstance.DesktopSingleInstance;
        yield* singleInstance.configure;
        if (entry === "open-url") {
          const event = { preventDefault: vi.fn() };
          listeners.get("open-url")!(event, link);
          assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        }
        const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
        assert.strictEqual(delivery?.environmentId, request.environmentId);
        assert.strictEqual(delivery?.instanceId, request.instanceId);
        assert.strictEqual(delivery?.flowId, request.flowId);
        assert.strictEqual(delivery?.returnUrl, request.returnUrl);
      }).pipe(
        Effect.provide(layerDesktopSingleInstance(true, [], "darwin", undefined, shell)),
        Effect.provideService(HostProcessArguments, entry === "startup" ? ["t3", link] : ["t3"]),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(
          ElectronWindow.ElectronWindow,
          {} as ElectronWindow.ElectronWindow["Service"],
        ),
      );
    }).pipe(Effect.scoped),
);
