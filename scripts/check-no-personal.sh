#!/usr/bin/env bash
# Fails when the repo contains personal data. It can run as a hard stop (docs/CI-LOCAL.md, "The personal-data scan").
# By default the pre-push hook (scripts/pre-push.sh) and the check job of every local-ci run call it too, and both
# only warn on a failure. The generic list is in the repo. A maintainer may keep a private list, scripts/personal-denylist.txt,
# which is gitignored: a hook in a worktree finds it in the main checkout and passes it in CHECK_EXTRA_RULES. A machine without
# it checks the generic list only.
#
#   scripts/check-no-personal.sh [root]        root defaults to $CHECK_ROOT, then the git top level
#
# Rule files are tab-separated, one rule per line:
#   PATH_RE <TAB> FLAGS <TAB> PATTERN [<TAB> ALLOW_RE]
#   PATH_RE   ERE matched against the repo-relative path; a leading "!" means "files that do NOT match".
#   FLAGS     "-" (case sensitive) or "i" (case insensitive)
#   PATTERN   ERE searched in each matching file
#   ALLOW_RE  optional ERE; a hit whose "file:line:match" text matches it is ignored (anchor it on the match end)
# Lines starting with # and blank lines are ignored.
# A failure prints "[rule file, rule line N] path:line" and never the matched text, so a hit on a private rule can't leak it.
#
# Private documents: every line of the "## Appendix P" section of a design doc kept OUTSIDE the repo is a fixed-string
# pattern too (docs/SCHEDULES.md is copied from such a doc). Name the docs in CHECK_PRIVATE_DOCS (colon-separated) or,
# one path per line, in the gitignored scripts/private-docs.txt. Hits print as file:line only, never the private text.
# A named doc without an "## Appendix P" heading is an error (exit 2), so a renamed heading can't silently pass.
set -euo pipefail

ROOT="${1:-${CHECK_ROOT:-}}"
if [ -z "$ROOT" ]; then ROOT="$(git rev-parse --show-toplevel)"; fi
# Inside a git hook GIT_DIR (and friends) point at the repository being pushed from. They must not steer this script's own git calls.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_PREFIX
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # before the cd: the script may have been called by a relative path
cd "$ROOT"
RULE_FILES=()
[ -f "$HERE/denylist.generic.txt" ] && RULE_FILES+=("$HERE/denylist.generic.txt")
[ -f "$HERE/personal-denylist.txt" ] && RULE_FILES+=("$HERE/personal-denylist.txt")
# CHECK_EXTRA_RULES: more rule files, colon-separated. A named file that is not there is an error, not a quiet pass.
if [ -n "${CHECK_EXTRA_RULES:-}" ]; then
  IFS=':' read -r -a _extra <<<"$CHECK_EXTRA_RULES"
  for f in ${_extra[@]+"${_extra[@]}"}; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || { echo "check-no-personal: a rule file named in CHECK_EXTRA_RULES does not exist" >&2; exit 2; }
    RULE_FILES+=("$f")
  done
fi
if [ "${#RULE_FILES[@]}" -eq 0 ]; then echo "check-no-personal: no rule files found" >&2; exit 2; fi

# Files to scan: tracked + untracked-not-ignored in a git checkout, otherwise everything under ROOT. The list is NUL-separated end to
# end ($LIST), so a name with a quote, a tab, a space or non-ASCII letters is scanned like any other: git would otherwise print
# such a name quoted, and a "does the file exist" filter would drop it, leaving the check to print ok over a file it never read.
LIST="$(mktemp)"
trap 'rm -f "$LIST" "$LIST.all" "$LIST.hits" "$LIST.sel" "$LIST.pats"' EXIT
EXCLUDE='(^|/)node_modules/|^pnpm-lock\.yaml$|\.(png|jpg|jpeg|gif|webp|ico|woff2?|mp3|mp4|m4a|pdf|zip)$|^scripts/(denylist\.generic|personal-denylist|private-docs)\.txt$'
# The listing goes to a file first, so a failed git or find is an error (exit 2), never a shorter list that passes.
# CHECK_NO_GIT=1: always find (the pre-push hook hands over a folder of exactly the pushed files).
if [ -z "${CHECK_NO_GIT:-}" ] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -c core.quotePath=off -C "$ROOT" ls-files -coz --exclude-standard > "$LIST.all" || { echo "check-no-personal: git ls-files failed; nothing was checked" >&2; exit 2; }
else
  find . -type f -not -path './.git/*' -not -path '*/node_modules/*' -print0 > "$LIST.all" || { echo "check-no-personal: find failed; nothing was checked" >&2; exit 2; }
fi
# A write that fails (a full disk) must stop the check: an empty list would read as a clean repository.
while IFS= read -r -d '' f; do
  f="${f#./}"
  [[ "$f" =~ $EXCLUDE ]] && continue
  if [ -f "$f" ]; then printf '%s\0' "$f" || exit 2; fi
done < "$LIST.all" > "$LIST" || { echo "check-no-personal: could not write the file list (disk full?); nothing was checked" >&2; exit 2; }

: > "$LIST.hits"
TAB=$'\t'
for rules in "${RULE_FILES[@]}"; do
  rule_line=0
  while IFS= read -r line || [ -n "$line" ]; do
    rule_line=$((rule_line + 1))
    case "$line" in ''|'#'*) continue ;; esac
    IFS="$TAB" read -r path_re flags pattern allow <<<"$line"
    # The rule text is never printed (a private rule is the value itself): only which file and which line.
    [ -z "${pattern:-}" ] && { echo "check-no-personal: bad rule at $(basename "$rules") line $rule_line (not printed)" >&2; exit 2; }
    if [ "${path_re#!}" != "$path_re" ]; then
      grep -zEv -- "${path_re#!}" "$LIST" > "$LIST.sel" || true
    else
      grep -zE -- "$path_re" "$LIST" > "$LIST.sel" || true
    fi
    [ -s "$LIST.sel" ] || continue
    iflag=""; [ "$flags" = "i" ] && iflag="-i"
    # shellcheck disable=SC2086
    hits="$(xargs -0 grep -nHIoE $iflag -- "$pattern" < "$LIST.sel" 2>/dev/null || true)"
    [ -z "$hits" ] && continue
    if [ -n "${allow:-}" ]; then hits="$(printf '%s\n' "$hits" | grep -Ev -- "$allow" || true)"; fi
    [ -z "$hits" ] && continue
    # Name the rule (rule file + its line number) and the offending file:line. The matched text is deliberately NOT printed:
    # with the private denylist it would be the personal value itself. Open the rule line to see what it looks for.
    printf '%s\n' "$hits" | cut -d: -f1,2 | sed "s#^#[$(basename "$rules") rule line $rule_line] #" >> "$LIST.hits"
  done < "$rules"
done

# ---- private documents ------------------------------------------------------------------------------------------
PRIVATE_DOCS=()
if [ -n "${CHECK_PRIVATE_DOCS:-}" ]; then
  IFS=':' read -r -a _docs <<<"$CHECK_PRIVATE_DOCS"
  for d in ${_docs[@]+"${_docs[@]}"}; do [ -n "$d" ] && PRIVATE_DOCS+=("$d"); done
fi
if [ -f "$HERE/private-docs.txt" ]; then
  while IFS= read -r d || [ -n "$d" ]; do
    case "$d" in ''|'#'*) continue ;; esac
    PRIVATE_DOCS+=("$d")
  done < "$HERE/private-docs.txt"
fi
PATS="$LIST.pats"
: > "$PATS"
for doc in ${PRIVATE_DOCS[@]+"${PRIVATE_DOCS[@]}"}; do
  if [ ! -f "$doc" ]; then echo "check-no-personal: a named private doc does not exist" >&2; rm -f "$PATS"; exit 2; fi
  if ! grep -q '^## Appendix P' "$doc"; then
    echo "check-no-personal: a named private doc has no '## Appendix P' section" >&2; rm -f "$PATS"; exit 2
  fi
  # the section's lines, markdown markers trimmed, 24+ characters (shorter lines are too generic to be a signal)
  awk '/^## Appendix P/{on=1; next} on && /^## /{on=0} on{print}' "$doc" \
    | sed -E 's/^[[:space:]]*([-*>|#]+[[:space:]]*|[0-9]+\.[[:space:]]+)*//; s/[[:space:]|]+$//' \
    | awk 'length($0) >= 24' >> "$PATS"
done
if [ -s "$PATS" ]; then
  hits="$(xargs -0 grep -nHIF -f "$PATS" < "$LIST" 2>/dev/null | cut -d: -f1,2 || true)"
  if [ -n "$hits" ]; then printf '%s\n' "$hits" | sed 's#^#[private-doc] #' >> "$LIST.hits"; fi
fi
rm -f "$PATS"

if [ -s "$LIST.hits" ]; then
  echo "check-no-personal: FAILED" >&2
  sort -u "$LIST.hits" >&2
  echo "check-no-personal: $(sort -u "$LIST.hits" | wc -l | tr -d ' ') hit(s). Use owner / Alex Example / alex@example.com / example.com / UTC." >&2
  exit 1
fi
echo "check-no-personal: ok ($(tr -cd '\0' < "$LIST" | wc -c | tr -d ' ') files, ${#RULE_FILES[@]} rule file(s))"
