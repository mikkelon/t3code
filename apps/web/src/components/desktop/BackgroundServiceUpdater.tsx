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
 * Desktop only. Announces the installed background service once and switches it to
 * the staged version when no agent runs. The switch is the server's own update, so a
 * failed start rolls back and shows as a failed update in Settings → Environments.
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the one-time install notice and staged update from the desktop bridge over IPC on mount.
  useEffect(() => {
    void bridge?.takeBackgroundServiceInstallNotice?.().then(
      (show) => {
        if (!show) return;
        toastManager.add({
          type: "info",
          title: "Agents keep running in the background",
          description:
            "T3 Code keeps your agents running in the background. Change this in Settings → Environments.",
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Applies the staged update when server state (idle agents, connected version) allows it; no user handler causes that transition.
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
