import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { serviceCommand } from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(
  serviceStatus: BootService.BootServiceStatus,
  restartOutcome: "restarted" | "queued" = "restarted",
) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const restarts: Array<true> = [];
  const starts: Array<true> = [];
  const stages: Array<Parameters<BootService.BootService["Service"]["stage"]>[0]> = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    stage: (options) =>
      Effect.sync(() => {
        stages.push(options);
        return {
          versionDir: "/test/t3/runtime/versions/1.0.0",
          entryPath: "/test/t3/runtime/versions/1.0.0/t3",
          sentinelPath: "/test/t3/runtime/versions/1.0.0/.install-complete",
        };
      }),
    withStopped: (operation) => operation,
    restart: Effect.sync(() => {
      restarts.push(true);
      return serviceStatus.installed ? restartOutcome : "skipped";
    }),
    start: Effect.sync(() => {
      starts.push(true);
      return serviceStatus.installed;
    }),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          program: ["/test/t3/runtime/versions/1.0.0/t3", "__service-launcher"],
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions, restarts, starts, stages };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect("start starts the installed service without restarting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, restarts, starts } = makeTestService(status);
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "start",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      expect(starts).toEqual([true]);
      expect(restarts).toEqual([]);
    }),
  );

  it.effect("install --no-start prepares the service without starting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, installOptions } = makeTestService({
        ...status,
        installed: false,
        current: false,
      });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "install",
        "--base-dir",
        baseDir,
        "--no-start",
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      expect(installOptions).toEqual([{ allowDowngrade: false, start: false }]);
    }),
  );

  it.effect("install and stage take the runtime from a local archive", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, installOptions, stages } = makeTestService({
        ...status,
        installed: false,
        current: false,
      });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );
      const run = (args: ReadonlyArray<string>) =>
        Command.runWith(serviceCommand, { version: packageJson.version })(args).pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );

      yield* run(["install", "--base-dir", baseDir, "--runtime-archive", "/app/t3-runtime.tar.gz"]);
      yield* run(["stage", "--base-dir", baseDir, "--runtime-archive", "/app/t3-runtime.tar.gz"]);

      expect(installOptions).toEqual([
        { allowDowngrade: false, runtimeArchive: "/app/t3-runtime.tar.gz" },
      ]);
      expect(stages).toEqual([{ runtimeArchive: "/app/t3-runtime.tar.gz" }]);
    }),
  );

  it.effect.each(["install", "update"] as const)(
    "%s refuses a downgrade before changing the service",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(newerServiceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        });
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect.each([
    { label: "a new service", installed: false, env: "", expected: "T3CODE_LAN=false\n" },
    // Services installed before T3CODE_LAN existed keep listening on the local network.
    { label: "an older service", installed: true, env: "", expected: "" },
    {
      label: "a set host",
      installed: false,
      env: "T3CODE_HOST=::\n",
      expected: "T3CODE_HOST=::\n",
    },
  ])("install keeps $label off the local network only when it is new", (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      yield* fs.writeFileString(`${baseDir}/service.env`, input.env);
      const { service } = makeTestService({
        ...status,
        installed: input.installed,
        current: false,
      });
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "install",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(yield* fs.readFileString(`${baseDir}/service.env`)).toBe(input.expected);
    }),
  );

  it.effect("protect refuses root before creating any T3 directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const baseDir = `${parent}/t3`;
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, makeTestService(status).service),
      );

      const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "protect",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => lines.join("\n")),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.UserId, 0),
        Effect.provide(
          Layer.mergeAll(
            ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
            Layer.fresh(TestConsole.layer),
          ),
        ),
      );
      expect(output).toContain("without sudo");
      expect(yield* fs.exists(baseDir)).toBe(false);
    }),
  );

  // regression: #13239 a stale nvm-installed CLI reported "already using" its own version
  it.effect.each(["install", "update"] as const)(
    "%s names the CLI that found nothing to change",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(status);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );
        const node = "/home/me/.nvm/versions/node/v26.8.2/bin/node";
        const script = "/home/me/.nvm/versions/node/v26.8.2/lib/node_modules/t3/dist/bin.mjs";

        const output = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.andThen(TestConsole.logLines),
          Effect.map((lines) => lines.join("\n")),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.ExecutablePath, node),
          Effect.provideService(HostProcess.Arguments, [node, script, "service", command]),
          Effect.provide(
            Layer.mergeAll(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
              Layer.fresh(TestConsole.layer),
            ),
          ),
        );
        expect(output).toContain(`t3@${packageJson.version}`);
        expect(output).toContain(script);
        expect(installOptions).toEqual([]);
      }),
  );
});
