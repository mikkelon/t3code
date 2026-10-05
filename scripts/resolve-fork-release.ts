#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import { readDesktopBaseVersion } from "./resolve-nightly-release.ts";
import { listGitTags } from "./resolve-previous-release-tag.ts";

/**
 * Fork releases are `<core>-mk.<n>`. The core is the one upstream's nightlies
 * use for the same commit (the next patch after the desktop package version),
 * so a fork build never claims an upstream stable version and sorts above the
 * upstream release it was built on. Every channel check in the app treats any
 * prerelease other than `-nightly.` and `-preview.` as stable, so these
 * follow the stable train without further changes.
 */
export const FORK_RELEASE_IDENTIFIER = "mk";

const FORK_RELEASE_VERSION = new RegExp(
  `^\\d+\\.\\d+\\.\\d+-${FORK_RELEASE_IDENTIFIER}\\.[1-9]\\d*$`,
);

export class InvalidForkReleaseVersionError extends Schema.TaggedError<InvalidForkReleaseVersionError>()(
  "InvalidForkReleaseVersionError",
  { requested: Schema.String },
) {
  override get message(): string {
    return `'${this.requested}' is not a fork release version; expected v<major>.<minor>.<patch>-${FORK_RELEASE_IDENTIFIER}.<n>.`;
  }
}

export class ForkReleaseGitHubOutputError extends Schema.TaggedError<ForkReleaseGitHubOutputError>()(
  "ForkReleaseGitHubOutputError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to write fork release metadata to GITHUB_OUTPUT.";
  }
}

/**
 * The version a fork release publishes. An explicit request (a pushed tag or a
 * workflow input) is validated and used as is; otherwise the next free `<n>`
 * for `baseVersion` is taken from the existing tags.
 */
export const resolveForkReleaseVersion = (input: {
  readonly baseVersion: string;
  readonly tags: ReadonlyArray<string>;
  readonly requested: string | undefined;
}) => {
  const requested = input.requested?.trim();
  if (requested) {
    const version = requested.replace(/^v/, "");
    return FORK_RELEASE_VERSION.test(version)
      ? Effect.succeed(version)
      : Effect.fail(new InvalidForkReleaseVersionError({ requested }));
  }
  const prefix = `v${input.baseVersion}-${FORK_RELEASE_IDENTIFIER}.`;
  const highest = input.tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((counter) => /^[1-9]\d*$/.test(counter))
    .reduce((max, counter) => Math.max(max, Number(counter)), 0);
  return Effect.succeed(`${input.baseVersion}-${FORK_RELEASE_IDENTIFIER}.${highest + 1}`);
};

const writeOutput = Effect.fn("writeForkReleaseOutput")(function* (
  version: string,
  githubOutput: boolean,
) {
  const serialized = [`version=${version}`, `tag=v${version}`, `name=T3 Code v${version}`]
    .map((line) => `${line}\n`)
    .join("");
  if (!githubOutput) {
    yield* Console.log(serialized.trimEnd());
    return;
  }
  const fs = yield* FileSystem.FileSystem;
  const outputPath = yield* Config.NonEmptyString("GITHUB_OUTPUT").pipe(
    Effect.mapError((cause) => new ForkReleaseGitHubOutputError({ cause })),
  );
  yield* fs
    .writeFileString(outputPath, serialized, { flag: "a" })
    .pipe(Effect.mapError((cause) => new ForkReleaseGitHubOutputError({ cause })));
});

const command = Command.make(
  "resolve-fork-release",
  {
    requested: Flag.String("requested").pipe(
      Flag.withDescription(
        "Version or tag to release. Empty picks the next -mk.<n> for the current base version.",
      ),
      Flag.optional,
    ),
    githubOutput: Flag.Boolean("github-output").pipe(
      Flag.withDescription("Write values to GITHUB_OUTPUT instead of stdout."),
      Flag.withDefault(false),
    ),
  },
  ({ requested, githubOutput }) =>
    Effect.all([readDesktopBaseVersion(undefined), listGitTags()]).pipe(
      Effect.flatMap(([baseVersion, tags]) =>
        resolveForkReleaseVersion({
          baseVersion,
          tags,
          requested: Option.getOrUndefined(requested),
        }),
      ),
      Effect.flatMap((version) => writeOutput(version, githubOutput)),
    ),
).pipe(Command.withDescription("Resolve the version of a fork release."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
