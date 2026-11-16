#!/usr/bin/env bash
# Writes the files this repository tracks, minus a fixed EXCLUDE list, into a new folder: the tree that can be published as
# one fresh commit. It copies files; it never touches git history, remotes or the source tree.
#
#   scripts/export-public.sh [--allow-dirty] TARGET_DIR      write the export (TARGET_DIR must be new or empty)
#   scripts/export-public.sh --print-excludes                print the EXCLUDE list, one path per line
#
# An EXCLUDE entry ending in "/" is a folder (everything under it); any other entry is one exact file. An entry that is not
# tracked is fine (a private list may exist on one machine only). The export is checked after it is written: no excluded path
# may exist in TARGET_DIR, the setup docs (README.md, SETUP.md, AGENTS.md, CLAUDE.md, docs/SETUP.md, docs/ios.md, kit/START-HERE.md,
# kit/README.md) must not name one, and the file count must equal tracked minus excluded, or the script says so and exits 1.
#
# Exit codes: 0 ok, 1 the written tree failed its own check or a copy failed, 2 bad usage or a refused target.
set -euo pipefail

# Kept out of the public tree: the private build spec and its follow-up list, the CI audit, the internal audits
# (docs/audits/), the manual smoke journals, the maintainer-only review scripts, a maintainer's private denylist, the
# self-hosted runner workflow (a public repository must not hand pull requests to a self-hosted runner) and the plan for the
# maintainer's CI machines.
EXCLUDE=(
  "docs/SPEC.md"
  "docs/CI-AUDIT-2026-10-31.md"
  "docs/FOLLOWUPS.md"
  "docs/audits/"
  "scripts/smoke/"
  "apps/desktop/scripts/review-d0-test.sh"
  "apps/desktop/scripts/review-d0-recheck-test.sh"
  "scripts/personal-denylist.txt"
  ".github/workflows/ci-runner.yml"
  "docs/CI-MACHINES.md"
  "kit/SOURCE"
  "scripts/kit-source.test.ts"
)

die() { echo "export-public: $*" >&2; exit "${2:-2}"; }

ALLOW_DIRTY=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --print-excludes) printf '%s\n' "${EXCLUDE[@]}"; exit 0 ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option: $1" ;;
    *) [ -z "$TARGET" ] || die "only one target folder"; TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || die "usage: export-public.sh [--allow-dirty] TARGET_DIR"

# EXPORT_SOURCE lets a test point the script at a small repository; normally it is the repository this script lives in.
SRC="${EXPORT_SOURCE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
git -C "$SRC" rev-parse --show-toplevel >/dev/null 2>&1 || die "$SRC is not a git repository"
SRC="$(git -C "$SRC" rev-parse --show-toplevel)"

if [ "$ALLOW_DIRTY" != 1 ] && [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
  die "tracked files have uncommitted changes, so the export would not match any commit. Commit them, or pass --allow-dirty."
fi

# Judged before anything is made: the target as the disk will have it (the nearest part that exists, links resolved, and
# the rest as given), so a refused target leaves no new folder behind.
case "$TARGET" in /*) ;; *) TARGET="$PWD/$TARGET" ;; esac
_p="$TARGET"; _rest=""
while [ ! -d "$_p" ]; do _rest="/$(basename "$_p")$_rest"; _p="$(dirname "$_p")"; done
_base="$(cd "$_p" && pwd -P)"; [ "$_base" = / ] && _base=""
# mkdir would resolve a . or .. in a part that does not exist yet, after this check: refused
case "$_rest/" in */../*|*/./*) die "$TARGET has a . or .. in a part that does not exist yet; give a plain path" ;; esac
SRC_PHYS="$(cd "$SRC" && pwd -P)"
case "$_base$_rest/" in "$SRC"/*|"$SRC_PHYS"/*) die "the target must be outside the source repository" ;; esac
if [ -e "$TARGET" ]; then
  [ -d "$TARGET" ] || die "$TARGET exists and is not a folder"
  [ -z "$(ls -A "$TARGET")" ] || die "$TARGET is not empty; refusing to mix an export into existing files"
else
  mkdir -p "$TARGET"
fi
TARGET="$(cd "$TARGET" && pwd -P)"
case "$TARGET/" in "$SRC"/*|"$SRC_PHYS"/*) die "the target must be outside the source repository" ;; esac

excluded() { # $1 = repo-relative path
  local e
  for e in "${EXCLUDE[@]}"; do
    case "$e" in
      */) case "$1" in "$e"*) return 0 ;; esac ;;
      *) [ "$1" = "$e" ] && return 0 ;;
    esac
  done
  return 1
}

LIST="$(mktemp "${TMPDIR:-/tmp}/export-public.XXXXXX")"
trap 'rm -f "$LIST"' EXIT
TRACKED=0; KEPT=0
while IFS= read -r -d '' f; do
  TRACKED=$((TRACKED + 1))
  excluded "$f" && continue
  [ -e "$SRC/$f" ] || [ -L "$SRC/$f" ] || die "tracked file is missing on disk: $f" 1
  printf '%s\0' "$f" >>"$LIST"
  KEPT=$((KEPT + 1))
done < <(git -C "$SRC" ls-files -z)
[ "$KEPT" -gt 0 ] || die "nothing to export" 1

tar -C "$SRC" -cf - --null -T "$LIST" | tar -C "$TARGET" -xf - || die "copy failed" 1

# After the write: read the result back instead of trusting the copy.
for e in "${EXCLUDE[@]}"; do
  [ ! -e "${TARGET}/${e%/}" ] || die "excluded path is present in the export: $e" 1
done
# A doc a stranger follows to set Talos up must not send them to a file this export leaves out. Reword the doc (preferred) or
# drop the link; the unit test scripts/setup-docs-public.test.ts checks a wider list of docs before the export is ever run.
for d in README.md SETUP.md AGENTS.md CLAUDE.md docs/SETUP.md docs/ios.md kit/START-HERE.md kit/README.md; do
  [ -f "${TARGET}/$d" ] || continue
  for e in "${EXCLUDE[@]}"; do
    if grep -qF -- "$e" "${TARGET}/$d"; then die "$d names $e, which is not in the public export; reword it" 1; fi
  done
done
GOT="$(cd "$TARGET" && find . \( -type f -o -type l \) | wc -l | tr -d ' ')"
[ "$GOT" = "$KEPT" ] || die "the export holds $GOT files, expected $KEPT" 1

echo "export-public: wrote $KEPT files to $TARGET ($((TRACKED - KEPT)) of $TRACKED tracked files excluded)"
