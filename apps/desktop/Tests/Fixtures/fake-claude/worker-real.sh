# A thread session that shows REAL Claude Code 2.1.318 screens: the files in ../real-2.1.318 are captures, printed back as they are.
# FAKE_REAL_START=trust|empty|draft: the first screen. With trust, the hub's ready file is written after the owner's Enter (or at
# once with FAKE_REAL_READY_FIRST) and the screen then becomes `empty`.
# FAKE_REAL_SWITCH=<file> with FAKE_REAL_THEN=<screen>: when that file appears, the screen changes to the named one.
# An Enter while the trust dialog is up answers it. Every line typed into the pane is logged (FAKE_TYPED_LOG).
. "$(dirname "$0")/lib.sh"
D="$(cd "$(dirname "$0")/../real-2.1.318" && pwd)"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
ready() { printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"; }
cur=
show() {  # one whole screen, rows joined by CR LF, no final newline (the pane is 40 rows)
  f="$D/$1.txt"; cur="$1"
  printf '\033[2J\033[H'
  awk 'NR>1{printf "\r\n"} {printf "%s", $0}' "$f" | head -c 100000
}
start="${FAKE_REAL_START:-empty}"
case "$start" in
  trust)
    [ -n "${FAKE_REAL_READY_FIRST:-}" ] && ready
    show trust-dialog
    IFS= read -r _
    ready
    show empty-input ;;
  *) ready; if [ "$start" = draft ]; then show draft-input; else show empty-input; fi ;;
esac
switched=
while true; do
  if [ -z "$switched" ] && [ -n "${FAKE_REAL_SWITCH:-}" ] && [ -f "$FAKE_REAL_SWITCH" ]; then show "${FAKE_REAL_THEN:-empty-input}"; switched=1; fi
  if IFS= read -r -t 1 line; then
    # an Enter on the trust dialog answers it (the highlighted row is `No, exit` in the real dialog, but here it only has to go away)
    if [ "$cur" = trust-dialog ]; then show empty-input; ready; continue; fi
    printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
  fi
done
