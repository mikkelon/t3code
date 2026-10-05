import { describe, expect, it, vi } from "vite-plus/test";

import { hasTracingPublicConfig, resolveObservabilityPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveObservabilityPublicConfig", () => {
  it("returns no tracing configuration for an unconfigured build", () => {
    expect(resolveObservabilityPublicConfig({})).toEqual({
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    });
  });

  it("normalizes statically injected tracing configuration", () => {
    expect(
      resolveObservabilityPublicConfig({
        observability: {
          tracesUrl: " https://api.axiom.co/v1/traces ",
          tracesDataset: " mobile-traces ",
          tracesToken: " public-ingest-token ",
        },
      }),
    ).toEqual({
      tracesUrl: "https://api.axiom.co/v1/traces",
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("rejects an insecure traces URL", () => {
    expect(
      resolveObservabilityPublicConfig({
        observability: {
          tracesUrl: "http://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }),
    ).toEqual({
      tracesUrl: null,
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasTracingPublicConfig(resolveObservabilityPublicConfig({}))).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveObservabilityPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveObservabilityPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
            tracesToken: "public-ingest-token",
          },
        }),
      ),
    ).toBe(true);
  });
});
