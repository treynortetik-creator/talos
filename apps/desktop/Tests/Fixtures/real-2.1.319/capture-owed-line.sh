#!/bin/bash
# Captures what the real Claude Code CLI does with Talos's pointer line, for fixtures (README method of
# apps/desktop/Tests/Fixtures/real-2.1.319): logged out, `env -i`, temp HOME and CLAUDE_CONFIG_DIR, a private `-L talos-test-*`
# tmux server at 120x40, `capture-pane -p -J` (plus `-e` copies for the colour check). NOTHING IS SUBMITTED: no Enter is ever sent.
# The server is killed and the temp dirs removed on every exit.
# Usage: capture-owed-line.sh <out-dir>     (needs `claude` and `tmux` on PATH; prints the first screen before typing anything)
set -euo pipefail
out="${1:?usage: capture-owed-line.sh <out-dir>}"
mkdir -p "$out"
LINE='Talos: new message in this thread. Call read_inbound.'   # PointerTyper.text, 53 characters
TMUX_BIN="$(command -v tmux)"
CLAUDE_BIN="$(command -v claude)"
NODE_DIR="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
SOCK="talos-test-owedcap-$$"
H="$(mktemp -d /private/tmp/tcap-owed-home.XXXXXX)"
CFG="$(mktemp -d /private/tmp/tcap-owed-cfg.XXXXXX)"
WORK="$(mktemp -d /private/tmp/tcap-owed-proj.XXXXXX)"
t() { "$TMUX_BIN" -L "$SOCK" "$@"; }
cleanup() { t kill-server 2>/dev/null || true; rm -rf "$H" "$CFG" "$WORK"; }
trap cleanup EXIT

# Onboarding done and the folder trusted, so the first screen is the input box (best-known keys). The check below stops the script
# before typing only when the first screen has no row starting with `❯` + U+00A0; the "Not logged in" check only warns.
printf '{"hasCompletedOnboarding":true,"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$WORK" > "$CFG/.claude.json"

cap() { t capture-pane -p -J -t cap > "$out/$1.txt"; t capture-pane -e -p -J -t cap > "$out/$1.ansi.txt"; }
box_row() { grep -c $'^❯\xc2\xa0' "$out/$1.txt" || true; }

t -f /dev/null new-session -d -s cap -x 120 -y 40 -c "$WORK" \
  env -i HOME="$H" CLAUDE_CONFIG_DIR="$CFG" TERM=xterm-256color PATH="$(dirname "$CLAUDE_BIN"):$NODE_DIR:/usr/bin:/bin" "$CLAUDE_BIN"

# First screen: wait up to 30 s for the input box, then show it.
for _ in $(seq 30); do sleep 1; cap 01-first; [ "$(box_row 01-first)" -gt 0 ] && break; done
sleep 2; cap 01-first
echo "== first screen ($out/01-first.txt):"; cat "$out/01-first.txt"
if [ "$(box_row 01-first)" -eq 0 ]; then echo "STOP: no input box (❯ + U+00A0) on the first screen; nothing was typed"; exit 2; fi
grep -q "Not logged in" "$out/01-first.txt" && echo "== logged out: OK" || echo "== WARNING: the first screen does not say 'Not logged in' — check it before trusting the captures"

clear_box() { for _ in $(seq 70); do t send-keys -t cap BSpace; sleep 0.02; done; sleep 1; }

# 1. Our line at 120 columns, then ONE send-keys with 53 BSpace (exactly TmuxCommands.sendBackspaces).
t send-keys -t cap -l -- "$LINE"; sleep 1.5; cap 02-typed-120
t send-keys -t cap $(printf 'BSpace %.0s' $(seq 53)); sleep 1.5; cap 03-after-burst-120
clear_box; cap 03b-cleared-120

# 2. The same 53 BSpace one key per call (the split alternative), for comparison.
t send-keys -t cap -l -- "$LINE"; sleep 1.5
for _ in $(seq 53); do t send-keys -t cap BSpace; sleep 0.02; done; sleep 1.5; cap 04-after-split-120
clear_box

# 3. Narrow panes: is our line drawn wrapped, and where does it break? Then the burst again.
for w in 40 30; do
  t resize-window -t cap -x "$w" -y 40; sleep 1.5
  t send-keys -t cap -l -- "$LINE"; sleep 1.5; cap "05-typed-$w"
  t send-keys -t cap $(printf 'BSpace %.0s' $(seq 53)); sleep 1.5; cap "06-after-burst-$w"
  clear_box; cap "06b-cleared-$w"
done

ver="$(env -i HOME="$H" CLAUDE_CONFIG_DIR="$CFG" PATH="$(dirname "$CLAUDE_BIN"):$NODE_DIR:/usr/bin:/bin" "$CLAUDE_BIN" --version 2>/dev/null || echo '?')"
echo "== claude: $ver  tmux: $("$TMUX_BIN" -V)"
echo "== captures in $out:"; ls -1 "$out"
echo "== no Enter was sent; the server is killed and the temp dirs removed now"
