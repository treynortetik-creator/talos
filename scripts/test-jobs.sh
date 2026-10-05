#!/usr/bin/env bash
# test-jobs.sh -- do the shipped Chronos jobs behave? Runs the real talos-jobs.py against a throwaway HOME.
#
# Reading a job definition is not testing it. This registers the jobs into a fake Chronos config, edits
# them, removes them, and checks that nothing outside that fake HOME was touched and that a user's own
# jobs and prompt edits survive.
#
# If TALOS_TEST_CHRONOS=/path/to/chronos is set, it also asks the REAL Chronos for the exact prompt each job
# would receive (`chronos prompt`) and for what would be due on a faked clock. It never runs `claude`
# and never touches launchd.
#
# Usage: scripts/test-jobs.sh
# Do not litter a Chronos checkout (or this kit) with __pycache__ when the suites run python.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TJ="$KIT/scripts/talos-jobs.py"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME/.config/chronos"
export CHRONOS_CONFIG="$HOME/.config/chronos/config.json"
printf '{\n "workspace": "%s",\n "jobs_file": "~/.config/chronos/jobs.json",\n "jobs_dir": "~/.config/chronos/jobs"\n}\n' "$SB/agent" > "$CHRONOS_CONFIG"
mkdir -p "$SB/agent/.claude"
# a user job that must survive everything below
cat > "$HOME/.config/chronos/jobs.json" <<'JSON'
[{"id":"my-own-job","name":"Mine","description":"x","time":"09:00","days":"daily","catchup_min":60,"enabled":true,"in_session":false,"notify":"failure","once":null,"created":"2026-01-01T00:00:00","updated":"2026-01-01T00:00:00"}]
JSON
mkdir -p "$HOME/.config/chronos/jobs/my-own-job"; echo "my prompt" > "$HOME/.config/chronos/jobs/my-own-job/prompt.md"
JF="$HOME/.config/chronos/jobs.json"; JD="$HOME/.config/chronos/jobs"

# 1. the shipped templates are valid Chronos jobs
python3 "$TJ" validate --kit-dir "$KIT" >/dev/null 2>&1 && ok "shipped job templates validate" || no "shipped job templates fail validation" "$(python3 "$TJ" validate --kit-dir "$KIT" 2>&1 | head -3)"

# 2. the validator actually rejects bad jobs (a validator that passes everything proves nothing)
mkbad(){ rm -rf "$SB/bad"; mkdir -p "$SB/bad"; cp -R "$KIT/jobs" "$SB/bad/jobs"; }
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[0]["enabled"]=True; json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a job that ships ENABLED" || ok "validator rejects a shipped job that is enabled"
mkbad; printf 'be nice\n' > "$SB/bad/jobs/talos-morning-brief/guard.md"
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a guard.md with no foreground-only rule" || ok "validator rejects a guard.md that does not forbid background work"
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[1]["id"]="Bad_ID"; d[2]["time"]="25:99"; json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a bad id / time" || ok "validator rejects a bad id and a bad time"
mkbad; printf 'do the thing in /%s/someone/agent\n{{TALOS_HOME}}\n' Users > "$SB/bad/jobs/talos-weekly-snapshot/prompt.md"
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted an absolute home path in a prompt" || ok "validator rejects an absolute user path in a prompt"

mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[1]["model"]="gpt-4"; json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a job model that Chronos would reject" || ok "validator rejects a model Chronos 0.2 would refuse"
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p)); d[1]["model"]="haiku"; json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a shipped job pinned to haiku" || ok "validator rejects a shipped job pinned to haiku (Sonnet is the floor)"
python3 - "$KIT/jobs/jobs.json" <<'PY' && ok "the lint, snapshot and sweep jobs pin model sonnet; the brief inherits the default; the index job is a command job with no model" || no "shipped model pins are wrong"
import json,sys
by={j["id"]:j for j in json.load(open(sys.argv[1]))}
assert all(by[i].get("model")=="sonnet" for i in ("talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"))
assert not by["talos-morning-brief"].get("model")
m=by["talos-memory-index"]
assert m["kind"]=="command" and "model" not in m and m["command"].startswith("bash {{TALOS_HOME}}/scripts/memory/refresh-index.sh")
PY

# 2b. command jobs: the validator holds them to their own rules
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-memory-index": j["command"]="bash /somewhere/else.sh"
json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a command that never names the agent folder" || ok "validator rejects a command job whose command never mentions {{TALOS_HOME}}"
mkbad; mkdir -p "$SB/bad/jobs/talos-memory-index"; echo "never read" > "$SB/bad/jobs/talos-memory-index/prompt.md"
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a command job that ships a prompt.md" || ok "validator rejects a command job that also ships a prompt.md (it would never be read)"
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-memory-index": j["in_session"]=True; j["model"]="sonnet"
json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a command job with in_session and a model" || ok "validator rejects a command job that is in_session or pins a model"

# 3. register: adds all four, disabled, with the agent path filled in, leaves the user's job alone
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
n=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$JF")
[ "$n" = 5 ] && ok "register adds the five Talos jobs" || no "register added $n jobs (want 5)"
python3 - "$JF" "$SB/agent" <<'PY' && ok "talos-memory-index registers as a command job with the agent path in the command and no prompt folder" || no "talos-memory-index not registered as a command job"
import json,sys
j={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-memory-index"]
assert j["kind"]=="command" and j["command"]=="bash %s/scripts/memory/refresh-index.sh" % sys.argv[2], j
assert j["enabled"] is False and "model" not in j
PY
[ ! -e "$JD/talos-memory-index" ] && ok "a command job gets no jobs/<id> folder (nothing for Claude to read)" || no "a prompt folder was created for the command job"
python3 - "$JF" <<'PY' && ok "every registered Talos job is disabled; the user's own job is untouched" || no "enabled flags wrong after register"
import json,sys
d=json.load(open(sys.argv[1])); by={j["id"]:j for j in d}
assert all(not j["enabled"] for j in d if j["id"].startswith("talos-"))
assert by["my-own-job"]["enabled"] is True and by["my-own-job"]["time"]=="09:00"
PY
if grep -rq '{{TALOS_HOME}}' "$JD"; then no "an unrendered {{TALOS_HOME}} remains in a registered prompt"
elif grep -q "$SB/agent" "$JD/talos-morning-brief/prompt.md"; then ok "the agent folder path is rendered into each prompt"
else no "the agent folder path is missing from the registered prompt"; fi
[ "$(cat "$JD/my-own-job/prompt.md")" = "my prompt" ] && ok "the user's own job prompt is byte-identical" || no "the user's job prompt changed"

# 4. register is idempotent and never overwrites an edited prompt
echo "I EDITED THIS" >> "$JD/talos-morning-brief/prompt.md"
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
n=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$JF")
{ [ "$n" = 5 ] && grep -q "I EDITED THIS" "$JD/talos-morning-brief/prompt.md"; } && ok "re-registering adds nothing and keeps the user's prompt edit" || no "re-register duplicated jobs or clobbered an edit (jobs=$n)"

# 5. enable / disable
python3 "$TJ" enable talos-morning-brief --time 06:40 --days mon,wed,fri >/dev/null 2>&1
python3 - "$JF" <<'PY' && ok "enable sets enabled, time and days" || no "enable did not apply"
import json,sys
j={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-morning-brief"]
assert j["enabled"] is True and j["time"]=="06:40" and j["days"]=="mon,wed,fri"
PY
python3 "$TJ" enable talos-morning-brief --time 99:99 >/dev/null 2>&1 && no "enable accepted time 99:99" || ok "enable refuses an invalid time and saves nothing"
python3 "$TJ" disable talos-morning-brief >/dev/null 2>&1
python3 -c 'import json,sys; sys.exit(0 if not {x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-morning-brief"]["enabled"] else 1)' "$JF" && ok "disable switches the job off" || no "disable did not"

# 6. a corrupt jobs.json is refused, not overwritten
cp "$JF" "$SB/jobs.good"; printf '{not json' > "$JF"
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1 && no "register ran against a corrupt jobs.json" \
  || { [ "$(cat "$JF")" = '{not json' ] && ok "a corrupt jobs.json is refused and left exactly as it was" || no "corrupt jobs.json was modified"; }
cp "$SB/jobs.good" "$JF"

# 7. the session hook entry: added once, keeps what was there, removed cleanly, and verify-install still parses it
mkdir -p "$SB/fakechronos/hooks"; printf 'print("{}")\n' > "$SB/fakechronos/hooks/chronos-session-start.py"
cp "$KIT/templates/dot-claude/settings.json" "$SB/agent/.claude/settings.json"
python3 "$TJ" hook-add --agent-dir "$SB/agent" --chronos-dir "$SB/fakechronos" >/dev/null 2>&1
python3 "$TJ" hook-add --agent-dir "$SB/agent" --chronos-dir "$SB/fakechronos" >/dev/null 2>&1
c=$(grep -c 'chronos-session-start.py' "$SB/agent/.claude/settings.json")
[ "$c" = 1 ] && ok "hook-add registers the Chronos hook exactly once" || no "Chronos hook registered $c times"
( cd "$SB/agent" && mkdir -p scripts && cp "$KIT/scripts/_check_hook_registration.py" scripts/ && python3 scripts/_check_hook_registration.py | grep -q '^OK' ) \
  && ok "the Talos hook registration check still passes with the Chronos hook alongside" || no "adding the Chronos hook broke the registration check"
python3 "$TJ" hook-remove --agent-dir "$SB/agent" >/dev/null 2>&1
{ ! grep -q 'chronos-session-start.py' "$SB/agent/.claude/settings.json" && grep -q 'pre-tool-guard.py' "$SB/agent/.claude/settings.json" && grep -q 'session-start.py' "$SB/agent/.claude/settings.json"; } \
  && ok "hook-remove takes out only the Chronos hook" || no "hook-remove removed too much or too little"

# 8. unregister removes only talos-*, prompts and all
python3 "$TJ" unregister >/dev/null 2>&1
python3 - "$JF" <<'PY' && ok "unregister removes every talos-* job and keeps the user's" || no "unregister left talos jobs or removed others"
import json,sys
ids=[j["id"] for j in json.load(open(sys.argv[1]))]
assert ids==["my-own-job"], ids
PY
{ [ ! -d "$JD/talos-morning-brief" ] && [ -f "$JD/my-own-job/prompt.md" ]; } && ok "unregister deletes the Talos prompt folders only" || no "prompt folders wrong after unregister"

# 8b. an agent folder with a space in its path: the command stays one safe shell command
mkdir -p "$SB/my agent"; rm -f "$HOME/.config/talos/chronos-dir"
python3 "$TJ" register --agent-dir "$SB/my agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" "$SB/my agent" <<'PY' && ok "an agent path with a space is shell-quoted inside the command" || no "agent path with a space not quoted"
import json,sys,shlex
j={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-memory-index"]
assert shlex.split(j["command"])==["bash", sys.argv[2]+"/scripts/memory/refresh-index.sh"], j["command"]
PY
python3 "$TJ" unregister >/dev/null 2>&1
# 8c. a Chronos older than 0.2.1 cannot run command jobs: register skips that one job, loudly, and registers the rest
mkdir -p "$HOME/.config/talos" "$SB/oldchronos/lib"; printf 'VERSION = "0.2.0"\n' > "$SB/oldchronos/lib/chronoslib.py"; printf '%s\n' "$SB/oldchronos" > "$HOME/.config/talos/chronos-dir"
out="$(python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"
n=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$JF")
{ [ "$n" = 4 ] && printf '%s' "$out" | grep -q 'SKIPPED talos-memory-index' && printf '%s' "$out" | grep -q 'command jobs need 0.2.1'; } \
  && ok "on Chronos 0.2.0 the command job is skipped with a message and the other four register" || no "old-Chronos gate wrong (jobs=$n)" "$out"
python3 "$TJ" unregister >/dev/null 2>&1
printf 'VERSION = "0.2.1"\n' > "$SB/oldchronos/lib/chronoslib.py"
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
n=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$JF")
[ "$n" = 5 ] && ok "on Chronos 0.2.1 all five register" || no "0.2.1 registered $n jobs (want 5)"
python3 "$TJ" unregister >/dev/null 2>&1; rm -f "$HOME/.config/talos/chronos-dir"

# 8d. refresh-index.sh, the command the job runs: a clear failure without the venv, the indexer (quietly) with it
mkdir -p "$SB/agent/scripts/memory"; cp "$KIT/scripts/memory/refresh-index.sh" "$SB/agent/scripts/memory/"
export XDG_DATA_HOME="$SB/data"
out="$(bash "$SB/agent/scripts/memory/refresh-index.sh" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'memory search is not installed (bash .*scripts/memory/setup.sh)'; } && ok "refresh-index.sh without the venv exits 1 and says how to install it (the job then fails and notifies)" || no "refresh-index.sh without a venv wrong (rc=$rc)" "$out"
mkdir -p "$XDG_DATA_HOME/talos/venv/bin"; printf '#!/bin/bash\necho "FAKE-PY $*" >> "%s/index.calls"\necho "indexed 0 files"\n' "$SB" > "$XDG_DATA_HOME/talos/venv/bin/python"; chmod +x "$XDG_DATA_HOME/talos/venv/bin/python"
out="$(bash "$SB/agent/scripts/memory/refresh-index.sh" 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "a venv without the memory-search marker (a voice-only venv) is not mistaken for an install" || no "voice-only venv accepted (rc=$rc)"
: > "$XDG_DATA_HOME/talos/venv/.talos-memory-ok"
out="$(bash "$SB/agent/scripts/memory/refresh-index.sh" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && grep -q "FAKE-PY $SB/agent/scripts/memory/mem_index.py --quiet" "$SB/index.calls"; } && ok "refresh-index.sh runs mem_index.py --quiet with the shared venv's python and passes its exit code through" || no "refresh-index.sh did not run the indexer (rc=$rc)" "$out"
unset XDG_DATA_HOME

# 9. against the REAL Chronos, if you point at one: the exact prompt a run would receive, and what is due when
if [ -n "${TALOS_TEST_CHRONOS:-}" ] && [ -x "$TALOS_TEST_CHRONOS/bin/chronos" ]; then
  python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
  CH="$TALOS_TEST_CHRONOS/bin/chronos"
  for id in talos-morning-brief talos-weekly-wiki-lint talos-weekly-snapshot talos-state-sweep; do
    p="$(python3 "$CH" prompt "$id" 2026-10-05 2>&1)"
    if printf '%s' "$p" | grep -q 'Never start background tasks' && printf '%s' "$p" | grep -q 'FOREGROUND ONLY' && printf '%s' "$p" | grep -q "$SB/agent"; then
      ok "real Chronos builds the $id prompt: preamble + locked guard + task, agent path present"
    else no "real Chronos prompt for $id is wrong" "$(printf '%s' "$p" | head -3)"; fi
  done
  # the command job, end to end through the real run script: no claude, the indexer is a fake python in a fake venv
  CHVER="$(python3 "$CH" --version 2>&1)"
  if python3 "$CH" field talos-memory-index kind 2>/dev/null | grep -q '^command$'; then
    ok "real Chronos reads talos-memory-index as a command job ($CHVER)"
    python3 "$CH" prompt talos-memory-index 2026-10-05 >/dev/null 2>&1 && no "real Chronos built a prompt for a command job" || ok "real Chronos has no prompt for it (nothing is sent to Claude)"
    python3 "$TJ" enable talos-memory-index >/dev/null 2>&1
    CHRONOS_NOW=2026-10-05T07:00 python3 "$CH" due 2>&1 | grep -q '^talos-memory-index|2026-10-05' && ok "real Chronos says the index job is due at 07:00 although it has no prompt.md" || no "command job not due"
    export XDG_DATA_HOME="$SB/data2"; mkdir -p "$XDG_DATA_HOME/talos/venv/bin" "$SB/agent/scripts/memory"; : > "$XDG_DATA_HOME/talos/venv/.talos-memory-ok"
    cp "$KIT/scripts/memory/refresh-index.sh" "$SB/agent/scripts/memory/"; rm -f "$SB/index.calls"
    printf '#!/bin/bash\necho "FAKE-PY $*" >> "%s/index.calls"\necho "indexed 3 files"\n' "$SB" > "$XDG_DATA_HOME/talos/venv/bin/python"; chmod +x "$XDG_DATA_HOME/talos/venv/bin/python"
    mkdir -p "$SB/nobin"; printf '#!/bin/bash\necho "claude was called" >> "%s/claude.called"\nexit 1\n' "$SB" > "$SB/nobin/claude"; chmod +x "$SB/nobin/claude"
    python3 - "$CHRONOS_CONFIG" "$SB/nobin/claude" <<'PY'
import json,sys; p=sys.argv[1]; c=json.load(open(p)); c["claude_bin"]=sys.argv[2]; json.dump(c,open(p,"w"))
PY
    CHRONOS_POLL_S=1 bash "$TALOS_TEST_CHRONOS/bin/chronos-run.sh" talos-memory-index 2026-10-05 >/dev/null 2>&1
    { [ -f "$HOME/.chronos/state/ran-talos-memory-index-2026-10-05" ] && grep -q "FAKE-PY .*mem_index.py --quiet" "$SB/index.calls" && [ ! -e "$SB/claude.called" ]; } \
      && ok "a real Chronos run of the index job runs the indexer, marks the day done and never starts claude" || no "real Chronos command run wrong" "$(ls "$HOME/.chronos/state" 2>&1 | head -3)"
    unset XDG_DATA_HOME
  else echo "  skip real-Chronos command-job checks (this Chronos predates 0.2.1)"; fi
  # Chronos 0.2 honours the per-job `model` key (0.1 has no jobenv command and ignores it)
  env_out="$(python3 "$CH" jobenv talos-weekly-snapshot 2>&1)"
  if printf '%s' "$env_out" | grep -q 'CH_JOB_MODEL'; then
    printf '%s' "$env_out" | grep -q "CH_JOB_MODEL=.\?sonnet" && ok "real Chronos reads the shipped per-job model (the snapshot job runs with --model sonnet)" || no "real Chronos did not pick up model: sonnet" "$env_out"
    printf '%s' "$(python3 "$CH" jobenv talos-morning-brief 2>&1)" | grep -q "CH_JOB_MODEL=''\|CH_JOB_MODEL=$" && ok "real Chronos: the morning brief pins no model (inherits your default)" || no "brief model not empty" "$(python3 "$CH" jobenv talos-morning-brief 2>&1 | head -3)"
  else echo "  skip per-job model check (this Chronos predates 0.2)"; fi
  python3 "$TJ" enable talos-morning-brief >/dev/null 2>&1
  due="$(CHRONOS_NOW=2026-10-05T07:20 python3 "$CH" due --dry 2>&1)"
  printf '%s' "$due" | grep -q '^talos-morning-brief|2026-10-05' && ok "real Chronos says the brief is due Monday 07:20" || no "brief not due when it should be" "$due"
  due="$(CHRONOS_NOW=2026-10-03T07:20 python3 "$CH" due --dry 2>&1)"
  printf '%s' "$due" | grep -q 'talos-morning-brief' && no "brief is due on a Saturday" "$due" || ok "real Chronos does not schedule the brief on a Saturday"
else
  echo "  skip real-Chronos checks (set TALOS_TEST_CHRONOS=/path/to/chronos to run them)"
fi

echo "  jobs: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
