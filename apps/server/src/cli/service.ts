import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const layer = (config: ServerConfig.ServerConfig["Service"]) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
  }).pipe(
    Layer.provide(ProcessRunner.layer),
    // Archive-distributed versions download the release archive here.
    Layer.provide(FetchHttpClient.layer),
  );

export type ServiceReconcileResult =
  | {
      readonly changed: false;
      readonly status: BootService.BootServiceStatus;
    }
  | {
      readonly changed: true;
      readonly previouslyInstalled: boolean;
      readonly plan: BootService.BootServicePlan;
    };

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {
  readonly allowDowngrade?: boolean;
  readonly start?: boolean;
}) {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  if (
    status.installedVersion !== undefined &&
    options?.allowDowngrade !== true &&
    compareExactServiceVersions(packageJson.version, status.installedVersion) < 0
  ) {
    return yield* new BootService.BootServiceDowngradeRefusedError({
      installedVersion: status.installedVersion,
      targetVersion: packageJson.version,
    });
  }
  const plan = yield* service.install(options);
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable on this machine\n  Supported on: Linux with systemd, macOS with launchd";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  const installedVersion = status.installedVersion ?? cliVersion;
  const problems = (status.problems ?? []).map(
    (problem) => `  [${problem}] ${BootService.formatBootServiceProblem(problem)}`,
  );
  if (
    !status.current &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, cliVersion) > 0
  ) {
    return [
      "T3 Code service",
      `  Status: installed · t3@${installedVersion} (newer than this t3@${cliVersion} CLI)`,
      `  Unit: ${status.unitPath}`,
      `  Logs: ${status.logPath}`,
      ...problems,
      `  Next: Run \`t3 update ${installedVersion}\` to match it, or pass \`--allow-downgrade\` to \`t3 service install\` explicitly.`,
    ].join("\n");
  }
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...problems,
    ...(status.current ? [] : ["  Next: Run `t3 service install` to repair it."]),
  ].join("\n");
}

/** Problems that leave the service working, such as a missing linger. */
const logServiceWarnings = Effect.gen(function* () {
  const status = yield* (yield* BootService.BootService).status;
  for (const problem of (status.problems ?? []).filter(BootService.isBootServiceWarning)) {
    yield* Console.log(`Warning: [${problem}] ${BootService.formatBootServiceProblem(problem)}`);
  }
});

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: { readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"] },
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(Effect.provide(layer(config)));
});

const serviceReconcileFlags = {
  ...projectLocationFlags,
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow replacing a newer installed service with this older CLI version."),
    Flag.withDefault(false),
  ),
};

const serviceInstallCommand = Command.make("install", {
  ...serviceReconcileFlags,
  noStart: Flag.Boolean("no-start").pipe(
    Flag.withDescription(
      "Prepare the runtime and unit without starting the service; `t3 service start` starts it.",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Install T3 Code as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService({
          allowDowngrade: flags.allowDowngrade,
          ...(flags.noStart ? { start: false } : {}),
        });
        if (!result.changed) {
          yield* Console.log(
            `T3 Code service is already installed with t3@${packageJson.version}.`,
          );
        } else {
          yield* Console.log(
            `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
          );
        }
        yield* logServiceWarnings;
      }),
    ),
  ),
);

// Kept one release for muscle memory and old docs. It did what `t3 service
// install` does; the way to move to a newer release is `t3 update`.
const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
  Command.withDescription("Deprecated. Run `t3 update` to move to a newer release."),
  Command.unlisted,
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log(
          "`t3 service update` is deprecated: run `t3 update` to move to a newer release, or `t3 service install` to repair the service. Repairing now.",
        );
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(`T3 Code service is already using t3@${packageJson.version}.`);
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceRestartCommand = Command.make("restart", projectLocationFlags).pipe(
  Command.withDescription(
    "Restart the background service. Picks up a version installed by `t3 update` that was not restarted at the time.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const status = yield* service.status;
        const restarted = yield* service.restart;
        yield* Console.log(
          restarted
            ? `Restarted the T3 Code service${status.installedVersion === undefined ? "" : ` on t3@${status.installedVersion}`}.`
            : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStartCommand = Command.make("start", projectLocationFlags).pipe(
  Command.withDescription("Start the installed background service if it is not running."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const started = yield* service.start;
        yield* Console.log(
          started ? "Started the T3 Code service." : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", projectLocationFlags).pipe(
  Command.withDescription("Stop and remove the T3 Code background service."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const removed = yield* service.uninstall;
        yield* Console.log(
          removed ? "Removed the T3 Code service." : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStatusCommand = Command.make("status", projectLocationFlags).pipe(
  Command.withDescription("Show whether the T3 Code background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        yield* Console.log(formatServiceStatus(yield* service.status, packageJson.version));
      }),
    ),
  ),
);

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the T3 Code background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceRestartCommand,
    serviceStartCommand,
    serviceUninstallCommand,
    serviceStatusCommand,
    serviceUpdateCommand,
  ]),
);
