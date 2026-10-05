#!/usr/bin/env bash
# test-notify.sh -- notify/telegram.sh (token off argv, --file, word cap) and scripts/talos-chat.sh (the launcher).
#
# A fake `curl`, `claude` and `pgrep` on PATH record what they were called with; nothing touches the network, the
# Telegram API, a real claude, or your real HOME. The "token" below is a made-up string.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"; export HOME="$SB/home"; mkdir -p "$HOME/bin" "$HOME/.config/talos"
export XDG_CONFIG_HOME="$HOME/.config"
FAKE_TOKEN="123456789:FAKEtokenFAKEtokenFAKEtokenFAKEtoken12"
printf 'TELEGRAM_BOT_TOKEN=%s\nTELEGRAM_CHAT_ID=4242\n' "$FAKE_TOKEN" > "$HOME/.config/talos/notify.env"; chmod 600 "$HOME/.config/talos/notify.env"

cat > "$HOME/bin/curl" <<FAKE
#!/bin/bash
{ echo "ARGV: \$*"; echo "STDIN: \$(cat 2>/dev/null)"; } >> "$SB/curl.calls"
[ -n "\${FAKE_CURL_FAIL:-}" ] && { echo "curl: (22) The requested URL returned error: 400" >&2; exit 22; }
exit 0
FAKE
cat > "$HOME/bin/claude" <<FAKE
#!/bin/bash
{ echo "ARGS: \$*"; echo "PWD: \$(pwd)"; } > "$SB/claude.called"
FAKE
chmod +x "$HOME/bin/curl" "$HOME/bin/claude"
export PATH="$HOME/bin:$PATH"
T="$KIT/notify/telegram.sh"

# ---- telegram.sh
: > "$SB/curl.calls"
bash "$T" "hello from a job" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -q 'ARGV:' "$SB/curl.calls" && grep -q 'sendMessage' "$SB/curl.calls" && grep -q 'text=hello from a job' "$SB/curl.calls" && grep -q 'chat_id=4242' "$SB/curl.calls"; } \
  && ok "telegram.sh sends a message through curl (sendMessage, chat id and text)" || no "telegram.sh did not call curl as expected (rc=$rc)" "$(cat "$SB/curl.calls")"
grep '^ARGV:' "$SB/curl.calls" | grep -q "$FAKE_TOKEN" && no "the bot token appears on curl's command line (visible in ps)" || ok "the bot token is NOT on curl's argv"
grep -q '^STDIN:.*api.telegram.org/bot'"$FAKE_TOKEN"'/sendMessage' "$SB/curl.calls" && ok "the token-bearing URL goes to curl on stdin (-K -)" || no "URL not passed on stdin" "$(cat "$SB/curl.calls")"
FAKE_CURL_FAIL=1 bash "$T" "hello" >/dev/null 2>&1; rc=$?
[ "$rc" != 0 ] && ok "telegram.sh exits non-zero when Telegram answers with an HTTP error (a bad token or chat id is not silent)" || no "telegram.sh reported success on an HTTP error"
grep -q -- ' -fsS \| -fsS' "$SB/curl.calls" && ok "curl runs with -f (fail on HTTP errors)" || no "curl is not run with -f" "$(head -3 "$SB/curl.calls")"
: > "$SB/curl.calls"; printf 'secret\n' > "$SB/secret.txt"; printf 'a brief\n' > "$SB/brief.md"
bash "$T" --file "$SB/brief.md" "<$SB/secret.txt" >/dev/null 2>&1
grep '^ARGV:' "$SB/curl.calls" | grep -q -- "--form-string caption=<$SB/secret.txt" && ! grep '^ARGV:' "$SB/curl.calls" | grep -q -- '-F caption=' \
  && ok "a caption that starts with < or @ is sent with --form-string, so curl cannot read a local file into it" || no "caption not protected from curl's file syntax" "$(grep ARGV "$SB/curl.calls")"
grep -q 'parse_mode' "$SB/curl.calls" && no "telegram.sh sets a parse_mode (markdown breaks on stray underscores)" || ok "no parse_mode: plain text only"

: > "$SB/curl.calls"; printf 'a brief\n' > "$SB/brief.md"
bash "$T" --file "$SB/brief.md" "the short caption" >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -q 'sendDocument' "$SB/curl.calls" && grep -q "document=@$SB/brief.md" "$SB/curl.calls" && grep -q 'caption=the short caption' "$SB/curl.calls"; } \
  && ok "--file PATH \"caption\" sends the file with sendDocument and the caption" || no "--file path wrong (rc=$rc)" "$(cat "$SB/curl.calls")"
grep '^ARGV:' "$SB/curl.calls" | grep -q "$FAKE_TOKEN" && no "token on argv for --file" || ok "the token is not on argv for --file either"
bash "$T" --file "$SB/does-not-exist.md" "x" >/dev/null 2>&1 && no "--file with a missing file succeeded" || ok "--file with a missing file fails clearly"

long="$(python3 -c "print(' '.join(['word'] * 200))")"
err="$(bash "$T" "$long" 2>&1 >/dev/null)"
printf '%s' "$err" | grep -q '200 words is past the 150-word cap' && ok "a message past 150 words warns on stderr (and still sends)" || no "no word-cap warning" "$err"
err="$(TALOS_TG_WORD_CAP=500 bash "$T" "$long" 2>&1 >/dev/null)"; [ -z "$err" ] && ok "TALOS_TG_WORD_CAP raises the cap" || no "cap env ignored" "$err"
: > "$SB/curl.calls"; bash "$T" "" >/dev/null 2>&1; [ ! -s "$SB/curl.calls" ] && ok "an empty message sends nothing" || no "empty message sent"
TALOS_NOTIFY_ENV="$SB/missing.env" bash "$T" "x" >/dev/null 2>&1 && no "ran with no token configured" || ok "with no token configured it refuses, naming the file"

# ---- talos-chat.sh
L="$KIT/scripts/talos-chat.sh"
[ -x "$L" ] && bash -n "$L" && ok "talos-chat.sh exists, is executable and parses" || no "talos-chat.sh missing, not executable or has a syntax error"
rm -f "$SB/claude.called"; bash "$L" >/dev/null 2>"$SB/err"; rc=$?
{ [ "$rc" = 1 ] && grep -q 'setup/telegram.md' "$SB/err" && [ ! -e "$SB/claude.called" ]; } && ok "with no plugin token it refuses and points at setup/telegram.md (claude is not started)" || no "launcher started without a token (rc=$rc)"
mkdir -p "$HOME/.claude/channels/telegram"; printf 'TELEGRAM_BOT_TOKEN=%s\n' "$FAKE_TOKEN" > "$HOME/.claude/channels/telegram/.env"
printf '#!/bin/bash\nexit 1\n' > "$HOME/bin/pgrep"; chmod +x "$HOME/bin/pgrep"
rm -f "$SB/claude.called"; bash "$L" --continue >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && grep -q '^ARGS: --channels plugin:telegram@claude-plugins-official --continue$' "$SB/claude.called" && grep -q "^PWD: .*$(basename "$KIT")$" "$SB/claude.called"; } \
  && ok "the launcher runs claude --channels plugin:telegram@claude-plugins-official from the agent folder, passing extra flags" || no "launcher call wrong (rc=$rc)" "$(cat "$SB/claude.called" 2>/dev/null)"
printf '#!/bin/bash\necho 4321\n' > "$HOME/bin/pgrep"
rm -f "$SB/claude.called"; bash "$L" >/dev/null 2>"$SB/err"; rc=$?
{ [ "$rc" = 1 ] && grep -q '409' "$SB/err" && [ ! -e "$SB/claude.called" ]; } && ok "if another claude --channels is running it refuses (a second poller means HTTP 409)" || no "second poller not refused (rc=$rc)"
rm -f "$SB/claude.called"; bash "$L" --force >/dev/null 2>&1
[ -e "$SB/claude.called" ] && ok "--force overrides the poller check" || no "--force ignored"

export HOME="$REALHOME"
echo "  notify: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
