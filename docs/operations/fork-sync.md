# Syncing the fork with upstream

> For the maintainer of this fork. Upstream is
> [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

The fork is a short stack of themed commits on top of upstream `main`, one per
area the fork changes (release channel, CI, sync tooling, T3 Connect removal,
analytics removal, background service, ...). Syncing means rebasing that stack
onto the newest upstream `main`, never merging upstream in. Few commits means
each upstream conflict is resolved once per theme instead of once per historic
commit.

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
5. Compares `ORCHESTRATION_PROTOCOL_VERSION` (in
   `packages/contracts/src/environment.ts`) on the result with the fork branch
   and prints a loud warning when it changed. See
   [Wire protocol changes](#wire-protocol-changes). `--checks-only` repeats this
   check after a stopped rebase, so run it before adopting.
6. Runs `vp i`, typechecks server, desktop, web, shared and scripts, and runs the
   test files next to every file the fork changes. `--skip-checks` skips this.
7. Prints the commands to inspect, adopt (`git reset --hard sync/<date>` on
   `main`) and push (`git push --force-with-lease origin main`). It never pushes.

Use `git range-diff` from the printed commands to compare the stack before and
after; it shows exactly how each fork commit changed during the rebase.

The script enables `rerere` for the clone, so git records every conflict you
resolve and replays it the next time the same conflict comes up. A replayed
resolution is written to the file but not staged: the script still stops and
lists those files as "already resolved from an earlier sync", so you review
them before `git add`.

## Wire protocol changes

Clients and servers refuse each other when their orchestration protocol versions
differ. Desktop and web ship with each fork release, so they always match. The
official App Store and Google Play app does not: it follows upstream's releases,
so a protocol bump in a sync can lock the phone out of every fork server, which
then shows **Client not supported**.

When the script prints the warning, decide before adopting whether the release
is worth losing the phone until the store app speaks the new protocol. As of
`v0.0.46-mk.2` the fork is on protocol 2 and the store app still speaks 1, so the
phone already shows **Client not supported**; it starts working again once the
store app ships protocol 2.

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
- Keep the stack themed. Work on an existing theme lands as its own commits
  (reviewable on its own), then gets folded into its theme commit with
  `git rebase -i --autosquash` (`git commit --fixup=<theme commit>`) before or
  during the next sync. Only a genuinely new area of change gets a new theme
  commit. Themes list what they absorbed in their commit body.
- The theme commit messages explain why the fork differs. During a sync, a
  commit whose purpose is clear is much easier to re-resolve.
