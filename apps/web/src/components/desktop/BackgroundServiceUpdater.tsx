import type { DesktopBackgroundServiceUpdate } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";

import { shouldApplyServiceUpdate } from "../../backgroundServiceUpdate";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { primaryRunningThreadCountAtom } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Desktop only. Tells the user once that the app installed its background
 * service, and switches the service to the version the app staged for it as
 * soon as no agent runs on it. The switch is the server's own update, so a
 * version that fails to start is rolled back and shows as a failed update in
 * Settings → Connections, where "Update now" also lives.
 */
export function BackgroundServiceUpdater() {
  const bridge = window.desktopBridge;
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const serverVersion = useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const runningAgents = useAtomValue(primaryRunningThreadCountAtom);
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const updateServer = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const [update, setUpdate] = useState<DesktopBackgroundServiceUpdate | null>(null);
  const attemptedVersion = useRef<string | null>(null);

  useEffect(() => {
    void bridge?.takeBackgroundServiceInstallNotice?.().then(
      (show) => {
        if (!show) return;
        toastManager.add({
          type: "info",
          title: "Agents keep running in the background",
          description:
            "T3 Code keeps your agents running in the background. Change this in Settings → Connections.",
          timeout: 0,
        });
      },
      () => undefined,
    );
    // Waits for the app to finish staging, so this resolves when it knows.
    void bridge?.getBackgroundServiceState?.().then(
      (state) => setUpdate(state.update),
      () => undefined,
    );
  }, [bridge]);

  useEffect(() => {
    if (
      environmentId === null ||
      update?.status !== "ready" ||
      !shouldApplyServiceUpdate({
        update,
        serverVersion,
        runningAgents,
        updateState,
        attemptedVersion: attemptedVersion.current,
      })
    ) {
      return;
    }
    const targetVersion = update.targetVersion;
    attemptedVersion.current = targetVersion;
    // Reading the state re-stages a runtime the server pruned meanwhile.
    void bridge?.getBackgroundServiceState?.().then(
      (state) => {
        if (state.update.status === "ready" && state.update.targetVersion === targetVersion) {
          void updateServer({ environmentId, input: { targetVersion } });
        } else {
          setUpdate(state.update);
        }
      },
      () => undefined,
    );
  }, [bridge, environmentId, runningAgents, serverVersion, update, updateServer, updateState]);

  return null;
}
