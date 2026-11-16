#!/bin/bash
# weekly-wiki-check.sh: the talos-weekly-wiki-lint job, as a plain command (no Claude, so it spends no plan usage). Read-only:
# it fixes nothing. What it prints is the job's report (Chronos keeps it and notifies), and the session-start hook still lints
# the wiki at the next session, where the owner can approve fixes. You can run it by hand too.
#
#   bash scripts/weekly-wiki-check.sh
#
# In order: refresh the memory search index (skipped when search is not installed), the wiki linter, the three notes most
# worth filling in (deep-dive-select.py), the CLAUDE.md config lint, and how many lines in memory/, wiki/ and .learnings/ are
# not committed yet. The first line says "clean" or what needs attention. Exit 0 when it ran; 1 only when the folder is not
# an agent folder (the job then fails and notifies).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$(python3 "$HERE/_agent_root.py" "$0" 1 2>/dev/null)" || AGENT_DIR="$(cd "$HERE/.." && pwd)"
cd "$AGENT_DIR" || exit 1
# where the wiki is: wiki/ unless .talos-version has a layout line (a layout-1 agent needs no resolver, and so no python3, for this);
# with one, the one resolver answers (layout 2: memory/wiki/) and a refusal stops this script with its message
WIKI_REL=wiki
if grep -qi '^[[:space:]]*layout' "$PWD/.talos-version" 2>/dev/null; then
  [ -f "$HERE/_talos_layout.py" ] || { echo "$PWD/.talos-version has a layout line but $HERE/_talos_layout.py is missing: refusing to guess where the wiki is"; exit 1; }
  _w="$(python3 "$HERE/_talos_layout.py" "$PWD" wiki)" || exit 1
  WIKI_REL="${_w#"$PWD"/}"
fi
WIKI_TOP="${WIKI_REL%%/*}"      # the folder git sees: "wiki", or "memory" (which holds it) on layout 2
[ -f scripts/wiki-lint.py ] && [ -d "$WIKI_REL" ] || { echo "weekly wiki check: $AGENT_DIR is not a Talos agent folder (no $WIKI_REL/ or scripts/wiki-lint.py)"; exit 1; }

index_note=""
if [ -f scripts/memory/refresh-index.sh ]; then
  if ! iout="$(bash scripts/memory/refresh-index.sh 2>&1)"; then
    case "$iout" in *"not installed"*) ;; *) index_note="the search index could not be refreshed: $(printf '%s' "$iout" | tail -1)" ;; esac
  fi
fi
lint="$(python3 scripts/wiki-lint.py "$WIKI_REL" --extra-dir memory 2>&1)"; lint_rc=$?
# the linter exits 1 on an empty wiki on purpose (an install check must not pass hardest when nothing was written); here an
# empty wiki is nothing to fix, so it is said as such, not as a problem
empty=0; [ "$lint_rc" = 1 ] && printf '%s\n' "$lint" | grep -q '^empty -- 0 notes' && { empty=1; lint_rc=0; }
# the top three candidates: the selector's numbered lines only (not its header)
deep=""; [ -f scripts/deep-dive-select.py ] && deep="$(python3 scripts/deep-dive-select.py "$WIKI_REL" 2>/dev/null | grep -E '^ *[0-9]+\. ' | head -3)"
cfg=""; cfg_rc=0; [ -f scripts/claude-md-lint.sh ] && { cfg="$(bash scripts/claude-md-lint.sh 2>&1)"; cfg_rc=$?; }
uncommitted="not a git repository"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 && uncommitted="$(git status --short -- memory $([ "$WIKI_TOP" = memory ] || echo "$WIKI_TOP") .learnings 2>/dev/null | wc -l | tr -d ' ') uncommitted lines"

cfg_bad=0; { [ "$cfg_rc" = 0 ] && ! printf '%s\n' "$cfg" | grep -q '^FAIL'; } || cfg_bad=1
if [ "$lint_rc" = 0 ] && [ "$cfg_bad" = 0 ] && [ -z "$index_note" ]; then
  if [ "$empty" = 1 ]; then summary="clean: nothing has been written to the wiki yet ($uncommitted)."
  else summary="clean: no errors from the wiki lint or the config lint; any warnings are listed below ($uncommitted)."; fi
else
  summary="needs attention: $([ "$lint_rc" = 0 ] || echo 'the wiki lint found problems; ')$([ "$cfg_bad" = 0 ] || echo 'the config lint found problems; ')${index_note:+$index_note; }$uncommitted"
fi
echo "$summary"
echo "date: $(date)"
echo
echo "== wiki lint"; printf '%s\n' "$lint"
[ -z "$cfg" ] || { echo; echo "== config lint (CLAUDE.md)"; printf '%s\n' "$cfg"; }
[ -z "$deep" ] || { echo; echo "== worth filling in next"; printf '%s\n' "$deep"; }
echo
# again at the end: Chronos keeps only the tail of a long output for the report and the notification
echo "$summary"
echo "Nothing in the notes was changed (the search index may have been refreshed). Fixing is a conversation in a live session."
exit 0
