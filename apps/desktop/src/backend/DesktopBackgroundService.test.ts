import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Electron from "electron";

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopBackgroundService from "./DesktopBackgroundService.ts";

const encoder = new TextEncoder();

interface Harness {
  readonly home: string;
  readonly stateDir: string;
  readonly unitPath: string;
  /** The service runtime the packaged app ships. */
  readonly runtimeArchive: string;
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
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

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
  /** The version the running server reports. Defaults to the app's own. */
  readonly serverVersion?: string;
  readonly platform?: NodeJS.Platform;
  /** False for a build without a service runtime, such as a development build. */
  readonly shipsRuntime?: boolean;
  readonly settings?: Partial<DesktopAppSettings.DesktopSettings>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-background-service-" });
  const stateDir = path.join(home, ".t3", "userdata");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.writeFileString(path.join(stateDir, "environment-id"), "env-home\n");
  const resourcesPath = path.join(home, "app-resources");
  yield* fs.makeDirectory(resourcesPath, { recursive: true });
  const runtimeArchive = path.join(resourcesPath, "service-runtime.tar.gz");
  if (options.shipsRuntime !== false) yield* fs.writeFileString(runtimeArchive, "archive");
  const harness: Harness = {
    home,
    stateDir,
    unitPath: path.join(home, ".config", "systemd", "user", "t3code.service"),
    runtimeArchive,
    commands: [],
    dialogs: [],
    writeRuntimeState: fs
      .writeFileString(path.join(stateDir, "server-runtime.json"), runtimeStateJson())
      .pipe(Effect.orDie),
  };
  const responses = [...(options.dialogResponses ?? [])];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const standard = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      // The bundled CLI is this process with the server entry; anything else
      // is recorded with its executable.
      const args =
        standard.command === process.execPath
          ? standard.args.slice(1).join(" ")
          : [standard.command, ...standard.args].join(" ");
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
            serverVersion: options.serverVersion ?? serverPackageJson.version,
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
    platform: options.platform ?? "linux",
    processArch: "x64",
    appVersion: serverPackageJson.version,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath,
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
    Layer.provideMerge(
      DesktopAppSettings.layerTest({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        ...options.settings,
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

const baseDirOf = (harness: Harness) => `${harness.home}/.t3`;

/** What `t3 service install` leaves behind once the service runs. */
const serviceRunning = (harness: Harness) =>
  Effect.all([installUnit(harness), writeRuntimeState(harness)]);

/** What `t3 service uninstall` leaves behind. */
const serviceRemoved = (harness: Harness) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(harness.unitPath, { force: true });
    yield* fs.remove(`${harness.stateDir}/server-runtime.json`, { force: true });
  }).pipe(Effect.provide(NodeServices.layer), Effect.orDie);

const succeed = (output = "") => Effect.succeed({ output, exitCode: 0 });

describe("DesktopBackgroundService", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("installs the service from the shipped runtime on first launch and adopts it", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: (args, current) =>
            args.startsWith("service install")
              ? serviceRunning(current).pipe(Effect.as({ output: "Installed.", exitCode: 0 }))
              : succeed(issuedSessionOutput("token-1")),
        });

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          const decision = yield* service.decide;
          assert.deepEqual(decision, { _tag: "InstallService" });
          assert.equal(yield* service.adopt(decision), "adopted");
          assert.equal(yield* service.getBearerToken, "token-1");
          // The one-time notice, for this launch only.
          assert.isTrue(yield* service.takeInstallNotice);
          assert.isFalse(yield* service.takeInstallNotice);
        }).pipe(Effect.provide(layer));

        assert.deepEqual(harness.commands, [
          `service install --base-dir ${baseDirOf(harness)} --runtime-archive ${harness.runtimeArchive}`,
          `auth session issue --base-dir ${baseDirOf(harness)} --label T3 Code Desktop --ttl 3650d --json`,
        ]);
        assert.deepEqual(harness.dialogs, []);
      }),
    );

    it.effect.each([
      { name: "the user opted out", options: { settings: { backgroundServiceDisabled: true } } },
      { name: "the build ships no service runtime", options: { shipsRuntime: false } },
      { name: "it runs on Windows", options: { platform: "win32" as const } },
    ])("runs the app's own backend when $name", ({ options }) =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness(options);
        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.deepEqual(yield* service.decide, { _tag: "Embed" });
        }).pipe(Effect.provide(layer));
        assert.deepEqual(harness.commands, []);
      }),
    );

    it.effect("adopts a service the user installed by hand without reinstalling it", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => succeed(issuedSessionOutput("token-1")),
          settings: { backgroundServiceDisabled: true },
        });
        yield* serviceRunning(harness);
        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          const decision = yield* service.decide;
          assert.equal(decision._tag, "Adopt");
          assert.equal(yield* service.adopt(decision), "adopted");
          assert.isFalse(yield* service.takeInstallNotice);
        }).pipe(Effect.provide(layer));
        assert.deepEqual(cli(harness, "service"), []);
      }),
    );

    it.effect(
      "falls back to the app's own backend after a failed install, without the service",
      () =>
        Effect.gen(function* () {
          const { harness, layer } = yield* makeHarness({
            // Retry once, then continue without it.
            dialogResponses: [0, 1],
            onCommand: (args, current) =>
              args.startsWith("service install")
                ? // The unit was written before the start failed.
                  installUnit(current).pipe(
                    Effect.as({
                      output: "Background setup failed while starting the service (exit code 1).",
                      exitCode: 1,
                    }),
                  )
                : args.startsWith("service uninstall")
                  ? serviceRemoved(current).pipe(Effect.as({ output: "Removed.", exitCode: 0 }))
                  : succeed(),
          });

          yield* Effect.gen(function* () {
            const service = yield* DesktopBackgroundService.DesktopBackgroundService;
            assert.equal(yield* service.adopt(yield* service.decide), "embed");
            // This launch does not try again behind the user's back.
            assert.deepEqual(yield* service.decide, { _tag: "Embed" });
            const state = yield* service.state;
            assert.equal(
              state.error,
              "Background setup failed while starting the service (exit code 1).",
            );
            assert.isFalse(state.installed);
            assert.isFalse(state.disabled);
          }).pipe(Effect.provide(layer));

          assert.deepEqual(cli(harness, "service"), [
            `service install --base-dir ${baseDirOf(harness)} --runtime-archive ${harness.runtimeArchive}`,
            `service install --base-dir ${baseDirOf(harness)} --runtime-archive ${harness.runtimeArchive}`,
            `service uninstall --base-dir ${baseDirOf(harness)}`,
          ]);
          assert.deepEqual(harness.dialogs, [
            "T3 Code couldn't set up its background service",
            "T3 Code couldn't set up its background service",
          ]);
        }),
    );

    it.effect("never falls back next to a failed install it could not remove", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          // Continue without it, then quit when the leftover will not start.
          dialogResponses: [1, 1],
          onCommand: (args, current) =>
            args.startsWith("service install")
              ? installUnit(current).pipe(
                  Effect.as({ output: "Background setup failed.", exitCode: 1 }),
                )
              : Effect.succeed({ output: "Could not stop it.", exitCode: 1 }),
        });

        const outcome = yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          return yield* service.adopt(yield* service.decide);
        }).pipe(Effect.provide(layer));

        assert.equal(outcome, "quit");
        assert.deepEqual(harness.dialogs, [
          "T3 Code couldn't set up its background service",
          "T3 Code couldn't start its background service",
        ]);
      }),
    );

    it.effect("starts a stopped installed service and adopts it as the local environment", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: (args, current) =>
            args.startsWith("service start")
              ? writeRuntimeState(current).pipe(Effect.as({ output: "Started.", exitCode: 0 }))
              : succeed(issuedSessionOutput("token-1")),
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
          `service start --base-dir ${baseDirOf(harness)}`,
          `auth session issue --base-dir ${baseDirOf(harness)} --label T3 Code Desktop --ttl 3650d --json`,
        ]);
        const fs = yield* FileSystem.FileSystem;
        const session = yield* fs.stat(`${harness.stateDir}/desktop-service-session.json`);
        assert.equal(session.mode & 0o777, 0o600);
      }),
    );

    it.effect("reuses the stored session on the next launch instead of issuing another", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => succeed(issuedSessionOutput("token-1")),
          shipsRuntime: false,
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

    it.effect("issues a new session when the stored one predates the running server", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => succeed(issuedSessionOutput("token-2")),
          shipsRuntime: false,
        });
        yield* writeRuntimeState(harness);
        // Written by an app that did not record the server version: its
        // session lacks whatever the running server added since.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(
          `${harness.stateDir}/desktop-service-session.json`,
          `${JSON.stringify({ environmentId: "env-home", token: "token-1" })}\n`,
        );
        const launch = Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          return yield* service.getBearerToken;
        }).pipe(Effect.provide(layer));

        assert.equal(yield* launch, "token-2");
        assert.equal(yield* launch, "token-2");
        assert.equal(cli(harness, "auth session issue").length, 1);
        const stored = JSON.parse(
          yield* fs.readFileString(`${harness.stateDir}/desktop-service-session.json`),
        );
        assert.equal(stored.serverVersion, serverPackageJson.version);
      }),
    );

    it.effect("never stops, restarts or cleans up an adopted server when the app quits", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: () => succeed(issuedSessionOutput("token-1")),
        });
        yield* serviceRunning(harness);

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          yield* service.state;
          harness.commands.length = 0;
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

    it.effect("stages the app's server for an older service and reports the update ready", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          serverVersion: "0.0.1",
          onCommand: (args) =>
            args.includes("auth session issue")
              ? succeed(issuedSessionOutput("token-1"))
              : succeed(`Staged t3@${serverPackageJson.version}.`),
        });
        yield* serviceRunning(harness);
        // An older service mints with its own runtime.
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${baseDirOf(harness)}/runtime/versions/0.0.1`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${baseDirOf(harness)}/runtime/versions/0.0.1/t3`, "");

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          const state = yield* service.state;
          assert.deepEqual(state.update, {
            status: "ready",
            targetVersion: serverPackageJson.version,
          });
          assert.equal(state.serverVersion, "0.0.1");
        }).pipe(Effect.provide(layer));

        assert.deepEqual(cli(harness, "service"), [
          `service stage --base-dir ${baseDirOf(harness)} --runtime-archive ${harness.runtimeArchive}`,
        ]);
      }),
    );

    it.effect.each([
      { name: "on the app's version", serverVersion: serverPackageJson.version },
      { name: "newer than the app", serverVersion: "999.0.0" },
    ])("leaves a service $name alone", ({ serverVersion }) =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          serverVersion,
          onCommand: () => succeed(issuedSessionOutput("token-1")),
        });
        yield* serviceRunning(harness);
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${baseDirOf(harness)}/runtime/versions/${serverVersion}`, {
          recursive: true,
        });
        yield* fs.writeFileString(`${baseDirOf(harness)}/runtime/versions/${serverVersion}/t3`, "");

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          assert.deepEqual((yield* service.state).update, { status: "none" });
        }).pipe(Effect.provide(layer));

        assert.deepEqual(cli(harness, "service"), []);
      }),
    );

    it.effect("reports a missing linger with the command that enables it", () =>
      Effect.gen(function* () {
        const { layer, harness } = yield* makeHarness({
          onCommand: (args) =>
            args.startsWith("loginctl show-user")
              ? succeed("no\n")
              : succeed(issuedSessionOutput("token-1")),
        });
        yield* serviceRunning(harness);
        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          const state = yield* service.state;
          assert.match(state.lingerCommand ?? "", /^sudo loginctl enable-linger \S+$/);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("opting out removes the service and the next launch runs its own backend", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: (args, current) =>
            args.startsWith("service uninstall")
              ? serviceRemoved(current).pipe(Effect.as({ output: "Removed.", exitCode: 0 }))
              : succeed(issuedSessionOutput("token-1")),
        });
        yield* serviceRunning(harness);

        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");

          yield* service.setEnabled(false);
          assert.isTrue((yield* settings.get).backgroundServiceDisabled);
          assert.deepEqual(yield* service.decide, { _tag: "Embed" });

          // The way back: the next launch installs it again before any backend starts.
          yield* service.setEnabled(true);
          assert.isFalse((yield* settings.get).backgroundServiceDisabled);
          assert.deepEqual(yield* service.decide, { _tag: "InstallService" });
        }).pipe(Effect.provide(layer));

        assert.deepEqual(cli(harness, "service"), [
          `service uninstall --base-dir ${baseDirOf(harness)}`,
        ]);
      }),
    );

    it.effect("keeps the opt-out unrecorded when the service cannot be removed", () =>
      Effect.gen(function* () {
        const { harness, layer } = yield* makeHarness({
          onCommand: (args) =>
            args.startsWith("service uninstall")
              ? Effect.succeed({ output: "Background setup failed.", exitCode: 1 })
              : succeed(issuedSessionOutput("token-1")),
        });
        yield* serviceRunning(harness);
        yield* Effect.gen(function* () {
          const service = yield* DesktopBackgroundService.DesktopBackgroundService;
          assert.equal(yield* service.adopt(yield* service.decide), "adopted");
          const error = yield* service.setEnabled(false).pipe(Effect.flip);
          assert.equal(error._tag, "DesktopBackgroundServiceCliError");
          assert.isFalse(
            (yield* (yield* DesktopAppSettings.DesktopAppSettings).get).backgroundServiceDisabled,
          );
        }).pipe(Effect.provide(layer));
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

describe("linkLauncher", () => {
  it.layer(NodeServices.layer)((it) => {
    const setup = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-" });
      const versionsDir = path.join(home, ".t3", "runtime", "versions");
      const runtime = (version: string) => path.join(versionsDir, version, "t3");
      for (const version of ["1.0.0", "1.1.0"]) {
        yield* fs.makeDirectory(path.dirname(runtime(version)), { recursive: true });
        yield* fs.writeFileString(runtime(version), "");
      }
      const launcherPath = path.join(home, ".local", "bin", "t3");
      return { fs, path, home, versionsDir, runtime, launcherPath };
    });

    it.effect("creates a missing launcher and moves one it owns to the service's version", () =>
      Effect.gen(function* () {
        const { fs, versionsDir, runtime, launcherPath } = yield* setup;
        const link = (target: string) =>
          DesktopBackgroundService.linkLauncher({ launcherPath, versionsDir, target });

        assert.equal(yield* link(runtime("1.0.0")), "linked");
        assert.equal(yield* fs.readLink(launcherPath), runtime("1.0.0"));
        assert.equal(yield* link(runtime("1.0.0")), "unchanged");
        assert.equal(yield* link(runtime("1.1.0")), "linked");
        assert.equal(yield* fs.readLink(launcherPath), runtime("1.1.0"));
      }),
    );

    it.effect("leaves a t3 that is not the install script's alone", () =>
      Effect.gen(function* () {
        const { fs, path, home, versionsDir, runtime, launcherPath } = yield* setup;
        yield* fs.makeDirectory(path.dirname(launcherPath), { recursive: true });
        const npmBin = path.join(home, ".local", "lib", "node_modules", "t3", "bin.js");
        yield* fs.symlink(npmBin, launcherPath);
        assert.equal(
          yield* DesktopBackgroundService.linkLauncher({
            launcherPath,
            versionsDir,
            target: runtime("1.1.0"),
          }),
          "foreign",
        );
        assert.equal(yield* fs.readLink(launcherPath), npmBin);

        yield* fs.remove(launcherPath);
        yield* fs.writeFileString(launcherPath, "#!/bin/sh\n");
        assert.equal(
          yield* DesktopBackgroundService.linkLauncher({
            launcherPath,
            versionsDir,
            target: runtime("1.1.0"),
          }),
          "foreign",
        );
        assert.equal(yield* fs.readFileString(launcherPath), "#!/bin/sh\n");
      }),
    );
  });
});
