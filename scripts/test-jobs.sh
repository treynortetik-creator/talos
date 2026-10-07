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
# The Chronos that LAUNCHD runs, as Talos reads it: the tick plist names <runtime>/bin/chronos-tick.sh, and the version comes from
# <runtime>/lib/chronoslib.py. (Not from the clone Talos made: that can be newer than what is actually installed.)
export CHRONOS_LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"; mkdir -p "$CHRONOS_LAUNCHAGENTS_DIR"
mkplist(){ # $1 = runtime dir, $2 = version ("" = leave no lib file)
  mkdir -p "$1/lib" "$1/bin"; rm -f "$1/lib/chronoslib.py"; [ -n "$2" ] && printf 'VERSION = "%s"\n' "$2" > "$1/lib/chronoslib.py"
  python3 - "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist" "$1" <<'PY'
import plistlib,sys
plistlib.dump({"Label":"io.github.chronos.tick","ProgramArguments":["/bin/bash",sys.argv[2]+"/bin/chronos-tick.sh"]},open(sys.argv[1],"wb"))
PY
}
mkplist "$SB/rt" 0.2.2

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
# 8c. old/unknown Chronos: 0.2.0 has no command jobs AND ignores "restricted" (it would run a "restricted" job with permissions
# skipped), so register skips both kinds, loudly. 0.2.1 has command jobs but still no restriction. An UNKNOWN Chronos cannot be
# trusted to honour the restriction either. The version is read from the runtime the launchd plist runs.
cnt(){ python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$JF"; }
mkplist "$SB/rt" 0.2.0
out="$(python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"; n=$(cnt)
{ [ "$n" = 0 ] && printf '%s' "$out" | grep -q 'SKIPPED talos-memory-index' && printf '%s' "$out" | grep -q 'command jobs need 0.2.1' && printf '%s' "$out" | grep -q 'SKIPPED talos-morning-brief.*restricted jobs need 0.2.2'; } \
  && ok "on Chronos 0.2.0 the command job and every restricted job are skipped with a message (nothing registers silently unrestricted)" || no "old-Chronos gate wrong (jobs=$n)" "$out"
printf '%s' "$out" | grep -q 'git -C ~/.local/share/talos/chronos fetch' && printf '%s' "$out" | grep -q 'reinstall-chronos' && ok "the message says how to update the Chronos clone (detached: fetch + checkout the pin, or --reinstall-chronos), not 'git pull'" || no "update help missing or says git pull" "$out"
out="$(python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" --full-access 2>&1)"; n=$(cnt)
{ [ "$n" = 4 ] && python3 - "$JF" <<'PY'
import json,sys
d={j["id"]:j for j in json.load(open(sys.argv[1]))}
assert all(d[i]["restricted"] is False and "allowed_tools" not in d[i] for i in ("talos-morning-brief","talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"))
PY
} && ok "--full-access registers the Claude jobs on an old Chronos, recording restricted:false and no tool list (the explicit opt-out)" || no "--full-access registration wrong (jobs=$n)" "$out"
python3 "$TJ" unregister >/dev/null 2>&1
mkplist "$SB/rt" 0.2.1
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1; n=$(cnt)
[ "$n" = 1 ] && ok "on Chronos 0.2.1 only the command job registers (restricted jobs wait for 0.2.2)" || no "0.2.1 registered $n jobs (want 1)"
python3 "$TJ" unregister >/dev/null 2>&1
mkplist "$SB/rt" 0.2.2
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1; n=$(cnt)
[ "$n" = 5 ] && ok "on Chronos 0.2.2 all five register" || no "0.2.2 registered $n jobs (want 5)"
mkplist "$SB/rt" 0.2.1
python3 "$TJ" enable talos-state-sweep >/dev/null 2>&1 && no "enable switched on a restricted job under Chronos 0.2.1" || ok "enable refuses a restricted job when Chronos is older than 0.2.2"
python3 "$TJ" access talos-state-sweep --restricted --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1 && no "access --restricted accepted on 0.2.1" || ok "access --restricted refuses on an old Chronos"
python3 "$TJ" unregister >/dev/null 2>&1

# 8c2. THE REVIEW'S CASE: the clone Talos made is 0.2.2 (chronos-dir says so) but launchd still runs an older copy
mkdir -p "$HOME/.config/talos" "$SB/clone022/lib"; printf 'VERSION = "0.2.2"\n' > "$SB/clone022/lib/chronoslib.py"; printf '%s\n' "$SB/clone022" > "$HOME/.config/talos/chronos-dir"
mkplist "$SB/rt" 0.2.1
out="$(python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"; n=$(cnt)
{ [ "$n" = 1 ] && printf '%s' "$out" | grep -q 'SKIPPED talos-state-sweep' && printf '%s' "$out" | grep -q "$SB/rt"; } && ok "a pinned 0.2.2 CLONE does not fool Talos: the version comes from the runtime launchd runs (0.2.1), so restricted jobs are skipped and the message names that runtime" || no "Talos trusted the clone's version" "$out"
python3 "$TJ" unregister >/dev/null 2>&1
# unknown: no plist at all, an unreadable runtime, a plist that names no tick script, a runtime with no VERSION
for case in noplist noruntime badplist noversion; do
  rm -f "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist"
  case "$case" in
    noplist) ;;
    noruntime) python3 - "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist" "$SB/does-not-exist" <<'PY'
import plistlib,sys
plistlib.dump({"ProgramArguments":["/bin/bash",sys.argv[2]+"/bin/chronos-tick.sh"]},open(sys.argv[1],"wb"))
PY
      ;;
    badplist) printf 'not a plist' > "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist" ;;
    noversion) mkplist "$SB/rt" ""; printf '# no version here\n' > "$SB/rt/lib/chronoslib.py" ;;
  esac
  out="$(python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"; n=$(cnt)
  { [ "$n" = 1 ] && printf '%s' "$out" | grep -q 'SKIPPED talos-morning-brief' && printf '%s' "$out" | grep -q 'cannot tell which Chronos'; } && ok "unknown Chronos version ($case): restricted jobs are refused, not assumed fine" || no "unknown version ($case) accepted (jobs=$n)" "$out"
  python3 "$TJ" unregister >/dev/null 2>&1
done
rm -f "$HOME/.config/talos/chronos-dir"
mkplist "$SB/rt" 0.2.2
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
rm -f "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist"
python3 "$TJ" enable talos-state-sweep >/dev/null 2>&1 && no "enable accepted a restricted job with an unknown Chronos" || ok "enable refuses a restricted job when the Chronos version cannot be determined"
python3 "$TJ" harden --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1; [ $? -ne 0 ] && ok "harden refuses when the Chronos version cannot be determined" || no "harden ran with an unknown Chronos"
python3 "$TJ" unregister >/dev/null 2>&1
mkplist "$SB/rt" 0.2.2

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

# 8e. RESTRICTED BY DEFAULT (1.1.2-cli): the shipped Claude jobs carry a tool list, rendered for this agent folder
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" "$SB/agent" <<'PY' && ok "the four Claude jobs register restricted, with their tool list rendered for the agent folder" || no "restricted registration wrong"
import json,sys
d={j["id"]:j for j in json.load(open(sys.argv[1]))}; A=sys.argv[2]
for i in ("talos-morning-brief","talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"):
    j=d[i]; assert j["restricted"] is True and j["allowed_tools"], i
    assert not any("{{" in t for t in j["allowed_tools"]), j["allowed_tools"]
    assert "Bash" not in j["allowed_tools"], "bare Bash"          # no unrestricted shell, ever
    assert not any(t in ("Read","Grep","Glob") for t in j["allowed_tools"]), "a bare read tool can read the whole disk"
    assert all("%s(/%s/**)" % (b, A) in j["allowed_tools"] for b in ("Read","Grep","Glob")), "read tools must be scoped to the agent folder"
    assert not any(t.startswith(("WebFetch","WebSearch","mcp__")) for t in j["allowed_tools"]), j["allowed_tools"]
    for t in j["allowed_tools"]:
        if t.startswith("Bash("): assert t.startswith("Bash(date)") or ("/scripts/" in t and A in t and not t.endswith(":*)")), t   # an exact command naming a kit script
        if t.startswith("Edit("): assert t.startswith(("Edit(/"+A+"/", "Edit(/"+__import__("os").path.realpath(A)+"/")), t                   # scoped inside the agent folder (or its resolved spelling)
assert "restricted" not in d["talos-memory-index"] and d["talos-memory-index"]["kind"]=="command"
assert "Edit(/%s/memory/briefs/**)" % A in d["talos-morning-brief"]["allowed_tools"]
assert not any(t.startswith("Edit") for t in d["talos-state-sweep"]["allowed_tools"]+d["talos-weekly-wiki-lint"]["allowed_tools"]+d["talos-weekly-snapshot"]["allowed_tools"]), "a read-only job has a write tool"
PY
list="$(python3 "$TJ" list 2>&1)"
{ [ "$(printf '%s' "$list" | grep -c RESTRICTED)" = 4 ] && printf '%s' "$list" | grep 'talos-memory-index' | grep -q command; } && ok "list shows RESTRICTED for the four Claude jobs and 'command' for the index job" || no "list does not show access" "$list"
# the chosen tool lists must be accepted by Chronos's own validator when a Chronos is around (real check below, section 9)
# a restricted tool list must cover every command each prompt tells the job to run (validate checks it; prove the check bites)
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-state-sweep": j["allowed_tools"]=[t for t in j["allowed_tools"] if not t.startswith("Bash(python3")]
json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a prompt whose command no rule allows" || ok "validator rejects a prompt that runs a command no tool rule allows (that job would fail at 7am)"
for mutate in 'j["allowed_tools"].append("Read")' 'j["allowed_tools"].append("Grep(//etc/**)")' 'j["allowed_tools"].append("Bash")' 'j["allowed_tools"].append("WebFetch")' 'j["allowed_tools"].append("mcp__x__send_message")' 'j["allowed_tools"].append("Bash(python3 {{TALOS_HOME}}/scripts/state-sweep.py:*)")' 'j["allowed_tools"].append("Edit(//etc/**)")' 'j.pop("restricted")' 'j.pop("allowed_tools")'; do
  mkbad; python3 - "$SB/bad/jobs/jobs.json" "$mutate" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-morning-brief": exec(sys.argv[2])
json.dump(d,open(p,"w"))
PY
  python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a shipped job with: $mutate" || ok "validator rejects a shipped job with: $mutate"
done
mkbad; python3 - "$SB/bad/jobs/jobs.json" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-state-sweep": j["restricted"]=True; j["in_session"]=True
json.dump(d,open(p,"w"))
PY
python3 "$TJ" validate --kit-dir "$SB/bad" >/dev/null 2>&1 && no "validator accepted a restricted job that is in_session" || ok "validator rejects a restricted job that is also in_session (a live session cannot be narrowed)"
if grep -rEq '`(bash|python3) scripts/' "$KIT/jobs"; then no "a shipped prompt runs a script by a relative path"; else ok "no shipped prompt runs a script by a relative path (restricted rules match the full path)"; fi
if grep -rq 'cd there first\|`cd ' "$KIT/jobs"/*/prompt.md; then no "a restricted prompt tells the job to cd (a cd is not on its tool list)"; else ok "no shipped prompt tells the job to cd"; fi

# 8f. the opt-out and the way back
python3 "$TJ" access talos-state-sweep --full --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" <<'PY' && ok "access --full records restricted:false and drops the tool list (documented opt-out)" || no "access --full wrong"
import json,sys
j={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-state-sweep"]
assert j["restricted"] is False and "allowed_tools" not in j
PY
python3 "$TJ" list | grep talos-state-sweep | grep -q 'FULL ACCESS' && ok "list says FULL ACCESS for an opted-out job" || no "list does not flag FULL ACCESS"
python3 "$TJ" access talos-state-sweep --restricted --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" "$SB/agent" <<'PY' && ok "access --restricted puts the shipped tool list back" || no "access --restricted wrong"
import json,sys
j={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-state-sweep"]
assert j["restricted"] is True and "Bash(python3 %s/scripts/state-sweep.py)" % sys.argv[2] in j["allowed_tools"]
PY
python3 "$TJ" access talos-memory-index --full --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1 && no "access changed a command job" || ok "access refuses a command job (it has no tools to restrict)"
python3 "$TJ" access talos-state-sweep --agent-dir "$SB/agent" >/dev/null 2>&1 && no "access ran with neither --restricted nor --full" || ok "access needs exactly one of --restricted / --full"

# 8g. allow: exact read-only MCP tools only
python3 "$TJ" allow talos-morning-brief mcp__mail__search_threads mcp__calendar__list_events >/dev/null 2>&1
python3 - "$JF" <<'PY' && ok "allow adds exact MCP tools and the ToolSearch loader they need" || no "allow wrong"
import json,sys
t={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-morning-brief"]["allowed_tools"]
assert "mcp__mail__search_threads" in t and "mcp__calendar__list_events" in t and "ToolSearch" in t, t
PY
for bad in mcp__mail__send_message mcp__drive__trash_file mcp__slack__slack_add_reaction 'mcp__mail__*' mcp__mail Bash 'Bash(rm:*)' WebFetch; do
  python3 "$TJ" allow talos-morning-brief "$bad" >/dev/null 2>&1 && no "allow accepted $bad" || ok "allow refuses $bad"
done
python3 "$TJ" allow talos-morning-brief mcp__mail__send_message --allow-write-tools >/dev/null 2>&1 && ok "allow --allow-write-tools overrides the read-only check (explicit)" || no "override flag did not work"
python3 "$TJ" allow talos-morning-brief mcp__mail__send_message --remove >/dev/null 2>&1; python3 "$TJ" allow talos-morning-brief mcp__calendar__list_events --remove >/dev/null 2>&1
python3 -c 'import json,sys; t={x["id"]:x for x in json.load(open(sys.argv[1]))}["talos-morning-brief"]["allowed_tools"]; sys.exit(0 if "mcp__calendar__list_events" not in t and "mcp__mail__send_message" not in t else 1)' "$JF" && ok "allow --remove takes a tool back out" || no "remove did not work"
python3 "$TJ" access talos-state-sweep --full --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 "$TJ" allow talos-state-sweep mcp__a__b >/dev/null 2>&1 && no "allow extended a full-access job" || ok "allow refuses a job that has no restriction to extend"
python3 "$TJ" unregister >/dev/null 2>&1

# 8h. harden: jobs registered by Talos 1.1.1 become restricted; an untouched prompt is replaced, an edited one is kept
mkdir -p "$SB/old111/jobs"
git -C "$KIT" rev-parse --git-dir >/dev/null 2>&1 && git -C "$KIT" cat-file -e 1f01d8b:jobs/jobs.json 2>/dev/null && {
  for f in jobs.json talos-morning-brief/prompt.md talos-morning-brief/guard.md talos-state-sweep/prompt.md talos-state-sweep/guard.md talos-weekly-snapshot/prompt.md talos-weekly-snapshot/guard.md talos-weekly-wiki-lint/prompt.md talos-weekly-wiki-lint/guard.md; do
    mkdir -p "$SB/old111/jobs/$(dirname "$f")"; git -C "$KIT" show "1f01d8b:jobs/$f" > "$SB/old111/jobs/$f"; done
  python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$SB/old111" --full-access >/dev/null 2>&1
  # a 1.1.1 registration has no restricted key at all: emulate it
  python3 - "$JF" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    j.pop("restricted",None); j.pop("allowed_tools",None)
    if j["id"]=="talos-state-sweep": j["in_session"]=True       # a 1.1.1 user may have armed this job in live sessions
json.dump(d,open(p,"w"))
PY
  echo "MY OWN EDIT" >> "$JD/talos-weekly-snapshot/prompt.md"
  out="$(python3 "$TJ" harden --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"
  python3 - "$JF" <<'PY' && ok "harden makes every 1.1.1 Claude job restricted with the shipped tool list" || no "harden did not restrict" "$out"
import json,sys
d={j["id"]:j for j in json.load(open(sys.argv[1]))}
assert all(d[i]["restricted"] is True and d[i]["allowed_tools"] for i in ("talos-morning-brief","talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"))
assert "restricted" not in d["talos-memory-index"]
PY
  grep -q 'RESTRICTED' "$JD/talos-state-sweep/prompt.md" && ok "harden replaces a 1.1.1 prompt the user never edited" || no "harden did not update an untouched prompt"
  { grep -q 'MY OWN EDIT' "$JD/talos-weekly-snapshot/prompt.md" && printf '%s' "$out" | grep -q 'prompt.md KEPT'; } && ok "harden keeps a prompt the user edited, and says so" || no "harden overwrote or hid an edited prompt" "$out"
  python3 - "$JF" "$TJ" <<'PY' && ok "harden switches in_session OFF on a job that had it (restricted + in_session is invalid: Chronos would skip it and the UI would refuse to save it) and every hardened job validates" || no "harden left restricted + in_session, or an invalid job" "$out"
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("tj", sys.argv[2]); tj = importlib.util.module_from_spec(spec); spec.loader.exec_module(tj)
d = json.load(open(sys.argv[1])); by = {x["id"]: x for x in d}
assert by["talos-state-sweep"]["restricted"] is True and by["talos-state-sweep"]["in_session"] is False, by["talos-state-sweep"]
bad = [(x["id"], tj.check_job(x)) for x in d if x["id"].startswith("talos-") and tj.check_job(x)]
assert not bad, bad
PY
  printf '%s' "$out" | grep -q 'in_session switched OFF' && ok "harden says it switched in_session off" || no "harden did not say it changed in_session" "$out"
  out2="$(python3 "$TJ" harden --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"; printf '%s' "$out2" | grep -q 'nothing to harden' && ok "harden is idempotent" || no "harden ran twice" "$out2"
  python3 "$TJ" unregister >/dev/null 2>&1
} || echo "  skip harden test (needs the kit's git history for the 1.1.1 files)"

# 8i. weekly-snapshot.sh: the whole snapshot job is exactly this script (the restricted job may run nothing else)
SN="$SB/snap"; rm -rf "$SN"; mkdir -p "$SN/scripts" "$SN/memory" "$SN/wiki" "$SN/.learnings"; cp "$KIT/scripts/weekly-snapshot.sh" "$SN/scripts/"
sn() { ( cd "$SN" && bash scripts/weekly-snapshot.sh 2>&1 ); }
out="$(sn)"; rc=$?; { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'not a git repository'; } && ok "snapshot script: outside a git repository it says so, exits 0 and never runs git init" || no "snapshot without a repo wrong (rc=$rc)" "$out"
[ ! -d "$SN/.git" ] && ok "snapshot script: it did not create a repository" || no "snapshot ran git init"
( cd "$SN" && git init -q . && git config user.email t@t && git config user.name t && echo base > memory/a.md && echo other > other.txt && git add -A && git commit -q -m base )
out="$(sn)"; { [ $? = 0 ] && printf '%s' "$out" | grep -q 'nothing to commit'; } && ok "snapshot script: a clean tree is reported as nothing to commit" || no "clean tree wrong" "$out"
echo more >> "$SN/memory/a.md"; echo note > "$SN/wiki/n.md"; echo l > "$SN/.learnings/l.md"; echo "UNRELATED" > "$SN/other.txt"; ( cd "$SN" && git add other.txt )
out="$(sn)"; rc=$?
c="$(git -C "$SN" show --stat --format=%s HEAD | head -1)"
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'committed 3 file' && printf '%s' "$c" | grep -q '^weekly snapshot 20'; } && ok "snapshot script: one local commit of memory, wiki and .learnings, titled 'weekly snapshot <date>'" || no "snapshot commit wrong (rc=$rc)" "$out"
git -C "$SN" show --name-only --format= HEAD | grep -q other.txt && no "snapshot swept in a file that was staged outside the three folders" || ok "snapshot script: something else already staged in the repo is NOT swept into the commit"
echo "SECRET=1" > "$SN/memory/.env"; echo x >> "$SN/memory/a.md"; before="$(git -C "$SN" rev-parse HEAD)"
out="$(sn)"; rc=$?; { [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'REFUSED' && [ "$(git -C "$SN" rev-parse HEAD)" = "$before" ] && ! git -C "$SN" diff --cached --name-only | grep -q '^memory/'; } && ok "snapshot script: a .env among the changes is refused BEFORE anything is staged or committed" || no ".env not refused (rc=$rc)" "$out"
rm -f "$SN/memory/.env"
for odd in "my notes" "caf\xc3\xa9" "tab	dir"; do
  d="$(printf "$odd")"; mkdir -p "$SN/memory/$d"; echo "SECRET=1" > "$SN/memory/$d/.env"; echo x >> "$SN/memory/a.md"; before="$(git -C "$SN" rev-parse HEAD)"
  out="$(sn)"; rc=$?
  { [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'REFUSED' && [ "$(git -C "$SN" rev-parse HEAD)" = "$before" ] && ! git -C "$SN" diff --cached --name-only | grep -q '^memory/'; } \
    && ok "snapshot script: a .env in a folder whose name has a space, a non-ASCII letter or a tab ('$odd') is refused (git quotes those names; -z does not)" || no ".env in an oddly named folder slipped through ($odd, rc=$rc)" "$out"
  rm -rf "$SN/memory/$d"
done
mkdir -p "$SN/memory/personal"; echo p > "$SN/memory/personal/p.md"; out="$(sn)"; rc=$?
{ [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'personal/p.md'; } && ok "snapshot script: anything under a personal/ folder is refused too" || no "personal/ not refused (rc=$rc)" "$out"
rm -rf "$SN/memory/personal"
# a parent repository must not be committed into: the repository has to BE the agent folder
PAR="$SB/par"; rm -rf "$PAR"; mkdir -p "$PAR/agent/scripts" "$PAR/agent/memory"; cp "$KIT/scripts/weekly-snapshot.sh" "$PAR/agent/scripts/"; ( cd "$PAR" && git init -q . && git config user.email t@t && git config user.name t && echo a > agent/memory/a.md && git add -A && git commit -q -m b && echo b >> agent/memory/a.md )
out="$( cd "$PAR/agent" && bash scripts/weekly-snapshot.sh 2>&1 )"; rc=$?; { [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'not this agent folder'; } && ok "snapshot script: refuses when the git repository is a PARENT folder, not the agent folder" || no "parent repo accepted (rc=$rc)" "$out"
if grep -v '^[[:space:]]*#' "$KIT/scripts/weekly-snapshot.sh" | grep -v 'echo ' | grep -qE 'git (push|pull|fetch|reset|clean|checkout|remote|init)|git add (-A|--all|\.)'; then no "the snapshot script contains a command that touches a remote or history"; else ok "snapshot script: contains no push, pull, fetch, reset, clean, checkout, remote, init or sweeping add"; fi

# 8j. a malformed `restricted` is INVALID (never "unrestricted"); harden refuses to write anything invalid
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    if j["id"]=="talos-state-sweep": j["restricted"]="true"
json.dump(d,open(p,"w"))
PY
python3 "$TJ" list | grep talos-state-sweep | grep -q INVALID && ok "list shows a malformed restricted (\"true\") as INVALID, not as full access or restricted" || no "malformed restricted not flagged in list"
python3 "$TJ" enable talos-state-sweep >/dev/null 2>&1 && no "enable accepted restricted:\"true\"" || ok "enable refuses a job whose restricted is not a real boolean"
python3 "$TJ" unregister >/dev/null 2>&1
python3 "$TJ" register --agent-dir "$SB/agent" --kit-dir "$KIT" >/dev/null 2>&1
python3 - "$JF" <<'PY'
import json,sys; p=sys.argv[1]; d=json.load(open(p))
for j in d:
    j.pop("restricted",None); j.pop("allowed_tools",None)
    if j["id"]=="talos-state-sweep": j["notify"]="sms"      # something harden cannot fix
json.dump(d,open(p,"w"))
PY
cp "$JF" "$SB/jobs.before"
out="$(python3 "$TJ" harden --agent-dir "$SB/agent" --kit-dir "$KIT" 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'nothing changed' && cmp -s "$JF" "$SB/jobs.before"; } && ok "harden validates every job first and writes nothing when one would end up invalid" || no "harden wrote or accepted an invalid job (rc=$rc)" "$out"
python3 "$TJ" unregister >/dev/null 2>&1

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
  # Chronos 0.2.2: the restriction is real. Chronos validates allowed_tools and silently falls back to a SAFE default list if
  # one entry is malformed, so assert that OUR rules came through verbatim (they validated) and that the built-ins stay narrow.
  jenv="$(python3 "$CH" jobenv talos-morning-brief 2>&1)"
  if printf '%s' "$jenv" | grep -q 'CH_RESTRICTED'; then
    for id in talos-morning-brief talos-weekly-wiki-lint talos-weekly-snapshot talos-state-sweep; do
      jenv="$(python3 "$CH" jobenv "$id" 2>&1)"
      want="$(python3 - "$JF" "$id" <<'PY'
import json,sys
print(",".join({x["id"]:x for x in json.load(open(sys.argv[1]))}[sys.argv[2]]["allowed_tools"]))
PY
)"
      { printf '%s' "$jenv" | grep -q '^CH_RESTRICTED=1$' && printf '%s' "$jenv" | grep -qF "CH_EV_ALLOWED='$want'" && printf '%s' "$jenv" | grep -q '^CH_EV_MCP=strict$' \
        && ! printf '%s' "$jenv" | grep '^CH_EV_TOOLS=' | grep -Eq 'WebFetch|WebSearch|Task|Agent'; } \
        && ok "real Chronos 0.2.2 runs $id restricted: our tool list validates as written, no web tools, no MCP server loads" || no "real Chronos did not adopt the restriction for $id" "$jenv"
      python3 "$CH" prompt "$id" 2026-10-05 2>&1 | grep -q 'This job is RESTRICTED. Your tools are limited to:' && ok "real Chronos tells $id its tool list in the prompt" || no "prompt for $id does not state the restriction"
    done
  else echo "  skip restricted-job checks (this Chronos predates 0.2.2)"; fi
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
