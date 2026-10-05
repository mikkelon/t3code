// @effect-diagnostics nodeBuiltinImport:off - Drives the real sync script against throwaway git repositories.
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = NodePath.resolve(import.meta.dirname, "sync-upstream.sh");
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim();
}

function commitFiles(cwd: string, message: string, files: Record<string, string | null>): void {
  for (const [name, contents] of Object.entries(files)) {
    if (contents === null) git(cwd, "rm", "-q", name);
    else {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(cwd, name), contents);
      git(cwd, "add", name);
    }
  }
  git(cwd, "commit", "-q", "-m", message);
}

const PROTOCOL_FILE = "packages/contracts/src/environment.ts";
const protocolSource = (version: number) =>
  `export const ORCHESTRATION_PROTOCOL_VERSION = ${version};\n`;

/** An upstream with a few files, and a fork of it that deletes one and edits another. */
function makeRepos() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-upstream-"));
  roots.push(root);
  const upstream = NodePath.join(root, "upstream");
  const fork = NodePath.join(root, "fork");
  NodeFS.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  commitFiles(upstream, "initial", {
    "deleted-by-fork.txt": "upstream\n",
    "edited-by-fork.txt": "one\ntwo\nthree\n",
    "untouched.txt": "same\n",
    [PROTOCOL_FILE]: protocolSource(2),
  });
  git(root, "clone", "-q", upstream, fork);
  commitFiles(fork, "fork: remove a leaf", { "deleted-by-fork.txt": null });
  commitFiles(fork, "fork: edit a line", { "edited-by-fork.txt": "one\nfork\nthree\n" });
  return { upstream, fork };
}

function runSync(cwd: string, upstream: string) {
  return NodeChildProcess.spawnSync("bash", [script, "--skip-checks"], {
    cwd,
    env: { ...gitEnv, T3CODE_UPSTREAM_URL: upstream },
    encoding: "utf8",
  });
}

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("sync-upstream.sh", () => {
  it("keeps fork deletions that upstream modified and leaves main alone", () => {
    const { upstream, fork } = makeRepos();
    commitFiles(upstream, "upstream: edit the file the fork deleted", {
      "deleted-by-fork.txt": "upstream changed\n",
      "added-upstream.txt": "new\n",
    });
    const mainBefore = git(fork, "rev-parse", "main");

    const result = runSync(fork, upstream);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("kept deleted");
    expect(result.stdout).toContain("deleted-by-fork.txt");
    const branch = git(fork, "branch", "--show-current");
    expect(branch).toMatch(/^sync\/\d{4}-\d{2}-\d{2}$/);
    expect(git(fork, "rev-parse", "main")).toBe(mainBefore);
    expect(git(fork, "log", "--format=%s", "upstream/main..HEAD").split("\n")).toEqual([
      "fork: edit a line",
      "fork: remove a leaf",
    ]);
    expect(NodeFS.existsSync(NodePath.join(fork, "deleted-by-fork.txt"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(fork, "added-upstream.txt"), "utf8")).toBe("new\n");
    expect(git(fork, "remote", "get-url", "--push", "upstream")).toBe("DISABLED");
    expect(result.stdout).toContain("Orchestration protocol: 2 (unchanged from main)");
    expect(result.stderr).not.toContain("ORCHESTRATION_PROTOCOL_VERSION");
  });

  it("warns loudly when the sync changes the orchestration protocol", () => {
    const { upstream, fork } = makeRepos();
    commitFiles(upstream, "upstream: bump the wire protocol", {
      [PROTOCOL_FILE]: protocolSource(3),
    });

    const result = runSync(fork, upstream);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("WARNING: ORCHESTRATION_PROTOCOL_VERSION changes from 2 to 3.");
    expect(result.stderr).toContain("Client not supported");
  });

  it("stops on a conflict that needs a human and names the file", () => {
    const { upstream, fork } = makeRepos();
    commitFiles(upstream, "upstream: edit the same line", {
      "edited-by-fork.txt": "one\nupstream\nthree\n",
    });

    const result = runSync(fork, upstream);

    expect(result.status, result.stdout + result.stderr).toBe(2);
    expect(result.stderr).toContain("UU edited-by-fork.txt");
    expect(result.stderr).toContain("fork: edit a line");
    expect(NodeFS.existsSync(NodePath.join(fork, ".git", "rebase-merge"))).toBe(true);
    expect(result.stderr).not.toContain("already resolved from an earlier sync");
  });

  it("replays an earlier resolution but still stops for review", () => {
    const { upstream, fork } = makeRepos();
    commitFiles(upstream, "upstream: edit the same line", {
      "edited-by-fork.txt": "one\nupstream\nthree\n",
    });
    const resolved = "one\nupstream and fork\nthree\n";

    const first = runSync(fork, upstream);
    expect(first.status, first.stdout + first.stderr).toBe(2);
    expect(git(fork, "config", "--bool", "rerere.enabled")).toBe("true");
    NodeFS.writeFileSync(NodePath.join(fork, "edited-by-fork.txt"), resolved);
    git(fork, "add", "edited-by-fork.txt");
    git(fork, "-c", "core.editor=true", "rebase", "--continue");
    git(fork, "switch", "-q", "main");

    const second = runSync(fork, upstream);

    expect(second.status, second.stdout + second.stderr).toBe(2);
    expect(second.stderr).toContain("already resolved from an earlier sync");
    expect(second.stderr).toContain("UU edited-by-fork.txt");
    expect(NodeFS.readFileSync(NodePath.join(fork, "edited-by-fork.txt"), "utf8")).toBe(resolved);
  });
});
