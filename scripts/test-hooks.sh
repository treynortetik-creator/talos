#!/usr/bin/env bash
# test-hooks.sh -- the enforcement hooks: claim gate, append-only guard, sub-agent log, statusline, channel debt.
#
# Each hook is fed the JSON the harness would send, inside a throwaway agent folder and a throwaway HOME, XDG state
# and config folders. Nothing here touches your real ~/.claude, ~/.local/state, ~/.config, ~/.chronos or an agent.
# Every hook must also FAIL OPEN: garbage in, exit 0, nothing out, no traceback.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"
export HOME="$SB/home"; mkdir -p "$HOME"
export XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg" XDG_DATA_HOME="$SB/data"
unset CHRONOS_CONFIG TALOS_TELEGRAM_MIRROR CHRONOS_RUN

A="$SB/agent"; rm -rf "$A"; mkdir -p "$A/hooks" "$A/memory" "$A/wiki" "$A/scripts"
cp "$KIT"/hooks/*.py "$A/hooks/"
SD="$(cd "$A" && python3 -c 'import sys; sys.path.insert(0, "hooks"); import _talos_common as C; print(C.state_dir())')"
H() { local hook="$1"; shift; ( cd "$A" && python3 "hooks/$hook" "$@" 2>"$SB/stderr" ); }
js() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# ---------------------------------------------------------------- state folder
case "$SD" in "$XDG_STATE_HOME"/talos/agent-*) ok "hook state lives under XDG_STATE_HOME/talos/<name>-<hash>, outside the agent folder" ;; *) no "unexpected state dir: $SD" ;; esac

# ================================================================ D1 claim-gate
S1='{"last_assistant_message":"There is no such file in the project.","session_id":"s1"}'
printf '%s' "$S1" | H claim-gate.py
[ -s "$SD/claim-gate-pending.json" ] && ok "claim gate: an absolute claim with no evidence queues a notice" || no "claim gate: nothing queued"
out="$(printf '{"prompt":"next","session_id":"s2"}' | H claim-gate.py inject)"
{ [ -z "$out" ] && [ -s "$SD/claim-gate-pending.json" ]; } && ok "claim gate: another session does not collect (or consume) the notice" || no "claim gate: wrong session got the notice" "$out"
out="$(printf '{"prompt":"next","session_id":"s1"}' | H claim-gate.py inject)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert "CLAIM GATE" in d["hookSpecificOutput"]["additionalContext"] and "Do NOT re-send" in d["hookSpecificOutput"]["additionalContext"]' 2>/dev/null \
  && ok "claim gate: the owning session gets the notice as context on its next prompt" || no "claim gate: inject output wrong" "$out"
out="$(printf '{"prompt":"again","session_id":"s1"}' | H claim-gate.py inject)"
[ -z "$out" ] && ok "claim gate: the notice is delivered once, then nothing" || no "claim gate: delivered twice" "$out"
printf '%s' "$S1" | H claim-gate.py
[ ! -s "$SD/claim-gate-pending.json" ] && ok "claim gate: the same message is never flagged twice" || no "claim gate: re-flagged the same message"

clean_state() { rm -rf "$SD"; }
for msg in 'There is no such file (checked: `ls memory`).' 'The export endpoint does not exist as of 2026-10-01.' \
           'It is broken, see https://example.com/status for the outage.' 'The deploy ships once the tests are verified.' \
           '| this row says there is no such thing | x |' 'It returned an empty list, so there is no match.'; do
  clean_state; printf '{"last_assistant_message":%s,"session_id":"s9"}' "$(js "$msg")" | H claim-gate.py
  [ ! -s "$SD/claim-gate-pending.json" ] || { no "claim gate: flagged a sentence that names evidence or is a plan: $msg"; }
done
ok "claim gate: backticks, a date, a URL, a plan, a table row and a stated result are not flagged"
clean_state; printf '{"last_assistant_message":"That tool is broken and the API is not available.","session_id":"s3"}' | H claim-gate.py
[ -s "$SD/claim-gate-pending.json" ] && ok "claim gate: 'is broken' / 'not available' with no evidence is flagged" || no "claim gate missed 'is broken'"
clean_state; mkdir -p "$SD"; touch "$SD/claim-gate.off"
printf '%s' "$S1" | H claim-gate.py
[ ! -e "$SD/claim-gate-pending.json" ] && ok "claim gate: the kill-switch file in the state folder turns it off" || no "claim gate ignored claim-gate.off"
rm -f "$SD/claim-gate.off"; printf '%s' "$S1" | TALOS_CLAIM_GATE_OFF=1 H claim-gate.py
[ ! -e "$SD/claim-gate-pending.json" ] && ok "claim gate: TALOS_CLAIM_GATE_OFF=1 turns it off" || no "claim gate ignored the env kill switch"
mkdir -p "$HOME/.chronos/switches"; touch "$HOME/.chronos/switches/claim-gate.off"
printf '%s' "$S1" | H claim-gate.py
[ ! -e "$SD/claim-gate-pending.json" ] && ok "claim gate: a switch in Chronos's kill-switch folder (the Control Room) turns it off too" || no "claim gate ignored the Chronos switch"
rm -f "$HOME/.chronos/switches/claim-gate.off"
grep -q '"claim-gate.off"' "$A/hooks/claim-gate.py" && ok "claim gate: the kill-switch file name is a string literal (so the Chronos Control Room offers the toggle)" || no "kill switch not a literal"

# ================================================================ D2 append-only guard
python3 -c "open('$A/memory/2026-10-01.md','w').write('x' * 1000)"
python3 -c "open('$A/wiki/_changelog.md','w').write('| 2026-10-01 | a row |\n' * 60)"
python3 -c "open('$A/memory/notes.md','w').write('x' * 1000)"
python3 -c "open('$A/memory/2026-10-02.md','w').write('x' * 300)"
mkdir -p "$SB/other"; python3 -c "open('$SB/other/2026-10-01.md','w').write('x' * 1000)"
W() { printf '{"tool_name":"Write","tool_input":{"file_path":%s,"content":%s}}' "$(js "$1")" "$(js "$2")" | H append-only-guard.py; }
out="$(W "$A/memory/2026-10-01.md" "short")"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin)["hookSpecificOutput"]; assert d["permissionDecision"]=="ask" and "SHRINK" in d["permissionDecisionReason"]' 2>/dev/null \
  && ok "append-only guard: a Write that shrinks a daily log asks first" || no "append-only guard: no ask on shrink" "$out"
out="$(W "$A/memory/2026-10-01.md" "$(python3 -c "print('y' * 1200)")")"
[ "$out" = "{}" ] && ok "append-only guard: a Write that grows the file passes" || no "growth blocked" "$out"
out="$(W "$A/wiki/_changelog.md" "short")"; printf '%s' "$out" | grep -q '"ask"' && ok "append-only guard: the changelog is protected" || no "changelog not protected" "$out"
out="$(W "$A/memory/notes.md" "short")"; [ "$out" = "{}" ] && ok "append-only guard: an ordinary file may shrink" || no "ordinary file blocked" "$out"
out="$(W "$A/memory/2026-10-02.md" "s")"; [ "$out" = "{}" ] && ok "append-only guard: a file under 500 bytes may shrink" || no "small file blocked" "$out"
out="$(W "$SB/other/2026-10-01.md" "short")"; [ "$out" = "{}" ] && ok "append-only guard: a file outside the agent folder is ignored" || no "outside file touched" "$out"
out="$(printf '{"tool_name":"Edit","tool_input":{"file_path":%s,"old_string":"x","new_string":"y"}}' "$(js "$A/memory/2026-10-01.md")" | H append-only-guard.py)"
[ "$out" = "{}" ] && ok "append-only guard: the Edit tool passes (edits are surgical)" || no "Edit blocked" "$out"
out="$(printf 'not json' | H append-only-guard.py)"; [ "$out" = "{}" ] && ok "append-only guard: garbage input fails open" || no "garbage input not open" "$out"
mkdir -p "$SD"; touch "$SD/append-only-guard.off"; out="$(W "$A/memory/2026-10-01.md" "short")"; rm -f "$SD/append-only-guard.off"
[ "$out" = "{}" ] && ok "append-only guard: its kill switch works" || no "kill switch ignored" "$out"

# ================================================================ D3 agent-log
printf 'artifact\n' > "$A/memory/real-artifact.md"; printf 'x\n' > "$SB/other/outside.md"
printf '{"agent_type":"general-purpose","description":"audit the notes","last_assistant_message":"Wrote memory/real-artifact.md and memory/invented-path.md."}' | H agent-log.py
grep -q 'memory/real-artifact.md' "$A/memory/agent-log.md" 2>/dev/null && ! grep -q 'invented-path' "$A/memory/agent-log.md" \
  && ok "agent log: lists an artifact that exists, and not one that was only claimed" || no "agent log artifacts wrong" "$(cat "$A/memory/agent-log.md" 2>/dev/null)"
printf '{"agent_type":"worker","description":"only a phantom","last_assistant_message":"Created memory/ghost.md"}' | H agent-log.py
tail -1 "$A/memory/agent-log.md" | grep -q '| — |$' && ok "agent log: a phantom path is recorded as — (nothing verified)" || no "phantom not dashed" "$(tail -1 "$A/memory/agent-log.md")"
printf '{"agent_type":"worker","description":"outside","last_assistant_message":"Wrote %s"}' "$SB/other/outside.md" | H agent-log.py
tail -1 "$A/memory/agent-log.md" | grep -q 'outside.md' && no "agent log listed a file outside the agent folder" || ok "agent log: a path outside the agent folder is never listed"
before="$(wc -l < "$A/memory/agent-log.md")"; printf '{}' | H agent-log.py; printf 'garbage' | H agent-log.py
[ "$(wc -l < "$A/memory/agent-log.md")" = "$before" ] && ok "agent log: an empty or garbage payload writes no row" || no "a blank row was written"
mkdir -p "$SB/tr"; printf '{"type":"user","message":{"role":"user","content":"Summarise the vendor notes"}}\n' > "$SB/tr/t.jsonl"
printf '{"agent_type":"worker","agent_transcript_path":"%s","last_assistant_message":"done"}' "$SB/tr/t.jsonl" | H agent-log.py
tail -1 "$A/memory/agent-log.md" | grep -q 'Summarise the vendor notes' && ok "agent log: the task is recovered from the sub-agent's transcript when no description is sent" || no "transcript task not used" "$(tail -1 "$A/memory/agent-log.md")"
head -1 "$A/memory/agent-log.md" | grep -q '^# Agent log' && ok "agent log: the file starts with its header" || no "no header"

# ================================================================ D4 statusline
printf 'handoff\n' > "$A/memory/HANDOFF.md"
SL='{"model":{"display_name":"Opus"},"context_window":{"used_percentage":23.4},"rate_limits":{"seven_day":{"used_percentage":12.2}}}'
out="$(printf '%s' "$SL" | H statusline.py)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = 1 ] && printf '%s' "$out" | grep -q 'Opus | ██░░░░░░░░ 23% | 7d: 12% | handoff: ' ; } \
  && ok "statusline: model | context bar | 7-day | handoff age on exactly one line" || no "statusline output wrong (rc=$rc)" "$out"
out="$(printf 'not json' | H statusline.py)"; rc=$?
{ [ "$rc" = 0 ] && ! printf '%s' "$out" | grep -qi traceback; } && ok "statusline: malformed JSON exits 0 and prints no traceback" || no "statusline broke on garbage (rc=$rc)" "$out"
out="$(printf '{"model":{"display_name":"Sonnet"}}' | H statusline.py)"; printf '%s' "$out" | grep -q '^Sonnet' && ok "statusline: missing fields are skipped, the model still prints" || no "statusline partial input wrong" "$out"
out="$(printf '{"model":{"display_name":"X"},"context_window":{"used_percentage":250}}' | H statusline.py)"; printf '%s' "$out" | grep -q '██████████ 100%' && ok "statusline: an out-of-range percentage is clamped" || no "percentage not clamped" "$out"
out="$(printf '%s' "$SL" | LANG=C LC_ALL=C PYTHONIOENCODING=ascii H statusline.py)"; printf '%s' "$out" | grep -q 'Opus' && ok "statusline: survives an ASCII terminal locale" || no "statusline died under LANG=C" "$out"

# ================================================================ E2 channel-debt
D() { H channel-debt.py "$@"; }
TAGGED='{"prompt":"<channel source=\"telegram\" chat_id=\"4242\" message_id=\"1\">hello</channel>"}'
printf '%s' "$TAGGED" | D arm
[ -s "$SD/channel-debt.json" ] && ok "channel debt: a prompt with a <channel source=telegram> tag records a debt" || no "no debt recorded"
out="$(printf '{}' | D check)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["decision"]=="block" and "4242" in d["reason"] and "CANNOT SEE" in d["reason"]' 2>/dev/null \
  && ok "channel debt: Stop with a debt blocks the turn and says why (names the chat)" || no "check did not block" "$out"
out="$(printf '{}' | D check)"
printf '%s' "$out" | grep -q '"block"' && ok "channel debt: a second check still blocks (at most twice in a row)" || no "second check not blocking" "$out"
out="$(printf '{}' | D check)"
[ -z "$out" ] && [ ! -e "$SD/channel-debt.json" ] && ok "channel debt: the third check gives up, so a session can never be trapped" || no "third check blocked" "$out"
printf '%s' "$TAGGED" | D arm; printf '{}' | D check >/dev/null
out="$(printf '{"stop_hook_active":true}' | D check)"
[ -z "$out" ] && [ ! -e "$SD/channel-debt.json" ] && ok "channel debt: when the harness reports our own block being retried it stands down" || no "did not stand down on stop_hook_active" "$out"
printf '%s' "$TAGGED" | D arm
printf '{"tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{}}' | D clear
[ ! -e "$SD/channel-debt.json" ] && out="$(printf '{}' | D check)" && [ -z "$out" ] && ok "channel debt: a successful reply-tool call pays the debt" || no "reply did not clear the debt"
printf '%s' "$TAGGED" | D arm
printf '{"tool_name":"Bash","tool_input":{"command":"bash notify/telegram.sh \\"done\\""}}' | D clear
[ ! -e "$SD/channel-debt.json" ] && ok "channel debt: notify/telegram.sh through Bash also pays it" || no "telegram.sh did not clear"
printf '%s' "$TAGGED" | D arm; printf '{"tool_name":"Read","tool_input":{}}' | D clear
[ -s "$SD/channel-debt.json" ] && ok "channel debt: an unrelated tool call does not pay it" || no "unrelated tool cleared the debt"
printf '{}' | D reset; [ ! -e "$SD/channel-debt.json" ] && ok "channel debt: SessionStart reset drops a leftover debt" || no "reset did not clear"

printf '{"prompt":"just a normal terminal message"}' | D arm
[ ! -e "$SD/channel-debt.json" ] && ok "channel debt: with mirror OFF (the default) an untagged prompt owes nothing" || no "untagged prompt armed with mirror off"

mkdir -p "$XDG_CONFIG_HOME/talos"; printf '{"chat_id": 777}\n' > "$XDG_CONFIG_HOME/talos/telegram.json"
printf '{"prompt":"a normal terminal message"}' | TALOS_TELEGRAM_MIRROR=1 D arm
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["mirror"] and d["chat_id"]=="777"' "$SD/channel-debt.json" 2>/dev/null \
  && ok "channel debt: mirror ON (env) arms an untagged human prompt, chat id from telegram.json" || no "mirror did not arm"
out="$(printf '{}' | D check)"; printf '%s' "$out" | grep -q 'MIRROR TO TELEGRAM' && ok "channel debt: mirror mode blocks with the mirror instruction" || no "mirror check wrong" "$out"
printf '{}' | D reset
for robot in '<task-notification>x</task-notification>' '<system-reminder>x</system-reminder>' '/compact' '<scheduled-task name="x">y</scheduled-task>'; do
  printf '{"prompt":%s}' "$(js "$robot")" | TALOS_TELEGRAM_MIRROR=1 D arm
  [ ! -e "$SD/channel-debt.json" ] || { no "robot or slash prompt armed mirror: $robot"; rm -f "$SD/channel-debt.json"; }
done
ok "channel debt: robot prompts (notifications, reminders, scheduled tasks) and slash commands never arm mirror"
rm -f "$XDG_CONFIG_HOME/talos/telegram.json"
printf '{"prompt":"a normal terminal message"}' | TALOS_TELEGRAM_MIRROR=1 D arm
[ ! -e "$SD/channel-debt.json" ] && ok "channel debt: mirror with no resolvable chat id stays silent rather than guess" || no "mirror armed with no chat id"
mkdir -p "$HOME/.claude/channels/telegram"; printf '{"allowFrom":["9001"]}\n' > "$HOME/.claude/channels/telegram/access.json"
printf '{"prompt":"a normal terminal message"}' | TALOS_TELEGRAM_MIRROR=1 D arm
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["chat_id"]=="9001"' "$SD/channel-debt.json" 2>/dev/null && ok "channel debt: the chat id falls back to the single allowFrom entry in access.json" || no "access.json fallback failed"
printf '{}' | D reset
printf '{"allowFrom":["9001","9002"]}\n' > "$HOME/.claude/channels/telegram/access.json"
printf '{"prompt":"a normal terminal message"}' | TALOS_TELEGRAM_MIRROR=1 D arm
[ ! -e "$SD/channel-debt.json" ] && ok "channel debt: two allowFrom entries are ambiguous, so mirror stays silent" || no "mirror guessed between two ids"
rm -rf "$HOME/.claude"
touch "$XDG_CONFIG_HOME/talos/telegram-mirror.on"; printf '{"chat_id": 5}\n' > "$XDG_CONFIG_HOME/talos/telegram.json"
printf '{"prompt":"a normal terminal message"}' | D arm
[ -s "$SD/channel-debt.json" ] && ok "channel debt: the ~/.config/talos/telegram-mirror.on file turns mirror on" || no "mirror flag file ignored"
printf '{}' | D reset; rm -f "$XDG_CONFIG_HOME/talos/telegram-mirror.on" "$XDG_CONFIG_HOME/talos/telegram.json"
mkdir -p "$SD"; touch "$SD/channel-debt.off"; printf '%s' "$TAGGED" | D arm
[ ! -e "$SD/channel-debt.json" ] && ok "channel debt: its kill switch works" || no "channel-debt.off ignored"; rm -f "$SD/channel-debt.off"

# per-session debts: a scheduled job (or another session) in the same folder neither sees, blocks on, nor wipes the live chat session's debt
tg() { printf '{"session_id":"%s","prompt":"<channel source=\\"telegram\\" chat_id=\\"4242\\">hi</channel>"}' "$1"; }
tg LIVE | D arm
ls "$SD"/channel-debt-LIVE.json >/dev/null 2>&1 && ok "channel debt: with a session id the debt is kept per session (channel-debt-<id>.json)" || no "no per-session debt file" "$(ls "$SD")"
out="$(printf '{"session_id":"JOB1"}' | CHRONOS_RUN=1 D check)"; [ -z "$out" ] && ok "channel debt: a headless scheduled run is never blocked by a chat debt" || no "headless run blocked" "$out"
printf '{"session_id":"JOB1"}' | CHRONOS_RUN=1 D reset; [ -s "$SD/channel-debt-LIVE.json" ] && ok "channel debt: a headless run's SessionStart reset does not wipe the live session's debt" || no "headless reset wiped the live debt"
out="$(printf '{"session_id":"OTHER"}' | D check)"; [ -z "$out" ] && ok "channel debt: a different session in the same folder is not blocked by it" || no "other session blocked" "$out"
printf '{"session_id":"OTHER"}' | D reset; [ -s "$SD/channel-debt-LIVE.json" ] && ok "channel debt: another session's fresh debt survives this session's reset" || no "reset wiped another session's fresh debt"
out="$(printf '{"session_id":"LIVE"}' | D check)"; printf '%s' "$out" | grep -q '"block"' && ok "channel debt: the owning session is still blocked until it replies" || no "owner not blocked" "$out"
printf '{"session_id":"OTHER","tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{}}' | D clear; [ -s "$SD/channel-debt-LIVE.json" ] && ok "channel debt: another session's reply does not pay this session's debt" || no "wrong session paid"
printf '{"session_id":"LIVE","tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{}}' | D clear; [ ! -e "$SD/channel-debt-LIVE.json" ] && ok "channel debt: the owning session's reply pays it" || no "owner reply did not pay"
python3 -c "import json,time; json.dump({'source':'telegram','ts':time.time()-4*3600,'blocks':0}, open('$SD/channel-debt-DEAD.json','w'))"; printf '{"session_id":"NEW"}' | D reset
[ ! -e "$SD/channel-debt-DEAD.json" ] && ok "channel debt: reset sweeps a debt older than 3 hours (a dead session's leftover)" || no "stale debt not swept"
printf '{"session_id":"JOB2","prompt":"a normal terminal message"}' | CHRONOS_RUN=1 TALOS_TELEGRAM_MIRROR=1 D arm; ls "$SD" | grep -q 'channel-debt-JOB2' && no "mirror armed a headless scheduled run" || ok "channel debt: mirror mode never arms a headless scheduled run"
for c in 'grep -n curl notify/telegram.sh' 'cat notify/telegram.sh' 'vim notify/telegram.sh' 'echo telegram.sh'; do
  tg LIVE | D arm; printf '{"session_id":"LIVE","tool_name":"Bash","tool_input":{"command":%s}}' "$(js "$c")" | D clear
  [ -s "$SD/channel-debt-LIVE.json" ] || { no "a command that only MENTIONS telegram.sh paid the debt: $c"; }
  printf '{"session_id":"LIVE"}' | D reset; rm -f "$SD/channel-debt-LIVE.json"
done
ok "channel debt: grep/cat/vim/echo of telegram.sh do not count as sending"
for c in 'bash notify/telegram.sh "done"' "$XDG_CONFIG_HOME/talos/notify/telegram.sh \"done\"" 'cd x && bash ./notify/telegram.sh --file a.md "cap"' 'sh notify/telegram.sh hi'; do
  tg LIVE | D arm; printf '{"session_id":"LIVE","tool_name":"Bash","tool_input":{"command":%s}}' "$(js "$c")" | D clear
  [ ! -e "$SD/channel-debt-LIVE.json" ] || { no "running telegram.sh did not pay the debt: $c"; rm -f "$SD/channel-debt-LIVE.json"; }
done
ok "channel debt: actually running notify/telegram.sh (bare, via bash/sh, by path, after cd) pays it"

# a debt survives a compaction: session-start re-injects the obligation on source=compact, and only then
cp "$KIT/hooks/session-start.py" "$A/hooks/"; mkdir -p "$A/wiki"
printf '%s' "$TAGGED" | D arm
ctx="$(printf '{"source":"compact"}' | ( cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ))"
printf '%s' "$ctx" | grep -q 'REPLY OWED' && ok "session start (after a compaction) tells the agent a chat reply is still owed" || no "no REPLY OWED after compact"
ctx="$(printf '{"source":"startup"}' | ( cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ))"
printf '%s' "$ctx" | grep -q 'REPLY OWED' && no "REPLY OWED shown on a fresh startup" || ok "session start does not announce an owed reply on a fresh startup"
printf '{}' | D reset
tg LIVE | D arm
ctx="$(printf '{"source":"compact","session_id":"LIVE"}' | ( cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ))"
printf '%s' "$ctx" | grep -q 'REPLY OWED' && ok "session start after a compaction announces the debt of THIS session" || no "own session's debt not announced"
ctx="$(printf '{"source":"compact","session_id":"OTHER"}' | ( cd "$A" && CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ))"
printf '%s' "$ctx" | grep -q 'REPLY OWED' && no "announced another session's debt" || ok "session start does not announce another session's debt"
rm -f "$SD"/channel-debt-*.json

# ================================================================ S2 check-vault
V="$SB/vault"; mkdir -p "$V/journal" "$XDG_CONFIG_HOME/talos"
printf '# my private terms\nzebra-clinic\nOakridge\n' > "$V/_guard-terms.txt"
CV() { printf '%s' "$1" | H check-vault.py; }
payload() { printf '{"tool_name":"Write","tool_input":{"file_path":%s,"content":%s}}' "$(js "$1")" "$(js "$2")"; }
out="$(CV "$(payload "$A/wiki/x.md" "She goes to Zebra-Clinic on Fridays.")")"
[ "$out" = "{}" ] && ok "vault guard: with no vault configured it is inert" || no "vault guard acted with no vault" "$out"
printf '%s\n' "$V" > "$XDG_CONFIG_HOME/talos/vault-dir"
out="$(CV "$(payload "$A/wiki/x.md" "She goes to Zebra-Clinic on Fridays.")")"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin)["hookSpecificOutput"]; assert d["permissionDecision"]=="ask" and "zebra-clinic" in d["permissionDecisionReason"].lower()' 2>/dev/null \
  && ok "vault guard: a guard term (any case) headed outside the vault asks first" || no "vault guard did not ask" "$out"
out="$(CV "$(payload "$V/journal/a.md" "She goes to Zebra-Clinic on Fridays.")")"
[ "$out" = "{}" ] && ok "vault guard: writing the same text INSIDE the vault is allowed" || no "vault write blocked" "$out"
out="$(CV "$(payload "$V/../vault/journal/../b.md" "Zebra-Clinic")")"
[ "$out" = "{}" ] && ok "vault guard: a path that wanders back into the vault is canonicalised, not fooled" || no "dotdot path misjudged" "$out"
out="$(CV "$(payload "$V/../escape.md" "Zebra-Clinic")")"
printf '%s' "$out" | grep -q '"ask"' && ok "vault guard: a path that climbs OUT of the vault is caught" || no "dotdot escape not caught" "$out"
out="$(CV "$(payload "$A/wiki/x.md" "nothing private here, and zebra-clinicals is a different word")")"
[ "$out" = "{}" ] && ok "vault guard: matching is whole-word (no hit inside a longer word) and clean text passes" || no "false positive" "$out"
out="$(CV '{"tool_name":"MultiEdit","tool_input":{"file_path":"'"$A"'/wiki/y.md","edits":[{"old_string":"a","new_string":"visit Oakridge"}]}}')"
printf '%s' "$out" | grep -q '"ask"' && ok "vault guard: MultiEdit payloads (edits[].new_string) are scanned too" || no "MultiEdit not scanned" "$out"
out="$(CV '{"tool_name":"Edit","tool_input":{"file_path":"'"$A"'/wiki/y.md","old_string":"Oakridge","new_string":"a town"}}')"
[ "$out" = "{}" ] && ok "vault guard: removing a term (it is only in old_string) is allowed" || no "old_string was scanned" "$out"
printf '# no terms yet\n' > "$V/_guard-terms.txt"; out="$(CV "$(payload "$A/wiki/x.md" "Zebra-Clinic")")"
[ "$out" = "{}" ] && ok "vault guard: an empty terms file means no tripwire (the kit ships no terms)" || no "acted with no terms" "$out"
printf 'zebra-clinic\n' > "$V/_guard-terms.txt"; mkdir -p "$SD"; touch "$SD/check-vault.off"; out="$(CV "$(payload "$A/wiki/x.md" "Zebra-Clinic")")"; rm -f "$SD/check-vault.off"
[ "$out" = "{}" ] && ok "vault guard: its kill switch works" || no "kill switch ignored" "$out"
rm -f "$XDG_CONFIG_HOME/talos/vault-dir"

# ================================================================ S7 hands-free
HF() { H hands-free.py "$@"; }
LONG="$(python3 -c "print('word ' * 120)")"
rp() { printf '{"tool_name":"mcp__plugin_telegram_telegram__reply","tool_input":{"chat_id":"1","text":%s,"files":%s}}' "$(js "$1")" "$2"; }
out="$(printf '{}' | HF check)"; [ -z "$out" ] && ok "hands-free: inactive means nothing is ever blocked" || no "hands-free blocked while off" "$out"
HF status >/dev/null; [ "$?" = 1 ] && ok "hands-free status exits 1 when off" || no "status wrong when off"
HF on 30 | grep -q '30 minutes' && ok "hands-free on 30 opens a 30-minute window" || no "hands-free on wrong"
HF status | grep -qE '(29|30) minutes left' && ok "hands-free status reports the minutes left" || no "status minutes wrong"
rp "$LONG" '[]' | HF note; out="$(printf '{}' | HF check)"
printf '%s' "$out" | grep -q 'HANDS-FREE MODE' && printf '%s' "$out" | grep -q 'tts.sh file' && ok "hands-free: a long text-only chat reply is blocked and told how to make audio" || no "long reply not blocked" "$out"
rp "$LONG" '["/tmp/x.m4a"]' | HF note; out="$(printf '{}' | HF check)"
[ -z "$out" ] && ok "hands-free: the same reply WITH an audio file attached pays the debt" || no "audio did not pay" "$out"
rp "on it" '[]' | HF note; out="$(printf '{}' | HF check)"; [ -z "$out" ] && ok "hands-free: a short acknowledgement may stay text" || no "short ack blocked" "$out"
rp "$LONG" '[]' | HF note; printf '{}' | HF check >/dev/null; printf '{}' | HF check >/dev/null; out="$(printf '{}' | HF check)"
[ -z "$out" ] && ok "hands-free: blocks at most twice, then gives up" || no "hands-free trapped the session" "$out"
rp "$LONG" '[]' | HF note; printf '{"tool_name":"Bash","tool_input":{"command":"x"}}' | HF note; out="$(printf '{}' | HF check)"
printf '%s' "$out" | grep -q 'HANDS-FREE' && ok "hands-free: only the channel reply tools count; other tool calls do not clear or add debt" || no "other tool changed debt" "$out"
HF off | grep -q off; out="$(printf '{}' | HF check)"; [ -z "$out" ] && ok "hands-free off ends the window and drops any debt" || no "off did not clear" "$out"
mkdir -p "$SD"; python3 -c "import json,time; json.dump({'until': time.time()-5}, open('$SD/hands-free.json','w'))"
rp "$LONG" '[]' | HF note; out="$(printf '{}' | HF check)"; [ -z "$out" ] && [ ! -e "$SD/hands-free.json" ] && ok "hands-free: an expired window is ignored and cleaned up" || no "expired window still active" "$out"
HF on 99999 | grep -q '480 minutes' && ok "hands-free: the window is capped at 480 minutes" || no "cap missing"; HF off >/dev/null
HF on 20 >/dev/null; touch "$SD/hands-free.off"; rp "$LONG" '[]' | HF note; out="$(printf '{}' | HF check)"; rm -f "$SD/hands-free.off"; HF off >/dev/null
[ -z "$out" ] && ok "hands-free: its kill switch works" || no "kill switch ignored" "$out"

# ================================================================ v1.1.2: symlink containment (a symlinked PARENT is as bad as a symlinked file)
OUT="$SB/outside"; rm -rf "$OUT"; mkdir -p "$OUT/memory" "$OUT/scripts"
printf 'SECRET-OUTSIDE-STATE\n' > "$OUT/memory/STATE.md"; printf 'SECRET-OUTSIDE-HANDOFF\n' > "$OUT/memory/HANDOFF.md"
printf 'SECRET-OUTSIDE-LOG\n' > "$OUT/memory/$(date +%Y-%m-%d).md"
mkagent() { local d="$1"; rm -rf "$d"; mkdir -p "$d/hooks" "$d/wiki/people" "$d/scripts" "$d/.claude"; cp "$KIT"/hooks/*.py "$d/hooks/"; }
SS() { printf '{"source":"startup"}' | ( cd "$1" && CLAUDE_PROJECT_DIR="$1" python3 hooks/session-start.py 2>/dev/null ); }

# control: a REAL memory folder is injected (so the symlink cases below can fail)
A2="$SB/agent2"; mkagent "$A2"; mkdir -p "$A2/memory"; printf 'REAL-STATE-MARK\n' > "$A2/memory/STATE.md"; printf 'REAL-HANDOFF-MARK\n' > "$A2/memory/HANDOFF.md"
ctx="$(SS "$A2")"; { printf '%s' "$ctx" | grep -q 'REAL-STATE-MARK' && printf '%s' "$ctx" | grep -q 'REAL-HANDOFF-MARK'; } && ok "containment control: a normal memory/ folder is read and injected" || no "control failed: real memory not injected" "$ctx"

# 1. memory/ is a symlink to a folder OUTSIDE the project: nothing from it reaches the context
rm -rf "$A2/memory"; ln -s "$OUT/memory" "$A2/memory"
ctx="$(SS "$A2")"
{ ! printf '%s' "$ctx" | grep -q 'SECRET-OUTSIDE'; } && ok "session start: a symlinked PARENT (memory/ -> elsewhere) is not read: no STATE, HANDOFF or daily log leaks into the context" || no "a symlinked memory/ was READ" "$(printf '%s' "$ctx" | grep -o 'SECRET-OUTSIDE[A-Z-]*' | sort -u)"
# 1b. a symlinked file inside a real folder (the old check) is still refused
rm -f "$A2/memory"; mkdir -p "$A2/memory"; ln -s "$OUT/memory/STATE.md" "$A2/memory/STATE.md"; printf 'REAL-HANDOFF-MARK\n' > "$A2/memory/HANDOFF.md"
ctx="$(SS "$A2")"; { ! printf '%s' "$ctx" | grep -q 'SECRET-OUTSIDE-STATE' && printf '%s' "$ctx" | grep -q 'REAL-HANDOFF-MARK'; } && ok "session start: a symlinked FILE is refused and its real neighbours still read" || no "symlinked file read, or the neighbour lost"
# 1c. an in-project symlink that stays inside the project is refused too (reject ANY link below the root)
rm -rf "$A2/memory"; mkdir -p "$A2/realmem"; printf 'INNER-LINK-MARK\n' > "$A2/realmem/STATE.md"; ln -s realmem "$A2/memory"
ctx="$(SS "$A2")"; { ! printf '%s' "$ctx" | grep -q 'INNER-LINK-MARK'; } && ok "session start: even a symlink that points INSIDE the project is refused (no link anywhere below the root)" || no "an in-project symlinked folder was read"
rm -f "$A2/memory"; rm -rf "$A2/realmem"; mkdir -p "$A2/memory"

# 2. stamps: a write through a symlinked parent must not create or truncate anything outside
sst() { ( cd "$1" && CLAUDE_PROJECT_DIR="$1" python3 - "$2" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ss", "hooks/session-start.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print("STAMPED" if m.safe_stamp(sys.argv[1]) else "REFUSED")
PY
); }
mkdir -p "$A2/stamps"; [ "$(sst "$A2" "$A2/stamps/.ok")" = STAMPED ] && [ -e "$A2/stamps/.ok" ] && ok "stamp control: a stamp in a real folder is written" || no "stamp control failed"
rm -rf "$A2/linkdir"; ln -s "$OUT" "$A2/linkdir"; printf 'KEEP-ME-INTACT\n' > "$OUT/.last-lint"
r="$(sst "$A2" "$A2/linkdir/.new-stamp")"
{ [ "$r" = REFUSED ] && [ ! -e "$OUT/.new-stamp" ]; } && ok "stamp write: a symlinked PARENT is refused and nothing is created outside the project" || no "a stamp was written through a symlinked parent" "$r"
r="$(sst "$A2" "$A2/linkdir/.last-lint")"
{ [ "$r" = REFUSED ] && [ "$(cat "$OUT/.last-lint")" = KEEP-ME-INTACT ]; } && ok "stamp write: an EXISTING file behind a symlinked parent is not truncated" || no "a file outside was truncated" "$(cat "$OUT/.last-lint")"
ln -sf "$OUT/.last-lint" "$A2/stamps/.leaf-link"; r="$(sst "$A2" "$A2/stamps/.leaf-link")"
{ [ "$r" = REFUSED ] && [ "$(cat "$OUT/.last-lint")" = KEEP-ME-INTACT ]; } && ok "stamp write: a symlinked leaf is still refused (the original O_NOFOLLOW case)" || no "leaf symlink followed"
[ "$(sst "$A2" "$SB/elsewhere-stamp")" = REFUSED ] && [ ! -e "$SB/elsewhere-stamp" ] && ok "stamp write: a path outside the project is refused outright" || no "outside stamp written"

# 3. the wiki linter is EXECUTED by session start: it must not run from behind a symlinked scripts/
for i in 1 2 3 4 5 6; do printf -- '---\ntitle: n%s\ntype: concept\nupdated: 2026-10-01\ntags: [a]\n---\nbody [[n1]] [[n2]]\n' "$i" > "$A2/wiki/n$i.md"; done
MARK="$SB/lint-ran"; rm -f "$MARK"
printf 'import sys\nopen("%s","a").write("RAN\\n")\nprint("clean: 0 errors")\n' "$MARK" > "$OUT/scripts/wiki-lint.py"
rm -rf "$A2/scripts"; ln -s "$OUT/scripts" "$A2/scripts"
SS "$A2" >/dev/null; [ ! -e "$MARK" ] && ok "session start: a symlinked scripts/ is never executed (the wiki linter does not run from outside the project)" || no "EXECUTED a script behind a symlinked scripts/ folder"
rm -f "$A2/scripts"; mkdir -p "$A2/scripts"; cp "$OUT/scripts/wiki-lint.py" "$A2/scripts/wiki-lint.py"; rm -f "$A2/memory/.last-lint"
SS "$A2" >/dev/null; [ -e "$MARK" ] && ok "lint control: the same linter in a REAL scripts/ folder does run when due" || no "lint control failed: the linter never ran, so the symlink test above proves nothing"
rm -f "$MARK"; rm -rf "$A2/wiki"; ln -s "$OUT" "$A2/wiki"; rm -f "$A2/memory/.last-lint"
SS "$A2" >/dev/null; [ ! -e "$MARK" ] && ok "session start: a symlinked wiki/ is not scanned or linted" || no "linted a symlinked wiki/"
rm -f "$A2/wiki"; mkdir -p "$A2/wiki"

# 4. the other hooks: agent-log must not append through a symlinked memory/, the status line must not stat through one
A3="$SB/agent3"; mkagent "$A3"; rm -rf "$OUT/memory/agent-log.md"; ln -s "$OUT/memory" "$A3/memory"
printf '{"agent_type":"worker","description":"through a link","last_assistant_message":"done"}' | ( cd "$A3" && python3 hooks/agent-log.py 2>/dev/null )
[ ! -e "$OUT/memory/agent-log.md" ] && ok "agent log: nothing is appended through a symlinked memory/" || no "agent-log wrote through a symlinked parent"
rm -f "$A3/memory"; mkdir -p "$A3/memory"; printf '{"agent_type":"worker","description":"normal","last_assistant_message":"done"}' | ( cd "$A3" && python3 hooks/agent-log.py 2>/dev/null )
grep -q 'normal' "$A3/memory/agent-log.md" 2>/dev/null && ok "agent log control: the same row is written when memory/ is a real folder" || no "agent-log control failed"
rm -rf "$A3/memory"; ln -s "$OUT/memory" "$A3/memory"
out="$(printf '{"model":{"display_name":"Opus"}}' | ( cd "$A3" && python3 hooks/statusline.py ))"; printf '%s' "$out" | grep -q 'handoff:' && no "status line stat()ed HANDOFF.md through a symlinked memory/" "$out" || ok "status line: no handoff age is read through a symlinked memory/"
# the shared helper itself
python3 - "$A3" "$OUT" <<'PY' && ok "contained(): in-root ok, '..' refused, outside refused, link refused, a missing file in a real folder is fine" || no "contained() misjudged a path"
import os, sys
sys.path.insert(0, os.path.join(sys.argv[1], "hooks")); import _talos_common as C
A, OUT = os.path.realpath(sys.argv[1]), sys.argv[2]
os.makedirs(os.path.join(A, "real"), exist_ok=True)
assert C.contained("real/new-file.md") == os.path.join(A, "real", "new-file.md")
assert C.contained(os.path.join(A, "real", "x")) is not None
assert C.contained("real/../real/x") is None and C.contained("../x") is None
assert C.contained("/etc/passwd") is None and C.contained(OUT) is None
assert C.contained("memory/STATE.md") is None                     # memory is a symlink here
assert C.contained("") is None and C.contained("a\0b") is None
assert C.contained(A) == A
PY

# session-start.py keeps its own private copy of the check (it must stay standalone): both must give the same verdicts
mkdir -p "$A3/real"; printf 'x\n' > "$A3/real/f.md"; ln -sf "$A3/real" "$A3/linkreal"; ln -sf "$OUT" "$A3/linkout"
( cd "$A3" && python3 - "$A3" "$OUT" <<'PY' ) && ok "session-start's private contained()/read_contained() agree with hooks/_talos_common.py on every path tried (no drift)" || no "the two containment implementations disagree"
import importlib.util, os, sys
sys.path.insert(0, os.path.join(sys.argv[1], "hooks")); import _talos_common as K
spec = importlib.util.spec_from_file_location("ss", os.path.join(sys.argv[1], "hooks", "session-start.py")); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
A, OUT = sys.argv[1], sys.argv[2]
for p in ["real/f.md", "real/nope", "linkreal/f.md", "linkout/x", "memory/STATE.md", "../x", "real/../real/f.md", "/etc/passwd", OUT, A, os.path.join(A, "real", "f.md"),
          os.path.join(A, "linkreal"), "", "a\0b", "wiki/n.md", ".index/index.log", "real//f.md", "./real/f.md"]:
    a, b = K.contained(p), m.C.contained(p)
    assert a == b, (p, a, b)
    assert K.read_contained(p) == m.C.read_contained(p), p
PY

# ================================================================ v1.1.2: FAIL OPEN in a live session, FAIL CLOSED when unattended
HU() { local hook="$1"; shift; ( cd "$A" && CHRONOS_RUN=1 python3 "hooks/$hook" "$@" 2>"$SB/stderr" ); }
denied() { printf '%s' "$1" | python3 -c 'import json,sys; d=json.load(sys.stdin)["hookSpecificOutput"]; sys.exit(0 if d["permissionDecision"]=="deny" else 1)' 2>/dev/null; }

# pre-tool-guard (exit code protocol): garbage input = an internal error
printf 'not json' | ( cd "$A" && python3 hooks/pre-tool-guard.py 2>/dev/null ); r1=$?
printf 'not json' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/pre-tool-guard.py 2>/dev/null ); r2=$?
printf 'not json' | ( cd "$A" && TALOS_UNATTENDED=1 python3 hooks/pre-tool-guard.py 2>/dev/null ); r3=$?
{ [ "$r1" = 0 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ]; } && ok "pre-tool guard: an internal error fails OPEN in a live session (exit 0) and CLOSED when unattended (exit 2, CHRONOS_RUN or TALOS_UNATTENDED)" || no "pre-tool guard fail modes wrong (live=$r1 chronos=$r2 manual=$r3)"
printf '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/pre-tool-guard.py 2>/dev/null ); r4=$?
printf '{"tool_name":"Bash","tool_input":{"command":"git add -A"}}' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/pre-tool-guard.py 2>/dev/null ); r5=$?
{ [ "$r4" = 0 ] && [ "$r5" = 2 ]; } && ok "pre-tool guard: unattended it still allows a normal command and still refuses a bad one" || no "unattended verdicts wrong (ls=$r4 add -A=$r5)"

# the three JSON guards: a payload that makes them raise (tool_input is a list)
BADIN='{"tool_name":"Write","tool_input":["not","a","dict"]}'     # (timeline-guard treats a non-dict tool_input as "nothing to judge"; its error path is exercised below)
for g in append-only-guard.py check-vault.py; do
  if [ "$g" = check-vault.py ]; then mkdir -p "$V"; printf 'zebra-clinic\n' > "$V/_guard-terms.txt"; printf '%s\n' "$V" > "$XDG_CONFIG_HOME/talos/vault-dir"; fi
  live="$(printf '%s' "$BADIN" | H "$g")"; un="$(printf '%s' "$BADIN" | HU "$g")"
  if [ "$g" = check-vault.py ]; then rm -f "$XDG_CONFIG_HOME/talos/vault-dir"; fi
  { [ "$live" = "{}" ] && denied "$un" && printf '%s' "$un" | grep -q 'unattended'; } && ok "$g: an unexpected error is allowed in a live session and DENIED (with the reason) when unattended" || no "$g fail modes wrong" "live=[$live] unattended=[$un]"
done
# timeline-guard: a broken or missing wiki-lint.py is the realistic internal error
mkdir -p "$A/wiki/people"; printf -- '---\ntitle: x\ntype: person\nupdated: 2026-10-01\ntags: [a]\n---\nbody\n\n<!-- TIMELINE:APPEND-ONLY -->\n' > "$A/wiki/people/tl.md"
mv "$A/scripts/wiki-lint.py" "$SB/wiki-lint.hold" 2>/dev/null || true
TLW="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"x\\n\\n<!-- TIMELINE:APPEND-ONLY -->\\n- 2026-10-02 | a | src | high\\n"}}' "$A/wiki/people/tl.md")"
live="$(printf '%s' "$TLW" | H timeline-guard.py)"; un="$(printf '%s' "$TLW" | HU timeline-guard.py)"
{ [ "$live" = "{}" ] && denied "$un"; } && ok "timeline guard: with wiki-lint.py missing a live session is allowed through and an unattended run is blocked" || no "timeline guard missing-lint modes wrong" "live=[$live] un=[$un]"
mv "$SB/wiki-lint.hold" "$A/scripts/wiki-lint.py" 2>/dev/null || true

# an `ask` has nobody to answer it when unattended: it becomes a deny
out="$(W "$A/memory/2026-10-01.md" "short")"; un="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"short"}}' "$A/memory/2026-10-01.md" | HU append-only-guard.py)"
{ printf '%s' "$out" | grep -q '"ask"' && denied "$un" && printf '%s' "$un" | grep -q 'nobody to ask'; } && ok "append-only guard: the shrink check asks in a live session and denies when unattended" || no "ask not converted" "live=[$out] un=[$un]"
printf 'zebra-clinic\n' > "$V/_guard-terms.txt"; printf '%s\n' "$V" > "$XDG_CONFIG_HOME/talos/vault-dir"
un="$(printf '%s' "$(payload "$A/wiki/x.md" "Zebra-Clinic")" | HU check-vault.py)"; rm -f "$XDG_CONFIG_HOME/talos/vault-dir"
denied "$un" && ok "vault guard: a term headed outside the vault is denied (not asked) when unattended" || no "vault guard ask not converted" "$un"
# a terms file that cannot be read is an error, not "no terms"
if [ "$(id -u)" != 0 ]; then
  printf 'zebra-clinic\n' > "$V/_guard-terms.txt"; chmod 000 "$V/_guard-terms.txt"; printf '%s\n' "$V" > "$XDG_CONFIG_HOME/talos/vault-dir"
  live="$(printf '%s' "$(payload "$A/wiki/x.md" "Zebra-Clinic")" | H check-vault.py)"; un="$(printf '%s' "$(payload "$A/wiki/x.md" "Zebra-Clinic")" | HU check-vault.py)"
  chmod 600 "$V/_guard-terms.txt"; rm -f "$XDG_CONFIG_HOME/talos/vault-dir"
  { [ "$live" = "{}" ] && denied "$un"; } && ok "vault guard: an unreadable terms file is a guard failure (open live, blocked unattended), not silently 'no terms'" || no "unreadable terms file mishandled" "live=[$live] un=[$un]"
fi

# the shared helpers cannot even load (file deleted / corrupt): same two modes, from the guards' own import fallback
A4="$SB/agent4"; mkagent "$A4"; printf 'def (:\n' > "$A4/hooks/_talos_common.py"
for g in append-only-guard.py check-vault.py timeline-guard.py; do
  live="$(printf '{}' | ( cd "$A4" && python3 "hooks/$g" 2>/dev/null ))"; un="$(printf '{}' | ( cd "$A4" && CHRONOS_RUN=1 python3 "hooks/$g" 2>/dev/null ))"
  { [ "$live" = "{}" ] && denied "$un"; } && ok "$g: with hooks/_talos_common.py broken: live = allow, unattended = deny" || no "$g broken-helper modes wrong" "live=[$live] un=[$un]"
done

# the settings template wrapper: a MISSING or CRASHING guard script blocks an unattended run and never a live one
python3 - "$KIT/templates/dot-claude/settings.json" "$SB" <<'PY' && ok "settings template: the four safety guards' wrappers fail open live and CLOSED unattended (missing script, python crash, syntax error); a real block (exit 2) passes through" || no "settings wrapper modes wrong"
import json, os, subprocess, sys, tempfile
d = json.load(open(sys.argv[1])); t = tempfile.mkdtemp(dir=sys.argv[2]); os.makedirs(t + "/hooks")
guards = {}
for ent in d["hooks"]["PreToolUse"]:
    for h in ent["hooks"]:
        n = h["command"].split("hooks/")[1].split('"')[0]; guards[n] = h["command"]
assert sorted(guards) == ["append-only-guard.py", "check-vault.py", "pre-tool-guard.py", "timeline-guard.py"], sorted(guards)
def run(cmd, name, env, script):
    p = t + "/hooks/" + name
    if script is None:
        if os.path.exists(p): os.remove(p)
    else: open(p, "w").write(script)
    e = {k: v for k, v in os.environ.items() if k not in ("CHRONOS_RUN", "TALOS_UNATTENDED")}; e.update(env); e["CLAUDE_PROJECT_DIR"] = t
    return subprocess.run(["bash", "-c", cmd], env=e, input="{}", capture_output=True, text=True).returncode
for name, cmd in guards.items():
    live = {}; un = {"CHRONOS_RUN": "1"}
    assert run(cmd, name, live, None) == 0, (name, "missing, live")
    assert run(cmd, name, un, None) == 2, (name, "missing, unattended")
    assert run(cmd, name, {"TALOS_UNATTENDED": "1"}, None) == 2, (name, "missing, manual flag")
    assert run(cmd, name, live, "import sys; sys.exit(1)") == 1, (name, "crash, live")          # non-blocking error: the tool proceeds
    assert run(cmd, name, un, "import sys; sys.exit(1)") == 2, (name, "crash, unattended")
    assert run(cmd, name, un, "def (:") == 2, (name, "syntax error, unattended")
    assert run(cmd, name, un, "print('{}')") == 0, (name, "ok, unattended")
    assert run(cmd, name, un, "import sys; sys.stderr.write('no'); sys.exit(2)") == 2, (name, "block passes through")
PY
# the reminder hooks stay fail-OPEN even unattended: they cannot cause harm by failing
bad=""
for spec in "claim-gate.py" "claim-gate.py inject" "agent-log.py" "statusline.py" "channel-debt.py arm" "channel-debt.py check" "channel-debt.py clear" "hands-free.py check" "hands-free.py note"; do
  # shellcheck disable=SC2086
  out="$(printf '\xff\xfe not json {' | ( cd "$A" && CHRONOS_RUN=1 python3 hooks/$spec 2>&1 ))"; rc=$?
  { [ "$rc" = 0 ] && ! printf '%s' "$out" | grep -qi 'traceback\|"deny"\|"block"'; } || bad="$bad [$spec rc=$rc]"
done
[ -z "$bad" ] && ok "reminder hooks (claim gate, channel debt, agent log, status line, hands-free) stay fail-open when unattended" || no "a reminder hook blocked or crashed unattended:$bad"
# a HUNG guard: Claude Code treats a hook that outlives its timeout as a non-blocking error, so the action would run unchecked.
# Each guard arms an alarm well inside that: a live session is allowed through, an unattended run is blocked. (stdin is held
# open for a few seconds so the guard sits in its read; the alarm is shortened to 1s for the test.)
hang() { # $1 = hook, $2 = extra env assignment; prints "<stdout, newlines removed>|<exit code>|<seconds the guard itself ran>"
  sleep 4 | ( cd "$A" && t=$SECONDS; out="$(env TALOS_GUARD_TIMEOUT_S=1 $2 python3 "hooks/$1" 2>/dev/null)"; rc=$?; printf '%s|%s|%s' "$(printf '%s' "$out" | tr -d '\n')" "$rc" "$((SECONDS - t))" )
}
r="$(hang pre-tool-guard.py CHRONOS_RUN=1)"; rl="$(hang pre-tool-guard.py FOO=1)"
{ printf '%s' "$r" | grep -q '^|2|' && printf '%s' "$rl" | grep -q '^|0|'; } && ok "pre-tool guard: a hang is refused (exit 2) when unattended and allowed (exit 0) in a live session, within the alarm, not after 4 seconds" || no "pre-tool guard hang handling wrong" "unattended=[$r] live=[$rl]"
{ [ "${r##*|}" -le 2 ] && [ "${rl##*|}" -le 2 ]; } && ok "pre-tool guard: the alarm, not the end of the held-open pipe, ended it (${r##*|}s unattended, ${rl##*|}s live)" || no "pre-tool guard waited for stdin to close (${r##*|}s)"
printf 'zebra-clinic\n' > "$V/_guard-terms.txt"; printf '%s\n' "$V" > "$XDG_CONFIG_HOME/talos/vault-dir"
for g in append-only-guard.py check-vault.py; do
  r="$(hang "$g" CHRONOS_RUN=1)"; rl="$(hang "$g" FOO=1)"
  { denied "${r%%|*}" && printf '%s' "$r" | grep -q 'did not finish' && [ "${rl%%|*}" = "{}" ]; } && ok "$g: a hung run is DENIED when unattended and allowed in a live session (alarm, not the harness timeout)" || no "$g hang handling wrong" "unattended=[$r] live=[$rl]"
  secs="${r##*|}"; [ "$secs" -le 3 ] && ok "$g: the alarm fired inside the shortened window ($secs s), not at the end of the held-open pipe" || no "$g took $secs seconds"
done
rm -f "$XDG_CONFIG_HOME/talos/vault-dir"
# timeline-guard hung inside wiki-lint.py (it executes that file)
mkdir -p "$A/wiki/people"; printf -- '---\ntitle: x\ntype: person\nupdated: 2026-10-01\ntags: [a]\n---\nbody\n\n<!-- TIMELINE:APPEND-ONLY -->\n' > "$A/wiki/people/tl2.md"
cp "$A/scripts/wiki-lint.py" "$SB/wiki-lint.keep" 2>/dev/null || true
printf 'import time\ntime.sleep(30)\n' > "$A/scripts/wiki-lint.py"
TLW2="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"x\\n\\n<!-- TIMELINE:APPEND-ONLY -->\\n- 2026-10-02 | a | src | high\\n"}}' "$A/wiki/people/tl2.md")"
un="$(printf '%s' "$TLW2" | ( cd "$A" && TALOS_GUARD_TIMEOUT_S=1 CHRONOS_RUN=1 python3 hooks/timeline-guard.py 2>/dev/null ))"; live="$(printf '%s' "$TLW2" | ( cd "$A" && TALOS_GUARD_TIMEOUT_S=1 python3 hooks/timeline-guard.py 2>/dev/null ))"
{ denied "$un" && [ "$live" = "{}" ]; } && ok "timeline guard: a hung wiki-lint.py is denied when unattended and allowed in a live session" || no "timeline guard hang handling wrong" "un=[$un] live=[$live]"
cp "$SB/wiki-lint.keep" "$A/scripts/wiki-lint.py" 2>/dev/null || true

# timeline-guard EXECUTES scripts/wiki-lint.py: not through a symlinked scripts/ folder
A5="$SB/agent5"; mkagent "$A5"; mkdir -p "$A5/wiki/people"; rm -rf "$A5/scripts"; MARK5="$SB/tl-lint-ran"; rm -f "$MARK5"
mkdir -p "$OUT/scripts5"; printf 'import sys\nopen("%s","a").write("RAN\\n")\nENTRY_FORMAT=ENTRY_GOOD=ENTRY_BAD=""\ndef new_timeline_violations(a,b): return []\n' "$MARK5" > "$OUT/scripts5/wiki-lint.py"; ln -s "$OUT/scripts5" "$A5/scripts"
cp "$A/wiki/people/tl.md" "$A5/wiki/people/tl.md"
TLW5="$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"x\\n\\n<!-- TIMELINE:APPEND-ONLY -->\\n- 2026-10-02 | a | src | high\\n"}}' "$A5/wiki/people/tl.md")"
live="$(printf '%s' "$TLW5" | ( cd "$A5" && python3 hooks/timeline-guard.py 2>/dev/null ))"; un="$(printf '%s' "$TLW5" | ( cd "$A5" && CHRONOS_RUN=1 python3 hooks/timeline-guard.py 2>/dev/null ))"
{ [ ! -e "$MARK5" ] && [ "$live" = "{}" ] && denied "$un"; } && ok "timeline guard: a symlinked scripts/ is never executed (no wiki-lint.py runs from outside the project); live = allow, unattended = deny" || no "timeline guard executed or mishandled a symlinked scripts/" "ran=$([ -e "$MARK5" ] && echo yes || echo no) live=[$live] un=[$un]"
rm -rf "$A5/scripts"; mkdir -p "$A5/scripts"; cp "$KIT/scripts/wiki-lint.py" "$A5/scripts/"
printf '%s' "$TLW5" | ( cd "$A5" && python3 hooks/timeline-guard.py >/dev/null 2>&1 ) && ok "timeline guard control: with a real scripts/ folder it still runs" || no "timeline guard control failed"

rm -f "$V/_guard-terms.txt"

# ================================================================ every hook fails open on garbage
bad=""
for spec in "hands-free.py check" "hands-free.py note" "check-vault.py" "claim-gate.py" "claim-gate.py inject" "append-only-guard.py" "timeline-guard.py" "agent-log.py" "statusline.py" "channel-debt.py arm" "channel-debt.py check" "channel-debt.py clear" "channel-debt.py reset"; do
  # shellcheck disable=SC2086
  out="$(printf '\xff\xfe not json {' | ( cd "$A" && python3 hooks/$spec 2>&1 ))"; rc=$?
  { [ "$rc" = 0 ] && ! printf '%s' "$out" | grep -qi traceback; } || bad="$bad [$spec rc=$rc]"
done
[ -z "$bad" ] && ok "every hook exits 0 with no traceback on binary garbage" || no "a hook did not fail open:$bad"

# ================================================================ no private or machine-specific content shipped in a hook
_u=Users; _a=America; _m=MST
leaks="$(grep -nE "/${_u}/|/home/[a-z]|${_a}/|\b${_m}\b|8537|parse_mode" "$KIT"/hooks/*.py | grep -v 'no parse_mode\|parse_mode on purpose' || true)"
[ -z "$leaks" ] && ok "no hook contains an absolute user path, a timezone, a chat id or a parse_mode" || no "hook content leaks something machine-specific" "$leaks"

# ================================================================ timeline guard (its own suite, run here so "all hook tests" is one command)
tg="$(bash "$KIT/scripts/test-timeline-guard.sh" 2>&1)"; tg_rc=$?
tg_sum="$(printf '%s' "$tg" | grep -E 'PASS [0-9]+ +FAIL [0-9]+' | tail -1 | sed 's/^ *//')"
[ "$tg_rc" -eq 0 ] && ok "timeline guard: scripts/test-timeline-guard.sh passes ($tg_sum)" || no "timeline guard suite failed" "$(printf '%s' "$tg" | grep FAIL | head -5)"

export HOME="$REALHOME"
echo "  hooks: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
