#!/usr/bin/env bash
# The pre-push hook. Fail closed: any failure, or a check that cannot run, refuses the push (git push --no-verify is the
# owner's own override, never a builder's). Two parts:
#   1. The personal-data check of what is being PUSHED: every commit in the range (the files it changes, as committed) and its
#      message, with the maintainer's private list from the main checkout when there is one (it says so when there is none).
#      A hit stops the push; there is no warning-only mode.
#   2. scripts/gate.sh, the one gate every machine runs: typecheck, lint, the personal-data check, the size budget and the test
#      suites this push touches (all of them when the hook cannot tell what the push contains). It is the fast gate (gate.sh
#      --fast, which falls back to the full gate where it must, and says which ran and why) unless GATE_FULL=1 asks for the full one.
# A handoff branch (refs/heads/handoff/<machine>/<name>) gets part 1 only: a machine that cannot gate hands its work to one
# that can, which lands it with `scripts/gate.sh --push --from` (the whole gate, then main). No other branch is spared part 2.
# The gate reads files on disk, so they must be the ones being pushed: uncommitted edits, or another branch checked out, refuse
# the push. Git gives the hook one line per ref on stdin: <local ref> <local sha> <remote ref> <remote sha>.
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

CHANGED="$(mktemp "${TMPDIR:-/tmp}/talos-pre-push.XXXXXX")" # the changed files still there, to compare with the disk
SCAN_DIR=""
trap 'rm -f "$CHANGED"; [ -z "$SCAN_DIR" ] || rm -rf "$SCAN_DIR"' EXIT # also on Ctrl-C: the INT trap below exits
trap 'exit 130' INT TERM
PERSONAL_RC=0
SCAN_ENDS="the push is stopped"
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
  local common main="" l sha base commits c bad=0 d
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
  while read -r sha base; do
    [ -n "$sha" ] || continue
    c="$(git rev-parse --verify -q "$sha^{commit}")" || { echo "pre-push: $sha is not a commit I can read; $SCAN_ENDS" >&2; bad=1; continue; }
    if [ "$base" = none ]; then
      scan_commit "$c" 1 || bad=1 # no idea where the push starts: the whole tree of its tip
    else
      commits="$(git rev-list "$base..$c" $NOT_MAIN)" || { echo "pre-push: cannot list the commits of the push; $SCAN_ENDS" >&2; bad=1; continue; }
      for l in $commits; do scan_commit "$l" 0 || bad=1; done
    fi
  done <<EOF
$PUSHES
EOF
  return $bad
}
# nl_names: NUL-separated names on stdin (git's -z, so none is ever a quoted C string, whatever core.quotePath says), one per line
# on stdout. A name with a newline in it cannot be one line: exit 3, and the caller refuses. (A name holding byte 036, the
# stand-in for a newline here, is taken for one: a refusal too, never a pass.)
nl_names() {
  local out
  out="$(tr '\n\000' '\036\n')" || return 1
  case "$out" in *$'\036'*) return 3 ;; esac
  printf '%s\n' "$out"
}
ANY=0 ALL=0 SHAS="" GATE_BASE="" HANDOFF=0
while read -r _lref lsha rref rsha; do
  [ -n "${lsha:-}" ] || continue
  [ "$lsha" = "$ZERO" ] && continue # deleting a branch: nothing to check
  # the push lease (scripts/gate.sh --push), never code: refs/locks/push, a commit (not a tag) with an empty tree, no parent
  # and a message in exactly the lease's form (so nothing else, personal data included, can ride on it unscanned); and the
  # queue for it, refs/locks/wait/<machine>, held to the same rules in its own form
  case "$rref" in refs/locks/*)
    if [ "$rref" = refs/locks/push ] && [ "$(git cat-file -t "$lsha" 2>/dev/null)" = commit ] &&
      [ "$(git rev-parse "$lsha^{tree}" 2>/dev/null)" = "$(git hash-object -t tree /dev/null)" ] &&
      [ "$(git rev-list --parents -n 1 "$lsha" | wc -w | tr -d ' ')" = 1 ] &&
      [ "$(git log -1 --format=%B "$lsha" | sed '/^$/d' | grep -Exc -e 'talos push lease' -e 'machine=[A-Za-z0-9._-]{1,63}' \
        -e 'until=[0-9]{1,12}' -e 'until_iso=[0-9TZ:.-]{1,32}' -e 'pid=[0-9]{1,10}')" = 5 ] &&
      [ "$(git log -1 --format=%B "$lsha" | sed '/^$/d' | wc -l | tr -d ' ')" = 5 ] &&
      [ "$(git log -1 --format=%B "$lsha" | sed -n 1p)" = "talos push lease" ] &&
      [ "$(git log -1 --format=%B "$lsha" | sed '/^$/d' | sed 1d | cut -d= -f1 | sort -u | tr '\n' ' ')" = "machine pid until until_iso " ]; then
      continue
    fi
    # a machine's place in the queue for the lease: refs/locks/wait/<machine>, the same empty commit, its own form
    wmsg="$(git log -1 --format=%B "$lsha" 2>/dev/null | sed '/^$/d')"
    if [ "${rref#refs/locks/wait/}" != "$rref" ] && [ "$(git cat-file -t "$lsha" 2>/dev/null)" = commit ] &&
      [ "$(git rev-parse "$lsha^{tree}" 2>/dev/null)" = "$(git hash-object -t tree /dev/null)" ] &&
      [ "$(git rev-list --parents -n 1 "$lsha" | wc -w | tr -d ' ')" = 1 ] &&
      { { [ "$(printf '%s\n' "$wmsg" | wc -l | tr -d ' ')" = 5 ] &&
        [ "$(printf '%s\n' "$wmsg" | sed 1d | cut -d= -f1 | sort -u | tr '\n' ' ')" = "machine pid seen since " ]; } ||
        { [ "$(printf '%s\n' "$wmsg" | wc -l | tr -d ' ')" = 6 ] && # with a red-main claim (gate.sh --push --red-main)
          [ "$(printf '%s\n' "$wmsg" | grep -Exc -e 'red_main=[0-9a-f]{40}')" = 1 ] &&
          [ "$(printf '%s\n' "$wmsg" | sed 1d | cut -d= -f1 | sort -u | tr '\n' ' ')" = "machine pid red_main seen since " ]; }; } &&
      [ "$(printf '%s\n' "$wmsg" | sed -n 1p)" = "talos push wait" ] &&
      [ "$(printf '%s\n' "$wmsg" | grep -Exc -e 'machine=[A-Za-z0-9._-]{1,63}' -e 'since=[0-9]{1,12}' -e 'seen=[0-9]{1,12}' -e 'pid=[0-9]{1,10}')" = 4 ] &&
      [ "refs/locks/wait/$(printf '%s\n' "$wmsg" | sed -n 's/^machine=//p')" = "$rref" ]; then
      continue
    fi
    # a red-main jump, once per machine per red (scripts/gate-push.sh): refs/locks/red-main/<machine>/<red sha>, the same
    # empty commit, its own form
    if [ "${rref#refs/locks/red-main/}" != "$rref" ] && [ "$(git cat-file -t "$lsha" 2>/dev/null)" = commit ] &&
      [ "$(git rev-parse "$lsha^{tree}" 2>/dev/null)" = "$(git hash-object -t tree /dev/null)" ] &&
      [ "$(git rev-list --parents -n 1 "$lsha" | wc -w | tr -d ' ')" = 1 ] &&
      [ "$(printf '%s\n' "$wmsg" | wc -l | tr -d ' ')" = 5 ] &&
      [ "$(printf '%s\n' "$wmsg" | sed -n 1p)" = "talos red-main" ] &&
      [ "$(printf '%s\n' "$wmsg" | grep -Exc -e 'machine=[A-Za-z0-9._-]{1,63}' -e 'red=[0-9a-f]{40}' -e 'failed=[A-Za-z0-9._/,-]{1,255}' -e 'at=[0-9]{1,12}')" = 4 ] &&
      [ "$(printf '%s\n' "$wmsg" | sed 1d | cut -d= -f1 | sort -u | tr '\n' ' ')" = "at failed machine red " ] &&
      [ "refs/locks/red-main/$(printf '%s\n' "$wmsg" | sed -n 's/^machine=//p')/$(printf '%s\n' "$wmsg" | sed -n 's/^red=//p')" = "$rref" ]; then
      continue
    fi
    echo "pre-push: REFUSED: refs/locks/ holds only the push lease (refs/locks/push, an empty commit in the lease's form), the queue for it (refs/locks/wait/<machine>) and red-main jumps (refs/locks/red-main/<machine>/<sha>)" >&2
    exit 1
    ;;
  esac
  # A handoff: a machine that cannot gate (too slow, or a broken environment) hands finished work to one that can, which
  # lands it with `scripts/gate.sh --push --from <remote>/handoff/<machine>/<name>` (full gate, then main by sha). Only
  # under refs/heads/handoff/<machine>/<name>; it gets the personal-data check of its commits (always, fail closed) and
  # not the gate. Every other ref in the same push is checked as usual.
  case "$rref" in refs/heads/handoff/*)
    if ! printf '%s\n' "$rref" | grep -Eqx 'refs/heads/handoff/[A-Za-z0-9._-]{1,63}/[A-Za-z0-9._-]{1,80}'; then
      echo "pre-push: REFUSED: a handoff branch is refs/heads/handoff/<machine>/<name> (letters, digits and . _ -)" >&2
      exit 1
    fi
    # no private list here: the generic rules run (a hit still refuses), and the landing machine scans it with the private list
    # too (gate-push.sh --from refuses without one, unless Delphi's personal-ok stamp for this exact tip is on the remote)
    common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
    if [ ! -f scripts/personal-denylist.txt ] && { [ -z "$common" ] || [ ! -f "$(dirname "$common")/scripts/personal-denylist.txt" ]; } &&
      [ -z "${CHECK_EXTRA_RULES:-}" ]; then
      echo "pre-push: a handoff from a machine with no private list: the generic rules run here; the private-list scan happens at landing" >&2
    fi
    # What the handoff is: every commit it has on top of the remote's main (<main>..<tip>), whatever the ref held before. Never
    # <old ref>..<tip>: after a rebase onto a newer main and a force-push, that range holds main's new commits too (refused for
    # gate inputs the handoff never touched), and on a plain push it skips commits the old ref holds that main has not (let
    # through unchecked, though the landing replays them). <main>..<tip> holds every commit the landing replays, and only those.
    if [ -n "$REMOTE_MAIN" ] && b="$(git merge-base "$REMOTE_MAIN" "$lsha" 2>/dev/null)"; then
      PUSHES="$PUSHES$lsha $b"$'\n'
      names="$(git diff -z --name-only --no-renames "$b" "$lsha" | nl_names)" || { echo "pre-push: REFUSED: cannot list the handoff's files (or a name in it holds a newline)" >&2; exit 1; }
      range="$REMOTE_MAIN..$lsha"
    elif b="$(base_of "$lsha" "$rsha")"; then # no main here to read against: today's base (the old ref)
      PUSHES="$PUSHES$lsha $b"$'\n'
      range="$b..$lsha"
      names="$(git diff -z --name-only --no-renames "$b" "$lsha" | nl_names)" || { echo "pre-push: REFUSED: cannot list the handoff's files (or a name in it holds a newline)" >&2; exit 1; }
    else
      PUSHES="$PUSHES$lsha none"$'\n'
      range="$lsha"
      names="$(git ls-tree -r -z --name-only "$lsha" | nl_names)" || { echo "pre-push: REFUSED: cannot list the handoff's files (or a name in it holds a newline)" >&2; exit 1; }
    fi
    # main and the handoff share no history at all: still every commit the handoff has that main has not
    [ -z "$REMOTE_MAIN" ] || range="$REMOTE_MAIN..$lsha"
    # a handoff is a straight line of commits: the landing machine's rebase drops merges and replays their side commits
    merges="$(git rev-list --merges "$range")" || { echo "pre-push: REFUSED: cannot list the handoff's commits" >&2; exit 1; }
    [ -z "$merges" ] || {
      echo "pre-push: REFUSED: the handoff holds a merge commit (${merges:0:7}): rebase it onto main, then hand it off again" >&2
      exit 1
    }
    # The push path is never handed off: the landing machine would check it with the handoff's own versions. The push path is
    # the one list, scripts/gate-inputs.txt (main's copy when this clone has the remote's main, else this checkout's), matched
    # with names folded as a Mac's disk folds them (scripts/path-fold.sh). The landing machine checks again with main's list.
    [ -f scripts/path-fold.sh ] || { echo "pre-push: REFUSED: scripts/path-fold.sh is missing, so the handoff's files cannot be checked" >&2; exit 1; }
    # shellcheck source=scripts/path-fold.sh
    . scripts/path-fold.sh
    pats=""
    [ -z "$REMOTE_MAIN" ] || pats="$(git show "$REMOTE_MAIN:scripts/gate-inputs.txt" 2>/dev/null)" || pats=""
    [ -n "$pats" ] || pats="$(cat scripts/gate-inputs.txt 2>/dev/null)" || pats=""
    [ -n "$pats" ] || { echo "pre-push: REFUSED: no gate-inputs list (scripts/gate-inputs.txt), so the handoff's files cannot be checked" >&2; exit 1; }
    # every commit's names, not the net diff (a gate input changed and put back is still replayed at landing: Fable R1-1)
    f="$(path_fold_range <(printf '%s\n' "$pats") "$range")"
    rc=$?
    [ "$rc" = 0 ] || [ "$rc" = 1 ] || { echo "pre-push: REFUSED: the handoff's files could not be checked against the gate-inputs list (exit $rc)" >&2; exit 1; }
    if [ "$rc" = 0 ]; then
      echo "pre-push: REFUSED: a handoff may not change the push path ($f, a gate input: scripts/gate-inputs.txt). Push a plain branch instead; the landing machine reads the scripts/ diff itself and lands it by cherry-pick (that read is the trust step)." >&2
      exit 1
    fi
    HANDOFF=1
    continue
    ;;
  esac
  ANY=1
  SHAS="$SHAS $lsha"
  if b="$(base_of "$lsha" "$rsha")"; then
    PUSHES="$PUSHES$lsha $b"$'\n'
    [ -n "$GATE_BASE" ] || GATE_BASE="$b"
    git diff --name-only -z --no-renames --diff-filter=d "$b" "$lsha" >> "$CHANGED" || ALL=1
  else
    PUSHES="$PUSHES$lsha none"$'\n'
    ALL=1 # no idea what this push contains: check everything
  fi
done
[ "$ANY" = 1 ] || [ "$HANDOFF" = 1 ] || exit 0
personal || PERSONAL_RC=1
if [ "$ANY" = 0 ]; then # handoff branches only: the personal-data check is all they get, and all they need here
  [ "$PERSONAL_RC" = 0 ] || { echo "pre-push: REFUSED: the personal-data check failed (above)" >&2; exit 1; }
  echo "pre-push: a handoff branch: the personal-data check passed; the landing machine runs the gate" >&2
  exit 0
fi

# The gate checks the files on disk, so they must be what is being pushed. Otherwise the push is refused: fail closed.
for sha in $SHAS; do
  # --literal-pathspecs: each name is that file, never a pattern (a * or a backslash in a name)
  [ ! -s "$CHANGED" ] || xargs -0 git --literal-pathspecs diff --quiet "$sha" -- < "$CHANGED" || {
    echo "pre-push: REFUSED: the files on disk aren't what you are pushing (uncommitted edits, or another branch checked out). Commit or stash them, or push from that branch's checkout." >&2
    exit 1
  }
done
[ "$PERSONAL_RC" = 0 ] || { echo "pre-push: REFUSED: the personal-data check failed (above)" >&2; exit 1; }

# One gate for every machine (scripts/gate.sh): typecheck, lint, the personal-data check of the tree, the size budget and the
# suites this push touches. It refuses on any failure, and when it cannot run (no node, no pnpm, no node_modules).
# exec replaces this shell, so its EXIT trap would never run: the temp file goes first.
rm -f "$CHANGED"
trap - EXIT
if [ "$ALL" = 1 ] || [ -z "$GATE_BASE" ]; then exec bash scripts/gate.sh --full; fi
# scripts/gate.sh --push ran the gate on exactly this tree, from this base, with this plan and this gate, a moment ago: the
# stamp says so, and the gate is not run a second time. Anything else about it (another tree or base, another version of the
# gate or of this hook, older than 30 minutes) and the gate runs here as usual.
stamp="$(git rev-parse --absolute-git-dir)/talos-gate.pass"
field() { sed -n "s/^$1=//p" "$stamp" 2>/dev/null | head -1; }
sum() { { shasum -a 256 "$1" 2>/dev/null || sha256sum "$1" 2>/dev/null; } | cut -d' ' -f1; }
sum_in() { { shasum -a 256 2>/dev/null || sha256sum 2>/dev/null; } | cut -d' ' -f1; }
# the gate's own code, one sha: scripts/gate.sh, then every file under scripts/gate/ in byte order (a change to any of them is
# another gate); nothing printed when gate.sh is missing. The gate-push.sh stamp computes it the same way (scripts/gate-push.sh).
gate_sha() {
  local f
  [ -f scripts/gate.sh ] || return 0
  { cat scripts/gate.sh; find scripts/gate -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do cat "$f"; done; } | sum_in
}
at="$(field at)"
case "$at" in '' | 0?* | *[!0-9]* | ????????????*) at="" ;; esac # a number of seconds (no leading 0), or no stamp age at all
age=$(($(date +%s) - ${at:-0}))
gate_sum="$(gate_sha)"
hook_sum="$(sum scripts/pre-push.sh)"
one_sha="${SHAS# }"
if [ -f "$stamp" ] && [ -n "$at" ] && [ "$age" -ge 0 ] && [ "$age" -lt 1800 ] && [ "${one_sha#* }" = "$one_sha" ] &&
  [ -n "$gate_sum" ] && [ -n "$hook_sum" ] && [ -n "$(field plan)" ] &&
  [ "$(field tree)" = "$(git rev-parse "$one_sha^{tree}" 2>/dev/null)" ] && [ "$(field base)" = "$GATE_BASE" ] &&
  [ "$(field gate)" = "$gate_sum" ] && [ "$(field hook)" = "$hook_sum" ] &&
  plan="$(bash scripts/gate.sh --plan --base "$GATE_BASE" 2>/dev/null)" && [ -n "$plan" ] &&
  [ "$(field plan)" = "$(printf '%s' "$plan" | sum_in)" ]; then
  echo "pre-push: the gate passed on this tree ${age} s ago ($(field mode)): not run again" >&2
  exit 0
fi
# The fast gate (gate.sh --fast: the full gate itself for a change on its keep-out list or one it cannot follow, saying why; CI
# runs everything after the push), measured from GATE_BASE: the remote's old tip, or for a new branch its merge base with the
# remote's main. A hook takes no flags: GATE_FULL=1 in the environment asks for the full gate (gate.sh --push --full sets it).
if [ "${GATE_FULL:-}" = 1 ]; then
  echo "pre-push: the full gate (GATE_FULL=1)" >&2
  exec bash scripts/gate.sh --base "$GATE_BASE"
fi
echo "pre-push: the fast gate where this change allows it (GATE_FULL=1 for the full gate)" >&2
exec bash scripts/gate.sh --base "$GATE_BASE" --fast
