import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly timeoutMs?: number;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, `/api/orchestration/threads/${input.threadId}/history`),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadHistoryPage({
        params: { threadId: input.threadId },
        query: {
          cursor: input.cursor,
          ...(input.view === undefined ? {} : { view: input.view }),
          ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
        },
        headers: withOrchestrationProtocolHeader(headers),
      }),
  });
});
