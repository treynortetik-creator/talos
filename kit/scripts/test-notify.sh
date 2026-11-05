#!/usr/bin/env bash
# test-notify.sh -- notify/talos.sh (thread, --file, word cap, failure exit code).
#
# A fake `talos-app` on PATH records what it was called with; nothing touches the network or your real HOME.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"; export HOME="$SB/home"; mkdir -p "$HOME/bin"

cat > "$HOME/bin/talos-app" <<FAKE
#!/bin/bash
{ printf 'ARGC: %s\n' "\$#"; for a in "\$@"; do printf 'ARG: %s\n' "\$a"; done; } >> "$SB/calls"
[ -n "\${FAKE_POST_FAIL:-}" ] && { echo "post failed" >&2; exit 1; }
exit 0
FAKE
chmod +x "$HOME/bin/talos-app"
export PATH="$HOME/bin:$PATH"
T="$KIT/notify/talos.sh"

[ -x "$T" ] && bash -n "$T" && ok "talos.sh exists, is executable and parses" || no "talos.sh missing, not executable or has a syntax error"

: > "$SB/calls"
bash "$T" "hello from a job" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -qx 'ARG: post' "$SB/calls" && grep -qx 'ARG: inbox' "$SB/calls" && grep -qx 'ARG: hello from a job' "$SB/calls"; } \
  && ok "talos.sh posts the message to the inbox thread through talos-app" || no "talos.sh did not call talos-app post as expected (rc=$rc)" "$(cat "$SB/calls")"

: > "$SB/calls"; TALOS_NOTIFY_THREAD=briefs bash "$T" "x" >/dev/null 2>&1
grep -qx 'ARG: briefs' "$SB/calls" && ok "TALOS_NOTIFY_THREAD picks the thread" || no "thread env ignored" "$(cat "$SB/calls")"

: > "$SB/calls"; printf '#!/bin/bash\necho "$@" > "%s/other"\n' "$SB" > "$SB/other-bin"; chmod +x "$SB/other-bin"
TALOS_APP_BIN="$SB/other-bin" bash "$T" "via env" >/dev/null 2>&1
{ grep -q 'post inbox via env' "$SB/other" 2>/dev/null && [ ! -s "$SB/calls" ]; } && ok "TALOS_APP_BIN overrides the command" || no "TALOS_APP_BIN ignored"

FAKE_POST_FAIL=1 bash "$T" "hello" >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && ok "talos.sh exits non-zero when the post fails" || no "talos.sh reported success on a failed post"

: > "$SB/calls"; printf 'a brief\n' > "$SB/brief.md"
bash "$T" --file "$SB/brief.md" "the short caption" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -q 'the short caption' "$SB/calls" && grep -q "(file on the Mac: $SB/brief.md)" "$SB/calls"; } \
  && ok "--file PATH \"caption\" posts the caption and names the file on the Mac" || no "--file path wrong (rc=$rc)" "$(cat "$SB/calls")"
bash "$T" --file "$SB/does-not-exist.md" "x" >/dev/null 2>&1 && no "--file with a missing file succeeded" || ok "--file with a missing file fails clearly"

long="$(python3 -c "print(' '.join(['word'] * 200))")"
err="$(bash "$T" "$long" 2>&1 >/dev/null)"
printf '%s' "$err" | grep -q '200 words is past the 150-word cap' && ok "a message past 150 words warns on stderr (and still sends)" || no "no word-cap warning" "$err"
err="$(TALOS_NOTIFY_WORD_CAP=500 bash "$T" "$long" 2>&1 >/dev/null)"; [ -z "$err" ] && ok "TALOS_NOTIFY_WORD_CAP raises the cap" || no "cap env ignored" "$err"
: > "$SB/calls"; bash "$T" "" >/dev/null 2>&1; [ ! -s "$SB/calls" ] && ok "an empty message sends nothing" || no "empty message sent"

# R1-4: Chronos runs with a thin PATH (no ~/.bun/bin, no ~/.local/bin). The wrapper must still find talos-app, and when
# it truly can't, say so on stderr and in a log file instead of vanishing.
THIN="/usr/bin:/bin"
mkdir -p "$HOME/.bun/bin" "$HOME/.config/talos"
mv "$HOME/bin/talos-app" "$HOME/.bun/bin/talos-app"
: > "$SB/calls"
env -i HOME="$HOME" PATH="$THIN" bash "$T" "thin path, bun fallback" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -qx 'ARG: thin path, bun fallback' "$SB/calls"; } \
  && ok "a Chronos-like PATH without ~/.bun/bin still finds talos-app there" || no "bun fallback failed (rc=$rc)" "$(cat "$SB/calls")"
mkdir -p "$HOME/.local/bin"; mv "$HOME/.bun/bin/talos-app" "$HOME/.local/bin/talos-app"
: > "$SB/calls"
env -i HOME="$HOME" PATH="$THIN" bash "$T" "local bin" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -qx 'ARG: local bin' "$SB/calls"; } && ok "~/.local/bin is the second fallback" || no "~/.local/bin fallback failed (rc=$rc)"
mkdir -p "$SB/elsewhere"; mv "$HOME/.local/bin/talos-app" "$SB/elsewhere/talos-app"
printf '%s\n' "$SB/elsewhere/talos-app" > "$HOME/.config/talos/talos-app-bin"
: > "$SB/calls"
env -i HOME="$HOME" PATH="$THIN" bash "$T" "recorded" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -qx 'ARG: recorded' "$SB/calls"; } && ok "the path install.sh recorded is used first" || no "recorded path ignored (rc=$rc)"
rm -f "$HOME/.config/talos/talos-app-bin" "$SB/elsewhere/talos-app"
err="$(env -i HOME="$HOME" PATH="$THIN" bash "$T" "nowhere" 2>&1 >/dev/null)"; rc=$?
{ [ "$rc" = 127 ] && printf '%s' "$err" | grep -q 'talos-app not found' && grep -q 'NOT delivered' "$HOME/.config/talos/notify-errors.log"; } \
  && ok "with no talos-app anywhere: exit 127, a line on stderr and in notify-errors.log" || no "a missing binary vanished silently (rc=$rc)" "$err"

# R2-5: a bare-name TALOS_APP_BIN that is not on PATH is a missing binary too: logged, exit 127, not a bare shell error
rm -f "$HOME/.config/talos/notify-errors.log"
err="$(env -i HOME="$HOME" PATH="$THIN" TALOS_APP_BIN=no-such-talos-app bash "$T" "bare" 2>&1 >/dev/null)"; rc=$?
{ [ "$rc" = 127 ] && grep -q 'NOT delivered' "$HOME/.config/talos/notify-errors.log" 2>/dev/null; } \
  && ok "a bare TALOS_APP_BIN that is not on PATH logs the not-found line and exits 127" || no "bare missing TALOS_APP_BIN left no log line (rc=$rc)" "$err"

export HOME="$REALHOME"
echo "  notify: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
