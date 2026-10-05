import * as NodeSqlite from "node:sqlite";

import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcessSpawner } from "effect/process";
import * as NetService from "@t3tools/shared/Net";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));
vi.mock("@clerk/electron", () => ({ createClerkBridge: vi.fn() }));
vi.mock("@clerk/electron/storage", () => ({ storage: vi.fn() }));
vi.mock("../ipc/DesktopIpcHandlers.ts", () => ({
  installDesktopIpcHandlers: () => Effect.void,
}));
vi.mock("../updates/DesktopRemoteUpdates.ts", () => ({ listen: Effect.void }));
vi.mock("./DesktopStartupRecovery.ts", () => ({ listen: Effect.void }));

import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopBackgroundService from "../backend/DesktopBackgroundService.ts";
import * as DesktopHomeOwner from "../backend/DesktopHomeOwner.ts";
import type * as DesktopLocalServerDiscovery from "../backend/DesktopLocalServerDiscovery.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as PreviewPasskeys from "../preview/Passkeys.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";

import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";
import * as DesktopPrimaryPaste from "./DesktopPrimaryPaste.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as PreviewManager from "../preview/Manager.ts";

it.effect("adopts the background service that holds the T3 home's ownership lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-adopt-" });
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const lock = new NodeSqlite.DatabaseSync(`${stateDir}/server-owner.sqlite`);
        lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        return lock;
      }),
      (lock) => Effect.sync(() => lock.close()),
    );
    const environment = {
      platform: "linux",
      isDevelopment: false,
      isPackaged: true,
      stateDir,
      configuredBackendPort: Option.some(3773),
      defaultDesktopSettings: { serverExposureMode: "local-only" },
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
    assert.isTrue(
      yield* DesktopHomeOwner.isHomeOwnershipLocked().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      ),
    );

    const server: DesktopLocalServerDiscovery.LiveLocalServer = {
      httpBaseUrl: new URL("http://127.0.0.1:3773/"),
      environmentId: "background-service",
      serverVersion: "0.0.0",
      serviceManaged: true,
      startedAt: undefined,
    };
    const windowUrl = yield* Deferred.make<URL>();
    const backendStarted = yield* Ref.make(false);
    const quitting = yield* Ref.make(false);

    const runApp = DesktopApp.program
      .pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(DesktopAppIdentity.DesktopAppIdentity, {
          resolveUserDataPath: Effect.succeed(stateDir),
          configure: Effect.void,
        } as DesktopAppIdentity.DesktopAppIdentity["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          setPath: () => Effect.void,
          whenReady: Effect.void,
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          showErrorBox: () => Effect.die("unexpected home-owned dialog"),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
        Effect.provideService(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions, {
          linux: null,
          linuxPasswordStoreCommandLine: "basic",
        }),
        Effect.provideService(DesktopShellEnvironment.DesktopShellEnvironment, {
          installIntoProcess: Effect.succeed(true),
          awaitDiscovery: Effect.succeed(true),
          awaitUserShellDiscovery: Effect.succeed(true),
          updates: Stream.empty,
        }),
        Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
          load: Effect.void,
          get: Effect.succeed({
            localEnvironmentEnabled: true,
            serverExposureMode: "local-only",
          }),
        } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
        Effect.provideService(DesktopLifecycle.DesktopLifecycle, {
          register: Effect.void,
          relaunch: () => Effect.void,
        }),
        Effect.provideService(DesktopClerk.DesktopClerk, {
          configure: Effect.void,
        } as DesktopClerk.DesktopClerk["Service"]),
        Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
          selectedStorageBackend: Effect.succeedNone,
        } as unknown as ElectronSafeStorage.ElectronSafeStorage["Service"]),
        Effect.provideService(PreviewPasskeys.PreviewPasskeys, {
          configure: Effect.void,
        } as PreviewPasskeys.PreviewPasskeys["Service"]),
        Effect.provideService(DesktopApplicationMenu.DesktopApplicationMenu, {
          configure: Effect.void,
        }),
        Effect.provideService(DesktopUpdates.DesktopUpdates, {
          configure: Effect.void,
        } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
        Effect.provideService(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler, {
          register: Effect.void,
        }),
      )
      .pipe(
        Effect.provideService(ElectronProtocol.ElectronProtocol, {
          registerDesktopProtocol: () => Effect.void,
        } as unknown as ElectronProtocol.ElectronProtocol["Service"]),
        Effect.provideService(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
          load: () => Effect.void,
        } as unknown as DesktopLegacyLocalStorage.DesktopLegacyLocalStorage["Service"]),
        Effect.provideService(DesktopSnapShot.DesktopSnapShot, {
          initialize: Effect.void,
        } as DesktopSnapShot.DesktopSnapShot["Service"]),
        Effect.provideService(DesktopState.DesktopState, {
          quitting,
        } as DesktopState.DesktopState["Service"]),
        Effect.provideService(DesktopWindow.DesktopWindow, {
          handleBackendReady: (url: URL) => Deferred.succeed(windowUrl, url).pipe(Effect.asVoid),
        } as unknown as DesktopWindow.DesktopWindow["Service"]),
        Effect.provideService(DesktopBackendPool.DesktopBackendPool, {
          primary: Effect.succeed({
            start: Ref.set(backendStarted, true),
            currentConfig: Effect.succeedNone,
          }),
          list: Effect.succeed([]),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
        Effect.provideService(DesktopServerExposure.DesktopServerExposure, {
          configureFromSettings: () => Effect.succeed({ mode: "local-only" }),
          backendConfig: Effect.succeed({ httpBaseUrl: new URL("http://127.0.0.1:3773") }),
        } as unknown as DesktopServerExposure.DesktopServerExposure["Service"]),
        Effect.provideService(DesktopWslBackend.DesktopWslBackend, {
          reconcile: Effect.void,
        } as DesktopWslBackend.DesktopWslBackend["Service"]),
        Effect.provideService(DesktopAppActivation.DesktopAppActivation, {
          start: Effect.void,
        } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]),
        Effect.provideService(DesktopRendererHistory.DesktopRendererHistory, {
          shutdown: Effect.void,
        } as DesktopRendererHistory.DesktopRendererHistory["Service"]),
      );
    const app = yield* runApp.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(BrowserImport.BrowserImport, {}),
          Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
          Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
          Layer.mock(DesktopBackgroundService.DesktopBackgroundService, {
            installable: false,
            logPath: "",
            decide: Effect.succeed({ _tag: "Adopt", server } as const),
            adopt: () => Effect.succeed("adopted"),
            adopted: Effect.succeedSome(server),
          }),
          Layer.mock(DesktopCliCommand.DesktopCliCommand, {}),
          Layer.mock(DesktopClientSettings.DesktopClientSettings, {}),
          Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore, {}),
          Layer.mock(DesktopIpc.DesktopIpc, {}),
          Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {}),
          Layer.mock(DesktopManagedPolicy.DesktopManagedPolicy, {}),
          Layer.succeed(DesktopPrimaryPaste.DesktopPrimaryPaste, { enabled: true }),
          Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment, {}),
          Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {}),
          Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {}),
          Layer.mock(DesktopWebLinks.DesktopWebLinks, {}),
          Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment, {}),
          Layer.mock(ElectronMenu.ElectronMenu, {}),
          Layer.mock(ElectronShell.ElectronShell, {}),
          Layer.mock(ElectronTheme.ElectronTheme, {}),
          Layer.mock(ElectronWindow.ElectronWindow, {}),
          Layer.mock(MacPermissions.MacPermissions, {}),
          Layer.mock(PreviewManager.PreviewManager, {
            isBrowserPartition: () => {
              throw new Error("unexpected browser partition lookup");
            },
          }),
          FileSystem.layerNoop({}),
          Layer.mock(NetService.NetService, {}),
          Path.layer,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected HTTP request")),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    const url = yield* Deferred.await(windowUrl).pipe(
      Effect.raceFirst(
        Fiber.join(app).pipe(Effect.andThen(Effect.die("app exited before opening the window"))),
      ),
    );
    assert.equal(url.href, "http://127.0.0.1:3773/");
    assert.isFalse(yield* Ref.get(backendStarted));
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    yield* shutdown.request;
    assert.isTrue(Exit.isSuccess(yield* Fiber.await(app)));
    assert.isTrue(yield* shutdown.isComplete);
  }).pipe(Effect.provide(Layer.mergeAll(DesktopShutdown.layer, NodeServices.layer))),
);
