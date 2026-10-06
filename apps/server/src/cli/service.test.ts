import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { formatServiceStatus, reconcileService, serviceCommand } from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "T3 Code service",
      "  Status: installed · t3@0.0.29",
      "  Unit: /home/me/.config/systemd/user/t3code.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `t3 service install` to repair it.",
  );
});

it("explains an incomplete nightly installation and keeps repair on its installed version", () => {
  const output = formatServiceStatus(
    {
      ...status,
      current: false,
      installedVersion: "0.0.32-nightly.1",
      problems: ["linger-disabled", "service-stopped"],
    },
    "0.0.32-nightly.1",
  );

  expect(output).toContain("[linger-disabled]");
  expect(output).toContain("stops when your last login session ends");
  expect(output).toContain('sudo loginctl enable-linger "$(id -un)"');
  expect(output).toContain("[service-stopped]");
  expect(output).toContain("Run `t3 service install` to repair it.");
  expect(output).not.toContain("npx");
});

it("points an older service at a repair, never at npx", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.28" },
    "0.0.29",
  );
  expect(output).toContain("Run `t3 service install` to repair it.");
  expect(output).not.toContain("npx");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd",
  );
});

it("reports a newer installed service and tells the CLI to catch up to it", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );

  assert.include(output, "t3@0.0.32-nightly.1 (newer than this t3@0.0.31 CLI)");
  assert.include(output, "Run `t3 update 0.0.32-nightly.1` to match it");
  assert.notInclude(output, "npx");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(serviceStatus: BootService.BootServiceStatus) {
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
    restart: Effect.sync(() => {
      restarts.push(true);
      return serviceStatus.installed;
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
  it.effect("restart restarts the installed service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, installOptions, restarts } = makeTestService(status);
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        "restart",
        "--base-dir",
        baseDir,
      ]).pipe(
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      expect(restarts).toEqual([true]);
      expect(installOptions).toEqual([]);
    }),
  );

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
        Effect.provideService(HostProcessEnvironment, {}),
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
        Effect.provideService(HostProcessEnvironment, {}),
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
          Effect.provideService(HostProcessEnvironment, {}),
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
          Effect.provideService(HostProcessEnvironment, {}),
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

  it.effect.each(["install", "update"] as const)("%s allows an explicit downgrade", (command) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, installOptions } = makeTestService(newerServiceStatus);
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        command,
        "--base-dir",
        baseDir,
        "--allow-downgrade",
      ]).pipe(
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      expect(installOptions).toEqual([{ allowDowngrade: true }]);
    }),
  );
});

it.effect.each([
  { name: "a new service", state: { ...status, installed: false, current: false } },
  { name: "an older service", state: { ...status, current: false, installedVersion: "0.0.0" } },
  {
    name: "the same version",
    state: { ...status, current: false, installedVersion: packageJson.version },
  },
  {
    name: "an incomplete install of the same version",
    state: {
      ...status,
      current: false,
      installedVersion: packageJson.version,
      problems: ["service-stopped"] as const,
    },
  },
  { name: "an unknown version", state: { ...status, current: false } },
])("installs or repairs $name without an override", ({ state }) =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(state);

    const result = yield* reconcileService().pipe(
      Effect.provideService(BootService.BootService, service),
    );

    expect(result.changed).toBe(true);
    expect(installOptions).toEqual([undefined]);
  }),
);
