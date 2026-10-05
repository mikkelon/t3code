import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

/**
 * The server config whose keybindings drive shortcuts. Normally the primary
 * environment's. Without a primary (the desktop app with its local environment
 * off, or the hosted app) it is the first environment with a config, which is
 * the one Settings shows and edits when only one machine is connected, so a
 * rebound shortcut is the one that fires.
 */
export function selectKeybindingsConfig(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly primaryConfig: ServerConfig | null;
  readonly environmentConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
}): ServerConfig | null {
  if (input.primaryEnvironmentId !== null) return input.primaryConfig;
  for (const config of input.environmentConfigs.values()) return config;
  return null;
}
