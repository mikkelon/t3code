import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as Electron from "electron";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";

const encoder = new TextEncoder();

interface Harness {
  readonly home: string;
  readonly stateDir: string;
  readonly unitPath: string;
  /** Every CLI invocation, as its arguments after the entry script. */
  readonly commands: string[];
  readonly dialogs: string[];
  /** Requirement-free, so the fake CLI can call it from inside a spawn. */
  readonly writeRuntimeState: Effect.Effect<void>;
}

const installUnit = (harness: Harness) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(harness.unitPath), { recursive: true });
    yield* fs.writeFileString(
      harness.unitPath,
      `[Service]\nEnvironment=T3CODE_HOME=${path.join(harness.home, ".t3")}\n`,
    );
  });

// The test process itself: alive for as long as the test runs.
const runtimeStateJson = (port = 3773) =>
  `{"version":1,"pid":${process.pid},"port":${port},"origin":"http://127.0.0.1:${port}","startedAt":"2026-10-05T00:00:00.000Z","serviceManaged":true}`;

const writeRuntimeState = (harness: Harness) => harness.writeRuntimeState;

/**
 * A desktop environment for a packaged Linux app whose T3 home lives in a
 * temp dir, with a CLI, HTTP server and dialog that are all fakes.
 */
const makeHarness = Effect.fn("test.makeBackgroundServiceHarness")(function* (options: {
  readonly onCommand?: (
    args: string,
    harness: Harness,
  ) => Effect.Effect<{
    readonly output: string;
    readonly exitCode: number;
  }>;
  readonly dialogResponses?: number[];
  readonly authenticated?: (token: string) => boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-service-" });
  const stateDir = path.join(home, ".t3", "userdata");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "environment-id"), "env-home\n");
  const harness: Harness = {
    home,
    stateDir,
    unitPath: path.join(home, ".config", "systemd", "user", "t3code.service"),
    commands: [],
    dialogs: [],
    writeRuntimeState: fs
      .writeFileString(path.join(stateDir, "server-runtime.json"), runtimeStateJson())
      .pipe(Effect.orDie),
  };
  const responses = [...(options.dialogResponses ?? [])];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args
        .slice(1)
        .join(" ");
      harness.commands.push(args);
      const result = options.onCommand
        ? yield* options.onCommand(args, harness)
        : { output: "", exitCode: 0 };
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.make(encoder.encode(result.output)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/t3/environment") {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId: "env-home",
            label: "This machine",
            platform: { os: "linux", arch: "x64" },
            serverVersion: serverPackageJson.version,
            capabilities: { repositoryIdentity: true },
          }),
        );
      }
      const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const authenticated = options.authenticated?.(token) ?? true;
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          authenticated,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "t3_session",
          },
        }),
      );
    }),
  );

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: home,
    platform: "linux",
    processArch: "x64",
    appVersion: serverPackageJson.version,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ T3CODE_HOME: path.join(home, ".t3") }),
      ),
    ),
  );

  const layer = DesktopBackgroundService.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(
      Layer.mock(ElectronDialog.ElectronDialog)({
        showMessageBox: (messageBox: Electron.MessageBoxOptions) =>
          Effect.sync(() => {
            harness.dialogs.push(messageBox.message);
            return { response: responses.shift() ?? 0, checkboxChecked: false };
          }),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  return { harness, layer };
});

const issuedSessionOutput = (token: string) =>
  `{\n  "sessionId": "s1",\n  "token": "${token}",\n  "scopes": []\n}\n`;

const cli = (harness: Harness, command: string) =>
  harness.commands.filter((args) => args.startsWith(command));

describe("DesktopBackgroundService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("starts a stopped installed service and adopts it as the local environment", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: (args, current) =>
            args.startsWith("service start")
              ? writeRuntimeState(current).pipe(Effect.as({ output: "Started.", exitCode: 0 }))
              : Effect.succeed({ output: issuedSessionOutput("token-1"), exitCode: 0 }),
        });
        yield* installUnit(harness);

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          const decision = yield* service.decide;
          assert.deepEqual(decision, { _tag: "StartService" });

          assert.equal(yield* service.adopt(decision), "adopted");
          const adopted = yield* service.adopted;
          assert.equal(Option.getOrThrow(adopted).httpBaseUrl.href, "http://127.0.0.1:3773/");
          assert.equal(yield* service.getBearerToken, "token-1");
        }).pipe(Effect.provide(layer));

        assert.deepEqual(harness.commands, [
          `service start --base-dir ${harness.home}/.t3`,
          `auth session issue --base-dir ${harness.home}/.t3 --label T3 Code Desktop --json`,
        ]);
        const fs = yield* FileSystem.FileSystem;
        const session = yield* fs.stat(`${harness.stateDir}/desktop-service-session.json`);
        assert.equal(session.mode & 0o777, 0o600);
      }),
    );

    it.effect("reuses the stored session on the next launch instead of issuing another", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => Effect.succeed({ output: issuedSessionOutput("token-1"), exitCode: 0 }),
        });
        yield* writeRuntimeState(harness);
        const launch = Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          return yield* service.getBearerToken;
        }).pipe(Effect.provide(layer));

        assert.equal(yield* launch, "token-1");
        assert.equal(yield* launch, "token-1");
        assert.equal(cli(harness, "auth session issue").length, 1);
      }),
    );

    it.effect("never stops, restarts or cleans up an adopted server when the app quits", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => Effect.succeed({ output: issuedSessionOutput("token-1"), exitCode: 0 }),
        });
        yield* installUnit(harness);
        yield* writeRuntimeState(harness);

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          yield* service.reportAgentActivity({ running: 2, continuesAfterRestart: false });
          harness.commands.length = 0;

          // The quit path: no prompt while agents run on the service, and the
          // post-shutdown hook has nothing to hand over.
          assert.isTrue(yield* service.confirmQuit);
          yield* service.startAfterShutdown;
        }).pipe(Effect.provide(layer));

        // Closing the layer scope ended the app's own fibers; nothing reached
        // the service and its runtime state is untouched.
        assert.deepEqual(harness.commands, []);
        assert.deepEqual(harness.dialogs, []);
        const fs = yield* FileSystem.FileSystem;
        assert.isTrue(yield* fs.exists(`${harness.stateDir}/server-runtime.json`));
        assert.isTrue(yield* fs.exists(harness.unitPath));
      }),
    );

    it.effect("hands running agents over only after the embedded backend has stopped", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({ dialogResponses: [0] });

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.deepEqual(yield* service.decide, { _tag: "Embed" });
          yield* service.reportAgentActivity({ running: 1, continuesAfterRestart: true });

          assert.isTrue(yield* service.confirmQuit);
          // Installed without starting: the embedded backend still owns the home.
          assert.deepEqual(harness.commands, [
            `service install --base-dir ${harness.home}/.t3 --no-start`,
          ]);

          yield* service.startAfterShutdown;
          assert.deepEqual(cli(harness, "service start"), [
            `service start --base-dir ${harness.home}/.t3`,
          ]);
        }).pipe(Effect.provide(layer));
        assert.deepEqual(harness.dialogs, [
          "Agents stop when T3 Code closes. Keep them running in the background?",
        ]);
      }),
    );

    it.effect("asks for lingering with the exact command and retries when done", () =>
      Effect.gen(function* () {
        let attempts = 0;
        const { harness, layer } = yield* makeHarness({
          // Install, then "Done, retry".
          dialogResponses: [0, 0],
          onCommand: () =>
            Effect.sync(() => {
              attempts += 1;
              return attempts === 1
                ? {
                    output:
                      '[linger-disabled] Lingering is disabled. Run `sudo loginctl enable-linger "$(id -un)"`.',
                    exitCode: 1,
                  }
                : { output: "Installed.", exitCode: 0 };
            }),
        });

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          yield* service.reportAgentActivity({ running: 1, continuesAfterRestart: false });
          assert.isTrue(yield* service.confirmQuit);
        }).pipe(Effect.provide(layer));

        assert.equal(cli(harness, "service install").length, 2);
        assert.deepEqual(harness.dialogs, [
          "Agents stop when T3 Code closes. Keep them running in the background?",
          "Allow T3 Code to keep running after you log out",
        ]);
      }),
    );

    it.effect("cancelling the quit prompt keeps the app and installs nothing", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({ dialogResponses: [2] });
        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          yield* service.reportAgentActivity({ running: 1, continuesAfterRestart: false });
          assert.isFalse(yield* service.confirmQuit);
          yield* service.startAfterShutdown;
        }).pipe(Effect.provide(layer));
        assert.deepEqual(harness.commands, []);
      }),
    );

    it.effect("offers retry or quit when the service cannot start, never an embedded backend", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          // Retry once, then quit.
          dialogResponses: [0, 1],
          onCommand: () =>
            Effect.succeed({ output: "Background setup failed while starting.", exitCode: 1 }),
        });
        yield* installUnit(harness);

        const outcome = yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          return yield* service.adopt(yield* service.decide);
        }).pipe(Effect.provide(layer));

        assert.equal(outcome, "quit");
        assert.equal(cli(harness, "service start").length, 2);
        assert.deepEqual(harness.dialogs, [
          "T3 Code couldn't start its background service",
          "T3 Code couldn't start its background service",
        ]);
      }),
    );
  });
});
