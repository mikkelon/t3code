/** For a host that stopped answering on an open connection, so the network path was already working. */
export const UNRESPONSIVE_HOST_HINT = "It may be overloaded, asleep, or off the network.";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocket is not connected\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  // Any trailing text means a different error that the user should still see.
  /\b(?:is not connected|disconnected|stopped responding|could not establish a WebSocket connection)\.$/i,
  new RegExp(`\\bstopped responding for \\d+s\\. ${escapeRegExp(UNRESPONSIVE_HOST_HINT)}$`, "i"),
  /\bClientProtocolError\b/i,
  /\bRpcClientError\b/i,
  /\bping timeout\b/i,
] as const;

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
