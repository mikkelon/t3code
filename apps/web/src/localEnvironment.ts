import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

export function isLocalEnvironmentDisabled(): boolean {
  return window.desktopBridge?.getLocalEnvironmentEnabled() === false;
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
