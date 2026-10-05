import type { DesktopBackgroundServiceState } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useState } from "react";

import { formatServiceUptime } from "../../backgroundServiceUpdate";
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
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

type PendingChange = "restart" | "disable" | "enable";

function runningAgentsNote(running: number | null, continuesAfterRestart: boolean): string {
  if (running === null || running === 0) return "";
  const agents = running === 1 ? "1 running agent" : `${running} running agents`;
  return continuesAfterRestart
    ? ` ${agents} restart and continue where they left off.`
    : ` ${agents} will be interrupted.`;
}

function describeService(state: DesktopBackgroundServiceState, now: number): string {
  if (!state.adopted) {
    return state.error === null
      ? "Agents run inside T3 Code and stop when you close it."
      : `T3 Code couldn't set up its background service: ${state.error} Agents run inside the app for now and stop when you close it.`;
  }
  const status = [
    "Running",
    state.serverVersion === null ? null : `t3@${state.serverVersion}`,
    formatServiceUptime(state.startedAt, now),
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const owner = state.installed
    ? "Agents keep running when you close T3 Code."
    : "A T3 server started outside the app runs agents on this computer. Closing T3 Code leaves it running.";
  const update =
    state.update.status === "ready"
      ? ` t3@${state.update.targetVersion} is ready and installs once no agents are running.`
      : state.update.status === "failed"
        ? ` Couldn't prepare t3@${state.update.targetVersion}: ${state.update.message}`
        : "";
  return `${status}. ${owner}${update}`;
}

const CHANGE_COPY: Record<PendingChange, { title: string; body: string; confirm: string }> = {
  restart: {
    title: "Restart the background service?",
    body: "The service stops and starts again. T3 Code reconnects on its own.",
    confirm: "Restart",
  },
  disable: {
    title: "Stop running agents in the background?",
    body: "The background service stops and is removed from this computer. T3 Code restarts and runs agents itself, so they stop when you close the app. Projects and threads are kept.",
    confirm: "Remove and restart",
  },
  enable: {
    title: "Run agents in the background?",
    body: "T3 Code restarts, installs its background service and runs agents there, so they keep running when you close the app. Projects and threads are kept.",
    confirm: "Restart",
  },
};

// Turning the service on or off relaunches the app, so the state read on
// mount is the state for this process's lifetime, apart from the server's
// version and uptime, which are read again after a restart.
export function BackgroundServiceSetting() {
  const bridge = window.desktopBridge;
  const [state, setState] = useState<DesktopBackgroundServiceState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useAtomValue(primaryRunningThreadCountAtom);
  const continuesAfterRestart =
    useAtomValue(primaryServerSettingsAtom).continueThreadsAfterServerUpdate;

  const refresh = useCallback(
    async () =>
      bridge?.getBackgroundServiceState?.().then(
        (next) => {
          setState(next);
          setNow(Date.now());
        },
        () => setState(null),
      ),
    [bridge],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === null || isLocalEnvironmentDisabled()) return null;
  // Windows, development builds, and builds without a service runtime: only a
  // server the app adopted is shown.
  if (!state.supported && !state.adopted) return null;

  const apply = async (change: PendingChange) => {
    setIsApplying(true);
    setError(null);
    try {
      if (change === "restart") {
        await bridge?.restartBackgroundService?.();
        setPending(null);
        setIsApplying(false);
        await refresh();
        return;
      }
      // Relaunches the app.
      await bridge?.setBackgroundServiceEnabled?.(change === "enable");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change the background service.");
      setIsApplying(false);
    }
  };

  const close = (open: boolean) => {
    if (isApplying || open) return;
    setPending(null);
    setError(null);
  };

  const note = runningAgentsNote(running, continuesAfterRestart);
  const manageable = state.supported && (state.installed || !state.adopted);

  return (
    <>
      <SettingsRow
        {...searchableSetting("background-service")}
        title={state.adopted && !state.installed ? "Local server" : "Background service"}
        description={describeService(state, now)}
        control={
          state.installed && state.supported ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isApplying}
                onClick={() => setPending("restart")}
              >
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void bridge?.openBackgroundServiceLogs?.()}
              >
                Show logs
              </Button>
            </>
          ) : state.error !== null && !state.disabled ? (
            <Button
              variant="outline"
              size="sm"
              disabled={isApplying}
              onClick={() => setPending("enable")}
            >
              Retry
            </Button>
          ) : undefined
        }
      >
        {state.lingerCommand !== null ? (
          <p className="max-w-xl pb-2 text-xs text-muted-foreground/80">
            It stops when you log out of this computer. To keep it running, run this once in a
            terminal:{" "}
            <code className="rounded bg-muted px-1 py-0.5 font-mono select-all">
              {state.lingerCommand}
            </code>
          </p>
        ) : null}
        {manageable ? (
          <details className="pb-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Advanced</summary>
            <div className="mt-2 flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <p className="text-sm font-medium text-foreground">
                  Don't run agents in the background
                </p>
                <p className="max-w-xl">
                  Removes the background service. T3 Code runs agents itself, and they stop when you
                  close it.
                </p>
              </div>
              <Switch
                checked={!state.installed}
                disabled={isApplying}
                onCheckedChange={(checked) => setPending(checked ? "disable" : "enable")}
                aria-label="Don't run agents in the background"
              />
            </div>
          </details>
        ) : null}
      </SettingsRow>
      <AlertDialog open={pending !== null} onOpenChange={close}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending === null ? "" : CHANGE_COPY[pending].title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending === null ? "" : `${CHANGE_COPY[pending].body}${note}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? <p className="px-6 pb-4 text-sm text-destructive">{error}</p> : null}
          <AlertDialogFooter>
            <AlertDialogClose disabled={isApplying} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant={pending === "disable" ? "destructive" : "default"}
              disabled={isApplying || pending === null}
              onClick={() => {
                if (pending !== null) void apply(pending);
              }}
            >
              {isApplying ? (
                <>
                  <Spinner size="sm" />
                  Restarting…
                </>
              ) : pending === null ? (
                ""
              ) : (
                CHANGE_COPY[pending].confirm
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
