/**
 * Publishing a server over Tailscale Serve HTTPS. `t3 pair --tailscale` uses
 * the mapping logic for one-off pairing; the `TailscaleServe` service keeps a
 * running server published according to its settings, so a background service
 * keeps its tailnet URL across restarts and any administrative client can turn
 * it on or off.
 */
import {
  type AdvertisedEndpointProvider,
  ExecutionEnvironmentDescriptor,
  TailscaleServeError,
  type TailscaleServeInput,
  type TailscaleServeState,
} from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpServer from "effect/unstable/http/HttpServer";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerActivation from "./serverActivation.ts";
import * as ServerSettings from "./serverSettings.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "./startupAccess.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/t3/environment";
const PROBE_TIMEOUT = Duration.millis(2_500);
// Tailscale provisions an HTTPS certificate on the first request to a fresh
// serve mapping, which can take a few seconds.
const TAILSCALE_PROBE_ATTEMPTS = 5;
const TAILSCALE_PROBE_RETRY_DELAY = Duration.seconds(1);

// Each tailscale failure gets its own class (same reasoning as
// scripts/lib/dev-share.ts): distinct caller-visible message, distinct remedy.
export class TailscaleUnavailableError extends Schema.TaggedError<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedError<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedError<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different T3 Code server. Publish this one on another HTTPS port (\`--tailscale-serve-port\`, or the port in Settings → Connections).`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedError<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to see why.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedError<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not a T3 Code server. Publish this one on another HTTPS port (\`--tailscale-serve-port\`, or the port in Settings → Connections).`;
  }
}

export class DevServerNotProxiableError extends Schema.TaggedError<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override get message(): string {
    return `Tailscale Serve can only proxy plain-HTTP local targets, and this dev server runs at ${this.devUrl}. Pair without --tailscale instead.`;
  }
}

export const isDevServerNotProxiableError = Schema.is(DevServerNotProxiableError);

export interface TailscaleLocalTarget {
  readonly localPort: number;
  readonly localHost?: string;
}

/**
 * The local endpoint Tailscale Serve should proxy to. Dev servers are
 * single-origin, so the web dev server's port is the one to publish; the
 * backend rides along behind Vite's proxy. Serve targets are always plain
 * HTTP, so an HTTPS dev URL cannot be proxied and is rejected.
 */
export const resolveTailscaleLocalTarget = (server: {
  readonly devUrl?: string | undefined;
  readonly host?: string | undefined;
  readonly port: number;
}): TailscaleLocalTarget | DevServerNotProxiableError => {
  if (server.devUrl !== undefined) {
    const devUrl = new URL(server.devUrl);
    if (devUrl.protocol !== "http:") {
      return new DevServerNotProxiableError({ devUrl: server.devUrl });
    }
    const localPort = devUrl.port.length > 0 ? Number.parseInt(devUrl.port, 10) : 80;
    return isLoopbackHost(devUrl.hostname)
      ? { localPort }
      : { localPort, localHost: devUrl.hostname };
  }
  // A server bound to one specific interface does not answer on loopback, so
  // the proxy has to target that interface directly.
  if (server.host !== undefined && !isWildcardHost(server.host) && !isLoopbackHost(server.host)) {
    return { localPort: server.port, localHost: formatHostForUrl(server.host) };
  }
  return { localPort: server.port };
};

/**
 * Three outcomes, because they drive different decisions: a T3 descriptor
 * (pair with it), nothing answering (safe to configure Tailscale Serve), or
 * something answering that is not a T3 server (do NOT overwrite its mapping).
 */
export type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-t3-server" };

export const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Bad-gateway family means a proxy (Tailscale Serve) answered for a
    // backend that is gone — a stale mapping, not a live occupant. Treating
    // it as unreachable lets a mapping repair itself after the server's port
    // changed.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-t3-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

const awaitEnvironmentDescriptor = Effect.fn(function* (baseUrl: string) {
  let last: EnvironmentProbeResult = { _tag: "unreachable" };
  for (let attempt = 0; attempt < TAILSCALE_PROBE_ATTEMPTS; attempt += 1) {
    last = yield* probeEnvironmentDescriptor(baseUrl);
    if (last._tag === "descriptor") {
      return last;
    }
    yield* Effect.sleep(TAILSCALE_PROBE_RETRY_DELAY);
  }
  return last;
});

/**
 * Maps `servePort` on this machine's MagicDNS name to the environment's local
 * target. Only an unreachable port, or a mapping already fronting this exact
 * environment, is (re)configured; any other responder keeps its mapping.
 */
export const publishOverTailscale = <E>(input: {
  readonly environmentId: string;
  readonly servePort: number;
  /**
   * Keep a mapping that already reaches this environment. A dev server's may
   * front the backend, whose descriptor also answers, while pairing needs the
   * web port, so dev servers repoint it.
   */
  readonly reuseMatchingMapping: boolean;
  readonly localTarget: Effect.Effect<TailscaleLocalTarget, E>;
}) =>
  Effect.gen(function* () {
    const notes: Array<string> = [];
    const status = yield* readTailscaleStatus.pipe(
      Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
    );
    if (status.magicDnsName === null) {
      return yield* new MagicDnsNameMissingError();
    }
    const baseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: status.magicDnsName,
      servePort: input.servePort,
    });

    const existing = yield* probeEnvironmentDescriptor(baseUrl);
    if (existing._tag === "descriptor") {
      if (existing.descriptor.environmentId !== input.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
      if (input.reuseMatchingMapping) {
        return { baseUrl, notes, reachable: true };
      }
    }
    if (existing._tag === "not-a-t3-server") {
      return yield* new ServePortOccupiedError({ servePort: input.servePort });
    }

    const localTarget = yield* input.localTarget;
    yield* ensureTailscaleServe({
      localPort: localTarget.localPort,
      servePort: input.servePort,
      ...(localTarget.localHost !== undefined ? { localHost: localTarget.localHost } : {}),
    }).pipe(
      Effect.mapError(
        (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),
      ),
    );
    notes.push(
      `Tailscale Serve now maps ${baseUrl} to this server and persists across restarts. Remove it with \`tailscale serve --https=${String(input.servePort)} off\`.`,
    );

    const probed = yield* awaitEnvironmentDescriptor(baseUrl);
    if (probed._tag === "descriptor") {
      if (probed.descriptor.environmentId !== input.environmentId) {
        return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
      }
      return { baseUrl, notes, reachable: true };
    }
    notes.push(
      "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
    );
    return { baseUrl, notes, reachable: false };
  }).pipe(Effect.withSpan("tailscaleServe.publish"));

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

const STARTUP_RETRY_WINDOW = Duration.minutes(10);

export class TailscaleServe extends Context.Service<
  TailscaleServe,
  {
    readonly state: Effect.Effect<TailscaleServeState>;
    readonly set: (
      input: TailscaleServeInput,
    ) => Effect.Effect<TailscaleServeState, TailscaleServeError>;
  }
>()("t3/tailscaleServe") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const httpServer = yield* HttpServer.HttpServer;
  const context = yield* Effect.context<
    HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
  >();
  const lock = yield* Semaphore.make(1);
  const lastProblemRef = yield* Ref.make(Option.none<string>());

  const address = httpServer.address;
  const localPort = typeof address !== "string" && "port" in address ? address.port : config.port;
  const localTarget = Effect.suspend(() => {
    const target = resolveTailscaleLocalTarget({
      devUrl: config.devUrl?.toString(),
      host: config.host,
      port: localPort,
    });
    return isDevServerNotProxiableError(target) ? Effect.fail(target) : Effect.succeed(target);
  });

  const desired = Effect.map(settings.getSettings, (current) =>
    config.tailscaleServeEnabled
      ? { enabled: true, port: config.tailscaleServePort, source: "launch" as const }
      : { ...current.tailscaleServe, source: "settings" as const },
  ).pipe(Effect.orElseSucceed(() => ({ enabled: false, port: 443, source: "settings" as const })));

  const publish = (servePort: number) =>
    Effect.gen(function* () {
      const environmentId = yield* serverEnvironment.getEnvironmentId;
      const result = yield* publishOverTailscale({
        environmentId,
        servePort,
        reuseMatchingMapping: config.devUrl === undefined,
        localTarget,
      });
      yield* Ref.set(
        lastProblemRef,
        result.reachable ? Option.none() : Option.some(result.notes.at(-1) ?? ""),
      );
      return result;
    }).pipe(
      Effect.tapError((error) => Ref.set(lastProblemRef, Option.some(error.message))),
      Effect.provide(context),
    );

  const state: TailscaleServe["Service"]["state"] = Effect.gen(function* () {
    const wanted = yield* desired;
    const status = yield* readTailscaleStatus.pipe(Effect.option);
    const magicDnsName = Option.flatMapNullishOr(status, (value) => value.magicDnsName);
    if (Option.isNone(magicDnsName)) {
      return {
        ...wanted,
        endpoint: null,
        problem: wanted.enabled ? new MagicDnsNameMissingError().message : null,
      };
    }
    const httpBaseUrl = buildTailscaleHttpsBaseUrl({
      magicDnsName: magicDnsName.value,
      servePort: wanted.port,
    });
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const probed = wanted.enabled
      ? yield* probeEnvironmentDescriptor(httpBaseUrl)
      : ({ _tag: "unreachable" } as const);
    const reachable =
      probed._tag === "descriptor" && probed.descriptor.environmentId === environmentId;
    const lastProblem = yield* Ref.get(lastProblemRef);
    return {
      ...wanted,
      endpoint: createAdvertisedEndpoint({
        provider: TAILSCALE_ENDPOINT_PROVIDER,
        source: "server",
        id: `tailscale-magicdns:${httpBaseUrl}`,
        label: "Tailscale HTTPS",
        httpBaseUrl,
        reachability: "private-network",
        hostedHttpsCompatibility: reachable ? "compatible" : "requires-configuration",
        status: reachable ? "available" : "unavailable",
        description: reachable
          ? "HTTPS endpoint served by Tailscale Serve."
          : "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
      }),
      problem:
        !wanted.enabled || reachable
          ? null
          : Option.getOrElse(lastProblem, () => "The HTTPS endpoint is not answering yet."),
    };
  }).pipe(Effect.provide(context), Effect.withSpan("tailscaleServe.state"));

  const fail = (error: { readonly message: string }) =>
    new TailscaleServeError({ detail: error.message });

  const set: TailscaleServe["Service"]["set"] = (input) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (config.tailscaleServeEnabled) {
            return yield* new TailscaleServeError({
              detail:
                "This server was started with Tailscale Serve enabled; change it where the server is launched.",
            });
          }
          const current = (yield* settings.getSettings.pipe(Effect.mapError(fail))).tailscaleServe;
          if (input.enabled) {
            yield* publish(input.port).pipe(Effect.mapError(fail));
            // Only after the new mapping works, and only the mapping this
            // setting created.
            if (current.enabled && current.port !== input.port) {
              yield* disableTailscaleServe({ servePort: current.port }).pipe(
                Effect.provide(context),
                Effect.ignore,
              );
            }
          } else if (current.enabled) {
            yield* disableTailscaleServe({ servePort: current.port }).pipe(
              Effect.provide(context),
              Effect.mapError(fail),
            );
            yield* Ref.set(lastProblemRef, Option.none());
          }
          yield* settings
            .updateSettings({ tailscaleServe: { enabled: input.enabled, port: input.port } })
            .pipe(Effect.mapError(fail));
          return yield* state;
        }),
      )
      .pipe(Effect.withSpan("tailscaleServe.set"));

  // The mapping outlives the process, but this server's port may not. Repair
  // it once the server is live; tailscaled may still be starting at boot.
  if (!config.tailscaleServeEnabled) {
    yield* ServerActivation.forkParked(
      Effect.gen(function* () {
        const wanted = yield* desired;
        if (!wanted.enabled) return;
        yield* publish(wanted.port).pipe(
          Effect.retry(
            Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
              Schedule.upTo({ duration: STARTUP_RETRY_WINDOW }),
            ),
          ),
          Effect.tap((result) =>
            Effect.logInfo("Tailscale Serve published", { baseUrl: result.baseUrl }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Failed to publish over Tailscale Serve", {
              cause: error.message,
              servePort: wanted.port,
            }),
          ),
        );
      }),
    );
  }

  return TailscaleServe.of({ state, set });
});

export const layer = Layer.effect(TailscaleServe, make);
