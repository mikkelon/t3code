# Syncing the fork with upstream

> For the maintainer of this fork. Upstream is
> [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The fork is a short stack of commits on top of upstream `main`. Syncing means
rebasing that stack onto the newest upstream `main`, never merging upstream in.

## Run a sync

From a clean checkout of the fork:

```bash
scripts/sync-upstream.sh
```

The script:

1. Adds an `upstream` remote (fetch only, push URL `DISABLED`) if it is missing,
   and fetches `upstream/main`.
2. Creates `sync/<date>` from `main` and rebases it onto `upstream/main`. `main`
   itself is never moved.
3. Resolves one conflict class on its own: a file the fork deleted that upstream
   changed since (`modify/delete`) stays deleted. The files it kept deleted are
   listed at the end.
4. Stops with exit code 2 on any other conflict, naming the files and the fork
   commit being replayed. Resolve, `git add`, `git rebase --continue`, then run
   `scripts/sync-upstream.sh --checks-only`.
5. Runs `vp i`, typechecks server, desktop, web, shared and scripts, and runs the
   test files next to every file the fork changes. `--skip-checks` skips this.
6. Prints the commands to inspect, adopt (`git reset --hard sync/<date>` on
   `main`) and push (`git push --force-with-lease origin main`). It never pushes.

Use `git range-diff` from the printed commands to compare the stack before and
after; it shows exactly how each fork commit changed during the rebase. Enabling
`git config rerere.enabled true` lets git replay conflict resolutions you made in
earlier syncs.

After adopting a sync, cut a release from the Actions tab (**Fork release**,
see [Maintaining the fork](../../README.md#maintaining-the-fork)) so installed
machines can `t3 update` to it.

## Keep the fork cheap to rebase

Every line the fork changes in an upstream file is a possible conflict on every
future sync. When changing the fork:

- Remove or gate features at their seams: registration points, layer wiring,
  route tables, settings sections, imports. Avoid sprawling edits deep inside
  hot upstream files.
- Delete a whole leaf module or directory rather than gutting it line by line.
  Upstream edits to a deleted file are the conflict class the sync script
  resolves automatically.
- Add fork-only behaviour in new files (as `fork-release.yml` and
  `scripts/resolve-fork-release.ts` do) and keep the hooks into upstream code
  small.
- No unrelated refactors, renames or reformatting, and do not run the
  formatter over files you did not otherwise change.
- Do not rename the `t3` binary, the `~/.t3` home, the `t3code.service` unit or
  app IDs.
- One commit per logical change, with a message that explains why. During a
  sync, a commit whose purpose is clear is much easier to re-resolve.
