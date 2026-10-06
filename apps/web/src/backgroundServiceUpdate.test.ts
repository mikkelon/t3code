import { describe, expect, it } from "vite-plus/test";

import { formatServiceUptime, shouldApplyServiceUpdate } from "./backgroundServiceUpdate";

const ready = { status: "ready", targetVersion: "0.0.46-mk.10" } as const;
const idle = { status: "idle" } as const;
const base = {
  update: ready,
  serverVersion: "0.0.46-mk.9",
  runningAgents: 0,
  updateState: idle,
  attemptedVersion: null,
};

describe("shouldApplyServiceUpdate", () => {
  it("waits while agents run, then applies once they are idle", () => {
    expect(shouldApplyServiceUpdate({ ...base, runningAgents: 2 })).toBe(false);
    expect(shouldApplyServiceUpdate({ ...base, runningAgents: 1 })).toBe(false);
    expect(shouldApplyServiceUpdate({ ...base, runningAgents: 0 })).toBe(true);
  });

  it("does not guess before the service's threads have loaded", () => {
    expect(shouldApplyServiceUpdate({ ...base, runningAgents: null })).toBe(false);
    expect(shouldApplyServiceUpdate({ ...base, serverVersion: null })).toBe(false);
  });

  it("does nothing without a staged update or once the service runs it", () => {
    expect(shouldApplyServiceUpdate({ ...base, update: null })).toBe(false);
    expect(shouldApplyServiceUpdate({ ...base, update: { status: "none" } })).toBe(false);
    expect(
      shouldApplyServiceUpdate({
        ...base,
        update: { status: "failed", targetVersion: ready.targetVersion, message: "no tar" },
      }),
    ).toBe(false);
    expect(shouldApplyServiceUpdate({ ...base, serverVersion: ready.targetVersion })).toBe(false);
  });

  it("never retries a failed or rolled-back update on its own", () => {
    expect(
      shouldApplyServiceUpdate({
        ...base,
        updateState: {
          status: "failed",
          stage: "resuming",
          fromVersion: base.serverVersion,
          targetVersion: ready.targetVersion,
          message: "The service launcher rolled back the update.",
        },
      }),
    ).toBe(false);
    // Back to idle after the rollback, but this launch already tried it.
    expect(shouldApplyServiceUpdate({ ...base, attemptedVersion: ready.targetVersion })).toBe(
      false,
    );
  });

  it("leaves an update in flight alone", () => {
    expect(
      shouldApplyServiceUpdate({
        ...base,
        updateState: {
          status: "running",
          stage: "downloading",
          fromVersion: base.serverVersion,
          targetVersion: ready.targetVersion,
        },
      }),
    ).toBe(false);
  });
});

describe("formatServiceUptime", () => {
  const now = Date.parse("2026-10-06T12:00:00.000Z");
  it("rounds down to the largest useful unit", () => {
    expect(formatServiceUptime(null, now)).toBeNull();
    expect(formatServiceUptime("not a date", now)).toBeNull();
    expect(formatServiceUptime("2026-10-06T11:59:30.000Z", now)).toBe("up less than a minute");
    expect(formatServiceUptime("2026-10-06T11:15:00.000Z", now)).toBe("up 45 min");
    expect(formatServiceUptime("2026-10-06T02:00:00.000Z", now)).toBe("up 10 h");
    expect(formatServiceUptime("2026-10-01T12:00:00.000Z", now)).toBe("up 5 days");
  });
});
