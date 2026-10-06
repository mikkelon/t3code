import {
  DesktopAgentActivitySchema,
  DesktopBackgroundServiceInstallResultSchema,
  DesktopBackgroundServiceStateSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackgroundService from "../../backend/DesktopBackgroundService.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getBackgroundServiceState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_BACKGROUND_SERVICE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.backgroundService.getState")(function* () {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    return {
      supported: backgroundService.installable,
      installed: yield* backgroundService.installed,
      adopted: Option.isSome(yield* backgroundService.adopted),
    };
  }),
});

// Prepares the service while the embedded backend keeps serving, then
// relaunches: shutdown stops the embedded backend before the next launch
// starts the service and adopts it, so the two never run at once.
export const installBackgroundService = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.INSTALL_BACKGROUND_SERVICE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceInstallResultSchema,
  handler: Effect.fn("desktop.ipc.backgroundService.install")(function* () {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const result = yield* backgroundService.install;
    if (result._tag === "Installed") {
      yield* lifecycle.relaunch("background service installed");
    }
    return result;
  }),
});

export const uninstallBackgroundService = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.UNINSTALL_BACKGROUND_SERVICE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundService.uninstall")(function* () {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* backgroundService.uninstall;
    yield* lifecycle.relaunch("background service uninstalled");
  }),
});

export const reportAgentActivity = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REPORT_AGENT_ACTIVITY_CHANNEL,
  payload: DesktopAgentActivitySchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.backgroundService.reportAgentActivity")(function* (activity) {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    yield* backgroundService.reportAgentActivity(activity);
  }),
});
