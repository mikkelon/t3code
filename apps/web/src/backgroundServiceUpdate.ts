import type { DesktopBackgroundServiceUpdate } from "@t3tools/contracts";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";

/**
 * Whether to switch the background service to the version the desktop app
 * staged for it, right now. Only once no agent runs on it (null means its
 * threads have not loaded yet, so that is not known), no update is in flight,
 * and this launch has not tried that version already: a failed or rolled-back
 * update waits for the user's Retry instead of looping.
 */
export function shouldApplyServiceUpdate(input: {
  readonly update: DesktopBackgroundServiceUpdate | null;
  /** The connected service's version, or null while it is not connected. */
  readonly serverVersion: string | null;
  readonly runningAgents: number | null;
  readonly updateState: ServerUpdateState;
  readonly attemptedVersion: string | null;
}): boolean {
  return (
    input.update?.status === "ready" &&
    input.serverVersion !== null &&
    input.serverVersion !== input.update.targetVersion &&
    input.runningAgents === 0 &&
    input.updateState.status === "idle" &&
    input.attemptedVersion !== input.update.targetVersion
  );
}

/** "up 3 h" style uptime, read once; the row does not tick. */
export function formatServiceUptime(startedAt: string | null, now: number): string | null {
  if (startedAt === null) return null;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return null;
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "up less than a minute";
  if (minutes < 60) return `up ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `up ${hours} h`;
  return `up ${Math.floor(hours / 24)} days`;
}
