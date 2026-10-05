import Constants from "expo-constants";

export interface ObservabilityPublicConfig {
  readonly tracesUrl: string | null;
  readonly tracesDataset: string | null;
  readonly tracesToken: string | null;
}

type ExpoExtra =
  | {
      readonly observability?: {
        readonly [Key in keyof ObservabilityPublicConfig]?: unknown;
      };
    }
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Reads the OTLP trace export settings that app.config.ts injects into `extra.observability`. */
export function resolveObservabilityPublicConfig(
  extra: ExpoExtra = Constants.expoConfig?.extra,
): ObservabilityPublicConfig {
  return {
    tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
    tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
    tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
  };
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

export function hasTracingPublicConfig(
  config: ObservabilityPublicConfig = resolveObservabilityPublicConfig(),
): config is Configured<ObservabilityPublicConfig> {
  return Boolean(config.tracesUrl && config.tracesDataset && config.tracesToken);
}
