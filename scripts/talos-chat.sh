#!/bin/bash
# talos-chat.sh: start this agent with the Telegram channel, so you can talk to it from your phone.
#
#   bash scripts/talos-chat.sh [--force] [any other claude flags, e.g. --continue]
#
# It does exactly one thing: cd to the agent folder and run
#   claude --channels plugin:telegram@claude-plugins-official
# one command instead of remembering the folder and the flag. Setup is in setup/telegram.md (bot, plugin, token,
# pairing); this launcher refuses to start if the plugin has no token yet.
#
# THE ONE RULE (HTTP 409): only one process may poll a Telegram bot. If another `claude --channels ...` is already
# running, a second one would break both with a 409, so this refuses unless you pass --force. Never run
# `claude mcp list` while a channel session is open either (409 again): its health check starts every server.
set -u
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0; ARGS=()
for a in "$@"; do
  case "$a" in
    --force) FORCE=1 ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
command -v claude >/dev/null 2>&1 || { echo "talos-chat: the 'claude' CLI is not on PATH. Install Claude Code first (see START-HERE.md)." >&2; exit 1; }
ENVF="${TELEGRAM_STATE_DIR:-$HOME/.claude/channels/telegram}/.env"
if [ ! -s "$ENVF" ] && [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo "talos-chat: no Telegram bot token found ($ENVF)." >&2
  echo "Do the one-time setup in setup/telegram.md first (BotFather, /plugin install, /telegram:configure, pairing)." >&2
  exit 1
fi
if [ "$FORCE" != 1 ]; then
  other="$(${TALOS_PGREP:-pgrep} -f 'claude.*--channels' 2>/dev/null | grep -v "^$$\$" | head -3 | tr '\n' ' ')"
  if [ -n "$other" ]; then
    echo "talos-chat: another 'claude --channels' process is already running (pid $other)." >&2
    echo "A second one would start a second Telegram poller and both would fail with HTTP 409. Use the running one," >&2
    echo "close it first, or pass --force if you are sure that process is not polling this bot." >&2
    exit 1
  fi
fi
cd "$AGENT_DIR" || exit 1
exec claude --channels plugin:telegram@claude-plugins-official ${ARGS[@]+"${ARGS[@]}"}
