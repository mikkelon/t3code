import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import { primaryServerSettingsAtom } from "../../state/server";
import { primaryRunningThreadCountAtom } from "../../state/threads";

/**
 * Desktop only. Tells the app how many agents run on the local environment,
 * so quitting can offer to keep them running in the background service.
 */
export function AgentActivityReporter() {
  const running = useAtomValue(primaryRunningThreadCountAtom);
  const continuesAfterRestart =
    useAtomValue(primaryServerSettingsAtom).continueThreadsAfterServerUpdate;
  useEffect(() => {
    void window.desktopBridge
      ?.reportAgentActivity?.({ running, continuesAfterRestart })
      .catch(() => undefined);
  }, [continuesAfterRestart, running]);
  return null;
}
