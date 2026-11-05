#!/bin/bash
# Talos notify wrapper: delivers through the Talos app (your phone or browser), with `talos-app post`.
#
#   talos.sh "message"                       Chronos calls it this way
#   talos.sh --file PATH "optional caption"  post the caption and name the file's path on this Mac
#
# The message lands in the thread named by TALOS_NOTIFY_THREAD (default: inbox). The talos-app command is, in order:
# TALOS_APP_BIN if set; the absolute path install.sh recorded in <config>/talos/talos-app-bin; `talos-app` on PATH;
# ~/.bun/bin/talos-app; ~/.local/bin/talos-app. Chronos runs with a thin PATH that has none of the user's bin folders, which
# is why the recorded path and the two fallbacks exist. If none is found, one line goes to stderr AND to
# <config>/talos/notify-errors.log and the exit code is 127: a notification never vanishes without a trace.
# Nothing secret is needed: the Mac is already signed in to the relay.
#
# Length: a message past TALOS_NOTIFY_WORD_CAP words (default 150) still sends, but a warning goes to stderr.
# A phone notification nobody finishes reading is a bad notification; put the long version in a file and
# send that with --file and a short caption.
set -u
CFGDIR="${XDG_CONFIG_HOME:-$HOME/.config}/talos"
BIN="${TALOS_APP_BIN:-}"
if [ -z "$BIN" ] && [ -r "$CFGDIR/talos-app-bin" ]; then
  rec="$(head -n 1 "$CFGDIR/talos-app-bin" 2>/dev/null)"
  [ -n "$rec" ] && [ -x "$rec" ] && BIN="$rec"
fi
if [ -z "$BIN" ]; then BIN="$(command -v talos-app 2>/dev/null || true)"; fi
if [ -z "$BIN" ]; then
  for c in "$HOME/.bun/bin/talos-app" "$HOME/.local/bin/talos-app"; do
    [ -x "$c" ] && { BIN="$c"; break; }
  done
fi
missing=0
if [ -z "$BIN" ]; then missing=1
elif [ "${BIN#*/}" != "$BIN" ]; then [ -x "$BIN" ] || missing=1
else command -v "$BIN" >/dev/null 2>&1 || missing=1; fi
if [ "$missing" = 1 ]; then
  line="talos.sh: $(date '+%Y-%m-%dT%H:%M:%S%z') talos-app not found (tried TALOS_APP_BIN, $CFGDIR/talos-app-bin, PATH, ~/.bun/bin, ~/.local/bin); message NOT delivered"
  echo "$line" >&2
  { mkdir -p "$CFGDIR" && printf '%s\n' "$line" >> "$CFGDIR/notify-errors.log"; } 2>/dev/null || true
  exit 127
fi
THREAD="${TALOS_NOTIFY_THREAD:-inbox}"

FILE=""
if [ "${1:-}" = "--file" ]; then
  FILE="${2:?--file needs a path}"; shift 2
  [ -f "$FILE" ] || { echo "talos.sh: no such file: $FILE" >&2; exit 1; }
fi
msg="${1:-}"
[ -n "$msg" ] || [ -n "$FILE" ] || exit 0

CAP="${TALOS_NOTIFY_WORD_CAP:-150}"
words=$(printf '%s' "$msg" | wc -w | tr -d ' ')
if [ "$words" -gt "$CAP" ]; then
  echo "talos.sh: warning: $words words is past the $CAP-word cap; consider --file with a short caption." >&2
fi

if [ -n "$FILE" ]; then
  msg="${msg:+$msg
}(file on the Mac: $FILE)"
fi
exec "$BIN" post "$THREAD" "${msg:0:4000}"
