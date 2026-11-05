#!/usr/bin/env bash
# UserPromptSubmit hook: stamps the start of a turn so the Stop hook can tell whether BOARD.md was rewritten since.
# Fails open: it always exits 0 and prints nothing.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$dir/.claude" ] && : >"$dir/.claude/.turn-start" 2>/dev/null
exit 0
