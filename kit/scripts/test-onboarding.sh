#!/usr/bin/env bash
# test-onboarding.sh -- the latched setup-interview offer: scripts/onboarding-state.py and the session-start hook.
#   resume at the saved wave, "no thanks" is final across restarts, a replay keeps the first answers, a stray temp file
#   from a killed write changes nothing, and a corrupt state file never stops a session from starting.
export PYTHONDONTWRITEBYTECODE=1
set -u
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)" || exit 2
case "$T" in /*/*) ;; *) echo "suspicious temp dir: $T" >&2; exit 2;; esac
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "  PASS  $1"; pass=$((pass+1)); }
bad() { echo "  FAIL  $1"; fail=$((fail+1)); }

A="$T/agent"; mkdir -p "$A/hooks" "$A/scripts" "$A/templates" "$A/wiki" "$A/memory"
cp "$KIT/hooks/session-start.py" "$KIT/hooks/_talos_session.py" "$A/hooks/"; cp "$KIT/scripts/onboarding-state.py" "$A/scripts/"
cp "$KIT/templates/_onboarding-progress.md.tmpl" "$A/templates/"
export CLAUDE_PROJECT_DIR="$A" TALOS_APP_HOME="$T/app"
S="$A/.agent-state/onboarding.json"
st()   { (cd "$A" && python3 scripts/onboarding-state.py "$@"); }
hook() { (cd "$A" && echo '{"source":"startup"}' | python3 hooks/session-start.py | python3 -c 'import json,sys; print(json.load(sys.stdin).get("hookSpecificOutput",{}).get("additionalContext",""))'); }
field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$S" "$1"; }

# ---- 1. a fresh agent: the offer is printed once, then it is latched as "later" ----
hook | grep -q 'SETUP (offer once)' && ok "no state file: the first start offers the interview" || bad "no offer on a fresh agent"
[ "$(field state)" = later ] && ok "the offer is latched as later in the same moment" || bad "state is $(field state), not later"
hook | grep -q -- '--- SETUP' && bad "a second start offered again" || ok "a second start prints nothing (offered once)"

# ---- 2. yes, then kill mid-wave: the next start resumes at the saved wave ----
st start >/dev/null; [ "$(field state)" = in_progress ] && ok "start -> in_progress" || bad "start did not set in_progress"
printf 'Name: Ada\n' | st record --wave 1 >/dev/null
printf 'Owner: Alex Example\n' | st record --wave 2 >/dev/null
[ "$(field wave)" = 3 ] && ok "two waves recorded -> next wave is 3" || bad "wave is $(field wave), not 3"
echo '{"half' > "$S.tmp.99999"   # what a write killed before its rename leaves behind
hook | grep -q 'stopped at wave 3' && bad "resumed within a day of the last record" || ok "a start within a day of the last record prints no resume prompt"
python3 - "$S" <<'PY'
import json, sys, time
p = sys.argv[1]; d = json.load(open(p)); d["at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 3 * 86400)); json.dump(d, open(p, "w"))
PY
hook | grep -q 'stopped at wave 3' && ok "a day later the next start resumes at wave 3" || bad "did not resume at wave 3"
hook | grep -q 'stopped at wave 3' && bad "resumed twice in one day" || ok "the resume prompt is shown once a day"
[ "$(field wave)" = 3 ] && ok "the stray temp file left the saved state alone" || bad "state changed"

# ---- 3. a replay keeps the first answers ----
printf 'Name: SOMEONE ELSE\n' | st record --wave 1 >/dev/null
grep -q 'Name: Ada' "$A/wiki/_onboarding-progress.md" && ! grep -q 'SOMEONE ELSE' "$A/wiki/_onboarding-progress.md" \
  && ok "recording wave 1 again keeps the first answers" || bad "a replay changed the answers"
[ "$(field wave)" = 3 ] && ok "a replay does not move the wave back" || bad "replay moved the wave to $(field wave)"
# killed after the answers landed but before the wave moved: recording again only moves the wave
printf '\n### Wave 3 — done 2026-01-01\nTasks: triage the inbox\n' >> "$A/wiki/_onboarding-progress.md"
printf 'Tasks: other\n' | st record --wave 3 >/dev/null
[ "$(field wave)" = 4 ] && grep -q 'triage the inbox' "$A/wiki/_onboarding-progress.md" && ! grep -q 'Tasks: other' "$A/wiki/_onboarding-progress.md" \
  && ok "answers written, wave not moved: record moves the wave and keeps the answers" || bad "half-finished record not repaired"

# ---- 4. "no thanks" is final across restarts ----
st set declined >/dev/null
for i in 1 2 3; do hook | grep -q -- '--- SETUP' && bad "restart $i asked again after declined"; done
[ "$(field state)" = declined ] && ok "declined: three restarts print nothing and the state stays declined" || bad "state changed from declined"

# ---- 5. a corrupt state file never blocks a start, and is not rewritten ----
printf '{not json' > "$S"
out=$(hook); rc=$?
[ "$rc" -eq 0 ] && ! printf '%s' "$out" | grep -q -- '--- SETUP' && [ "$(cat "$S")" = '{not json' ] && ok "corrupt onboarding.json: session starts, no offer, file untouched" || bad "corrupt file mishandled"
st status | grep -q corrupt && ok "the script says corrupt rather than guessing" || bad "script did not flag the corrupt file"

echo; echo "onboarding: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
