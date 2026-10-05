#!/bin/bash
# Talos notify wrapper: Telegram, over the Bot API with plain curl.
#
#   telegram.sh "message"                       Chronos calls it this way
#   telegram.sh --file PATH "optional caption"  send a document (a brief, a report) with a caption
#
# Needs two values. launchd does not read your shell profile, so they live in a file this script sources:
#   ~/.config/talos/notify.env      (chmod 600; override the path with TALOS_NOTIFY_ENV)
#     TELEGRAM_BOT_TOKEN=<token from @BotFather>
#     TELEGRAM_CHAT_ID=<your numeric chat id>
# Copy notify.env.example next to it and fill it in yourself. Never paste a token into a chat with the
# agent, a note, or a command line.
#
# The token never appears on a command line: the request URL (which carries it) is handed to curl on stdin
# with `-K -`, because anything on argv is visible to every process on the machine through `ps`.
#
# Length: a message past TALOS_TG_WORD_CAP words (default 150) still sends, but a warning goes to stderr.
# A phone notification nobody finishes reading is a bad notification; put the long version in a file and
# send that with --file. Telegram itself caps a text message at 4096 characters, so the text is cut there.
#
# curl never starts a getUpdates poller, so this cannot cause the HTTP 409 conflict that a headless
# Claude with the Telegram channel plugin enabled would (Chronos also disables that plugin in jobs).
set -u
ENV_FILE="${TALOS_NOTIFY_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/talos/notify.env}"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
: "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN in $ENV_FILE}" "${TELEGRAM_CHAT_ID:?set TELEGRAM_CHAT_ID in $ENV_FILE}"

FILE=""
if [ "${1:-}" = "--file" ]; then
  FILE="${2:?--file needs a path}"; shift 2
  [ -f "$FILE" ] || { echo "telegram.sh: no such file: $FILE" >&2; exit 1; }
fi
msg="${1:-}"
[ -n "$msg" ] || [ -n "$FILE" ] || exit 0

CAP="${TALOS_TG_WORD_CAP:-150}"
words=$(printf '%s' "$msg" | wc -w | tr -d ' ')
if [ "$words" -gt "$CAP" ]; then
  echo "telegram.sh: warning: $words words is past the $CAP-word cap; consider --file with a short caption." >&2
fi

# No parse_mode on purpose: plain text cannot be broken by a stray underscore or asterisk.
# curl -f: an HTTP error from Telegram (a bad token or chat id) must be a non-zero exit, not a silent success.
# --form-string for the text fields: with -F, a caption starting with `<` would make curl upload a LOCAL FILE's
# contents as the caption and one starting with `@` would attach a file; --form-string never interprets the value.
if [ -n "$FILE" ]; then
  printf 'url = "https://api.telegram.org/bot%s/sendDocument"\n' "$TELEGRAM_BOT_TOKEN" \
    | curl -fsS --max-time 60 -K - \
        --form-string "chat_id=$TELEGRAM_CHAT_ID" -F "document=@$FILE" --form-string "caption=${msg:0:1000}" >/dev/null
else
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$TELEGRAM_BOT_TOKEN" \
    | curl -fsS --max-time 20 -K - \
        --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
        --data-urlencode "text=${msg:0:4000}" >/dev/null
fi
