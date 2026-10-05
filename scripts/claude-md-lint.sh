#!/usr/bin/env bash
# claude-md-lint.sh -- the ceiling that keeps CLAUDE.md a hot file.
#
#   bash scripts/claude-md-lint.sh [--root DIR]
#
# WHY: a config file grows by paragraphs and shrinks by discipline. Past a few thousand words its rules compete
# for attention and the load-bearing ones get skimmed. Rules that hold are written as triggers ("Before X: do
# Y"); the stories behind them belong in memory/rules-ledger.md under the same [R-nn] key. This script is a
# ceiling the agent cannot talk its way around. It FAILS when:
#   - CLAUDE.md is longer than the word cap (default 3000; set TALOS_CLAUDE_MD_WORD_CAP to change it)
#   - a line carrying the red-circle marker has no [R-nn] key
#   - an [R-nn] key used in CLAUDE.md has no "## R-nn ..." entry in memory/rules-ledger.md
# and NOTES (does not fail) any row of the Observations table whose "re-check after" date has passed.
#
# Section 0 (the setup tutor block, deleted when setup finishes) is exempt from the key rule.
# The placeholder CLAUDE.md the kit ships ("# Setup is not finished.", replaced in BOOTSTRAP step 2) is not a
# config yet: the lint says so and exits 0 instead of failing it, the same way verify-install.sh skips it.
# Exit 0 clean, 1 violations, 2 cannot run. Run it after any CLAUDE.md edit and from the weekly lint job.
ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root) ROOT="${2:?--root needs a folder}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ROOT" ] || ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2
[ -f CLAUDE.md ] || { echo "FAIL: no CLAUDE.md in $ROOT" >&2; exit 2; }
if head -1 CLAUDE.md | grep -q '^# Setup is not finished'; then
  echo "skip: CLAUDE.md is the setup placeholder, not a config yet (BOOTSTRAP step 2 replaces it); nothing to lint"; exit 0
fi

CAP="${TALOS_CLAUDE_MD_WORD_CAP:-3000}"
fail=0

words=$(wc -w < CLAUDE.md | tr -d ' ')
if [ "$words" -gt "$CAP" ]; then
  echo "FAIL: CLAUDE.md is $words words, cap $CAP. Move a story to memory/rules-ledger.md."; fail=1
else
  echo "ok: CLAUDE.md $words words (cap $CAP)"
fi

# the body without section 0
BODY="$(mktemp)" || exit 2
trap 'rm -f "$BODY"' EXIT
awk '/^## 0/ {skip=1; next} skip && /^## [1-9]/ {skip=0} !skip' CLAUDE.md > "$BODY"

# every red-circle line carries a rule key
n=0
while IFS= read -r line; do
  printf '%s' "$line" | grep -qE '\[R-[0-9]{2}\]' || { echo "FAIL: red-circle line without an [R-nn] key: ${line:0:90}"; n=$((n+1)); }
done < <(grep '🔴' "$BODY")
if [ "$n" -eq 0 ]; then echo "ok: every red-circle line is keyed"; else fail=1; fi

# every key used here exists in the ledger
missing=0
for k in $(grep -oE '\[R-[0-9]{2}\]' "$BODY" | tr -d '[]' | sort -u); do
  if [ ! -f memory/rules-ledger.md ] || ! grep -qE "^## $k " memory/rules-ledger.md; then
    echo "FAIL: $k is used in CLAUDE.md but has no '## $k ...' entry in memory/rules-ledger.md"; missing=$((missing+1))
  fi
done
if [ "$missing" -eq 0 ]; then echo "ok: every [R-nn] has a ledger entry"; else fail=1; fi

# expired observations: rows of the Observations table whose third column (re-check after) is a past date
today=$(date +%Y-%m-%d)
exp=$(grep -E '^\| ' "$BODY" | awk -F'|' -v today="$today" 'NF>=4 && $4 ~ /20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/ {d=$4; gsub(/ /,"",d); if (d < today) print "  -" $2}')
if [ -n "$exp" ]; then printf 'note: expired observations, re-check before citing:\n%s\n' "$exp"; else echo "ok: no expired observations"; fi
exit $fail
