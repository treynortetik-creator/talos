#!/usr/bin/env bash
# wiki-search.sh -- grep your wiki without fooling yourself.
#
# WHY THIS EXISTS: your CLAUDE.md already says "a zero result is a claim about your
# search term, not about the world -- try two or three phrasings before you say there
# is nothing on it." That is a rule a tired agent skips. This script DOES the phrasings,
# so the discipline is the default instead of the intention.
#
# It also refuses to return a bare zero. Every empty answer says what was searched,
# how much of it, and what to try next -- because "no results" and "your search is
# broken" look identical otherwise, and only one of them means the fact doesn't exist.
#
# Usage:  scripts/wiki-search.sh "<term>" [wiki-dir]
set -uo pipefail

TERM_RAW="${1:-}"
WIKI="${2:-wiki}"
[ -z "$TERM_RAW" ] && { echo "usage: $0 \"<term>\" [wiki-dir]"; exit 2; }

if [ ! -d "$WIKI" ]; then
  echo "! no such directory: $WIKI"
  echo "  This is a BROKEN SEARCH, not an empty result. Run from your agent folder,"
  echo "  or pass the wiki path as the second argument."
  exit 2
fi

# Shipped fixtures are not knowledge. Until HOMEWORK day 13 deletes wiki/examples/, a
# search for a name that appears only in a fixture would otherwise answer "1 note matched"
# and hand back an invented person as if the user had written them. (TALOS-14, 2026-08-26.)
FIND_NOTES() { find "$WIKI" -name '*.md' ! -name '_*' ! -name 'README.md' \
                 ! -path '*/examples/*' 2>/dev/null; }
NOTES=$(FIND_NOTES | wc -l | tr -d ' ')
if [ "$NOTES" -eq 0 ]; then
  echo "! $WIKI contains no notes yet."
  echo "  Nothing has been written, so this says nothing about the topic."
  exit 2
fi

# --- build the variants the rule asks a human to try -----------------------------
lower=$(printf '%s' "$TERM_RAW" | tr '[:upper:]' '[:lower:]')
variants=("$lower")
add() { case " ${variants[*]} " in *" $1 "*) ;; *) variants+=("$1");; esac; }
add "$(printf '%s' "$lower" | tr ' ' '-')"      # two words -> kebab
add "$(printf '%s' "$lower" | tr '-' ' ')"      # kebab -> two words
add "$(printf '%s' "$lower" | tr '_' ' ')"
case "$lower" in
  *ies) add "${lower%ies}y" ;;
  *s)   add "${lower%s}" ;;
  *)    add "${lower}s" ;;
esac

hits=""; tried=""
for v in "${variants[@]}"; do
  [ -z "$v" ] && continue
  tried="$tried\"$v\" "
  # -F: the terms are literal words, not patterns. Without it a term containing . or *
  # silently over-matches and the "N notes matched" count is a lie. (Review 2026-08-26.)
  found=$(FIND_NOTES | tr '\n' '\0' | xargs -0 grep -ilF -- "$v" 2>/dev/null || true)
  [ -n "$found" ] && hits="$hits$found"$'\n'
done
hits=$(printf '%s' "$hits" | grep -v '^$' | sort -u)

if [ -n "$hits" ]; then
  n=$(printf '%s\n' "$hits" | grep -c .)
  echo "$n note(s) matched (searched $NOTES notes; tried $tried):"
  printf '%s\n' "$hits" | sed 's/^/  /'
  exit 0
fi

# --- the whole point: an empty answer that explains itself ------------------------
echo "NO MATCH -- and here is exactly what that does and does not mean."
echo
echo "  Searched : $NOTES notes in $WIKI"
echo "  Variants : $tried"
echo "  Verdict  : the search RAN and the wiki is NOT empty, so this is a real"
echo "             absence for these terms -- not a broken tool."
echo
echo "  🔴 It is still a claim about your SEARCH TERMS, not about the world."
echo "  Before telling anyone there is nothing on this, try:"
echo "    1. a synonym or the other side of the concept (vendor vs supplier, churn vs retention)"
echo "    2. a person or project name involved, instead of the topic"
echo "    3. grep the index for a neighbour:  grep -i \"<related>\" $WIKI/_index.md"
echo "    4. walk the graph: open the closest note and follow its [[links]]"
echo
echo "  If those also come back empty, say so as: \"I searched N notes for X, Y and Z"
echo "  and found nothing\" -- never as \"there is nothing about that.\""
exit 1
