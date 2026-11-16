#!/usr/bin/env bash
# The fresh public snapshot, up to the push and never past it. Run it on the machine that keeps the private personal-data
# list (scripts/personal-denylist.txt), from a clean checkout of a green main:
#
#   scripts/publish-public.sh PUBLIC_REPO_URL WORKDIR
#
#   1. refuses unless the private list is there (here, in the main checkout, or named in PUBLISH_PRIVATE_LIST): only that
#      machine can check everything the snapshot carries
#   2. runs the privacy check on this checkout (the generic list and the private one): a hit stops it
#   3. writes the export (scripts/export-public.sh: the excluded paths left out, the export checked) to WORKDIR/export
#   4. runs the privacy check again on that exported folder, every file read (CHECK_ALL_FILES=1): what would be published
#   5. clones PUBLIC_REPO_URL to WORKDIR/public, replaces its whole tree with the export (its .git kept) and stages that
#   6. prints what the snapshot changes: counts added / changed / removed, the removed files, and every NEW file (public
#      for the first time) grouped by top-level folder with counts, before the push commands
# Then it stops and prints the two commands that publish it (a commit with a changelog message, and the push). It never
# commits or pushes; WORKDIR is left for a look.
# The snapshot commit names the private commit it was made from in a trailer, `Talos-Source: <private sha>`: a commit-msg hook in
# the clone adds it to whatever message the commit is given (replacing one already there). A Mac release names the public commit,
# and apps/desktop/scripts/release-publish.sh follows this trailer back to the private commit whose CI must be green.
#
# Exit codes: 0 staged and summarized, 1 a privacy check or a step failed, 2 bad usage or a refused start.
set -euo pipefail

die() { echo "publish-public: $1" >&2; exit "${2:-2}"; }
[ $# -eq 2 ] || die "usage: publish-public.sh PUBLIC_REPO_URL WORKDIR"
URL="$1"
WORK="$2"
case "$WORK" in /*) ;; *) WORK="$PWD/$WORK" ;; esac

# the public commit's identity is set in the clone; identity variables in this shell would override it
for v in GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL; do
  [ -z "${!v:-}" ] || die "$v is set in this shell and would override the public commit's identity: unset it. Nothing was done."
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(git -C "$HERE/.." rev-parse --show-toplevel)" || die "this script must run from a checkout of the repository"

# 1. the private list and the private docs: next to this script, else in the main checkout (found the way pre-push.sh finds
#    it: beside the common git dir, so a bare-repository layout works too), or named in PUBLISH_PRIVATE_LIST
COMMON="$(git -C "$SRC" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || COMMON=""
MAIN="${COMMON:+$(dirname "$COMMON")}"
LIST="${PUBLISH_PRIVATE_LIST:-}"
if [ -z "$LIST" ]; then
  if [ -f "$HERE/personal-denylist.txt" ]; then
    LIST="$HERE/personal-denylist.txt"
  elif [ -n "$MAIN" ] && [ -f "$MAIN/scripts/personal-denylist.txt" ]; then
    LIST="$MAIN/scripts/personal-denylist.txt"
  fi
fi
[ -n "$LIST" ] && [ -f "$LIST" ] ||
  die "no private list (scripts/personal-denylist.txt here or in the main checkout, or PUBLISH_PRIVATE_LIST): run this on the machine that keeps it. Nothing was done."
# check-no-personal.sh reads private-docs.txt beside itself; from a worktree, pass the main checkout's on as pre-push.sh does
DOCS="${CHECK_PRIVATE_DOCS:-}"
if [ ! -f "$HERE/private-docs.txt" ] && [ -n "$MAIN" ] && [ -f "$MAIN/scripts/private-docs.txt" ]; then
  while IFS= read -r d || [ -n "$d" ]; do
    case "$d" in '' | '#'*) continue ;; esac
    DOCS="${DOCS:+$DOCS:}$d"
  done < "$MAIN/scripts/private-docs.txt"
fi

# only a clean checkout of main as origin has it: a branch or a stale commit is not what gets published
git -C "$SRC" fetch --quiet origin main 2>/dev/null || die "could not fetch origin main. Nothing was done."
[ "$(git -C "$SRC" rev-parse HEAD)" = "$(git -C "$SRC" rev-parse origin/main)" ] ||
  die "HEAD is not origin/main: check out the current main first. Nothing was done."
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || die "the checkout has uncommitted changes. Nothing was done."
# never the private repository itself
[ "$URL" != "$(git -C "$SRC" remote get-url origin)" ] && [ "$URL" != "$SRC" ] && [ "$URL" != "$COMMON" ] ||
  die "$URL is this private repository, not the public one. Nothing was done."

[ -e "$WORK" ] && [ -n "$(ls -A "$WORK" 2>/dev/null)" ] && die "$WORK is not empty: give a new folder. Nothing was done."
# inside the checkout? walk WORKDIR's existing ancestors and compare files (-ef: real paths, case, symlinks); no ".."
case "/$WORK/" in */../* | */./*) die "$WORK has a . or .. part: give a plain absolute folder. Nothing was done." ;; esac
a="$WORK"
while :; do
  [ -e "$a" ] && [ "$a" -ef "$SRC" ] && die "$WORK is inside this checkout: give a folder outside it. Nothing was done."
  [ "$a" = / ] && break
  a="$(dirname "$a")"
done

check() { # $1 = folder; the rest: extra environment for the check
  local root="$1"; shift
  env "$@" CHECK_EXTRA_RULES="$LIST" CHECK_PRIVATE_DOCS="$DOCS" bash "$HERE/check-no-personal.sh" "$root"
}

echo "== 2/6 the privacy check on this checkout ($(git -C "$SRC" rev-parse --short HEAD))"
check "$SRC" || die "the privacy check found something in this checkout (above): fix it on main first. Nothing was exported." 1

echo "== 3/6 the export"
mkdir -p "$WORK"
bash "$HERE/export-public.sh" "$WORK/export" || die "export-public.sh failed (above)." 1

echo "== 4/6 the privacy check on the exported folder, every file"
check "$WORK/export" CHECK_ALL_FILES=1 CHECK_NO_GIT=1 ||
  die "the privacy check found something in the export (above). Nothing was staged." 1

echo "== 5/6 the public repository, its tree replaced by the export"
git clone --quiet -- "$URL" "$WORK/public" || die "could not clone $URL." 1
# whatever the URL's spelling: a clone that holds this checkout's commit is the private repository, not the public one
if git -C "$WORK/public" cat-file -e "$(git -C "$SRC" rev-parse HEAD)^{commit}" 2>/dev/null; then
  die "$URL holds this checkout's commit: it is the private repository, not the public one. Nothing was staged." 2
fi
find "$WORK/public" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$WORK/export/." "$WORK/public/"
git -C "$WORK/public" add -A --force # the export holds tracked files only: none of them may be dropped by an ignore rule
# the commit's identity: the one the last public snapshot used (or PUBLISH_AUTHOR="Name <email>"), never this machine's
AUTHOR="${PUBLISH_AUTHOR:-$(git -C "$WORK/public" log -1 --format='%an <%ae>' 2>/dev/null || true)}"
case "$AUTHOR" in
  ?*' <'?*'@'?*'>') ;;
  *) die "no identity for the public commit (an empty public repository, or a last commit without a usable author): set PUBLISH_AUTHOR=\"Name <email>\". Staged in $WORK/public." 2 ;;
esac
AN="${AUTHOR% <*}"
AE="${AUTHOR##* <}"
AE="${AE%>}"
git -C "$WORK/public" config user.name "$AN"
git -C "$WORK/public" config user.email "$AE"
# the private commit this snapshot is made from, as a trailer on the snapshot commit, however the commit is written
SOURCE_SHA="$(git -C "$SRC" rev-parse HEAD)"
HOOKS="$(git -C "$WORK/public" rev-parse --absolute-git-dir)/hooks"
mkdir -p "$HOOKS"
printf '#!/bin/sh
exec git interpret-trailers --in-place --if-exists replace --trailer "Talos-Source: %s" "$1"
' "$SOURCE_SHA" > "$HOOKS/commit-msg"
chmod +x "$HOOKS/commit-msg"

echo "== 6/6 what this snapshot changes (the commit will be by: $AUTHOR)"
NS="$(git -C "$WORK/public" -c core.quotePath=false diff --cached --name-status --no-renames)"
count() { printf '%s\n' "$NS" | grep -c "^$1	" || true; }
echo "   added $(count A), changed $(count M), removed $(count D) (from $(git -C "$WORK/public" rev-parse --short HEAD 2>/dev/null || echo 'an empty repository'))"
if [ "$(count D)" != 0 ]; then
  echo "   removed:"
  printf '%s\n' "$NS" | sed -n 's/^D	/     /p'
fi
if [ "$(count A)" != 0 ]; then
  # every file that becomes public for the first time, by top-level folder: read these before the push
  echo "   NEW since the last public snapshot, by top-level folder ($(count A) files):"
  printf '%s\n' "$NS" | sed -n 's/^A	//p' | LC_ALL=C sort | awk -F/ '
    { top = (NF > 1 ? $1 "/" : "(top level)"); n[top]++; list[top] = list[top] "       " $0 "\n"; if (!(top in seen)) { seen[top] = 1; order[++k] = top } }
    END { for (i = 1; i <= k; i++) { t = order[i]; printf "     %s  %d new\n%s", t, n[t], list[t] } }'
fi
[ -n "$NS" ] || echo "   nothing: the public repository already holds exactly this tree"

cat <<EOF

Staged in $WORK/public, NOT committed, NOT pushed. The commit gets the trailer Talos-Source: $SOURCE_SHA (a hook in the clone).
To publish (after a look at the summary above):
  git -C $(printf '%q' "$WORK/public") commit -F <changelog message file>
  git -C $(printf '%q' "$WORK/public") push origin HEAD
EOF
