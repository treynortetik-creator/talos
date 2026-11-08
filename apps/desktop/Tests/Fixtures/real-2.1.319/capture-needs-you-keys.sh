#!/bin/bash
# Captures how the real Claude Code CLI's folder-trust and MCP-consent dialogs take keys, for the Needs-you prompts fixtures (README
# method of apps/desktop/Tests/Fixtures/real-2.1.318): logged out, `env -i`, temp HOME and CLAUDE_CONFIG_DIR, a throwaway project folder,
# a private `-L talos-test-*` tmux server at 120x40, `capture-pane -p -J` plus `-e` copies. Keys go ONLY to a dialog, inside the throwaway
# folder; a capture that shows the input box stops that session before any key (nothing is ever typed into the input box or submitted).
# The MCP server is `/bin/echo` (it exits at once; nothing runs). Each session's server is killed and its temp dirs removed.
# Usage: capture-needs-you-keys.sh <out-dir>     (needs `claude` and `tmux` on PATH)
set -euo pipefail
out="${1:?usage: capture-needs-you-keys.sh <out-dir>}"
mkdir -p "$out"
TMUX_BIN="$(command -v tmux)"
CLAUDE_BIN="$(command -v claude)"
NODE_DIR="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
SAFE_PATH="$(dirname "$CLAUDE_BIN"):$NODE_DIR:/usr/bin:/bin"

SOCK="" H="" CFG="" WORK=""
t() { "$TMUX_BIN" -L "$SOCK" "$@"; }
end_session() { [ -n "$SOCK" ] && t kill-server 2>/dev/null || true; [ -n "$H" ] && rm -rf "$H" "$CFG" "$WORK"; SOCK="" H="" CFG="" WORK=""; }
trap end_session EXIT

# start <name> <trust:0|1> <mcp:0|1>: onboarding done; the folder trusted only if asked; a harmless .mcp.json only if asked.
start() {
  SOCK="talos-test-nyc-$1-$$"
  H="$(mktemp -d /private/tmp/tcap-ny-home.XXXXXX)"; CFG="$(mktemp -d /private/tmp/tcap-ny-cfg.XXXXXX)"
  WORK="$(mktemp -d /private/tmp/tcap-ny-proj.XXXXXX)"
  if [ "$2" = 1 ]; then
    printf '{"hasCompletedOnboarding":true,"projects":{"%s":{"hasTrustDialogAccepted":true}}}\n' "$WORK" > "$CFG/.claude.json"
  else
    printf '{"hasCompletedOnboarding":true}\n' > "$CFG/.claude.json"
  fi
  [ "$3" = 1 ] && printf '{"mcpServers":{"harmless":{"command":"/bin/echo","args":["hi"]}}}\n' > "$WORK/.mcp.json"
  t -f /dev/null new-session -d -s cap -x 120 -y 40 -c "$WORK" \
    env -i HOME="$H" CLAUDE_CONFIG_DIR="$CFG" TERM=xterm-256color PATH="$SAFE_PATH" "$CLAUDE_BIN"
}
LAST=""
cap() { t capture-pane -p -J -t cap > "$out/$1.txt"; t capture-pane -e -p -J -t cap > "$out/$1.ansi.txt"; LAST="$1"; }
has() { grep -qF -- "$2" "$out/$1.txt"; }
input_box() { grep -q $'^❯\xc2\xa0' "$out/$1.txt"; }
# wait_for <capture-name> <text>: up to 30 s; prints the screen; returns 1 (and the caller stops the session) if it never shows
wait_for() {
  for _ in $(seq 30); do sleep 1; cap "$1"; has "$1" "$2" && break; done
  sleep 1.5; cap "$1"; echo "== $1:"; grep -v '^\s*$' "$out/$1.txt" | tail -14
  has "$1" "$2" || { echo "STOP: '$2' never showed in $1; no key sent in this session"; return 1; }
}
# key <capture-name> <tmux key>: refuses if the last capture shows the input box (keys go to dialogs only)
key() {
  if [ -n "$LAST" ] && input_box "$LAST"; then echo "STOP: the input box is up in $LAST; no key sent"; return 1; fi
  t send-keys -t cap "$2"; sleep 1.5; cap "$1"
}

echo "#### A. Folder trust: arrow keys (no Enter)"
start trust-arrows 0 0
{ if wait_for 01-trust-first "Yes, I trust"; then
  key 02-trust-down Down; key 03-trust-down2 Down; key 04-trust-up Up
fi; } || true
end_session

echo "#### B. Folder trust: a digit (does '2' choose the second option, and does it confirm?)"
start trust-digit 0 0
{ if wait_for 05-trust-first "Yes, I trust"; then key 06-trust-after-2 2; sleep 1.5; cap 07-trust-after-2-later; fi; } || true
end_session

echo "#### C. Folder trust: Down then Enter on 'Yes, I trust this folder' (throwaway folder) -> the next screen"
start trust-yes 0 0
{ if wait_for 08-trust-first "Yes, I trust"; then key 09-trust-on-yes Down && key 10-trust-after-enter Enter; sleep 2; cap 11-trust-after-enter-later; fi; } || true
end_session

echo "#### D. Folder trust: Enter on 'No, exit' (the default) -> what happens"
start trust-no 0 0
{ if wait_for 12-trust-first "Yes, I trust"; then key 13-trust-after-no Enter; sleep 2; cap 14-trust-after-no-later; fi; } || true
end_session

echo "#### E. MCP consent (trusted folder, /bin/echo server): arrows, then Enter on 'Use this MCP server'"
start mcp 1 1
{ if wait_for 20-mcp-first "MCP server"; then
  key 21-mcp-up Up; key 22-mcp-up2 Up; key 23-mcp-down Down
  # the cursor starts on the LAST option; walk to the first ('Use this MCP server') whatever the order turns out to be
  for _ in 1 2 3; do key 24-mcp-to-top Up; done
  key 25-mcp-after-enter Enter; sleep 2; cap 26-mcp-after-enter-later
fi; } || true
end_session

echo "#### F. MCP consent: a digit"
start mcp-digit 1 1
{ if wait_for 27-mcp-first "MCP server"; then key 28-mcp-after-1 1; sleep 1.5; cap 29-mcp-after-1-later; fi; } || true
end_session

vd="$(mktemp -d /private/tmp/tcap-ny-ver.XXXXXX)"
ver="$(env -i HOME="$vd" CLAUDE_CONFIG_DIR="$vd" PATH="$SAFE_PATH" "$CLAUDE_BIN" --version 2>/dev/null || echo '?')"; rm -rf "$vd"
echo "== claude: $ver  tmux: $("$TMUX_BIN" -V)"
echo "== captures in $out:"; ls -1 "$out"
echo "== keys went only to dialogs in throwaway folders; nothing typed into an input box; servers killed, temp dirs removed"
