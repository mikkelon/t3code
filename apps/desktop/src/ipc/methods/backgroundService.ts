import { DesktopBackgroundServiceStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackgroundService from "../../backend/DesktopBackgroundService.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getBackgroundServiceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_BACKGROUND_SERVICE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.backgroundService.getState")(function* () {
    return yield* (yield* DesktopBackgroundService.DesktopBackgroundService).state;
  }),
});

export const takeBackgroundServiceInstallNotice = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TAKE_BACKGROUND_SERVICE_INSTALL_NOTICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.backgroundService.takeInstallNotice")(function* () {
    return yield* (yield* DesktopBackgroundService.DesktopBackgroundService).takeInstallNotice;
  }),
});

export const restartBackgroundService = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.RESTART_BACKGROUND_SERVICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundService.restart")(function* () {
    yield* (yield* DesktopBackgroundService.DesktopBackgroundService).restart;
  }),
});

export const openBackgroundServiceLogs = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OPEN_BACKGROUND_SERVICE_LOGS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundService.openLogs")(function* () {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    yield* (yield* ElectronShell.ElectronShell).openPath(backgroundService.logPath);
  }),
});

// Relaunching hands the home over in one direction at a time: removing the
// service stops it before the next launch embeds the app's own backend, and
// the next launch installs the service before any backend starts.
export const setBackgroundServiceEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_BACKGROUND_SERVICE_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundService.setEnabled")(function* (enabled) {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* backgroundService.setEnabled(enabled);
    yield* lifecycle.relaunch(
      enabled ? "background service enabled" : "background service disabled",
    );
  }),
});
