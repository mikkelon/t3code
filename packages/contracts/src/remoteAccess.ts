import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AdvertisedEndpointProviderKind = Schema.Literals([
  "core",
  "private-network",
  "tunnel",
  "manual",
]);
export type AdvertisedEndpointProviderKind = typeof AdvertisedEndpointProviderKind.Type;

export const AdvertisedEndpointReachability = Schema.Literals([
  "loopback",
  "lan",
  "private-network",
  "public",
]);
export type AdvertisedEndpointReachability = typeof AdvertisedEndpointReachability.Type;

export const AdvertisedEndpointHostedHttpsCompatibility = Schema.Literals([
  "compatible",
  "mixed-content-blocked",
  "requires-configuration",
  "unknown",
]);
export type AdvertisedEndpointHostedHttpsCompatibility =
  typeof AdvertisedEndpointHostedHttpsCompatibility.Type;

export const AdvertisedEndpointStatus = Schema.Literals(["available", "unavailable", "unknown"]);
export type AdvertisedEndpointStatus = typeof AdvertisedEndpointStatus.Type;

export const AdvertisedEndpointSource = Schema.Literals([
  "desktop-core",
  "desktop-addon",
  "server",
  "user",
]);
export type AdvertisedEndpointSource = typeof AdvertisedEndpointSource.Type;

export const AdvertisedEndpointProvider = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  kind: AdvertisedEndpointProviderKind,
  isAddon: Schema.Boolean,
});
export type AdvertisedEndpointProvider = typeof AdvertisedEndpointProvider.Type;

export const AdvertisedEndpointCompatibility = Schema.Struct({
  hostedHttpsApp: AdvertisedEndpointHostedHttpsCompatibility,
  desktopApp: Schema.Literals(["compatible", "unknown"]),
});
export type AdvertisedEndpointCompatibility = typeof AdvertisedEndpointCompatibility.Type;

export const AdvertisedEndpoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  provider: AdvertisedEndpointProvider,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  reachability: AdvertisedEndpointReachability,
  compatibility: AdvertisedEndpointCompatibility,
  source: AdvertisedEndpointSource,
  status: AdvertisedEndpointStatus,
  isDefault: Schema.optional(Schema.Boolean),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type AdvertisedEndpoint = typeof AdvertisedEndpoint.Type;

/** HTTPS ports Tailscale Serve offers for a tailnet endpoint. */
export const TAILSCALE_SERVE_HTTPS_PORTS = [443, 8443, 10000] as const;
export const TailscaleServeHttpsPort = Schema.Literals(TAILSCALE_SERVE_HTTPS_PORTS);
export type TailscaleServeHttpsPort = typeof TailscaleServeHttpsPort.Type;

export const TailscaleServeInput = Schema.Struct({
  enabled: Schema.Boolean,
  port: TailscaleServeHttpsPort,
});
export type TailscaleServeInput = typeof TailscaleServeInput.Type;

export const TailscaleServeState = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.Int,
  /**
   * `settings`: stored in this server's settings and changed with
   * `server.setTailscaleServe`. `launch`: fixed by how the server was started
   * (`--tailscale-serve`, or a desktop app's own backend), so not changeable here.
   */
  source: Schema.Literals(["settings", "launch"]),
  /** The MagicDNS HTTPS endpoint; null without a running, MagicDNS-enabled Tailscale. */
  endpoint: Schema.NullOr(AdvertisedEndpoint),
  /** Why the endpoint is not serving this environment, when it should be. */
  problem: Schema.NullOr(Schema.String),
});
export type TailscaleServeState = typeof TailscaleServeState.Type;

export class TailscaleServeError extends Schema.TaggedError<TailscaleServeError>()(
  "TailscaleServeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
