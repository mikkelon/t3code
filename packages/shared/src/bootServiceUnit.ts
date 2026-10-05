/**
 * Where the per-user background service lives and how to read it back. The
 * server renders and manages the unit (apps/server/src/cloud/bootService.ts);
 * the desktop app only reads it to learn whether a service serves its T3 home.
 */

export const BOOT_SERVICE_UNIT_FILE = "t3code.service";
// `.service` suffix keeps the label distinct from the desktop app's bundle id
// (com.t3tools.t3code), so launchd and TCC records never collide.
export const BOOT_SERVICE_LAUNCHD_LABEL = "com.t3tools.t3code.service";
export const BOOT_SERVICE_PLIST_FILE = `${BOOT_SERVICE_LAUNCHD_LABEL}.plist`;

/** Undefined where the background service is not supported. */
export function bootServiceUnitPath(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly joinPath: (...segments: string[]) => string;
}): string | undefined {
  if (input.homeDir === "") return undefined;
  if (input.platform === "linux") {
    return input.joinPath(input.homeDir, ".config", "systemd", "user", BOOT_SERVICE_UNIT_FILE);
  }
  if (input.platform === "darwin") {
    return input.joinPath(input.homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE);
  }
  return undefined;
}

/**
 * Reads `T3CODE_HOME` back out of a rendered unit or plist. Only values the
 * server writes are expected, so a quoted systemd value is unquoted and
 * unescaped the same way the renderer produced it.
 */
export function bootServiceBaseDirOf(contents: string): string | undefined {
  const systemd = /^Environment=T3CODE_HOME=(.*)$/m.exec(contents)?.[1];
  if (systemd !== undefined) {
    const raw = systemd.trim();
    const unquoted =
      raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
        : raw;
    return unquoted.replaceAll("%%", "%");
  }
  const plist = /<key>T3CODE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(contents)?.[1];
  if (plist !== undefined) {
    return plist.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  }
  return undefined;
}
