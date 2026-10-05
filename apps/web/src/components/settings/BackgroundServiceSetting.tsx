import type { DesktopBackgroundServiceState } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { primaryServerSettingsAtom } from "../../state/server";
import { primaryRunningThreadCountAtom } from "../../state/threads";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type PendingChange = "install" | "uninstall";

function runningAgentsNote(running: number, continuesAfterRestart: boolean): string {
  if (running === 0) return "";
  const agents = running === 1 ? "1 running agent" : `${running} running agents`;
  return continuesAfterRestart
    ? ` ${agents} restart and continue where they left off.`
    : ` ${agents} will be interrupted.`;
}

// Installing or removing the service restarts the app, so the state read on
// mount is the state for this process's lifetime.
export function BackgroundServiceSetting() {
  const bridge = window.desktopBridge;
  const [state, setState] = useState<DesktopBackgroundServiceState | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [lingerCommand, setLingerCommand] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useAtomValue(primaryRunningThreadCountAtom);
  const continuesAfterRestart =
    useAtomValue(primaryServerSettingsAtom).continueThreadsAfterServerUpdate;

  useEffect(() => {
    void bridge?.getBackgroundServiceState?.().then(setState, () => setState(null));
  }, [bridge]);

  if (state === null || isLocalEnvironmentDisabled()) return null;
  // Not offered: Windows, Intel Macs, development builds. A server the app
  // adopted there still shows as running in the background.
  if (!state.supported && !state.adopted) return null;
  if (state.installed && !state.adopted) return null;

  const apply = async (change: PendingChange) => {
    setIsUpdating(true);
    setError(null);
    try {
      if (change === "uninstall") {
        await bridge?.uninstallBackgroundService?.();
        return;
      }
      const result = await bridge?.installBackgroundService?.();
      if (result?._tag === "NeedsLinger") {
        setLingerCommand(result.command);
        setIsUpdating(false);
      }
      // Installed: the app restarts on the service.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the background service.");
      setIsUpdating(false);
    }
  };

  const close = (open: boolean) => {
    if (isUpdating || open) return;
    setPending(null);
    setLingerCommand(null);
    setError(null);
  };

  const note = runningAgentsNote(running, continuesAfterRestart);

  return (
    <>
      <SettingsRow
        {...searchableSetting("background-service")}
        title={state.adopted ? "Background service" : searchableSetting("background-service").title}
        description={
          state.adopted
            ? "Agents on this computer run in the background service and keep running when you close T3 Code."
            : "Agents stop when T3 Code closes. Run them in a background service that starts with this computer instead."
        }
        control={
          state.supported ? (
            <Button
              variant="outline"
              size="sm"
              disabled={isUpdating}
              onClick={() => setPending(state.adopted ? "uninstall" : "install")}
            >
              {state.adopted ? "Stop running in background" : "Set up"}
            </Button>
          ) : undefined
        }
      />
      <AlertDialog open={pending !== null} onOpenChange={close}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {lingerCommand !== null
                ? "Allow T3 Code to keep running after you log out"
                : pending === "uninstall"
                  ? "Stop running in the background?"
                  : "Keep agents running in the background?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {lingerCommand !== null
                ? "This needs administrator rights once. Run this in a terminal, then choose Done."
                : pending === "uninstall"
                  ? `The background service stops and is removed from this computer. T3 Code restarts and runs agents itself again, so they stop when you close the app. Projects and threads are kept.${note}`
                  : `T3 Code installs its background service and restarts on it. Projects and threads are kept.${note}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {lingerCommand !== null ? (
            <code className="mx-6 block rounded-md bg-muted px-3 py-2 font-mono text-xs select-all">
              {lingerCommand}
            </code>
          ) : null}
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isUpdating} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant={pending === "uninstall" ? "destructive" : "default"}
              disabled={isUpdating || pending === null}
              onClick={() => {
                if (pending !== null) void apply(pending);
              }}
            >
              {isUpdating ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : lingerCommand !== null ? (
                "Done, retry"
              ) : pending === "uninstall" ? (
                "Stop and restart"
              ) : (
                "Install and restart"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
