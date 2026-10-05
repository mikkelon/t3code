/**
 * The desktop app's copy of the `t3` launcher helpers in
 * apps/server/src/cloud/pinnedRuntime.ts, which desktop cannot import.
 * posixLauncher.test.ts in the server keeps the two formats identical.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * The `t3` script the install scripts and `t3 update` write on macOS and Linux. Exec by absolute
 * path: through a symlink, argv0 is the link, and the Cursor SDK looks for its helpers beside it.
 */
export const posixLauncherScript = (executable: string) =>
  `#!/bin/sh\nexec '${executable.replaceAll("'", "'\\''")}' "$@"\n`;

/** The executable a script exactly as {@link posixLauncherScript} writes it runs; never a user's wrapper. */
const readPosixLauncherTarget = Effect.fn("shared.posix_launcher.read_script_target")(function* (
  launcher: string,
) {
  const fs = yield* FileSystem.FileSystem;
  // Stat first so a runtime binary found the same way is never read whole.
  const info = yield* fs.stat(launcher).pipe(Effect.option);
  if (Option.isNone(info) || info.value.type !== "File" || info.value.size > 4096n) {
    return undefined;
  }
  const contents = yield* fs.readFileString(launcher).pipe(Effect.option);
  if (Option.isNone(contents)) return undefined;
  const quoted = /^#!\/bin\/sh\nexec '((?:[^']|'\\'')*)' "\$@"\n$/.exec(contents.value)?.[1];
  return quoted?.replaceAll("'\\''", "'");
});

/** Where a `t3` launcher leads: a legacy symlink's target, or what a {@link posixLauncherScript} runs. */
export const readLauncherTarget = Effect.fn("shared.posix_launcher.read_target")(function* (
  launcher: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const link = yield* fs.readLink(launcher).pipe(Effect.option);
  if (Option.isSome(link)) {
    return {
      kind: "link",
      target: path.resolve(path.dirname(launcher), link.value),
    } as const;
  }
  const target = yield* readPosixLauncherTarget(launcher);
  return target === undefined ? undefined : ({ kind: "script", target } as const);
});

/** Writes {@link posixLauncherScript} at `launcher` in one rename, replacing a legacy symlink rather than writing through it. */
export const writePosixLauncher = Effect.fn("shared.posix_launcher.write")(function* (input: {
  readonly launcher: string;
  readonly executable: string;
  /** Fail instead of replacing a file that is there, even one created after the caller looked. */
  readonly exclusive: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const staging = yield* fs.makeTempFileScoped({
    directory: path.dirname(input.launcher),
    prefix: ".t3-",
  });
  yield* fs.writeFileString(staging, posixLauncherScript(input.executable));
  yield* fs.chmod(staging, 0o755);
  yield* input.exclusive ? fs.link(staging, input.launcher) : fs.rename(staging, input.launcher);
}, Effect.scoped);
