#!/usr/bin/env bash
# Writes the files this repository tracks, minus a fixed EXCLUDE list, into a new folder: the tree that can be published as
# one fresh commit. It copies files; it never touches git history, remotes or the source tree.
#
#   scripts/export-public.sh [--allow-dirty] TARGET_DIR      write the export (TARGET_DIR must be new or empty)
#   scripts/export-public.sh --print-excludes                print the EXCLUDE list, one path per line
#
# An EXCLUDE entry ending in "/" is a folder (everything under it); any other entry is one exact file. An entry that is not
# tracked is fine (a private list may exist on one machine only). The export is checked after it is written: no excluded path
# may exist in TARGET_DIR and the file count must equal tracked minus excluded, or the script says so and exits 1.
#
# Exit codes: 0 ok, 1 the written tree failed its own check or a copy failed, 2 bad usage or a refused target.
set -euo pipefail

# Kept out of the public tree: the private build spec and its follow-up list, the CI audit, the manual smoke journals, the
# maintainer-only review scripts, a maintainer's private denylist, and the self-hosted runner workflow (a public repository must
# not hand pull requests to a self-hosted runner).
EXCLUDE=(
  "docs/SPEC.md"
  "docs/CI-AUDIT-2026-10-31.md"
  "docs/FOLLOWUPS.md"
  "scripts/smoke/"
  "apps/desktop/scripts/review-d0-test.sh"
  "apps/desktop/scripts/review-d0-recheck-test.sh"
  "scripts/personal-denylist.txt"
  ".github/workflows/ci-runner.yml"
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

if [ -e "$TARGET" ]; then
  [ -d "$TARGET" ] || die "$TARGET exists and is not a folder"
  [ -z "$(ls -A "$TARGET")" ] || die "$TARGET is not empty; refusing to mix an export into existing files"
else
  mkdir -p "$TARGET"
fi
TARGET="$(cd "$TARGET" && pwd -P)"
case "$TARGET/" in "$SRC"/*) die "the target must be outside the source repository" ;; esac

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
GOT="$(cd "$TARGET" && find . \( -type f -o -type l \) | wc -l | tr -d ' ')"
[ "$GOT" = "$KEPT" ] || die "the export holds $GOT files, expected $KEPT" 1

echo "export-public: wrote $KEPT files to $TARGET ($((TRACKED - KEPT)) of $TRACKED tracked files excluded)"
