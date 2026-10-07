#!/usr/bin/env bash
# test-install.sh -- dry-run and sandbox-run install.sh / uninstall.sh against a FAKE HOME.
#
# Nothing here touches your real ~/.claude, your real Chronos config or launchd. HOME, XDG_CONFIG_HOME,
# CHRONOS_CONFIG and CHRONOS_LAUNCHAGENTS_DIR all point inside a throwaway directory, Chronos is replaced by
# a stub (scripts/fixtures/fake-chronos) unless you point TALOS_TEST_CHRONOS at a real checkout, and a
# `launchctl` shim on PATH records any call and fails it. The suite asserts the shim was never called.
#
# Usage: scripts/test-install.sh        (TALOS_TEST_CHRONOS=/path/to/chronos to also run the real Chronos)
# Do not litter a Chronos checkout (or this kit) with __pycache__ when the suites run python.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"
fresh_home(){ # $1 = name; sets up an empty fake HOME and a launchctl tripwire
  export HOME="$SB/$1"; rm -rf "$HOME"; mkdir -p "$HOME/bin" "$HOME/Library/LaunchAgents"
  export XDG_CONFIG_HOME="$HOME/.config"; export CHRONOS_CONFIG="$HOME/.config/chronos/config.json"
  export CHRONOS_LAUNCHAGENTS_DIR="$HOME/Library/LaunchAgents"; export TALOS_VENDOR_DIR="$HOME/.local/share/talos"
  printf '#!/bin/bash\necho "launchctl $*" >> "%s/launchctl.calls"\nexit 1\n' "$SB" > "$HOME/bin/launchctl"; chmod +x "$HOME/bin/launchctl"
  export PATH="$HOME/bin:$ORIGPATH"
}
ORIGPATH="$PATH"
STUB="$KIT/scripts/fixtures/fake-chronos"

# ---- 1. --dry-run changes nothing
fresh_home h1
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --notify macos --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "--dry-run exits 0" || no "--dry-run exited $rc" "$(printf '%s' "$out" | tail -3)"
{ [ ! -e "$HOME/agent" ] && [ ! -e "$HOME/.config" ] && [ ! -e "$HOME/.chronos" ]; } && ok "--dry-run created nothing" || no "--dry-run wrote files"
printf '%s' "$out" | grep -q 'would:' && ok "--dry-run prints a plan" || no "--dry-run printed no plan"

# ---- 2. a real install with the stub Chronos
fresh_home h2; A="$HOME/agent"
out="$(bash "$KIT/install.sh" --agent-dir "$A" --chronos-path "$STUB" --no-load --notify macos 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install.sh exits 0 against the stub Chronos" || no "install.sh exited $rc" "$(printf '%s' "$out" | tail -5)"
miss=""; for f in BOOTSTRAP.md START-HERE.md CLAUDE.md hooks/session-start.py hooks/pre-tool-guard.py scripts/verify-install.sh \
  scripts/talos-jobs.py templates/CLAUDE.md.tmpl wiki/README.md .claude/agents/grunt.md .claude/settings.json .talos-version jobs/jobs.json; do
  [ -e "$A/$f" ] || miss="$miss $f"; done
[ -z "$miss" ] && ok "the agent folder has the kit, settings.json and a version stamp" || no "agent folder is missing:$miss"
[ ! -e "$A/.git" ] && ok "the agent folder is a copy, not a git checkout (no .git)" || no ".git was copied into the agent folder"
[ -x "$A/hooks/session-start.py" ] && [ -x "$A/install.sh" ] && ok "hooks and scripts are executable" || no "a hook or script lost its executable bit"
python3 -m json.tool "$A/.claude/settings.json" >/dev/null 2>&1 && ok ".claude/settings.json is valid JSON" || no ".claude/settings.json is not valid JSON"
grep -q "^version=$(tr -d ' \t\r\n' < "$KIT/VERSION")\$" "$A/.talos-version" && grep -q '^kind=git-checkout$' "$A/.talos-version" && ok ".talos-version records the version" || no ".talos-version wrong: $(cat "$A/.talos-version" 2>/dev/null | tr '\n' ' ')"
grep -q "workspace $A noload=1" "$HOME/.chronos/fake-install.log" 2>/dev/null && ok "Chronos's installer was run with the agent folder as workspace and --no-load" || no "Chronos installer args wrong: $(cat "$HOME/.chronos/fake-install.log" 2>/dev/null)"
n=$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for j in d if j["id"].startswith("talos-") and not j["enabled"]))' "$HOME/.config/chronos/jobs.json" 2>/dev/null)
[ "$n" = 5 ] && ok "five Talos jobs are registered, all disabled" || no "jobs registered: $n (want 5 disabled)"
grep -q "$A" "$HOME/.config/chronos/jobs/talos-morning-brief/prompt.md" && ok "the job prompt names this agent folder" || no "job prompt does not name the agent folder"
python3 - "$HOME/.config/chronos/jobs.json" "$A" <<'PY' && ok "a default install registers the Claude jobs RESTRICTED (tool list, agent folder filled in, no bare Bash)" || no "default install did not register restricted jobs"
import json,sys
d={j["id"]:j for j in json.load(open(sys.argv[1]))}
for i in ("talos-morning-brief","talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"):
    assert d[i]["restricted"] is True and "Bash" not in d[i]["allowed_tools"] and not any("{{" in t for t in d[i]["allowed_tools"]), i
    assert any(sys.argv[2] in t for t in d[i]["allowed_tools"] if t.startswith("Bash(")), i
PY
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["notify"].endswith("notify/macos.sh") else 1)' "$CHRONOS_CONFIG" && [ -x "$XDG_CONFIG_HOME/talos/notify/macos.sh" ] \
  && ok "--notify macos installs the wrapper and sets Chronos's notify" || no "notify not wired"
grep -q 'chronos-session-start.py' "$A/.claude/settings.json" && ok "the Chronos session hook is registered in the agent's settings" || no "session hook not registered"
{ printf '%s' "$out" | grep -q '   chronos: chronos 0.2.2 installed' && ! printf '%s' "$out" | grep -q 'empty jobs.json'; } \
  && ok "Chronos's installer runs --quiet: one labelled summary line, and no stray \"created an empty jobs.json\" before the jobs are registered" || no "Chronos output not quiet/labelled" "$(printf '%s' "$out" | grep -i chronos | head -4)"
grep -q 'quiet=1' "$HOME/.chronos/fake-install.log" && ok "install.sh passed --quiet to a Chronos that supports it" || no "--quiet not passed"
{ printf '%s' "$out" | grep -q 'NOT running (--no-load)' && printf '%s' "$out" | grep -q 'io.github.chronos.tick.plist' && printf '%s' "$out" | grep -q 'ui/server.py'; } \
  && ok "--no-load ends with how to start the scheduler and the UI by hand (and claims no UI address is serving)" || no "--no-load instructions missing" "$(printf '%s' "$out" | tail -8)"
[ -f "$XDG_CONFIG_HOME/talos/chronos-dir" ] && ok "install remembers where Chronos came from (for uninstall)" || no "chronos-dir not recorded"
vi="$(cd "$A" && bash scripts/verify-install.sh 2>&1)"; printf '%s' "$vi" | grep -q 'hook parsed' && ok "verify-install.sh parses the installed hook registration" || no "verify-install does not see the hook"
printf '%s' "$vi" | grep -q 'enforcement hooks registered' && ! printf '%s' "$vi" | grep -q 'registered but the file is missing' \
  && ok "verify-install reports the enforcement hooks as registered, and does not mistake Chronos's own hook for a missing one" || no "verify-install hook note wrong" "$(printf '%s' "$vi" | grep -i hooks)"
[ ! -e "$SB/launchctl.calls" ] && ok "launchctl was never called" || no "launchctl WAS called" "$(cat "$SB/launchctl.calls")"

# ---- 2b. an older Chronos without --quiet still installs; its output is shown, labelled
fresh_home h2b
OLD="$SB/old-chronos"; rm -rf "$OLD"; cp -R "$STUB" "$OLD"; sed -i.bak 's/--quiet/--q-u-i-e-t/g' "$OLD/install.sh"; rm -f "$OLD/install.sh.bak"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$OLD" --no-load 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && grep -q 'quiet=0' "$HOME/.chronos/fake-install.log" && printf '%s' "$out" | grep -q '   chronos: no jobs yet'; } \
  && ok "a Chronos without --quiet is not passed it, and its output is still labelled" || no "old-Chronos fallback wrong (rc=$rc)" "$(printf '%s' "$out" | tail -4)"

# ---- 2d. THE REVIEW'S CASE: a Chronos config already exists, so Chronos's installer is not re-run; the pinned clone is 0.2.2
# but launchd still runs an older copy. Talos must read the version of the copy launchd runs, and skip the restricted jobs.
fresh_home h2d
OLDRT="$SB/old-runtime"; rm -rf "$OLDRT"; mkdir -p "$OLDRT/lib" "$OLDRT/bin"; printf 'VERSION = "0.2.1"\n' > "$OLDRT/lib/chronoslib.py"
python3 - "$CHRONOS_LAUNCHAGENTS_DIR/io.github.chronos.tick.plist" "$OLDRT" <<'PY'
import plistlib,sys
plistlib.dump({"Label":"io.github.chronos.tick","ProgramArguments":["/bin/bash",sys.argv[2]+"/bin/chronos-tick.sh"]},open(sys.argv[1],"wb"))
PY
mkdir -p "$HOME/.config/chronos/jobs" "$HOME/.chronos"; echo "[]" > "$HOME/.config/chronos/jobs.json"
printf '{"workspace": "%s", "jobs_file": "~/.config/chronos/jobs.json", "jobs_dir": "~/.config/chronos/jobs", "notify": ""}\n' "$HOME/agent" > "$CHRONOS_CONFIG"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --no-load 2>&1)"; rc=$?
n=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j["id"].startswith("talos-")))' "$HOME/.config/chronos/jobs.json")
r=$(python3 -c 'import json,sys; print(sum(1 for j in json.load(open(sys.argv[1])) if j.get("restricted") is True))' "$HOME/.config/chronos/jobs.json")
{ [ "$rc" = 0 ] && [ "$r" = 0 ] && [ "$n" = 1 ] && ! grep -q 'install.sh --workspace' "$HOME/.chronos/fake-install.log" 2>/dev/null \
  && printf '%s' "$out" | grep -q 'not running its installer again' && printf '%s' "$out" | grep -q 'SKIPPED talos-morning-brief' && printf '%s' "$out" | grep -q "$OLDRT"; } \
  && ok "an existing Chronos config + an OLDER runtime under launchd: Chronos's installer is not re-run, and the restricted jobs are skipped (read from the runtime launchd runs, not the 0.2.2 clone), with the runtime named" \
  || no "install trusted the clone's version or registered restricted jobs on an old runtime (rc=$rc jobs=$n restricted=$r)" "$(printf '%s' "$out" | tail -8)"

# ---- 2c. the documented opt-out: --full-access-jobs registers the Claude jobs unrestricted, and says so
fresh_home h2c
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --no-load --full-access-jobs 2>&1)"; rc=$?
python3 - "$HOME/.config/chronos/jobs.json" <<'PY' && [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'permission prompts SKIPPED' && ok "--full-access-jobs records restricted:false with no tool list, and the installer says prompts are skipped" || no "--full-access-jobs wrong (rc=$rc)" "$(printf '%s' "$out" | tail -4)"
import json,sys
d={j["id"]:j for j in json.load(open(sys.argv[1]))}
assert all(d[i]["restricted"] is False and "allowed_tools" not in d[i] for i in ("talos-morning-brief","talos-weekly-wiki-lint","talos-weekly-snapshot","talos-state-sweep"))
PY

# ---- 3. second install is refused, with the upgrade hint
out="$(bash "$KIT/install.sh" --agent-dir "$A" --chronos-path "$STUB" --no-load 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'upgrade.sh'; } && ok "re-running install on an installed folder is refused and points at upgrade.sh" || no "second install was not refused (rc=$rc)"

# ---- 4. other refusals
fresh_home h3
mkdir -p "$HOME/full"; echo x > "$HOME/full/mine.txt"
bash "$KIT/install.sh" --agent-dir "$HOME/full" --no-chronos >/dev/null 2>&1 && no "installed into a non-empty folder" || ok "refuses a non-empty folder"
bash "$KIT/install.sh" --agent-dir "$KIT/inside" --no-chronos >/dev/null 2>&1 && no "installed inside the kit" || ok "refuses an agent folder inside the kit"
bash "$KIT/install.sh" --agent-dir "$HOME/Google Drive/agent" --no-chronos >/dev/null 2>&1 && no "installed into a Google Drive path" || ok "refuses a cloud-synced path"
mkdir -p "$HOME/Documents"
bash "$KIT/install.sh" --agent-dir "$HOME/Documents/agent" --chronos-path "$STUB" --no-load >/dev/null 2>&1 && no "installed into ~/Documents with Chronos on" || ok "refuses ~/Documents when Chronos is on (macOS privacy rules)"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/Documents/agent" --no-chronos 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ -e "$HOME/Documents/agent/BOOTSTRAP.md" ]; } && ok "allows ~/Documents with --no-chronos" || no "--no-chronos in ~/Documents failed"
{ printf '%s' "$out" | grep -q 'WARNING: this folder is inside a macOS-protected folder' && printf '%s' "$out" | grep -q 'would like to access files in your Desktop folder' && printf '%s' "$out" | grep -q '~/agent'; } \
  && ok "an agent folder inside ~/Documents WARNS about the macOS access prompt and recommends ~/agent" || no "no protected-folder warning" "$(printf '%s' "$out" | grep -i -A2 warning)"
for pf in Desktop Downloads; do
  mkdir -p "$HOME/$pf"; fresh_h="$HOME/$pf/agent-$pf"
  out="$(bash "$KIT/install.sh" --agent-dir "$fresh_h" --chronos-path "$STUB" --no-load --allow-protected-folder 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'WARNING: this folder is inside a macOS-protected folder'; } && ok "--allow-protected-folder under ~/$pf installs and WARNS" || no "no warning under ~/$pf (rc=$rc)"
done
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/Documents/dry-agent" --no-chronos --dry-run 2>&1)"
printf '%s' "$out" | grep -q 'WARNING: this folder is inside a macOS-protected folder' && ok "--dry-run shows the protected-folder warning too" || no "dry-run hides the protected-folder warning"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent-ok" --no-chronos 2>&1)"
printf '%s' "$out" | grep -qi 'macOS-protected' && no "a normal folder got the protected-folder warning" || ok "no protected-folder warning for a folder outside Desktop, Documents and Downloads"
bash "$KIT/install.sh" --agent-dir "$HOME/x" --notify carrier-pigeon >/dev/null 2>&1 && no "accepted --notify carrier-pigeon" || ok "rejects an unknown --notify"

# ---- 5. --no-chronos installs the agent and nothing else
fresh_home h4
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos >/dev/null 2>&1; rc=$?
{ [ "$rc" = 0 ] && [ -e "$HOME/agent/BOOTSTRAP.md" ] && [ ! -e "$HOME/.config" ] && [ ! -e "$HOME/.chronos" ] && [ ! -e "$HOME/.local" ]; } \
  && ok "--no-chronos: agent installed, no Chronos config, no jobs, no clone" || no "--no-chronos left Chronos traces or failed (rc=$rc)"

# ---- 6. the clone path: pinned commit from a local repo, no network
fresh_home h5
R="$SB/chronos-origin"; rm -rf "$R"; mkdir -p "$R"; cp -R "$STUB/." "$R/"
( cd "$R" && git init -q . && git add -A && git -c user.email=t@t.t -c user.name=t commit -qm one && echo more > more.txt && git add more.txt && git -c user.email=t@t.t -c user.name=t commit -qm two ) >/dev/null 2>&1
FIRST="$(git -C "$R" rev-list --max-parents=0 HEAD)"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-repo "file://$R" --chronos-ref "$FIRST" --no-load 2>&1)"; rc=$?
head="$(git -C "$TALOS_VENDOR_DIR/chronos" rev-parse HEAD 2>/dev/null)"
{ [ "$rc" = 0 ] && [ "$head" = "$FIRST" ] && [ ! -e "$TALOS_VENDOR_DIR/chronos/more.txt" ]; } && ok "clone path pins the requested commit (HEAD is the first commit, not the tip)" || no "pin failed (rc=$rc head=$head want=$FIRST)" "$(printf '%s' "$out" | tail -3)"
fresh_home h6
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-repo "file://$R" --chronos-ref 0000000000000000000000000000000000000000 --no-load >/dev/null 2>&1 && no "installed with a commit that does not exist" || ok "a pinned commit that does not exist aborts the install"
fresh_home h7
cl="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-repo "file://$SB/does-not-exist" --no-load 2>&1)"; printf '%s' "$cl" | grep -q 'Could not clone' && ok "a failed clone says what to do (private repo, --chronos-path, --no-chronos)" || no "failed clone gave no guidance"

# ---- 4b. a nonexistent parent folder is a hard error, never the filesystem root (A3)
fresh_home h3b
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/no/such/parent/agent" --no-chronos 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ ! -e "$HOME/no" ] && [ ! -e /agent ] && printf '%s' "$out" | grep -q 'parent folder'; } \
  && ok "a missing parent folder is refused with a clear message and creates nothing" || no "missing parent not handled (rc=$rc)" "$(printf '%s' "$out" | tail -2)"

# ---- 5b. the kit's test fixtures are not copied into the agent folder (A9)
fresh_home h4b
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos >/dev/null 2>&1
{ [ ! -e "$HOME/agent/scripts/fixtures" ] && [ -e "$HOME/agent/scripts/verify-install.sh" ]; } \
  && ok "scripts/fixtures (a fake Chronos installer) is not copied into the agent folder" || no "fixtures leaked into the agent folder"

# ---- 5c. an existing Chronos with a DIFFERENT workspace is warned about, and --set-chronos-workspace fixes it (A7)
fresh_home h4c; mkdir -p "$HOME/.config/chronos" "$HOME/other-ws"
printf '{\n "workspace": "%s",\n "jobs_file": "~/.config/chronos/jobs.json",\n "jobs_dir": "~/.config/chronos/jobs",\n "notify": ""\n}\n' "$HOME/other-ws" > "$CHRONOS_CONFIG"
echo "[]" > "$HOME/.config/chronos/jobs.json"; chmod 600 "$CHRONOS_CONFIG"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --no-load 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'WARNING: Chronos.s workspace' && grep -q "other-ws" "$CHRONOS_CONFIG"; } \
  && ok "a different Chronos workspace is warned about and left alone by default" || no "workspace mismatch not warned (rc=$rc)" "$(printf '%s' "$out" | grep -i workspace | head -2)"
fresh_home h4d; mkdir -p "$HOME/.config/chronos" "$HOME/other-ws"
printf '{\n "workspace": "%s",\n "jobs_file": "~/.config/chronos/jobs.json",\n "jobs_dir": "~/.config/chronos/jobs",\n "notify": ""\n}\n' "$HOME/other-ws" > "$CHRONOS_CONFIG"
echo "[]" > "$HOME/.config/chronos/jobs.json"; chmod 600 "$CHRONOS_CONFIG"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --no-load --set-chronos-workspace 2>&1)"; rc=$?
mode="$(stat -f %Lp "$CHRONOS_CONFIG" 2>/dev/null || stat -c %a "$CHRONOS_CONFIG")"
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["workspace"]==sys.argv[2] else 1)' "$CHRONOS_CONFIG" "$HOME/agent" \
  && [ "$mode" = 600 ] && [ "$rc" = 0 ] && ok "--set-chronos-workspace repoints it atomically and keeps the file mode" || no "--set-chronos-workspace failed (rc=$rc mode=$mode)"

# ---- 6b. --with-memory-search: the dry-run prints the plan and creates nothing; with no Python 3.10+ the install still succeeds (C3)
fresh_home h6b
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --with-memory-search --embed-model small --dry-run 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'bge-small-en-v1.5' && printf '%s' "$out" | grep -q 'fastembed==' && printf '%s' "$out" | grep -q 'talos-memory-index' \
  && [ ! -e "$HOME/agent" ] && [ ! -e "$HOME/.local" ] && [ ! -e "$HOME/.config" ]; } \
  && ok "--with-memory-search --dry-run prints the venv, pinned packages, model, index and job, and creates nothing" || no "memory-search dry-run wrong (rc=$rc)" "$(printf '%s' "$out" | tail -8)"
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --with-memory-search --embed-model huge --dry-run >/dev/null 2>&1 && no "accepted --embed-model huge" || ok "rejects an unknown --embed-model"
fresh_home h6c
out="$(PATH="$HOME/bin:/usr/bin:/bin" bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-path "$STUB" --no-load --with-memory-search 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'NONE FOUND' && printf '%s' "$out" | grep -q 'NOT enabled' && [ -e "$HOME/agent/BOOTSTRAP.md" ] && [ ! -e "$HOME/.local/share/talos/venv" ] \
  && printf '%s' "$out" | grep -q 'brew install uv && bash .*scripts/memory/setup.sh' && printf '%s' "$out" | grep -q 'astral.sh/uv/install.sh'; } \
  && ok "with no Python 3.10+ (and no uv) the install still succeeds, says so, and builds no venv" || no "no-python fallback wrong (rc=$rc)" "$(printf '%s' "$out" | tail -6)"

# ---- 6c2. Python discovery sees a newer python3.14 (Homebrew's current default) and a plain python3 that is 3.10+
fresh_home h6c2; mkdir -p "$HOME/pybin"
# The wrapper must point at a REAL 3.10+ interpreter. Under the system python3 (3.9) `command -v python3` is not one, so look for any 3.10+ and skip when the machine has none.
_py10=""; for _c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
  _p="$(command -v "$_c" 2>/dev/null || true)"; [ -n "$_p" ] || continue
  "$_p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null && { _py10="$_p"; break; }
done
if [ -n "$_py10" ]; then
  printf '#!/bin/bash\nexec %s "$@"\n' "$_py10" > "$HOME/pybin/python3.14"; chmod +x "$HOME/pybin/python3.14"
  out="$(PATH="$HOME/pybin:/usr/bin:/bin" bash "$KIT/scripts/memory/setup.sh" --dry-run 2>&1)"
  printf '%s' "$out" | grep -q "python:  *$HOME/pybin/python3.14" && ok "setup.sh finds a python3.14 when it is the only 3.10+ on PATH" || no "python3.14 not found" "$(printf '%s' "$out" | grep python:)"
else
  echo "  skip setup.sh python3.14 discovery (no Python 3.10+ on this machine to wrap)"
fi

# ---- 6d. --with-vault: a private vault, validated first, never inside the agent or on synced storage (S2)
fresh_home h6d
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos --with-vault "$HOME/private-vault" --dry-run 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'private-vault' && [ ! -e "$HOME/private-vault" ] && [ ! -e "$HOME/agent" ]; } && ok "--with-vault --dry-run prints the plan and creates nothing" || no "vault dry-run wrong (rc=$rc)" "$(printf '%s' "$out" | tail -4)"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos --with-vault "$HOME/private-vault" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ -f "$HOME/private-vault/CLAUDE.md" ] && [ -f "$HOME/private-vault/_guard-terms.txt" ] && [ ! -e "$HOME/private-vault/_guard-terms.txt.example" ] \
  && [ "$(cat "$XDG_CONFIG_HOME/talos/vault-dir")" = "$HOME/private-vault" ] && printf '%s' "$out" | grep -q '## Personal vault'; } \
  && ok "--with-vault copies the vault template, records its path, and prints the block to add to CLAUDE.md" || no "vault install wrong (rc=$rc)" "$(printf '%s' "$out" | tail -5)"
mode="$(stat -f %Lp "$HOME/private-vault" 2>/dev/null || stat -c %a "$HOME/private-vault")"; [ "$mode" = 700 ] && ok "the vault folder is mode 700" || no "vault mode is $mode"
grep -v '^#' "$HOME/private-vault/_guard-terms.txt" | grep -q '[a-z]' && no "the shipped guard-terms file contains terms" || ok "the vault's guard-terms file ships with comments only, no terms"
fresh_home h6e
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos --with-vault "$HOME/agent/vault" >/dev/null 2>&1 && no "vault allowed inside the agent folder" || ok "--with-vault inside the agent folder is refused"
bash "$KIT/install.sh" --agent-dir "$HOME/agent2" --no-chronos --with-vault "$HOME/Google Drive/vault" >/dev/null 2>&1 && no "vault allowed on synced storage" || ok "--with-vault on synced storage is refused"
mkdir -p "$HOME/occupied"; echo x > "$HOME/occupied/f"; bash "$KIT/install.sh" --agent-dir "$HOME/agent3" --no-chronos --with-vault "$HOME/occupied" >/dev/null 2>&1 && no "vault allowed into a non-empty folder" || ok "--with-vault into a non-empty folder is refused"
[ ! -e "$HOME/agent2" ] && [ ! -e "$HOME/agent3" ] && ok "a refused vault leaves no half-installed agent behind" || no "agent folder created despite a refused vault"
mkdir -p "$HOME/Documents"; bash "$KIT/install.sh" --agent-dir "$HOME/agent4" --no-chronos --with-vault "$HOME/Documents/vault" >/dev/null 2>&1 && no "vault allowed under ~/Documents" || ok "--with-vault under ~/Documents (iCloud may sync it) is refused"

# ---- 6f. --global-pointer: an opt-in block in ~/.claude/CLAUDE.md, removed again by uninstall, nothing else touched (S7)
fresh_home h6f; mkdir -p "$HOME/.claude"
printf '# My global rules\n\n- be brief\n' > "$HOME/.claude/CLAUDE.md"
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos >/dev/null 2>&1
grep -q 'TALOS-POINTER' "$HOME/.claude/CLAUDE.md" && no "a plain install edited the global CLAUDE.md (it must be opt-in)" || ok "without --global-pointer the global ~/.claude/CLAUDE.md is untouched"
fresh_home h6g; mkdir -p "$HOME/.claude"; printf '# My global rules\n\n- be brief\n' > "$HOME/.claude/CLAUDE.md"; cp "$HOME/.claude/CLAUDE.md" "$SB/global.orig"
out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos --global-pointer --dry-run 2>&1)"
{ [ "$(cat "$HOME/.claude/CLAUDE.md")" = "$(cat "$SB/global.orig")" ] && printf '%s' "$out" | grep -q 'TALOS-POINTER:BEGIN'; } && ok "--global-pointer --dry-run shows the block and changes nothing" || no "global-pointer dry-run wrong"
bash "$KIT/install.sh" --agent-dir "$HOME/agent" --no-chronos --global-pointer >/dev/null 2>&1
{ grep -q "recall.py" "$HOME/.claude/CLAUDE.md" && grep -q "$HOME/agent" "$HOME/.claude/CLAUDE.md" && grep -q 'be brief' "$HOME/.claude/CLAUDE.md" && [ -f "$HOME/.claude/CLAUDE.md.bak-before-talos" ]; } \
  && ok "--global-pointer appends one marked block (agent path, recall command), keeps the user's lines, backs the file up first" || no "global block wrong"
python3 "$KIT/scripts/global-pointer.py" add --agent-dir "$HOME/agent" >/dev/null 2>&1
[ "$(grep -c 'TALOS-POINTER:BEGIN' "$HOME/.claude/CLAUDE.md")" = 1 ] && ok "adding it twice leaves exactly one block" || no "block duplicated"
bash "$HOME/agent/uninstall.sh" --agent-dir "$HOME/agent" >/dev/null 2>&1
{ [ "$(cat "$HOME/.claude/CLAUDE.md")" = "$(cat "$SB/global.orig")" ]; } && ok "uninstall removes exactly the block: the global file is byte-identical to before" || no "uninstall left the file different" "$(diff "$SB/global.orig" "$HOME/.claude/CLAUDE.md")"
printf '<!-- TALOS-POINTER:BEGIN -->\nhalf\n' > "$HOME/.claude/CLAUDE.md"; python3 "$KIT/scripts/global-pointer.py" add --agent-dir "$HOME/agent" >/dev/null 2>&1 && no "unbalanced markers were overwritten" || ok "unbalanced markers are refused and the file is left alone"
out="$(python3 "$KIT/scripts/global-pointer.py" remove 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'nothing was removed' && grep -q 'half' "$HOME/.claude/CLAUDE.md"; } && ok "remove with a BEGIN marker but no END says so (exit 1) instead of claiming it removed a block" || no "false removal message (rc=$rc)" "$out"
# a symlinked global CLAUDE.md (a dotfiles repo) stays a symlink; the real file is what changes
mkdir -p "$HOME/dotfiles"; printf '# dotfiles global\n' > "$HOME/dotfiles/CLAUDE.md"; rm -f "$HOME/.claude/CLAUDE.md"; ln -s "$HOME/dotfiles/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
python3 "$KIT/scripts/global-pointer.py" add --agent-dir "$HOME/agent" >/dev/null 2>&1
{ [ -L "$HOME/.claude/CLAUDE.md" ] && grep -q 'TALOS-POINTER:BEGIN' "$HOME/dotfiles/CLAUDE.md"; } && ok "a symlinked ~/.claude/CLAUDE.md stays a symlink and the real file gets the block" || no "symlink replaced by a regular file"
python3 "$KIT/scripts/global-pointer.py" remove >/dev/null 2>&1
{ [ -L "$HOME/.claude/CLAUDE.md" ] && [ "$(cat "$HOME/dotfiles/CLAUDE.md")" = "# dotfiles global" ]; } && ok "remove through a symlink restores the real file and keeps the link" || no "symlink or content wrong after remove" "$(cat "$HOME/dotfiles/CLAUDE.md")"

# ---- 7. uninstall removes what install added, and not the agent
fresh_home h8; A="$HOME/agent"
bash "$KIT/install.sh" --agent-dir "$A" --chronos-path "$STUB" --no-load --notify macos >/dev/null 2>&1
[ "$(cat "$XDG_CONFIG_HOME/talos/agent-dir" 2>/dev/null)" = "$A" ] && ok "install records the agent folder for uninstall" || no "agent-dir not recorded"
# no --agent-dir on purpose: uninstall must find the agent folder from what install recorded (A4)
uout="$(bash "$A/uninstall.sh" 2>&1)"
{ printf '%s' "$uout" | grep -q 'The one change inside it: the Chronos hook entry was removed from' && ! printf '%s' "$uout" | grep -q 'was not touched'; } \
  && ok "uninstall names the one edit it made inside the agent folder instead of claiming it was not touched" || no "uninstall message is false" "$(printf '%s' "$uout" | tail -3)"
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["notify"]=="" else 1)' "$CHRONOS_CONFIG" \
  && ok "uninstall clears Chronos's notify when it pointed into ~/.config/talos (no dangling wrapper)" || no "Chronos notify still points at the deleted wrapper"
ids="$(python3 -c 'import json,sys; print(",".join(j["id"] for j in json.load(open(sys.argv[1]))))' "$HOME/.config/chronos/jobs.json")"
{ [ -z "$ids" ] && [ ! -d "$HOME/.config/chronos/jobs/talos-morning-brief" ]; } && ok "uninstall unregisters the Talos jobs" || no "jobs left after uninstall: $ids"
{ [ ! -e "$XDG_CONFIG_HOME/talos" ] && ! grep -q 'chronos-session-start.py' "$A/.claude/settings.json"; } && ok "uninstall removes ~/.config/talos and the session hook" || no "uninstall left config or hook"
{ [ -e "$A/BOOTSTRAP.md" ] && [ -e "$A/wiki/README.md" ]; } && ok "uninstall leaves the agent folder alone" || no "uninstall touched the agent folder"

fresh_home h8b; A="$HOME/agent"
bash "$KIT/install.sh" --agent-dir "$A" --chronos-path "$STUB" --no-load --no-session-hook >/dev/null 2>&1
uout="$(bash "$A/uninstall.sh" 2>&1)"
printf '%s' "$uout" | grep -q 'Your agent folder .* was not touched' && ok "when uninstall edited nothing in the agent folder it says it was not touched" || no "wrong message when nothing was edited" "$(printf '%s' "$uout" | tail -2)"

# ---- 8. the REAL Chronos, if you point at one (still a fake HOME; --no-load; launchctl tripwire)
if [ -n "${TALOS_TEST_CHRONOS:-}" ] && [ -f "$TALOS_TEST_CHRONOS/install.sh" ]; then
  fresh_home h9; A="$HOME/agent"
  out="$(bash "$KIT/install.sh" --agent-dir "$A" --chronos-path "$TALOS_TEST_CHRONOS" --no-load --notify macos 2>&1)"; rc=$?
  [ "$rc" = 0 ] && ok "[real Chronos] install.sh exits 0" || no "[real Chronos] install.sh exited $rc" "$(printf '%s' "$out" | tail -5)"
  { printf '%s' "$out" | grep -q '   chronos: chronos [0-9.]* installed:' && ! printf '%s' "$out" | grep -q 'empty jobs.json'; } \
    && ok "[real Chronos] its installer output is one labelled line in the middle of the Talos install" || no "[real Chronos] output not quiet" "$(printf '%s' "$out" | grep -i chronos | head -5)"
  c="$(python3 "$TALOS_TEST_CHRONOS/bin/chronos" list 2>&1)"; printf '%s' "$c" | grep -q 'talos-memory-index' && ok "[real Chronos] the index command job shows in chronos list" || no "[real Chronos] index job missing" "$c"
  labels="$(grep -ho '<string>[a-z.]*chronos[a-z.]*</string>' "$HOME"/Library/LaunchAgents/*.plist 2>/dev/null | sort -u | tr '\n' ' ')"
  ls "$HOME"/Library/LaunchAgents/*.plist >/dev/null 2>&1 && ok "[real Chronos] plists were written into the FAKE LaunchAgents folder only" || no "[real Chronos] no plists rendered"
  ls "$HOME"/Library/LaunchAgents/ | grep -qi talos && no "[real Chronos] a Talos launchd agent exists; Talos must add none" || ok "[real Chronos] Talos added no launchd agent of its own"
  [ ! -e "$SB/launchctl.calls" ] && ok "[real Chronos] launchctl was never called" || no "[real Chronos] launchctl WAS called" "$(cat "$SB/launchctl.calls")"
  c="$(python3 "$TALOS_TEST_CHRONOS/bin/chronos" list 2>&1)"
  printf '%s' "$c" | grep -q 'talos-morning-brief' && ok "[real Chronos] 'chronos list' shows the Talos jobs" || no "[real Chronos] list does not show Talos jobs" "$c"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["workspace"]==sys.argv[2] else 1)' "$CHRONOS_CONFIG" "$A" && ok "[real Chronos] workspace in its config is the agent folder" || no "[real Chronos] workspace not set to the agent folder"
  # the shipped pin must be a real commit of that Chronos, and a clone at it must install (no network: file://)
  fresh_home h10
  PIN="$(sed -n 's/^CHRONOS_PINNED_REF="\([0-9a-f]*\)".*/\1/p' "$KIT/install.sh")"
  out="$(bash "$KIT/install.sh" --agent-dir "$HOME/agent" --chronos-repo "file://$TALOS_TEST_CHRONOS" --no-load 2>&1)"; rc=$?
  head="$(git -C "$TALOS_VENDOR_DIR/chronos" rev-parse HEAD 2>/dev/null)"
  { [ "$rc" = 0 ] && [ "$head" = "$PIN" ]; } && ok "[real Chronos] the pinned commit ${PIN:0:7} exists, clones and installs (default ref, no flags)" \
    || no "[real Chronos] pinned clone failed (rc=$rc head=$head pin=$PIN)" "$(printf '%s' "$out" | tail -3)"
  [ ! -e "$SB/launchctl.calls" ] && ok "[real Chronos] launchctl was never called by the pinned-clone install" || no "launchctl WAS called" "$(cat "$SB/launchctl.calls")"
else
  echo "  skip real-Chronos install (set TALOS_TEST_CHRONOS=/path/to/chronos to run it)"
fi
export HOME="$REALHOME"
echo "  install: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
