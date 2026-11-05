#!/usr/bin/env bash
# The pre-push hook: the personal-data check, then format, lint and type-check what this push changes, in about 10 seconds, so a
# typo fails here and not after the code is on main. The personal-data check (scripts/check-no-personal.sh, the repo's
# `pnpm check:personal`) comes first and always runs, but it only warns by default (docs/CI-LOCAL.md, "The personal-data scan").
# TALOS_PERSONAL_SCAN=stop makes it stop this push.
# It also runs a maintainer's private list when the main checkout of this repository has one (a worktree has none of its own). The
# rest never replaces CI, so it stays quick: biome on the changed files, tsc on the changed packages (not on what depends on them:
# CI does that, after the push). tsc gets 8 seconds (PRE_PUSH_TSC_SECONDS): on a quiet Mac that is plenty, and with CI
# running it can take 30, so it is cut off and the push goes on, because a hook that holds up every push gets --no-verify.
#
# Git gives it one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>. A change it cannot place in
# one package (root config, the lockfile) type-checks everything. It reads files on disk, so when those aren't what is being
# pushed, it says so and lets the push go. So it does with no node_modules, or no node or pnpm on PATH (a launchd job, a GUI
# git client): a check that can't run is not a code problem.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1
ZERO=0000000000000000000000000000000000000000
# Git hands the hook the remote's name (or its URL, when pushed to a URL) as the first argument. What "already on main" means is
# that remote's main, not always origin's: a push to a fork has not got the commits that only origin/main has.
REMOTE_MAIN=""
git rev-parse --verify -q "refs/remotes/${1:-origin}/main" >/dev/null 2>&1 && REMOTE_MAIN="refs/remotes/${1:-origin}/main"
base_of() { # base_of <local sha> <remote sha>: where this push starts from
  local b
  [ "$2" != "$ZERO" ] && git cat-file -e "$2^{commit}" 2>/dev/null && { echo "$2"; return 0; }
  [ -n "$REMOTE_MAIN" ] && b="$(git merge-base "$REMOTE_MAIN" "$1" 2>/dev/null)" && { echo "$b"; return 0; }
  return 1
}

CHANGED="$(mktemp "${TMPDIR:-/tmp}/talos-pre-push.XXXXXX")" # what goes to biome: changed files still there
TOUCHED="$(mktemp "${TMPDIR:-/tmp}/talos-pre-push.XXXXXX")" # what picks packages: deleted files count, others may import them
TYPES_PID=""
SCAN_DIR=""
TYPES_OUT="$(mktemp "${TMPDIR:-/tmp}/talos-pre-push.XXXXXX")" # what the type check printed; shown only if it finished
CUT=0
trap 'rm -f "$CHANGED" "$TOUCHED" "$TYPES_OUT"; [ -z "$SCAN_DIR" ] || rm -rf "$SCAN_DIR"' EXIT # also on Ctrl-C: the INT trap below exits
# capped() puts the type check in a group of its own, out of reach of the terminal's Ctrl-C, so it has to be stopped from here.
trap '[ -z "$TYPES_PID" ] || kill -TERM -- "-$TYPES_PID" 2>/dev/null; exit 130' INT TERM
PERSONAL_RC=0
SCAN_MODE="${TALOS_PERSONAL_SCAN:-warn}" # the one place that default lives: change it to stop to make the scan a hard stop (docs/CI-LOCAL.md)
if [ "$SCAN_MODE" = stop ]; then SCAN_ENDS="the push is stopped"; else SCAN_ENDS="warning only, the push goes on"; fi
skip() { echo "pre-push: $1; skipping the lint and type checks (the personal-data check above already ran). They run in CI, after the push." >&2; exit $PERSONAL_RC; }
# The personal-data check reads what is being pushed, not the working tree: every commit in the range (the files it changes, as
# committed) and its message. So a value that a later commit removes, a file deleted on disk, or a push of another branch than
# the one checked out cannot slip past. The private list and private-docs list are gitignored, so a worktree does
# not have them: look in the main checkout of this repository and hand them over.
PUSHES=""
fold_key() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | cksum | cut -d' ' -f1; } # the same for paths that differ only by case
scan_commit() { # scan_commit <commit> <whole tree: 1|0>: the commit's message and files, as committed, through check-no-personal.sh
  # The files go into numbered folders under one temp folder. A path goes into the first folder that holds no path equal to it
  # when case is ignored (and where it can be written at all), so on a disk that ignores case two files that differ only by case
  # are both scanned, each in a folder of its own, and a file cannot hide the message: that is written first, under a name no file
  # of the commit has.
  local c="$1" whole="$2" d f rc=0 msg=.commit-message n=0 k key dir b
  d="$(mktemp -d "${TMPDIR:-/tmp}/talos-pre-push.XXXXXX")" || return 1
  SCAN_DIR="$d" # the EXIT trap removes it if the hook is interrupted
  mkdir "$d/fold" "$d/1" || { rm -rf "$d"; SCAN_DIR=""; return 1; }
  while git cat-file -e "$c:$msg" 2>/dev/null; do n=$((n + 1)); msg=".commit-message.$n"; done
  git log -1 --format=%B "$c" > "$d/1/$msg" || { rm -rf "$d"; SCAN_DIR=""; return 1; }
  : > "$d/fold/1.$(fold_key "$msg")"
  # The listing goes to a file first: a git that fails half way must stop the push, not look like a shorter list.
  # -c: for a merge, only the files that differ from every parent (a file taken whole from one side was already checked there).
  if [ "$whole" = 1 ]; then git ls-tree -r -z --name-only "$c" > "$d/names"
  else git diff-tree -r -z --name-only --no-renames --diff-filter=d -c --root --no-commit-id "$c" > "$d/names"; fi || {
    echo "pre-push: could not list the files of commit ${c:0:12}; $SCAN_ENDS" >&2
    rm -rf "$d"; SCAN_DIR=""; return 1
  }
  while IFS= read -r -d '' f; do
    [ "$(git cat-file -t "$c:$f" 2>/dev/null)" = blob ] || continue # a submodule or the like has no text here
    key="$(fold_key "$f")" k=1
    while [ -e "$d/fold/$k.$key" ] || [ -e "$d/$k/$f" ] || ! mkdir -p "$d/$k/$(dirname -- "$f")" 2>/dev/null; do
      k=$((k + 1))
      [ "$k" -le 50 ] || { echo "pre-push: too many paths that differ only by case in commit ${c:0:12}; $SCAN_ENDS" >&2; rm -rf "$d"; SCAN_DIR=""; return 1; }
    done
    git cat-file blob "$c:$f" > "$d/$k/$f" || { rm -rf "$d"; SCAN_DIR=""; return 1; }
    : > "$d/fold/$k.$key"
  done < "$d/names"
  # CHECK_NO_GIT: these files are exactly the commit's, so the scanner lists them with find. Inside a linked worktree git exports
  # GIT_DIR to the hook, and a listing that followed it would read the worktree's index and ignore rules instead.
  for dir in "$d"/[0-9]*; do
    [ -d "$dir" ] || continue
    CHECK_NO_GIT=1 CHECK_EXTRA_RULES="$EXTRA_RULES" CHECK_PRIVATE_DOCS="$EXTRA_DOCS" bash scripts/check-no-personal.sh "$dir" >&2 || {
      echo "pre-push: the personal-data check failed on commit ${c:0:12} (see above); $SCAN_ENDS" >&2
      rc=1
    }
  done
  rm -rf "$d"; SCAN_DIR=""
  return $rc
}
personal() {
  local common main="" l sha base commits c bad=0 d limit count
  if [ ! -f scripts/check-no-personal.sh ]; then
    echo "pre-push: scripts/check-no-personal.sh is missing, so the personal-data check could not run; $SCAN_ENDS" >&2
    return 1
  fi
  EXTRA_RULES="${CHECK_EXTRA_RULES:-}" EXTRA_DOCS="${CHECK_PRIVATE_DOCS:-}"
  if common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then main="$(dirname "$common")"; fi
  if [ ! -f scripts/personal-denylist.txt ] && [ -n "$main" ] && [ -f "$main/scripts/personal-denylist.txt" ]; then
    EXTRA_RULES="${EXTRA_RULES:+$EXTRA_RULES:}$main/scripts/personal-denylist.txt"
  fi
  if [ ! -f scripts/private-docs.txt ] && [ -n "$main" ] && [ -f "$main/scripts/private-docs.txt" ]; then
    while IFS= read -r d || [ -n "$d" ]; do
      case "$d" in '' | '#'*) continue ;; esac
      EXTRA_DOCS="${EXTRA_DOCS:+$EXTRA_DOCS:}$d"
    done < "$main/scripts/private-docs.txt"
  fi
  if [ ! -f scripts/personal-denylist.txt ] && [ "${EXTRA_RULES#*personal-denylist.txt}" = "$EXTRA_RULES" ]; then
    echo "pre-push: no private list (scripts/personal-denylist.txt) here or in the main checkout; only the generic personal-data rules ran" >&2
  fi
  # Commits already on the pushed-to remote's main are not this push's to fix (a rebase or merge brings them into the range).
  NOT_MAIN=""
  [ -z "$REMOTE_MAIN" ] || NOT_MAIN="--not $REMOTE_MAIN"
  # PRE_PUSH_SCAN_COMMITS is a plain base-10 number (08 is eight). Anything else, empty or 0 or too long to count, means no cap.
  limit="${PRE_PUSH_SCAN_COMMITS-100}"
  case "$limit" in '' | *[!0-9]* | ??????????*) limit="" ;; *) limit=$((10#$limit)) ;; esac
  [ "${limit:-0}" -gt 0 ] || limit="" # 0 is no cap either
  while read -r sha base; do
    [ -n "$sha" ] || continue
    c="$(git rev-parse --verify -q "$sha^{commit}")" || { echo "pre-push: $sha is not a commit I can read; $SCAN_ENDS" >&2; bad=1; continue; }
    if [ "$base" = none ]; then
      scan_commit "$c" 1 || bad=1 # no idea where the push starts: the whole tree of its tip
    else
      commits="$(git rev-list "$base..$c" $NOT_MAIN)" || { echo "pre-push: cannot list the commits of the push; $SCAN_ENDS" >&2; bad=1; continue; }
      count="$(printf '%s\n' "$commits" | grep -c .)"
      if [ -n "$limit" ] && [ "$SCAN_MODE" != stop ] && [ "$count" -gt "$limit" ]; then
        # One scanner run per commit is too slow for a very large push. Warn, never refuse: read the newest commits one by one
        # and the whole tree of the tip, and say what that leaves out. Not in stop mode: that one reads every commit.
        echo "pre-push: this push has $count commits, more than the $limit the personal-data check reads one by one (PRE_PUSH_SCAN_COMMITS). It reads the newest $limit and the whole tree of the tip. The other $((count - limit)) older commits are not checked one by one: their messages, and a value added and taken out again inside them, are not checked. This is a warning only; the push goes on." >&2
        commits="$(printf '%s\n' "$commits" | head -n "$limit")"
        scan_commit "$c" 1 || bad=1
      fi
      for l in $commits; do scan_commit "$l" 0 || bad=1; done
    fi
  done <<EOF
$PUSHES
EOF
  return $bad
}
ANY=0 ALL=0 SHAS=""
while read -r _lref lsha _rref rsha; do
  [ -n "${lsha:-}" ] || continue
  [ "$lsha" = "$ZERO" ] && continue # deleting a branch: nothing to check
  ANY=1
  SHAS="$SHAS $lsha"
  if b="$(base_of "$lsha" "$rsha")"; then
    PUSHES="$PUSHES$lsha $b"$'\n'
    git diff --name-only -z --no-renames --diff-filter=d "$b" "$lsha" >> "$CHANGED" || ALL=1
    git diff --name-only -z --no-renames "$b" "$lsha" >> "$TOUCHED" || ALL=1
  else
    PUSHES="$PUSHES$lsha none"$'\n'
    ALL=1 # no idea what this push contains: check everything
  fi
done
[ "$ANY" = 1 ] || exit 0
personal || { [ "$SCAN_MODE" != stop ] || PERSONAL_RC=1; }

[ -x node_modules/.bin/biome ] || skip "no node_modules here (run pnpm install)"
command -v node >/dev/null 2>&1 || skip "no node on PATH"
command -v pnpm >/dev/null 2>&1 || skip "no pnpm on PATH"
for sha in $SHAS; do
  [ ! -s "$CHANGED" ] || xargs -0 git diff --quiet "$sha" -- < "$CHANGED" ||
    skip "the files on disk aren't what you are pushing (uncommitted edits, or another branch)"
done

rc=$PERSONAL_RC
if [ "$ALL" = 1 ]; then
  node_modules/.bin/biome check . || rc=1
elif [ -s "$CHANGED" ]; then
  # --files-ignore-unknown skips what biome has no parser for.
  xargs -0 node_modules/.bin/biome check --no-errors-on-unmatched --files-ignore-unknown=true < "$CHANGED" || rc=1
fi

# Packages to type-check: the paths decide, because pnpm's own "[base]" filter would miss files outside a package.
FILTERS=() TYPES=none MOD=0
while IFS= read -r -d '' f; do
  case "$f" in
    apps/*/* | packages/*/*) d="$(printf '%s' "$f" | cut -d/ -f1-2)" ;;
    e2e/*) d=e2e ;;
    plugins/*) MOD=1; continue ;;
    *.md | docs/* | scripts/* | .githooks/* | assets/* | examples/* | third_party/* | .github/*) continue ;;
    *) TYPES=all; continue ;; # root config, lockfile, anything new: everything may depend on it
  esac
  [ -f "$d/tsconfig.json" ] || continue
  [ "$TYPES" = all ] || TYPES=some
  FILTERS+=("--filter=./$d")
done < "$TOUCHED"
[ "$ALL" = 1 ] && TYPES=all
# After a rebase onto a new lockfile, node_modules is old and tsc would blame code nobody touched.
if [ "$TYPES" != none ] && [ -f node_modules/.modules.yaml ] && [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  echo "pre-push: pnpm-lock.yaml is newer than node_modules (run pnpm install); skipping the type check. It runs in CI, after the push." >&2
  TYPES=none MOD=0
fi

types() {
  local bad=0
  case "$TYPES" in
    all) pnpm -r --workspace-concurrency=0 --if-present typecheck || bad=1 ;;
    some) pnpm "${FILTERS[@]}" -r --workspace-concurrency=0 --if-present typecheck || bad=1 ;;
  esac
  if [ "$MOD" = 1 ] || [ "$TYPES" = all ]; then pnpm typecheck:mod || bad=1; fi
  return $bad
}
capped() { # capped <cmd...>: its exit code, or 0 with a note if it runs past the budget (the whole process group is stopped)
  local pid ticks=0 limit=$((${PRE_PUSH_TSC_SECONDS:-8} * 4))
  set -m
  "$@" </dev/null &
  pid=$!
  TYPES_PID=$pid
  set +m
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$limit" ]; then
      kill -TERM -- "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      CUT=1
      return 0
    fi
    sleep 0.25
    ticks=$((ticks + 1))
  done
  wait "$pid"
}
if [ "$TYPES" != none ] || [ "$MOD" = 1 ]; then
  # Its output is held back: a type check that is stopped prints "Failed" and a signal, which reads like a real failure.
  capped types >"$TYPES_OUT" 2>&1 || rc=1
  if [ "$CUT" = 1 ]; then
    # whatever it had already found is still worth seeing; the stopped run's own "Failed" noise is not
    grep -F 'error TS' "$TYPES_OUT" >&2 || true
    echo "pre-push: typecheck: skipped, over ${PRE_PUSH_TSC_SECONDS:-8}s, so the push continues; CI runs the full check" >&2
  else
    cat "$TYPES_OUT" >&2
  fi
fi

[ "$rc" = 0 ] || echo "pre-push: fix the above and push again" >&2
exit $rc
