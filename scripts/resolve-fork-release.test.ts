import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveForkReleaseVersion } from "./resolve-fork-release.ts";

const tags = [
  "v0.0.45",
  "v0.0.46-nightly.20261005.2689",
  "v0.0.46-mk.1",
  "v0.0.46-mk.2",
  "v0.0.46-mk.10",
  "v0.0.46-mk.x",
  "v0.0.47-mk.4",
];

it.effect("takes the next counter for the base version", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveForkReleaseVersion({ baseVersion: "0.0.46", tags, requested: undefined }),
      "0.0.46-mk.11",
    );
  }),
);

it.effect("starts a new base version at 1", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveForkReleaseVersion({ baseVersion: "0.0.48", tags, requested: "" }),
      "0.0.48-mk.1",
    );
  }),
);

it.effect("uses a requested tag or version as is", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveForkReleaseVersion({ baseVersion: "0.0.46", tags, requested: "v0.0.46-mk.3" }),
      "0.0.46-mk.3",
    );
    assert.equal(
      yield* resolveForkReleaseVersion({ baseVersion: "0.0.46", tags, requested: "1.2.3-mk.1" }),
      "1.2.3-mk.1",
    );
  }),
);

it.effect("rejects requests that are not fork versions", () =>
  Effect.gen(function* () {
    for (const requested of ["v0.0.46", "v0.0.46-nightly.20261005.1", "v0.0.46-mk.0", "latest"]) {
      const error = yield* Effect.flip(
        resolveForkReleaseVersion({ baseVersion: "0.0.46", tags, requested }),
      );
      assert.equal(error._tag, "InvalidForkReleaseVersionError");
    }
  }),
);
