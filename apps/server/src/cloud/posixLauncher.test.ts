import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as SharedLauncher from "@t3tools/shared/posixLauncher";

import { posixLauncherScript, readPosixLauncherTarget } from "./pinnedRuntime.ts";

// The desktop app's background service writes `t3` with the shared copy; the CLI reads it with these.
it.layer(NodeServices.layer)("desktop launcher copy", (it) => {
  it.effect("writes the launcher the CLI writes and reads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-copy-" });
      const executable = path.join(dir, "runtime", "versions", "it's 1.0.0", "t3");
      const launcher = path.join(dir, "t3");

      assert.equal(SharedLauncher.posixLauncherScript(executable), posixLauncherScript(executable));
      yield* SharedLauncher.writePosixLauncher({ launcher, executable, exclusive: true });
      assert.equal(yield* readPosixLauncherTarget(launcher), executable);
      assert.deepEqual(yield* SharedLauncher.readLauncherTarget(launcher), {
        kind: "script",
        target: executable,
      });
    }).pipe(Effect.scoped),
  );
});
