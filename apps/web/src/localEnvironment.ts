import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

/**
 * True when the desktop app runs without its local server. The renderer then
 * has no primary environment: it skips primary auth and discovery and only
 * connects to saved remote environments. Always false in browsers and on
 * desktop builds predating the setting.
 */
export function isLocalEnvironmentDisabled(): boolean {
  return window.desktopBridge?.getLocalEnvironmentEnabled?.() === false;
}

/**
 * True when the desktop app's local environment is the background service it
 * adopted instead of a backend it runs itself. Closing the app then leaves
 * agents running, and settings that reconfigure the app's own backend do not
 * apply. Decided at launch, so it cannot change while the renderer runs.
 */
export function isLocalEnvironmentBackgroundService(): boolean {
  return (
    window.desktopBridge
      ?.getLocalEnvironmentBootstraps()
      .some((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID && entry.backgroundService) ===
    true
  );
}
