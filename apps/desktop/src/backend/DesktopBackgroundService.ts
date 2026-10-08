// The desktop side of the background service (`t3 service`). The service is
// part of the app: on Linux and macOS a packaged app installs it on launch
// from the runtime it ships, adopts it as its local environment, and keeps it
// on the app's version. When a T3 server already owns this app's T3 home, it
// is adopted instead of embedding a second backend on the same database. The
// app never stops, restarts or cleans up an adopted server on quit; closing
// the app leaves it and its agents running. Every change to the service goes
// through the bundled `t3` CLI, so the unit, runtime and linger handling stay
// the server's.

import { fetchRemoteSessionState } from "@t3tools/client-runtime/authorization";
import type {
  DesktopBackgroundServiceState,
  DesktopBackgroundServiceUpdate,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeOS from "node:os";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopLocalServerDiscovery from "./DesktopLocalServerDiscovery.ts";

export type LocalServerDecision = DesktopLocalServerDiscovery.LocalServerDecision;

const SERVICE_READY_TIMEOUT = Duration.minutes(1);
const SERVICE_READY_POLL = Duration.millis(500);
const ADOPTED_SERVER_POLL = Duration.seconds(5);
const CLI_TIMEOUT = Duration.minutes(2);
// Unpacking the runtime and waiting for the service manager.
const CLI_INSTALL_TIMEOUT = Duration.minutes(10);
// This platform's CLI release archive, shipped by packaged Linux and macOS
// builds (scripts/build-desktop-artifact.ts, SERVICE_RUNTIME_ARCHIVE_NAME).
const SERVICE_RUNTIME_ARCHIVE = "service-runtime.tar.gz";
const SESSION_FILE = "desktop-service-session.json";
const SESSION_LABEL = "T3 Code Desktop";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-background-service",
);

export class DesktopBackgroundServiceCliError extends Schema.TaggedError<DesktopBackgroundServiceCliError>()(
  "DesktopBackgroundServiceCliError",
  {
    command: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    output: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = lastMeaningfulLine(this.output);
    return detail === undefined
      ? `\`t3 ${this.command}\` failed${this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`}.`
      : detail;
  }
}

export class DesktopBackgroundServiceTimeoutError extends Schema.TaggedError<DesktopBackgroundServiceTimeoutError>()(
  "DesktopBackgroundServiceTimeoutError",
  {},
) {
  override get message(): string {
    return `The background service did not answer within ${Duration.format(SERVICE_READY_TIMEOUT)}.`;
  }
}

export class DesktopBackgroundServiceCredentialError extends Schema.TaggedError<DesktopBackgroundServiceCredentialError>()(
  "DesktopBackgroundServiceCredentialError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

export class DesktopBackgroundServiceNotAdoptedError extends Schema.TaggedError<DesktopBackgroundServiceNotAdoptedError>()(
  "DesktopBackgroundServiceNotAdoptedError",
  {},
) {
  override get message(): string {
    return "This app is not connected to a background service.";
  }
}

export type DesktopBackgroundServiceError =
  | DesktopBackgroundServiceCliError
  | DesktopBackgroundServiceTimeoutError
  | DesktopBackgroundServiceCredentialError
  | DesktopBackgroundServiceNotAdoptedError;

export interface AdoptedServer {
  readonly httpBaseUrl: URL;
  readonly environmentId: string;
  readonly serverVersion: string;
  readonly serviceManaged: boolean;
  readonly startedAt?: string | undefined;
}

export type AdoptOutcome = "adopted" | "embed" | "quit";

export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    /**
     * The app installs, updates and removes the service: a packaged Linux or
     * macOS build that ships a service runtime. A development build must
     * never touch the user's one service unit.
     */
    readonly installable: boolean;
    /** How the primary environment should run this launch. */
    readonly decide: Effect.Effect<DesktopLocalServerDiscovery.LocalServerDecision>;
    /**
     * Brings up and adopts the server a non-Embed decision names: installs or
     * starts the service when needed, waits for it, and obtains a credential.
     * A service that is installed or running is never replaced by a second
     * backend: failures ask the user to retry or quit. Only a failed install
     * may fall back to the app's own backend, after removing what it
     * installed. Resolves "embed" when nothing owns the home anymore.
     */
    readonly adopt: (
      decision: DesktopLocalServerDiscovery.LocalServerDecision,
    ) => Effect.Effect<AdoptOutcome>;
    /** Some while the primary environment is an adopted server. */
    readonly adopted: Effect.Effect<Option.Option<AdoptedServer>>;
    readonly getBearerToken: Effect.Effect<string, DesktopBackgroundServiceError>;
    /** What Settings → Connections shows. Re-reads the server, which may have updated. */
    readonly state: Effect.Effect<DesktopBackgroundServiceState>;
    /** True once, after the launch that installed the service. */
    readonly takeInstallNotice: Effect.Effect<boolean>;
    /** Restarts the installed service on the version its unit names. */
    readonly restart: Effect.Effect<void, DesktopBackgroundServiceCliError>;
    /** The file the service manager appends the service's output to. */
    readonly logPath: string;
    /**
     * "Don't run agents in the background": false removes the service and
     * stops installing it on launch; true installs it again on the next
     * launch. The caller relaunches the app, so the service and the app's own
     * backend never run at once.
     */
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<
      void,
      DesktopBackgroundServiceCliError | DesktopAppSettings.DesktopSettingsWriteError
    >;
  }
>()("@t3tools/desktop/backend/DesktopBackgroundService") {}

function lastMeaningfulLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
}

// A session keeps the permissions it was issued with, and a newer server may
// guard actions with permissions an older one never granted. A stored session
// therefore only serves the server version that issued it.
const SessionFile = Schema.Struct({
  environmentId: Schema.String,
  serverVersion: Schema.optionalKey(Schema.String),
  token: Schema.String,
});
const decodeSessionFile = Schema.decodeUnknownOption(Schema.fromJsonString(SessionFile));
const encodeSessionFile = Schema.encodeSync(Schema.fromJsonString(SessionFile));
const IssuedSession = Schema.Struct({ token: Schema.String });
const decodeIssuedSession = Schema.decodeUnknownOption(Schema.fromJsonString(IssuedSession));

/** An unreadable origin counts as unchanged; the next probe decides. */
function namesSameOrigin(raw: string, current: URL): boolean {
  try {
    return new URL(raw).href === current.href;
  } catch {
    return true;
  }
}

/** The JSON object a CLI printed, ignoring any noise around it. */
function extractJsonObject(output: string): string | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start === -1 || end < start ? undefined : output.slice(start, end + 1);
}

/**
 * Points `~/.local/bin/t3`, the launcher the install script manages, at the
 * runtime the service runs, so `t3` in a terminal is the same version as the
 * app and the service. Only a missing launcher or a symlink into this home's
 * `runtime/versions` is ours; a `t3` from npm, a distro package or a copy is
 * left alone.
 */
export const linkLauncher = Effect.fn("desktop.backgroundService.linkLauncher")(function* (input: {
  readonly launcherPath: string;
  readonly versionsDir: string;
  readonly target: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const current = yield* fs.readLink(input.launcherPath).pipe(Effect.option);
  if (Option.isSome(current)) {
    const resolved = path.resolve(path.dirname(input.launcherPath), current.value);
    const relative = path.relative(input.versionsDir, resolved);
    if (relative.length === 0 || relative.startsWith("..") || path.isAbsolute(relative)) {
      return "foreign" as const;
    }
    if (resolved === input.target) return "unchanged" as const;
  } else if (yield* fs.exists(input.launcherPath)) {
    return "foreign" as const;
  }
  yield* fs.makeDirectory(path.dirname(input.launcherPath), { recursive: true });
  const temporary = `${input.launcherPath}.${process.pid}.tmp`;
  yield* fs.remove(temporary, { force: true });
  yield* fs.symlink(input.target, temporary);
  yield* fs.rename(temporary, input.launcherPath);
  return "linked" as const;
});

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const path = environment.path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
  >();

  // The CLI addresses a home's `userdata` directory. A development app that
  // keeps its state under `dev` shares no database with a service.
  const adoptable = environment.stateDir === path.join(environment.baseDir, "userdata");
  const runtimeArchive = path.join(environment.resourcesPath, SERVICE_RUNTIME_ARCHIVE);
  const installable =
    adoptable &&
    !environment.isDevelopment &&
    (environment.platform === "linux" || environment.platform === "darwin") &&
    (yield* fs.exists(runtimeArchive).pipe(Effect.orElseSucceed(() => false)));
  const logPath = path.join(environment.stateDir, "logs", "boot-service.log");

  const adoptedRef = yield* Ref.make(Option.none<AdoptedServer>());
  const tokenRef = yield* Ref.make(
    Option.none<{ readonly serverVersion: string; readonly token: string }>(),
  );
  const tokenLock = yield* Semaphore.make(1);
  const updateRef = yield* Ref.make<DesktopBackgroundServiceUpdate>({ status: "none" });
  // Why this launch runs the app's own backend instead of the service.
  const errorRef = yield* Ref.make<string | null>(null);
  // The user chose to continue without the service after a failed install.
  const skipInstallRef = yield* Ref.make(false);
  const noticeRef = yield* Ref.make(false);
  // Staging the app's server after adoption; state waits for it.
  const preparingRef = yield* Ref.make(Option.none<Fiber.Fiber<void>>());

  const readInstalled = DesktopLocalServerDiscovery.readServiceInstalled({
    platform: environment.platform,
    homeDir: environment.homeDirectory,
    baseDir: environment.baseDir,
  }).pipe(Effect.provide(context));

  const probeLive = DesktopLocalServerDiscovery.probeLiveLocalServer(environment.stateDir).pipe(
    Effect.provide(context),
  );

  const runCli = Effect.fn("desktop.backgroundService.runCli")(function* (input: {
    readonly executable: "bundled" | string;
    readonly args: ReadonlyArray<string>;
    readonly timeout?: Duration.Duration;
  }) {
    const commandLabel = input.args.slice(0, 2).join(" ");
    const command =
      input.executable === "bundled"
        ? ChildProcess.make(process.execPath, [environment.backendEntryPath, ...input.args], {
            cwd: environment.backendCwd,
            env: { ELECTRON_RUN_AS_NODE: "1" },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          })
        : ChildProcess.make(input.executable, [...input.args], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(command);
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { output, exitCode: Number(exitCode) };
      }),
    ).pipe(
      Effect.timeout(input.timeout ?? CLI_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new DesktopBackgroundServiceCliError({ command: commandLabel, output: "", cause }),
      ),
    );
    if (result.exitCode !== 0) {
      return yield* new DesktopBackgroundServiceCliError({
        command: commandLabel,
        exitCode: result.exitCode,
        output: result.output,
      });
    }
    return result.output;
  });

  const baseDirArgs = ["--base-dir", environment.baseDir] as const;

  const start = runCli({ executable: "bundled", args: ["service", "start", ...baseDirArgs] }).pipe(
    Effect.asVoid,
    Effect.withSpan("desktop.backgroundService.start"),
  );

  const notInstallable = (command: string) =>
    new DesktopBackgroundServiceCliError({
      command,
      output: "This build of T3 Code does not manage the background service.",
    });

  const whenInstallable = <A, E>(command: string, effect: Effect.Effect<A, E>) =>
    installable ? effect : Effect.fail(notInstallable(command));

  // Unpacks the shipped runtime into the home, writes the unit and starts it.
  // A missing linger is only a warning; the service then runs while the user
  // is logged in.
  const install = whenInstallable(
    "service install",
    runCli({
      executable: "bundled",
      args: ["service", "install", ...baseDirArgs, "--runtime-archive", runtimeArchive],
      timeout: CLI_INSTALL_TIMEOUT,
    }),
  ).pipe(Effect.asVoid, Effect.withSpan("desktop.backgroundService.install"));

  const uninstall = whenInstallable(
    "service uninstall",
    runCli({ executable: "bundled", args: ["service", "uninstall", ...baseDirArgs] }),
  ).pipe(Effect.asVoid, Effect.withSpan("desktop.backgroundService.uninstall"));

  const restart = whenInstallable(
    "service restart",
    runCli({ executable: "bundled", args: ["service", "restart", ...baseDirArgs] }),
  ).pipe(Effect.asVoid, Effect.withSpan("desktop.backgroundService.restart"));

  // Minting writes to the server's database, and every CLI that opens it runs
  // migrations, so only a CLI of the server's own version may do it: the one
  // bundled with this app, or the runtime the service installed for it.
  const resolveCredentialCli = Effect.fn("desktop.backgroundService.resolveCredentialCli")(
    function* (server: AdoptedServer) {
      if (server.serverVersion === serverPackageJson.version) return "bundled";
      const runtime = path.join(
        environment.baseDir,
        "runtime",
        "versions",
        server.serverVersion,
        environment.platform === "win32" ? "t3.exe" : "t3",
      );
      if (yield* fs.exists(runtime).pipe(Effect.orElseSucceed(() => false))) return runtime;
      return yield* new DesktopBackgroundServiceCredentialError({
        reason: `The T3 server running for ${environment.baseDir} is t3@${server.serverVersion}, and this app (t3@${serverPackageJson.version}) cannot sign in to it. Update the app or the server so both run the same version.`,
      });
    },
  );

  const sessionPath = path.join(environment.stateDir, SESSION_FILE);

  const readPersistedToken = (server: AdoptedServer) =>
    fs.readFileString(sessionPath).pipe(
      Effect.option,
      Effect.map((raw) =>
        Option.flatMap(raw, decodeSessionFile).pipe(
          Option.filter(
            (session) =>
              session.environmentId === server.environmentId &&
              session.serverVersion === server.serverVersion,
          ),
          Option.map((session) => session.token),
        ),
      ),
    );

  // A network failure keeps the stored token: the server may simply be
  // restarting, and issuing a new session on every hiccup would pile them up.
  const tokenStillValid = (server: AdoptedServer, token: string) =>
    fetchRemoteSessionState({ httpBaseUrl: server.httpBaseUrl.href, bearerToken: token }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.map((session) => session.authenticated),
      Effect.catch(() => Effect.succeed(true)),
    );

  const issueToken = Effect.fn("desktop.backgroundService.issueToken")(function* (
    server: AdoptedServer,
  ) {
    const executable = yield* resolveCredentialCli(server);
    const output = yield* runCli({
      executable,
      args: ["auth", "session", "issue", ...baseDirArgs, "--label", SESSION_LABEL, "--json"],
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopBackgroundServiceCredentialError({
            reason: `Could not sign in to the background service: ${cause.message}`,
            cause,
          }),
      ),
    );
    const issued = Option.flatMap(
      Option.fromNullishOr(extractJsonObject(output)),
      decodeIssuedSession,
    );
    if (Option.isNone(issued)) {
      return yield* new DesktopBackgroundServiceCredentialError({
        reason: "The T3 CLI did not return a session token.",
      });
    }
    // Same trust boundary as the database next to it: owner-only.
    yield* fs
      .writeFileString(
        sessionPath,
        `${encodeSessionFile({
          environmentId: server.environmentId,
          serverVersion: server.serverVersion,
          token: issued.value.token,
        })}\n`,
        { mode: 0o600 },
      )
      .pipe(
        Effect.catch((error) =>
          logWarning("could not persist the background service session", { error }),
        ),
      );
    return issued.value.token;
  });

  const tokenFor = (server: AdoptedServer) =>
    tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenRef);
        if (Option.isSome(cached) && cached.value.serverVersion === server.serverVersion) {
          return cached.value.token;
        }
        const persisted = yield* readPersistedToken(server);
        const token =
          Option.isSome(persisted) && (yield* tokenStillValid(server, persisted.value))
            ? persisted.value
            : yield* issueToken(server);
        yield* Ref.set(tokenRef, Option.some({ serverVersion: server.serverVersion, token }));
        return token;
      }),
    );

  const getBearerToken = Effect.gen(function* () {
    const adopted = yield* Ref.get(adoptedRef);
    if (Option.isNone(adopted)) return yield* new DesktopBackgroundServiceNotAdoptedError();
    return yield* tokenFor(adopted.value);
  }).pipe(Effect.withSpan("desktop.backgroundService.getBearerToken"));

  const decide = Effect.gen(function* () {
    if (!adoptable) return { _tag: "Embed" } as const;
    const [serviceInstalled, live, settings, skipInstall] = yield* Effect.all(
      [readInstalled, probeLive, desktopSettings.get, Ref.get(skipInstallRef)],
      { concurrency: "unbounded" },
    );
    return DesktopLocalServerDiscovery.decideLocalServer({
      serviceInstalled,
      live,
      autoInstall: installable && !settings.backgroundServiceDisabled && !skipInstall,
    });
  }).pipe(Effect.withSpan("desktop.backgroundService.decide"));

  const waitForLive = probeLive.pipe(
    Effect.flatMap((live) =>
      Option.isSome(live)
        ? Effect.succeed(live.value)
        : Effect.fail(new DesktopBackgroundServiceTimeoutError()),
    ),
    Effect.retry(Schedule.spaced(SERVICE_READY_POLL)),
    Effect.timeoutOrElse({
      duration: SERVICE_READY_TIMEOUT,
      orElse: () => Effect.fail(new DesktopBackgroundServiceTimeoutError()),
    }),
  );

  const attempt = Effect.fn("desktop.backgroundService.attempt")(function* (
    decision: Exclude<DesktopLocalServerDiscovery.LocalServerDecision, { _tag: "Embed" }>,
  ) {
    let server: AdoptedServer;
    if (decision._tag === "Adopt") {
      server = decision.server;
    } else if (decision._tag === "InstallService") {
      yield* logInfo("installing the background service");
      yield* install;
      server = yield* waitForLive;
    } else {
      yield* logInfo("starting the installed background service");
      yield* start;
      server = yield* waitForLive;
    }
    // Obtain the credential before the window opens, so a server this app
    // cannot sign in to is reported here instead of as a stuck window.
    yield* tokenFor(server);
    return server;
  });

  // `t3 service` serves this home and the app ships the newer server: put the
  // app's version on disk next to the running one. The renderer then switches
  // the service to it through the server's own update, which keeps the old
  // version and rolls back to it when the new one fails its start. A service
  // newer than the app is left alone.
  const prepareUpdate = Effect.fn("desktop.backgroundService.prepareUpdate")(function* (
    server: AdoptedServer,
  ) {
    const targetVersion = serverPackageJson.version;
    if (
      !installable ||
      !server.serviceManaged ||
      compareSemverVersions(targetVersion, server.serverVersion) <= 0 ||
      !(yield* readInstalled)
    ) {
      return;
    }
    yield* logInfo("staging the app's server for the background service", {
      from: server.serverVersion,
      to: targetVersion,
    });
    const staged = yield* Effect.result(
      runCli({
        executable: "bundled",
        args: ["service", "stage", ...baseDirArgs, "--runtime-archive", runtimeArchive],
        timeout: CLI_INSTALL_TIMEOUT,
      }),
    );
    if (staged._tag === "Success") {
      yield* Ref.set(updateRef, { status: "ready", targetVersion });
      return;
    }
    yield* logWarning("could not stage the background service update", {
      error: staged.failure.message,
    });
    yield* Ref.set(updateRef, { status: "failed", targetVersion, message: staged.failure.message });
  });

  const syncLauncher = (server: AdoptedServer) =>
    Effect.gen(function* () {
      if (!installable || !server.serviceManaged) return;
      const target = path.join(
        environment.baseDir,
        "runtime",
        "versions",
        server.serverVersion,
        "t3",
      );
      if (!(yield* fs.exists(target))) return;
      const outcome = yield* linkLauncher({
        launcherPath: path.join(environment.homeDirectory, ".local", "bin", "t3"),
        versionsDir: path.join(environment.baseDir, "runtime", "versions"),
        target,
      }).pipe(Effect.provide(context));
      if (outcome === "linked")
        yield* logInfo("pointed ~/.local/bin/t3 at the service", { target });
    }).pipe(
      Effect.catch((error) => logWarning("could not update ~/.local/bin/t3", { error })),
      Effect.withSpan("desktop.backgroundService.syncLauncher"),
    );

  // The renderer reconnects on its own when the server restarts on the same
  // origin. A restart on another port only shows up in the runtime file.
  const followServer = Effect.gen(function* () {
    const origin = yield* DesktopLocalServerDiscovery.readRuntimeOrigin(environment.stateDir).pipe(
      Effect.provide(context),
    );
    const current = yield* Ref.get(adoptedRef);
    if (
      Option.isNone(origin) ||
      Option.isNone(current) ||
      namesSameOrigin(origin.value, current.value.httpBaseUrl)
    ) {
      return;
    }
    const live = yield* probeLive;
    if (Option.isNone(live)) return;
    yield* Ref.update(adoptedRef, (current) =>
      Option.isSome(current) && current.value.httpBaseUrl.href !== live.value.httpBaseUrl.href
        ? Option.some(live.value)
        : current,
    );
  }).pipe(Effect.repeat(Schedule.spaced(ADOPTED_SERVER_POLL)), Effect.asVoid);

  const layerScope = yield* Effect.scope;

  const failureDetail = (
    decision: DesktopLocalServerDiscovery.LocalServerDecision,
    error: DesktopBackgroundServiceError,
  ) =>
    decision._tag === "Adopt" && !decision.server.serviceManaged
      ? `${error.message}\n\nA T3 server started outside the app owns ${environment.baseDir}. T3 Code will not start a second server on the same data.`
      : decision._tag === "InstallService"
        ? `${error.message}\n\nT3 Code can run agents itself instead; they then stop when you close the app. Background running can be turned off in Settings → Connections.`
        : `${error.message}\n\nRun \`t3 service status\` in a terminal to see what's wrong.`;

  const adopt: DesktopBackgroundService["Service"]["adopt"] = Effect.fn(
    "desktop.backgroundService.adopt",
  )(function* (initial) {
    let decision = initial;
    while (decision._tag !== "Embed") {
      const result = yield* Effect.result(attempt(decision));
      if (result._tag === "Success") {
        const server = result.success;
        yield* Ref.set(adoptedRef, Option.some(server));
        if (decision._tag === "InstallService") yield* Ref.set(noticeRef, true);
        yield* logInfo("adopted local server", {
          httpBaseUrl: server.httpBaseUrl.href,
          serviceManaged: server.serviceManaged,
        });
        yield* Effect.forkIn(followServer, layerScope);
        const preparing = yield* Effect.forkIn(
          syncLauncher(server).pipe(Effect.andThen(prepareUpdate(server))),
          layerScope,
        );
        yield* Ref.set(preparingRef, Option.some(preparing));
        return "adopted";
      }
      yield* logWarning("could not adopt local server", { error: result.failure.message });
      const installing = decision._tag === "InstallService";
      const choice = yield* dialog
        .showMessageBox({
          type: "error",
          title: "T3 Code",
          message: installing
            ? "T3 Code couldn't set up its background service"
            : decision._tag === "StartService"
              ? "T3 Code couldn't start its background service"
              : "T3 Code couldn't connect to the T3 server on this computer",
          detail: failureDetail(decision, result.failure),
          buttons: installing ? ["Retry", "Continue without it"] : ["Retry", "Quit"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        .pipe(
          Effect.map((value) => value.response),
          Effect.orElseSucceed(() => 1),
        );
      if (choice !== 0) {
        if (!installing) return "quit";
        // Fall back to the app's own backend, but never next to a service: a
        // half-finished install may have left one running. If it cannot be
        // removed, the next decision starts it and only Retry or Quit remain.
        yield* Ref.set(errorRef, result.failure.message);
        yield* Ref.set(skipInstallRef, true);
        yield* uninstall.pipe(
          Effect.catch((error) =>
            logWarning("could not remove a failed background service install", {
              error: error.message,
            }),
          ),
        );
      } else if (installing) {
        // Installing again repairs whatever the failed attempt left behind,
        // and keeps the way back to the app's own backend open.
        continue;
      }
      decision = yield* decide;
    }
    return "embed";
  });

  const readLingerCommand = Effect.gen(function* () {
    const uid = process.getuid?.();
    if (environment.platform !== "linux" || uid === undefined) return null;
    const output = yield* runCli({
      executable: "loginctl",
      args: ["show-user", String(uid), "--property=Linger", "--value"],
    }).pipe(Effect.orElseSucceed(() => ""));
    return output.trim() === "no"
      ? `sudo loginctl enable-linger ${NodeOS.userInfo().username}`
      : null;
  });

  const state: DesktopBackgroundService["Service"]["state"] = Effect.gen(function* () {
    const preparing = yield* Ref.get(preparingRef);
    if (Option.isSome(preparing)) yield* Fiber.join(preparing.value);
    const [settings, installed, previous] = yield* Effect.all([
      desktopSettings.get,
      readInstalled,
      Ref.get(adoptedRef),
    ]);
    // The server may have restarted or switched versions since it was adopted.
    const live = Option.isSome(previous) ? yield* probeLive : Option.none<AdoptedServer>();
    if (Option.isSome(live)) {
      yield* Ref.set(adoptedRef, live);
      yield* syncLauncher(live.value);
    }
    const server = Option.orElse(live, () => previous);
    const serverVersion = Option.match(server, {
      onNone: () => null,
      onSome: (current) => current.serverVersion,
    });
    const update = yield* Ref.updateAndGet(updateRef, (current): DesktopBackgroundServiceUpdate =>
      current.status !== "none" &&
      serverVersion !== null &&
      compareSemverVersions(serverVersion, current.targetVersion) >= 0
        ? { status: "none" }
        : current,
    );
    return {
      supported: installable,
      installed,
      adopted: Option.isSome(previous),
      disabled: settings.backgroundServiceDisabled,
      serverVersion,
      startedAt: Option.match(server, {
        onNone: () => null,
        onSome: (current) => current.startedAt ?? null,
      }),
      update,
      error: yield* Ref.get(errorRef),
      lingerCommand: installed ? yield* readLingerCommand : null,
    };
  }).pipe(Effect.withSpan("desktop.backgroundService.state"));

  const setEnabled: DesktopBackgroundService["Service"]["setEnabled"] = Effect.fn(
    "desktop.backgroundService.setEnabled",
  )(function* (enabled) {
    // Removed first: a failed removal must not leave the opt-out recorded for
    // a service that still runs.
    if (!enabled && (yield* readInstalled)) yield* uninstall;
    yield* desktopSettings.setBackgroundServiceDisabled(!enabled);
  });

  return DesktopBackgroundService.of({
    installable,
    decide,
    adopt,
    adopted: Ref.get(adoptedRef),
    getBearerToken,
    state,
    takeInstallNotice: Ref.getAndSet(noticeRef, false),
    restart,
    logPath,
    setEnabled,
  });
});

export const layer = Layer.effect(DesktopBackgroundService, make);

/** A service that never adopts or installs anything, for tests that do not exercise it. */
export const layerTest = (
  overrides: Partial<DesktopBackgroundService["Service"]> = {},
): Layer.Layer<DesktopBackgroundService> =>
  Layer.succeed(
    DesktopBackgroundService,
    DesktopBackgroundService.of({
      installable: false,
      decide: Effect.succeed({ _tag: "Embed" }),
      adopt: () => Effect.succeed("embed"),
      adopted: Effect.succeedNone,
      getBearerToken: Effect.fail(new DesktopBackgroundServiceNotAdoptedError()),
      state: Effect.die("DesktopBackgroundService.layerTest has no state"),
      takeInstallNotice: Effect.succeed(false),
      restart: Effect.die("DesktopBackgroundService.layerTest does not restart"),
      logPath: "/dev/null",
      setEnabled: () =>
        Effect.die("DesktopBackgroundService.layerTest does not change the service"),
      ...overrides,
    }),
  );
