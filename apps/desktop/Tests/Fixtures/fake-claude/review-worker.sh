# Review fixture (PR #68 review): a thread session with knobs. Never Claude Code. Every FAKE_RV_* is optional.
# FAKE_RV_NOISE=<comma list of threads>: print output until FAKE_RV_QUIET exists (a turn in progress: "busy").
# FAKE_RV_QUIET_ONCE=1: the first run to see FAKE_RV_QUIET consumes it (deletes it), so only that run goes quiet.
# FAKE_RV_SIGLOG=<file>: log a SIGTERM and exit. FAKE_RV_IGNORE_TERM: ignore SIGTERM. FAKE_RV_BANNER: print this first.
# FAKE_RV_TOUCH_NOW / FAKE_RV_TOUCH_BOT + FAKE_RV_TOUCH_LATE: rewrite bot.pid at load / N seconds after ready, as the
# Telegram plugin does. FAKE_RV_NO_READY: never connect. FAKE_RV_EXIT_AFTER: exit 3 N seconds after ready.
# FAKE_RV_CHILD=<file>: leave a child in our group that ignores TERM/HUP and holds no tty (an MCP server on pipes).
# FAKE_RV_PWD=<file>: log the folder the session really runs in. FAKE_RV_BOX_DELAY=<seconds>: draw the input box this long after ready.
# FAKE_RV_DIALOG=<file>: once this file exists, draw a question with a cursor (a dialog that appears while live). With FAKE_RV_DIALOG_GONE=<file>
# the dialog goes away when that file exists, and the input box is back.
# FAKE_RV_SETSID_CHILD=<file>: leave a child in its own session, no tty (what Claude Code's Bash tool does: its shells are
# their own group with no tty, OBSERVED 2026-10-30). Logs its pid.
# FAKE_RV_READY_FILE=<file>: write `ready` only once this file exists (a start that is still "starting"). FAKE_RV_BOX_FILE=<file>: draw the
# input box only once this file exists (the box is not on the pane yet). FAKE_RV_ECHO_BOX=1: the input box shows what is typed into it,
# as Claude's does (raw tty, one key at a time, Backspace deletes); a line ends at Enter and only then goes to the typed log.
# With it: FAKE_RV_NO_BSPACE=1 ignores Backspace; FAKE_RV_DIM_TEXT=<text> shows that text dim in the empty box, as Claude's placeholder is.
# Ctrl-U empties the box in one redraw (no half-cleared frame). Also with it, all off by default:
# FAKE_RV_BLANK_BSPACE=<seconds>: the Backspace that empties the box is followed by a blank screen (no box) for this long, then the empty
# box, as a redraw caught mid-way is (the text frames before it, and the blank, are the same on every run). FAKE_RV_DRAW_LAG=<seconds>: typed text reaches the screen this long after its first key (the box shows
# nothing meanwhile); the keys are not lost. FAKE_RV_SWALLOW_UNTIL=<file>: every key is dropped until this file exists.
# FAKE_RV_EMPTY_ENTER_LOG=<file>: an Enter that arrives with the box empty (it sends nothing) is logged here, one line each.
# FAKE_RV_STATUS=<seconds>: repaint a status line on the row under the box's footer every N seconds, with text that changes each time
# ("Sonnet 5.5 | 20% | 7d: 38%", as the owner's statusLine does when usage changes). No turn, no key: the only thing on the pane that moves.
# FAKE_RV_STATUS_ONLY=<comma list of threads> limits it to those threads. FAKE_RV_TURN=<file>: while this file exists, a turn is "running":
# a changing line ("thinking N") on row 1, above the box, every 0.3 s. FAKE_RV_DEAF=<file>: once this file exists the pane's tty
# stops echoing what is typed (plain mode), so a key typed by an attached client changes nothing on the screen. (Before that, the pointer
# the supervisor types is echoed in the box, which it needs to see before it sends the Enter.)
. "$(dirname "$0")/lib.sh"
T="$TALOS_APP_WORKER_THREAD"
noisy=""
case ",${FAKE_RV_NOISE:-}," in *",$T,"*) noisy=1 ;; esac
# The box is drawn with the cursor in its input row, so the tty's echo of a typed line lands in the box, as Claude draws it (lib.sh
# `typing_box`). A noisy session writes its output on row 1, above the box, not at the cursor. `plain`: reads its lines and nothing else.
plain=""
[ -z "$noisy" ] && [ -z "${FAKE_RV_SIGLOG:-}" ] && [ -z "${FAKE_RV_EXIT_AFTER:-}" ] && [ -z "${FAKE_RV_IGNORE_TERM:-}" ] && plain=1
# DIALOG_GONE / BLANK_BACK redraw the box over a line that may be half typed (Claude's box shows its typed text again; the tty's cooked
# buffer cannot), so those two run the echo loop below, which draws the box from what is typed.
{ [ -n "${FAKE_RV_DIALOG_GONE:-}" ] || [ -n "${FAKE_RV_BLANK_BACK:-}" ]; } && [ -n "$plain" ] && FAKE_RV_ECHO_BOX=1
box=input_box
[ -z "${FAKE_RV_ECHO_BOX:-}" ] && box=typing_box
box_back() {  # the screen cleared, the box drawn again
  if [ -n "${FAKE_RV_ECHO_BOX:-}" ]; then mkdir -p "$TALOS_APP_HOME/workers/$T"; : > "$TALOS_APP_HOME/workers/$T/redraw"  # the key loop draws it
  else printf '\033[2J\033[H\n'; $box; fi
}
[ -n "${FAKE_RV_IGNORE_TERM:-}" ] && trap '' TERM
[ -n "${FAKE_RV_SIGLOG:-}" ] && trap 'echo "$T term" >> "$FAKE_RV_SIGLOG"; exit 0' TERM
[ -n "${FAKE_RV_BANNER:-}" ] && printf '%s\n' "$FAKE_RV_BANNER"
[ -n "${FAKE_RV_TOUCH_NOW:-}" ] && printf '%d' "$$" > "$FAKE_RV_TOUCH_NOW"
[ -n "${FAKE_WORKER_ENV_LOG:-}" ] && env | sort > "$FAKE_WORKER_ENV_LOG.$T"
[ -n "${FAKE_RV_PWD:-}" ] && pwd -P > "$FAKE_RV_PWD.$T"
if [ -n "${FAKE_RV_CHILD:-}" ]; then
  ( trap '' TERM HUP; exec /bin/sleep 60 ) </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_RV_CHILD.$T"
fi
if [ -n "${FAKE_RV_SETSID_CHILD:-}" ]; then
  ( exec /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "60"' ) </dev/null >/dev/null 2>&1 &
  echo $! > "$FAKE_RV_SETSID_CHILD.$T"
fi
if [ -n "${FAKE_RV_DIALOG:-}" ]; then
  # FAKE_RV_DIALOG_GONE=<file>: once this file exists the dialog is answered, the screen clears and the input box is drawn again
  ( until [ -f "$FAKE_RV_DIALOG" ]; do sleep 0.1; done; [ "$box" != typing_box ] || printf '\033[3B\033[1G'  # below the box, as the cursor was
    printf '\n \342\235\257 1. Yes, I trust this folder\n   2. No, exit\n'
    [ -n "${FAKE_RV_DIALOG_GONE:-}" ] || exit 0
    until [ -f "$FAKE_RV_DIALOG_GONE" ]; do sleep 0.1; done; box_back ) &
fi
if [ -n "${FAKE_RV_BLANK:-}" ]; then
  # FAKE_RV_BLANK=<file>: once this file exists the screen is cleared (no input box); FAKE_RV_BLANK_BACK=<file>: the box is drawn again
  ( until [ -f "$FAKE_RV_BLANK" ]; do sleep 0.1; done; printf '\033[2J\033[H'
    until [ -f "${FAKE_RV_BLANK_BACK:-/nonexistent}" ]; do sleep 0.1; done; box_back ) &
fi
[ -n "${FAKE_RV_READY_FILE:-}" ] && until [ -f "$FAKE_RV_READY_FILE" ]; do sleep 0.1; done
if [ -z "${FAKE_RV_NO_READY:-}" ]; then
  d="$TALOS_APP_HOME/workers/$T"
  mkdir -p "$d"
  printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$T" "$$" > "$d/ready"
fi
case ",${FAKE_RV_STATUS_ONLY:-$T}," in
  *",$T,"*)
    if [ -n "${FAKE_RV_STATUS:-}" ]; then  # row 6: under the footer, the last row of the box's layout (lib.sh `input_box`)
      ( n=19; while :; do n=$((n+1)); printf '\0337\033[6;1H\033[2K  Sonnet 5.5 | %d%% | 7d: 38%%\0338' "$n"; sleep "$FAKE_RV_STATUS"; done ) &
    fi ;;
esac
if [ -n "${FAKE_RV_TURN:-}" ]; then
  ( n=0; while :; do if [ -f "$FAKE_RV_TURN" ]; then n=$((n+1)); printf '\0337\033[1;1H\033[2Kthinking %d\0338' "$n"; fi; sleep 0.3; done ) &
fi
[ -n "${FAKE_RV_BOX_DELAY:-}" ] && sleep "$FAKE_RV_BOX_DELAY"  # ready is written first, so a slow machine shows the box late
[ -n "${FAKE_RV_BOX_FILE:-}" ] && until [ -f "$FAKE_RV_BOX_FILE" ]; do sleep 0.1; done
# With DIM_TEXT the box is first drawn by the echo loop below, dim from the start: a plain empty box first would be the screen the
# pointer is typed onto, and the dim copy would never be what the guard reads.
[ -n "${FAKE_RV_ECHO_BOX:-}" ] && [ -n "${FAKE_RV_DIM_TEXT:-}" ] || { printf '\n'; $box; }
if [ -n "${FAKE_RV_TOUCH_LATE:-}" ]; then
  ( sleep "$FAKE_RV_TOUCH_LATE"; printf '%d' "$$" > "$FAKE_RV_TOUCH_BOT" ) &
fi
if [ -n "${FAKE_RV_ECHO_BOX:-}" ]; then
  # one whole screen per key, so a read of the pane never catches the box half drawn
  rule='────────────────────────────────────────────────'
  buf=""
  blanked=""
  draw() {
    local shown="$buf"
    [ -z "$buf" ] && [ -n "${FAKE_RV_DIM_TEXT:-}" ] && shown=$'\033[2m'"$FAKE_RV_DIM_TEXT"$'\033[22m'
    printf '\033[2J\033[H\n%s\n\342\235\257\302\240%s \n%s\n  \342\217\265\342\217\265 auto mode on (shift+tab to cycle)\n' "$rule" "$shown" "$rule"
  }
  stty -echo -icanon min 1 time 0 2>/dev/null
  [ -n "${FAKE_RV_DIM_TEXT:-}" ] && draw
  while :; do
    IFS= read -rsn1 -t 1 ch; rc=$?
    if [ "$rc" -ne 0 ]; then  # a second without a key (bash 3.2 gives 1 for that, not 142): was the box asked for again (box_back)?
      [ -f "$TALOS_APP_HOME/workers/$T/redraw" ] && rm -f "$TALOS_APP_HOME/workers/$T/redraw" && draw
      continue
    fi
    [ -n "${FAKE_RV_SWALLOW_UNTIL:-}" ] && [ ! -f "$FAKE_RV_SWALLOW_UNTIL" ] && continue
    case "$ch" in
      "")
        if [ -n "$buf" ]; then printf '%s %s\n' "$T" "$buf" >> "${FAKE_TYPED_LOG:-/dev/null}"
        elif [ -n "${FAKE_RV_EMPTY_ENTER_LOG:-}" ]; then printf '%s\n' "$T" >> "$FAKE_RV_EMPTY_ENTER_LOG"; fi
        buf="" ;;
      $'\177'|$'\b')
        [ -n "${FAKE_RV_NO_BSPACE:-}" ] || buf="${buf%?}"
        if [ -n "${FAKE_RV_BLANK_BSPACE:-}" ] && [ -z "$buf" ] && [ -z "$blanked" ]; then
          blanked=1; printf '\033[2J\033[H'; sleep "$FAKE_RV_BLANK_BSPACE"
        fi ;;
      $'\025') buf="" ;;
      *) buf="$buf$ch"; [ -n "${FAKE_RV_DRAW_LAG:-}" ] && [ "${#buf}" -eq 1 ] && sleep "$FAKE_RV_DRAW_LAG" ;;
    esac
    draw
  done
  idle
fi
if [ -n "$plain" ]; then
  [ -n "${FAKE_RV_DEAF:-}" ] && ( until [ -f "$FAKE_RV_DEAF" ]; do sleep 0.1; done; stty -echo < /dev/tty 2>/dev/null ) &  # a background job has no stdin: the pane's tty is /dev/tty
  log_typed_lines  # logs "$TALOS_APP_WORKER_THREAD <line>", the same as "$T <line>"
  idle
fi
exec 3<&0
( while IFS= read -r line <&3; do printf '%s %s\n' "$T" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"; printf '\033[2J\033[H\n'; typing_box; done ) &
if [ -n "$noisy" ]; then
  q="${FAKE_RV_QUIET:-/nonexistent}"; ( while :; do if [ -f "$q" ]; then [ -n "${FAKE_RV_QUIET_ONCE:-}" ] && rm -f "$q"; break; fi; printf '\033%s\033[1;1Hworking\033%s' 7 8; sleep 0.1; done ) &
fi
if [ -n "${FAKE_RV_EXIT_AFTER:-}" ]; then
  sleep "$FAKE_RV_EXIT_AFTER"
  kill $(jobs -p) 2>/dev/null
  exit 3
fi
while :; do
  sleep "${FAKE_MAX_LIFETIME:-600}" &
  wait $!
  [ -n "${FAKE_RV_IGNORE_TERM:-}" ] || exit 0
done
