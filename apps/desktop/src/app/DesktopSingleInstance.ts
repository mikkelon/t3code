import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { codexAuthDeliveryUrl, readCodexAuthHandoff } from "@t3tools/shared/codexAuthHandoff";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

export class DesktopSingleInstance extends Context.Service<
  DesktopSingleInstance,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopSingleInstance") {}

/**
 * Takes Electron's profile-scoped single-instance lock so deep links on
 * Windows and Linux reach the running app as `second-instance`. macOS
 * delivers them to the running app as `open-url` without a lock.
 */
function acquireSingleInstanceLock(platform: NodeJS.Platform): "unlocked" | "locked" | "secondary" {
  if (platform === "darwin") return "unlocked";
  return Electron.app.requestSingleInstanceLock() ? "locked" : "secondary";
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  // The lock both lives in and creates the userData directory, so the real
  // path must be set first. Must not yield: deep links can arrive as soon as
  // Electron is ready.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);

  const lock = yield* Effect.acquireRelease(
    Effect.sync(() => acquireSingleInstanceLock(environment.platform)),
    (lock) =>
      lock === "locked" ? Effect.sync(() => Electron.app.releaseSingleInstanceLock()) : Effect.void,
  );
  const isPrimaryInstance = lock !== "secondary";
  if (isPrimaryInstance) {
    // Route t3code:// links (provider sign-in returns) to this app.
    yield* electronApp.setAsDefaultProtocolClient(
      ElectronProtocol.getDesktopScheme(environment.isDevelopment),
    );
  }

  return DesktopSingleInstance.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);

      // A secondary instance hands its arguments to the running app through
      // `second-instance`. app.quit() is asynchronous, so stop bootstrap here
      // before whenReady can fire.
      if (!isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const expectedOrigin = `${ElectronProtocol.getDesktopScheme(environment.isDevelopment)}://app`;
        if (!destination?.startsWith(`${expectedOrigin}/`)) return false;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(destination));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      const args = yield* HostProcessArguments;
      args.some((value) => startProviderAuthHandoff(value));
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        if (startProviderAuthHandoff(url) || resumeProviderAuth(url)) event.preventDefault();
      });
      yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
        if (argv?.some((value) => startProviderAuthHandoff(value) || resumeProviderAuth(value)))
          return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) yield* electronWindow.reveal(mainWindow.value);
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.single_instance.configure")),
  });
});

export const layer = Layer.effect(DesktopSingleInstance, make);
