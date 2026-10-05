import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";
import { RemoteEnvironmentAuthFetchError, RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";

describe("mapRemoteEnvironmentError", () => {
  it("blocks on an invalid environment credential", () => {
    const mapped = mapRemoteEnvironmentError(
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "invalid_credential",
        traceId: "trace-descriptor",
      }),
    );
    expect(mapped).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
      detail: "The environment credential is invalid.",
      traceId: "trace-descriptor",
    });
  });

  it.each([
    {
      error: new RemoteEnvironmentAuthFetchError({
        message: "Failed to fetch remote environment endpoint.",
        cause: new TypeError("Failed to fetch"),
      }),
      reason: "network",
    },
    {
      error: new RemoteEnvironmentAuthTimeoutError("https://environment.example.test", 10_000),
      reason: "timeout",
    },
  ])("retries an unreachable endpoint with its own message: $error._tag", ({ error, reason }) => {
    const mapped = mapRemoteEnvironmentError(error);
    expect(mapped).toMatchObject({
      _tag: "ConnectionTransientError",
      reason,
      detail: error.message,
    });
  });
});
