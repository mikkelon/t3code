// The desktop side of the background service (`t3 service`). When a T3 server
// already owns this app's T3 home, or the service is installed for it, the
// app adopts that server as its local environment instead of embedding a
// second backend on the same database. The app never stops, restarts or
// cleans up an adopted server; closing the app leaves it and its agents
// running. It also installs and removes the service on the user's request,
// always through the bundled `t3` CLI so the unit, runtime and linger handling
// stay the server's.

import { fetchRemoteSessionState } from "@t3tools/client-runtime/authorization";
import { cliArchivePlatformKey } from "@t3tools/shared/cliRelease";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeOS from "node:os";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopLocalServerDiscovery from "./DesktopLocalServerDiscovery.ts";

export type LocalServerDecision = DesktopLocalServerDiscovery.LocalServerDecision;

const SERVICE_READY_TIMEOUT = Duration.minutes(1);
const SERVICE_READY_POLL = Duration.millis(500);
const ADOPTED_SERVER_POLL = Duration.seconds(5);
const CLI_TIMEOUT = Duration.minutes(2);
// Installing downloads the release archive for this version on first use.
const CLI_INSTALL_TIMEOUT = Duration.minutes(10);
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
}

export type AdoptOutcome = "adopted" | "embed" | "quit";

export type InstallResult =
  | { readonly _tag: "Installed" }
  // Linux only: lingering needs an administrator. The command is shown to the
  // user, who runs it and retries.
  | { readonly _tag: "NeedsLinger"; readonly command: string };

/** Reported by the renderer for the primary environment. */
export interface AgentActivity {
  readonly running: number;
  /** The server resumes interrupted turns after a restart. */
  readonly continuesAfterRestart: boolean;
}

export class DesktopBackgroundService extends Context.Service<
  DesktopBackgroundService,
  {
    /**
     * The app may install or remove the service: Linux or macOS with a
     * release runtime, in a packaged build. A development build must never
     * touch the user's one service unit.
     */
    readonly installable: boolean;
    /** How the primary environment should run this launch. */
    readonly decide: Effect.Effect<DesktopLocalServerDiscovery.LocalServerDecision>;
    /**
     * Brings up and adopts the server a non-Embed decision names: starts the
     * installed service when needed, waits for it, and obtains a credential.
     * Failures ask the user to retry or quit, never to embed a second backend.
     * Resolves "embed" only when a retry finds nothing owning the home anymore.
     */
    readonly adopt: (
      decision: DesktopLocalServerDiscovery.LocalServerDecision,
    ) => Effect.Effect<AdoptOutcome>;
    /** Some while the primary environment is an adopted server. */
    readonly adopted: Effect.Effect<Option.Option<AdoptedServer>>;
    readonly getBearerToken: Effect.Effect<string, DesktopBackgroundServiceError>;
    /** Whether the service is installed for this app's T3 home right now. */
    readonly installed: Effect.Effect<boolean>;
    /** Prepares the service without starting it; the embedded backend keeps running. */
    readonly install: Effect.Effect<InstallResult, DesktopBackgroundServiceCliError>;
    /** Starts the installed service; a running one is left alone. */
    readonly start: Effect.Effect<void, DesktopBackgroundServiceCliError>;
    /** Stops and removes the service. Projects and threads stay in the T3 home. */
    readonly uninstall: Effect.Effect<void, DesktopBackgroundServiceCliError>;
    readonly reportAgentActivity: (activity: AgentActivity) => Effect.Effect<void>;
    /**
     * Asked before a user-initiated quit. While agents run on the embedded
     * backend and no service is installed, offers to install it so they keep
     * running. Resolves false when the user cancels the quit.
     */
    readonly confirmQuit: Effect.Effect<boolean>;
    /**
     * Run after the embedded backend has stopped during shutdown: starts the
     * service when the quit prompt installed it. Never two servers at once.
     */
    readonly startAfterShutdown: Effect.Effect<void>;
  }
>()("@t3tools/desktop/backend/DesktopBackgroundService") {}

function lastMeaningfulLine(output: string): string | undefined {
  return output
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.length > 0);
}

const SessionFile = Schema.Struct({ environmentId: Schema.String, token: Schema.String });
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
export function extractJsonObject(output: string): string | undefined {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  return start === -1 || end < start ? undefined : output.slice(start, end + 1);
}

/** The exact `loginctl` command for a CLI failure that needs lingering. */
export function lingerCommandFor(output: string, username: string): string | undefined {
  return output.includes("[linger-disabled]")
    ? `sudo loginctl enable-linger ${username}`
    : undefined;
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const path = environment.path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
  >();

  // The CLI addresses a home's `userdata` directory. A development app that
  // keeps its state under `dev` shares no database with a service.
  const adoptable = environment.stateDir === path.join(environment.baseDir, "userdata");
  const installable =
    adoptable &&
    !environment.isDevelopment &&
    (environment.platform === "linux" || environment.platform === "darwin") &&
    cliArchivePlatformKey(environment.platform, environment.processArch) !== undefined;

  const adoptedRef = yield* Ref.make(Option.none<AdoptedServer>());
  const tokenRef = yield* Ref.make(Option.none<string>());
  const tokenLock = yield* Semaphore.make(1);

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

  const install = Effect.suspend(() =>
    installable ? Effect.void : Effect.fail(notInstallable("service install")),
  ).pipe(
    Effect.andThen(
      runCli({
        executable: "bundled",
        args: ["service", "install", ...baseDirArgs, "--no-start"],
        timeout: CLI_INSTALL_TIMEOUT,
      }),
    ),
    Effect.as<InstallResult>({ _tag: "Installed" }),
    Effect.catchTag("DesktopBackgroundServiceCliError", (error) => {
      const command = lingerCommandFor(error.output, NodeOS.userInfo().username);
      return command === undefined
        ? Effect.fail(error)
        : Effect.succeed<InstallResult>({ _tag: "NeedsLinger", command });
    }),
    Effect.withSpan("desktop.backgroundService.install"),
  );

  const uninstall = Effect.suspend(() =>
    installable ? Effect.void : Effect.fail(notInstallable("service uninstall")),
  ).pipe(
    Effect.andThen(
      runCli({ executable: "bundled", args: ["service", "uninstall", ...baseDirArgs] }),
    ),
    Effect.asVoid,
    Effect.withSpan("desktop.backgroundService.uninstall"),
  );

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
          Option.filter((session) => session.environmentId === server.environmentId),
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
        `${encodeSessionFile({ environmentId: server.environmentId, token: issued.value.token })}\n`,
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
        if (Option.isSome(cached)) return cached.value;
        const persisted = yield* readPersistedToken(server);
        const token =
          Option.isSome(persisted) && (yield* tokenStillValid(server, persisted.value))
            ? persisted.value
            : yield* issueToken(server);
        yield* Ref.set(tokenRef, Option.some(token));
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
    const [serviceInstalled, live] = yield* Effect.all([readInstalled, probeLive], {
      concurrency: "unbounded",
    });
    return DesktopLocalServerDiscovery.decideLocalServer({ serviceInstalled, live });
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
      : `${error.message}\n\nRun \`t3 service status\` in a terminal to see what's wrong.`;

  const adopt: DesktopBackgroundService["Service"]["adopt"] = Effect.fn(
    "desktop.backgroundService.adopt",
  )(function* (initial) {
    let decision = initial;
    while (decision._tag !== "Embed") {
      const result = yield* Effect.result(attempt(decision));
      if (result._tag === "Success") {
        yield* Ref.set(adoptedRef, Option.some(result.success));
        yield* logInfo("adopted local server", {
          httpBaseUrl: result.success.httpBaseUrl.href,
          serviceManaged: result.success.serviceManaged,
        });
        yield* Effect.forkIn(followServer, layerScope);
        return "adopted";
      }
      yield* logWarning("could not adopt local server", { error: result.failure.message });
      const choice = yield* dialog
        .showMessageBox({
          type: "error",
          title: "T3 Code",
          message:
            decision._tag === "StartService"
              ? "T3 Code couldn't start its background service"
              : "T3 Code couldn't connect to the T3 server on this computer",
          detail: failureDetail(decision, result.failure),
          buttons: ["Retry", "Quit"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
        .pipe(
          Effect.map((value) => value.response),
          Effect.orElseSucceed(() => 1),
        );
      if (choice !== 0) return "quit";
      decision = yield* decide;
    }
    return "embed";
  });

  const activityRef = yield* Ref.make<AgentActivity>({ running: 0, continuesAfterRestart: false });
  const startAfterShutdownRef = yield* Ref.make(false);

  const askToInstallUntilDone: Effect.Effect<boolean> = Effect.gen(function* () {
    while (true) {
      const result = yield* Effect.result(install);
      const outcome = result._tag === "Success" ? result.success : undefined;
      if (outcome?._tag === "Installed") return true;
      const retry =
        outcome?._tag === "NeedsLinger"
          ? yield* dialog.showMessageBox({
              type: "info",
              title: "T3 Code",
              message: "Allow T3 Code to keep running after you log out",
              detail: `This needs administrator rights once. Run this in a terminal, then choose Done:\n\n${outcome.command}`,
              buttons: ["Done, retry", "Cancel"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            })
          : yield* dialog.showMessageBox({
              type: "error",
              title: "T3 Code",
              message: "T3 Code couldn't install its background service",
              detail: `${result._tag === "Failure" ? result.failure.message : "Installation failed."}\n\nRun \`t3 service status\` in a terminal to see what's wrong.`,
              buttons: ["Retry", "Cancel"],
              defaultId: 0,
              cancelId: 1,
              noLink: true,
            });
      if (retry.response !== 0) return false;
    }
  }).pipe(Effect.orElseSucceed(() => false));

  const promptOpenRef = yield* Ref.make(false);

  const promptToKeepAgentsRunning = Effect.gen(function* () {
    const activity = yield* Ref.get(activityRef);
    if (!installable || activity.running === 0) return true;
    if (Option.isSome(yield* Ref.get(adoptedRef)) || (yield* readInstalled)) return true;
    const agents = activity.running === 1 ? "1 agent is" : `${activity.running} agents are`;
    const choice = yield* dialog.showMessageBox({
      type: "question",
      title: "T3 Code",
      message: "Agents stop when T3 Code closes. Keep them running in the background?",
      detail: `${agents} running. T3 Code can install its background service and hand this computer's agents over to it, so they keep working after the app closes. ${
        activity.continuesAfterRestart
          ? "Running turns restart in the service and continue where they left off."
          : "Running turns are interrupted by the switch. Turn on continuing threads after server updates to have them resume."
      }`,
      buttons: ["Install", "Quit anyway", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 1) return true;
    if (choice.response !== 0) return false;
    const installed = yield* askToInstallUntilDone;
    if (installed) yield* Ref.set(startAfterShutdownRef, true);
    return installed;
  }).pipe(Effect.orElseSucceed(() => true));

  // A second quit while the prompt is open is the same request, not a new one.
  const confirmQuit = Ref.getAndSet(promptOpenRef, true).pipe(
    Effect.flatMap((alreadyOpen) =>
      alreadyOpen
        ? Effect.succeed(false)
        : promptToKeepAgentsRunning.pipe(Effect.ensuring(Ref.set(promptOpenRef, false))),
    ),
    Effect.withSpan("desktop.backgroundService.confirmQuit"),
  );

  const startAfterShutdown = Effect.gen(function* () {
    if (!(yield* Ref.get(startAfterShutdownRef))) return;
    yield* logInfo("handing over to the background service");
    yield* start.pipe(
      Effect.catch((error) =>
        logWarning("could not start the background service after shutdown", {
          error: error.message,
        }),
      ),
    );
  });

  return DesktopBackgroundService.of({
    installable,
    decide,
    adopt,
    adopted: Ref.get(adoptedRef),
    getBearerToken,
    installed: readInstalled,
    install,
    start,
    uninstall,
    reportAgentActivity: (activity) => Ref.set(activityRef, activity),
    confirmQuit,
    startAfterShutdown,
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
      installed: Effect.succeed(false),
      install: Effect.die("DesktopBackgroundService.layerTest does not install"),
      start: Effect.die("DesktopBackgroundService.layerTest does not start"),
      uninstall: Effect.die("DesktopBackgroundService.layerTest does not uninstall"),
      reportAgentActivity: () => Effect.void,
      confirmQuit: Effect.succeed(true),
      startAfterShutdown: Effect.void,
      ...overrides,
    }),
  );
