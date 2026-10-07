#!/bin/bash
# weekly-snapshot.sh: one local git commit of memory/, wiki/ and .learnings/ in THIS agent folder. Run by the
# talos-weekly-snapshot Chronos job; you can run it by hand too.
#
#   bash scripts/weekly-snapshot.sh
#
# WHY A SCRIPT: the job used to hand Claude the git commands. Under a restricted tool list (Chronos 0.2.2) the
# only shell command that job may run is THIS file, so the whole job is exactly what is written below and
# nothing else: it stages three named folders, refuses a .env or a personal/ folder, makes ONE commit, and never
# touches a remote, history or the rest of the repository. A prefix rule like `git commit -m:*` cannot say that
# (it would also allow `--amend`); a script can.
#
# Exit 0: committed, or nothing to commit, or not a git repository (all reported on stdout). Exit 1: refused
# or failed (the message says why).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(cd "$HERE/.." && pwd)"
cd "$AGENT_DIR" || { echo "snapshot: cannot enter $AGENT_DIR"; exit 1; }

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "snapshot: this folder is not a git repository; nothing done (no git init here)"; exit 0; }
# the repository must BE this folder: a parent repository would be committing someone else's files
[ "$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" = "$(pwd -P)" ] || { echo "snapshot: the git repository is not this agent folder ($(git rev-parse --show-toplevel)); refusing"; exit 1; }

PATHS=""
for p in memory wiki .learnings; do [ -d "$p" ] && [ ! -L "$p" ] && PATHS="$PATHS $p"; done
[ -n "$PATHS" ] || { echo "snapshot: none of memory, wiki, .learnings exists; nothing to do"; exit 0; }

# Only paths git actually reports a change in: `git add -- <an existing but empty folder>` fails with "pathspec did not match",
# and a commit naming an unchanged path is pointless. (An empty memory/ next to a dirty wiki/ must not stop the snapshot.)
CH=""
for p in $PATHS; do [ -n "$(git status --porcelain -- "$p")" ] && CH="$CH $p"; done
[ -n "$CH" ] || { echo "snapshot: nothing to commit"; exit 0; }
PATHS="$CH"

# refuse BEFORE staging: a .env file or anything under a personal/ folder among the changes. `-z` gives NUL-separated,
# UNQUOTED paths (plain porcelain output wraps a name with a space or a non-ASCII character in quotes, which would hide it
# from this check). A record is "XY path" (a rename is followed by its original path), so the patterns allow a space before the
# name. The `.env.example` exemption belongs to the .env pattern ONLY: memory/personal/x.env.example is still refused.
# shellcheck disable=SC2086
ST="$(git status --porcelain -z --untracked-files=all -- $PATHS | tr '\0' '\n')"
BAD="$( { printf '%s\n' "$ST" | grep -E '(^|[/ ])personal/'
          printf '%s\n' "$ST" | grep -E '(^|[/ ])\.env($|\.)' | grep -v '\.env\.example$'; } | head -5)"
if [ -n "$BAD" ]; then echo "snapshot: REFUSED, these changed paths must never be committed:"; echo "$BAD"; exit 1; fi

# shellcheck disable=SC2086
git add -- $PATHS || { echo "snapshot: git add failed"; exit 1; }
# shellcheck disable=SC2086
N="$(git diff --cached --name-only -- $PATHS | wc -l | tr -d ' ')"
# commit ONLY those paths, so anything else already staged in this repository is left alone
# shellcheck disable=SC2086
git commit -q -m "weekly snapshot $(date +%Y-%m-%d)" -- $PATHS >/dev/null || { echo "snapshot: git commit failed"; exit 1; }
echo "snapshot: committed $N file(s) as $(git rev-parse --short HEAD)"
