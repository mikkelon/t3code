import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TailscaleServe from "./tailscaleServe.ts";

const encoder = new TextEncoder();
const LOCAL_PORT = 41_773;
const MAGIC_DNS = "box.tail1234.ts.net";

/**
 * A tailnet in memory: `tailscale serve` maps an HTTPS port to a local port,
 * and the MagicDNS URL answers as whichever environment that port belongs to.
 */
const makeTailnet = (options: { readonly occupied?: Record<number, string> } = {}) => {
  const mappings = new Map<number, number>();
  const commands: string[] = [];
  const environmentsByLocalPort = new Map([[LOCAL_PORT, "env-home"]]);

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      const args = (command as unknown as { readonly args: ReadonlyArray<string> }).args;
      commands.push(args.join(" "));
      if (args[0] === "serve") {
        const port = Number(/--https=(\d+)/.exec(args.join(" "))?.[1]);
        if (args.at(-1) === "off") mappings.delete(port);
        else mappings.set(port, Number(new URL(args.at(-1) ?? "").port));
      }
      const stdout = args[0] === "status" ? `{"Self":{"DNSName":"${MAGIC_DNS}."}}` : "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const port = url.port === "" ? 443 : Number(url.port);
      const occupant = options.occupied?.[port];
      const mapped = mappings.get(port);
      const environmentId =
        occupant ?? (mapped === undefined ? undefined : environmentsByLocalPort.get(mapped));
      return HttpClientResponse.fromWeb(
        request,
        environmentId === undefined
          ? new Response(null, { status: 502 })
          : Response.json({
              environmentId,
              label: "Box",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "1.2.3",
              capabilities: { repositoryIdentity: true },
            }),
      );
    }),
  );

  return { mappings, commands, spawner, http };
};

const makeLayer = (
  tailnet: ReturnType<typeof makeTailnet>,
  options: { readonly launchFlag?: boolean; readonly settings?: object } = {},
) =>
  TailscaleServe.layer.pipe(
    Layer.provideMerge(ServerSettings.layerTest(options.settings ?? {})),
    Layer.provide(
      Layer.unwrap(
        Effect.map(ServerConfig.ServerConfig, (config) =>
          Layer.succeed(ServerConfig.ServerConfig, {
            ...config,
            tailscaleServeEnabled: options.launchFlag === true,
            tailscaleServePort: 443,
          }),
        ),
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tailscale-" }))),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-home")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", LOCAL_PORT),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, tailnet.spawner),
        Layer.succeed(HttpClient.HttpClient, tailnet.http),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
    // Last, so the fakes above win over the real spawner and HTTP client.
    Layer.provide(NodeServices.layer),
  );

const serveCommands = (tailnet: ReturnType<typeof makeTailnet>) =>
  tailnet.commands.filter((command) => command.startsWith("serve"));

describe("TailscaleServe", () => {
  it.effect("publishes on the chosen port, remembers it, and reports the HTTPS URL", () => {
    const tailnet = makeTailnet();
    return Effect.gen(function* () {
      const tailscale = yield* TailscaleServe.TailscaleServe;
      const settings = yield* ServerSettings.ServerSettingsService;

      const state = yield* tailscale.set({ enabled: true, port: 8443 });

      assert.deepEqual(serveCommands(tailnet), [
        `serve --bg --https=8443 http://127.0.0.1:${LOCAL_PORT}`,
      ]);
      assert.deepEqual((yield* settings.getSettings).tailscaleServe, {
        enabled: true,
        port: 8443,
      });
      assert.equal(state.source, "settings");
      assert.equal(state.endpoint?.httpBaseUrl, `https://${MAGIC_DNS}:8443/`);
      assert.equal(state.endpoint?.status, "available");
      assert.isNull(state.problem);
    }).pipe(Effect.provide(makeLayer(tailnet)));
  });

  it.effect("maps a new port before removing the old one", () => {
    const tailnet = makeTailnet();
    return Effect.gen(function* () {
      const tailscale = yield* TailscaleServe.TailscaleServe;
      yield* tailscale.set({ enabled: true, port: 443 });
      yield* tailscale.set({ enabled: true, port: 10000 });

      assert.deepEqual(serveCommands(tailnet), [
        `serve --bg --https=443 http://127.0.0.1:${LOCAL_PORT}`,
        `serve --bg --https=10000 http://127.0.0.1:${LOCAL_PORT}`,
        "serve --https=443 off",
      ]);
      assert.deepEqual([...tailnet.mappings.keys()], [10000]);
    }).pipe(Effect.provide(makeLayer(tailnet)));
  });

  it.effect("turning it off removes this server's mapping and is remembered", () => {
    const tailnet = makeTailnet();
    return Effect.gen(function* () {
      const tailscale = yield* TailscaleServe.TailscaleServe;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* tailscale.set({ enabled: true, port: 443 });

      const state = yield* tailscale.set({ enabled: false, port: 443 });

      assert.equal(tailnet.mappings.size, 0);
      assert.isFalse((yield* settings.getSettings).tailscaleServe.enabled);
      assert.equal(state.endpoint?.status, "unavailable");
      assert.isNull(state.problem);
    }).pipe(Effect.provide(makeLayer(tailnet)));
  });

  it.effect("leaves a port that fronts another T3 server alone", () => {
    const tailnet = makeTailnet({ occupied: { 443: "env-other" } });
    return Effect.gen(function* () {
      const tailscale = yield* TailscaleServe.TailscaleServe;
      const settings = yield* ServerSettings.ServerSettingsService;

      const error = yield* tailscale.set({ enabled: true, port: 443 }).pipe(Effect.flip);

      assert.include(error.message, "already fronts a different T3 Code server");
      assert.deepEqual(serveCommands(tailnet), []);
      assert.isFalse((yield* settings.getSettings).tailscaleServe.enabled);
    }).pipe(Effect.provide(makeLayer(tailnet)));
  });

  it.effect("refuses changes on a server whose launch flags own Tailscale Serve", () => {
    const tailnet = makeTailnet();
    return Effect.gen(function* () {
      const tailscale = yield* TailscaleServe.TailscaleServe;
      assert.equal((yield* tailscale.state).source, "launch");

      const error = yield* tailscale.set({ enabled: false, port: 443 }).pipe(Effect.flip);

      assert.include(error.message, "started with Tailscale Serve enabled");
      assert.deepEqual(serveCommands(tailnet), []);
    }).pipe(Effect.provide(makeLayer(tailnet, { launchFlag: true })));
  });
});
