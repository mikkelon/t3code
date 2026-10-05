import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  decideLocalServer,
  probeLiveLocalServer,
  readServiceInstalled,
} from "./DesktopLocalServerDiscovery.ts";

const descriptorFor = (environmentId: string) => ({
  environmentId,
  label: "This machine",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.2.3",
  capabilities: { repositoryIdentity: true },
});

const httpLayer = (environmentId: string | null, requests: string[] = []) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request.url);
        return HttpClientResponse.fromWeb(
          request,
          environmentId === null
            ? new Response(null, { status: 502 })
            : Response.json(descriptorFor(environmentId)),
        );
      }),
    ),
  );

const makeStateDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-server-" });
  const writeRuntime = (state: object) =>
    fs.writeFileString(path.join(stateDir, "server-runtime.json"), JSON.stringify(state));
  yield* fs.writeFileString(path.join(stateDir, "environment-id"), "env-home\n");
  return { stateDir, writeRuntime };
});

const runtimeState = {
  version: 1,
  pid: 4242,
  port: 3773,
  origin: "http://127.0.0.1:3773",
  startedAt: "2026-10-05T00:00:00.000Z",
  serviceManaged: true,
};

describe("decideLocalServer", () => {
  const live = {
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    environmentId: "env-home",
    serverVersion: "1.2.3",
    serviceManaged: true,
    startedAt: undefined,
  };

  it("adopts a live owner whether or not the service is installed", () => {
    for (const serviceInstalled of [true, false]) {
      for (const autoInstall of [true, false]) {
        assert.deepEqual(
          decideLocalServer({ serviceInstalled, live: Option.some(live), autoInstall }),
          { _tag: "Adopt", server: live },
        );
      }
    }
  });

  it("starts an installed service that is stopped, even after an opt-out", () => {
    for (const autoInstall of [true, false]) {
      assert.deepEqual(
        decideLocalServer({ serviceInstalled: true, live: Option.none(), autoInstall }),
        { _tag: "StartService" },
      );
    }
  });

  it("installs the service when nothing owns the home and the app may", () => {
    assert.deepEqual(
      decideLocalServer({ serviceInstalled: false, live: Option.none(), autoInstall: true }),
      { _tag: "InstallService" },
    );
  });

  it("embeds only when nothing is installed or running and the app may not install", () => {
    assert.deepEqual(
      decideLocalServer({ serviceInstalled: false, live: Option.none(), autoInstall: false }),
      { _tag: "Embed" },
    );
  });
});

describe("probeLiveLocalServer", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("finds nothing without a runtime file", () =>
      Effect.gen(function* () {
        const { stateDir } = yield* makeStateDir;
        const requests: string[] = [];
        const live = yield* probeLiveLocalServer(stateDir, { isProcessAlive: () => true }).pipe(
          Effect.provide(httpLayer("env-home", requests)),
        );
        assert.isTrue(Option.isNone(live));
        assert.deepEqual(requests, []);
      }),
    );

    it.effect("ignores a runtime file whose pid is dead", () =>
      Effect.gen(function* () {
        const { stateDir, writeRuntime } = yield* makeStateDir;
        yield* writeRuntime(runtimeState);
        const requests: string[] = [];
        const live = yield* probeLiveLocalServer(stateDir, { isProcessAlive: () => false }).pipe(
          Effect.provide(httpLayer("env-home", requests)),
        );
        assert.isTrue(Option.isNone(live));
        assert.deepEqual(requests, []);
      }),
    );

    it.effect("rejects a live pid whose origin answers as another environment", () =>
      Effect.gen(function* () {
        const { stateDir, writeRuntime } = yield* makeStateDir;
        yield* writeRuntime(runtimeState);
        const live = yield* probeLiveLocalServer(stateDir, { isProcessAlive: () => true }).pipe(
          Effect.provide(httpLayer("env-other")),
        );
        assert.isTrue(Option.isNone(live));
      }),
    );

    it.effect("rejects a live pid whose origin does not answer", () =>
      Effect.gen(function* () {
        const { stateDir, writeRuntime } = yield* makeStateDir;
        yield* writeRuntime(runtimeState);
        const live = yield* probeLiveLocalServer(stateDir, { isProcessAlive: () => true }).pipe(
          Effect.provide(httpLayer(null)),
        );
        assert.isTrue(Option.isNone(live));
      }),
    );

    it.effect("accepts a live pid that answers as this home's environment", () =>
      Effect.gen(function* () {
        const { stateDir, writeRuntime } = yield* makeStateDir;
        yield* writeRuntime(runtimeState);
        const requests: string[] = [];
        const live = yield* probeLiveLocalServer(stateDir, { isProcessAlive: () => true }).pipe(
          Effect.provide(httpLayer("env-home", requests)),
        );
        assert.deepEqual(
          Option.map(live, (server) => ({ ...server, httpBaseUrl: server.httpBaseUrl.href })),
          Option.some({
            httpBaseUrl: "http://127.0.0.1:3773/",
            environmentId: "env-home",
            serverVersion: "1.2.3",
            serviceManaged: true,
            startedAt: "2026-10-05T00:00:00.000Z",
          }),
        );
        assert.deepEqual(requests, ["http://127.0.0.1:3773/.well-known/t3/environment"]);
      }),
    );
  });
});

describe("readServiceInstalled", () => {
  it.layer(NodeServices.layer)((it) => {
    const unitFor = (baseDir: string) =>
      [
        "[Service]",
        `Environment=T3CODE_HOME=${baseDir}`,
        "ExecStart=/x/t3 __service-launcher",
        "",
      ].join("\n");

    it.effect("recognizes a systemd unit that serves this home only", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-home-" });
        const baseDir = path.join(homeDir, ".t3");
        const check = (base: string) =>
          readServiceInstalled({ platform: "linux", homeDir, baseDir: base });

        assert.isFalse(yield* check(baseDir));

        const unitDir = path.join(homeDir, ".config", "systemd", "user");
        yield* fs.makeDirectory(unitDir, { recursive: true });
        yield* fs.writeFileString(path.join(unitDir, "t3code.service"), unitFor(baseDir));

        assert.isTrue(yield* check(baseDir));
        assert.isTrue(yield* check(`${baseDir}/`));
        assert.isFalse(yield* check(path.join(homeDir, "other-home")));
        assert.isFalse(yield* readServiceInstalled({ platform: "win32", homeDir, baseDir }));
      }),
    );
  });
});
