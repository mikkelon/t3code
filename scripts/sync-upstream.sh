#!/usr/bin/env bash
# Rebases this fork's main onto upstream (pingdotgg/t3code) on a temporary
# `sync/<date>` branch, checks the result, and prints what to do next. It
# never moves main and never pushes. See docs/operations/fork-sync.md.
#
#   scripts/sync-upstream.sh [--branch <fork-branch>] [--skip-checks]
#   scripts/sync-upstream.sh [--branch <fork-branch>] --checks-only   # after finishing a stopped rebase
#
# Both modes warn when the result changes ORCHESTRATION_PROTOCOL_VERSION
# compared with <fork-branch> (default: main).
#
# Environment:
#   T3CODE_UPSTREAM_URL  upstream repository (default: https://github.com/pingdotgg/t3code)
#   T3CODE_UPSTREAM_REF  upstream branch to rebase onto (default: main)
set -euo pipefail

upstream_url="${T3CODE_UPSTREAM_URL:-https://github.com/pingdotgg/t3code}"
upstream_ref="${T3CODE_UPSTREAM_REF:-main}"
target="upstream/${upstream_ref}"
fork_branch="main"
mode="sync"
run_checks=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch) fork_branch="${2:?--branch needs a value}"; shift 2 ;;
    --skip-checks) run_checks=false; shift ;;
    --checks-only) mode="checks"; shift ;;
    -h | --help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "sync-upstream: unknown argument $1" >&2; exit 64 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nsync-upstream: %s\n' "$*" >&2; exit 1; }
rebase_in_progress() {
  [[ -d "$(git rev-parse --git-path rebase-merge)" || -d "$(git rev-parse --git-path rebase-apply)" ]]
}

protocol_file="packages/contracts/src/environment.ts"

# Prints the ORCHESTRATION_PROTOCOL_VERSION at a revision, or nothing.
protocol_version_at() {
  git show "$1:${protocol_file}" 2>/dev/null |
    sed -n 's/^export const ORCHESTRATION_PROTOCOL_VERSION = \([0-9][0-9]*\);.*/\1/p' | head -n 1
}

# Clients and servers on different orchestration protocols refuse each other.
# The official mobile app follows upstream's releases, so a bump here can lock
# it out of every server this fork builds until the store app catches up.
check_protocol_version() {
  local before after
  before="$(protocol_version_at "$fork_branch")"
  after="$(protocol_version_at HEAD)"
  if [[ -z "$before" || -z "$after" ]]; then
    {
      printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
      printf '!! Could not read ORCHESTRATION_PROTOCOL_VERSION from %s\n' "$protocol_file"
      printf '!! on %s (%s) or HEAD (%s). Check the wire protocol by hand.\n' \
        "$fork_branch" "${before:-missing}" "${after:-missing}"
      printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    } >&2
    return
  fi
  if [[ "$before" == "$after" ]]; then
    say "Orchestration protocol: ${after} (unchanged from ${fork_branch})"
    return
  fi
  {
    printf '\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
    printf '!! WARNING: ORCHESTRATION_PROTOCOL_VERSION changes from %s to %s.\n' "$before" "$after"
    printf '!!\n'
    printf '!! Servers built from this sync refuse clients on protocol %s. The\n' "$before"
    printf '!! official App Store / Google Play app follows upstream releases and may\n'
    printf '!! stop connecting ("Client not supported") until it speaks protocol %s.\n' "$after"
    printf '!! Desktop and web from the same fork release are not affected.\n'
    printf '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n'
  } >&2
}

# Typecheck the packages the fork touches, then run the tests beside every
# file the fork changes relative to upstream.
run_fork_checks() {
  command -v vp >/dev/null 2>&1 || die "vp is not on PATH (try: . ~/.config/vite-plus/env)"
  say "Installing dependencies"
  vp i

  say "Typechecking server, desktop, web, shared and scripts"
  vp run --filter t3 --filter @t3tools/desktop --filter @t3tools/web --filter @t3tools/shared \
    --filter @t3tools/scripts typecheck

  local tests=() file candidate candidates
  while IFS= read -r file; do
    case "$file" in
      apps/server/* | apps/desktop/* | apps/web/* | packages/shared/* | scripts/*) ;;
      *) continue ;;
    esac
    case "$file" in
      *.test.ts | *.test.tsx) candidates=("$file") ;;
      *.ts | *.tsx) candidates=("${file%.*}.test.ts" "${file%.*}.test.tsx") ;;
      *) continue ;;
    esac
    for candidate in "${candidates[@]}"; do
      if [[ -f "$candidate" ]]; then tests+=("$candidate"); fi
    done
  done < <(git diff --name-only --diff-filter=AMR "$target" HEAD)

  if [[ ${#tests[@]} -eq 0 ]]; then
    say "No fork-touched test files to run"
    return
  fi
  mapfile -t tests < <(printf '%s\n' "${tests[@]}" | sort -u)
  say "Running ${#tests[@]} test file(s) next to fork changes"
  vp test run "${tests[@]}"
}

cd "$(git rev-parse --show-toplevel)"
rebase_in_progress && die "a rebase is in progress; finish it ('git rebase --continue') or abort it first"

if [[ "$mode" == "checks" ]]; then
  git rev-parse -q --verify "refs/remotes/${target}" >/dev/null || die "${target} is not fetched yet"
  check_protocol_version
  run_fork_checks
  say "Checks passed on $(git branch --show-current)"
  exit 0
fi

git rev-parse -q --verify "refs/heads/${fork_branch}" >/dev/null || die "no local branch '${fork_branch}'"
[[ -z "$(git status --porcelain)" ]] || die "the working tree has changes; commit them or move them aside first"

if ! git remote get-url upstream >/dev/null 2>&1; then
  say "Adding remote 'upstream' (${upstream_url}), fetch only"
  git remote add upstream "$upstream_url"
  git remote set-url --push upstream DISABLED
fi
say "Fetching upstream"
git fetch --no-tags upstream "+refs/heads/${upstream_ref}:refs/remotes/${target}"

sync_branch="sync/$(date +%Y-%m-%d)"
suffix=2
while git rev-parse -q --verify "refs/heads/${sync_branch}" >/dev/null; do
  sync_branch="sync/$(date +%Y-%m-%d)-${suffix}"
  suffix=$((suffix + 1))
done

say "Rebasing $(git rev-list --count "${target}..${fork_branch}") fork commit(s) of '${fork_branch}' onto $(git rev-list --count "${fork_branch}..${target}") new upstream commit(s), on ${sync_branch}"
git switch -q -c "$sync_branch" "$fork_branch"

# During a rebase "them" is the fork commit being replayed, so "deleted by
# them" (UD) is a file the fork deleted and upstream changed since: it stays
# deleted. Every other conflict needs a human.
auto_resolved=()
if ! git rebase --empty=drop "$target"; then
  while rebase_in_progress; do
    stopped_at="$(git rev-parse -q --verify REBASE_HEAD || true)"
    hard=()
    while IFS= read -r -d '' entry; do
      status="${entry:0:2}"
      path="${entry:3}"
      case "$status" in
        UD)
          git rm -q -- "$path"
          auto_resolved+=("$path")
          ;;
        DD | AU | UA | DU | AA | UU) hard+=("${status} ${path}") ;;
      esac
    done < <(git status --porcelain=v1 -z)

    if [[ ${#hard[@]} -gt 0 ]]; then
      {
        printf '\nsync-upstream: stopped on conflicts that need a human.\n'
        if [[ -n "$stopped_at" ]]; then
          printf '\n  while applying: %s\n' "$(git log -1 --format='%h %s' "$stopped_at")"
        fi
        printf '\n'
        printf '    %s\n' "${hard[@]}"
        if [[ ${#auto_resolved[@]} -gt 0 ]]; then
          printf '\n  kept deleted so far (the fork removed them, upstream changed them):\n'
          printf '    %s\n' "${auto_resolved[@]}"
        fi
        printf '\n  Resolve and stage the files above, then run git rebase --continue.\n'
        printf '  Rerun this script with --checks-only once the rebase has finished.\n'
        printf '  To give up: git rebase --abort && git switch %s && git branch -D %s\n' \
          "$fork_branch" "$sync_branch"
      } >&2
      exit 2
    fi

    if git diff --cached --quiet; then
      # Nothing of this fork commit is left once its deletions are kept.
      git rebase --skip >/dev/null 2>&1 || true
    else
      GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 || true
    fi
    if rebase_in_progress && [[ "$(git rev-parse -q --verify REBASE_HEAD || true)" == "$stopped_at" ]] &&
      ! git diff --name-only --diff-filter=U | grep -q .; then
      die "the rebase stopped at $(git log -1 --format='%h %s' "$stopped_at") for a reason other than a conflict; see git status"
    fi
  done
fi

say "Rebased: ${sync_branch} is $(git rev-list --count "${target}..HEAD") commit(s) on top of ${target}"
if [[ ${#auto_resolved[@]} -gt 0 ]]; then
  printf '  kept deleted (the fork removed them, upstream changed them):\n'
  printf '    %s\n' "${auto_resolved[@]}" | sort -u
fi
check_protocol_version

if "$run_checks"; then
  run_fork_checks
fi

cat <<EOF

Done. Nothing was pushed and '${fork_branch}' is unchanged.

  Inspect:    git log --oneline ${target}..${sync_branch}
              git range-diff ${target}...${fork_branch} ${target}...${sync_branch}
  Adopt it:   git switch ${fork_branch} && git reset --hard ${sync_branch}
  Publish:    git push --force-with-lease origin ${fork_branch}
  Clean up:   git branch -D ${sync_branch}
EOF
