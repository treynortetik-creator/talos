#!/usr/bin/env bash
# Stop hook: before a lead parks, BOARD.md must be rewritten this turn and be under 4 KB. If not, block the stop ONCE with
# a plain reason. Claude Code sets stop_hook_active when a stop follows a block; then this lets it through, so it cannot
# loop. Fails open: any problem (empty or invalid stdin, no folder) exits 0 and prints nothing.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
[ -d "$dir" ] || exit 0
input="$(cat 2>/dev/null || true)"
# Empty or not a Stop event (not a JSON object carrying one of Claude Code's keys): let the stop through, print nothing.
obj='^[[:space:]]*\{.*\}[[:space:]]*$'
[[ "$input" =~ $obj ]] || exit 0
[[ "$input" == *'"session_id"'* || "$input" == *'"stop_hook_active"'* || "$input" == *'"hook_event_name"'* ]] || exit 0
active='"stop_hook_active"[[:space:]]*:[[:space:]]*true'
[[ "$input" =~ $active ]] && exit 0
board="$dir/BOARD.md"
marker="$dir/.claude/.turn-start"
max=4096
reason=""
if [ ! -f "$board" ]; then
  reason="BOARD.md is missing. Write it now (Now, Next, Waiting on, Note to next session), under 4 KB, then stop."
else
  size="$(wc -c <"$board" 2>/dev/null | tr -d ' ')"
  if [ -n "$size" ] && [ "$size" -gt "$max" ] 2>/dev/null; then
    reason="BOARD.md is $size bytes. Rewrite it under 4 KB (4096 bytes): drop what is done and shorten the rest, then stop."
  elif [ -f "$marker" ] && [ ! "$board" -nt "$marker" ]; then
    reason="Rewrite BOARD.md before you stop, under 4 KB: what is now, what is next, what you are waiting on, and a note to the next session."
  fi
fi
[ -n "$reason" ] || exit 0
printf '{"decision":"block","reason":"%s"}\n' "$reason"
exit 0
