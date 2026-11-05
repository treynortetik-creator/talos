#!/usr/bin/env bash
# test-plugin.sh -- the Talos zone as a Claude Code plugin: build, install, migrate, and what Claude Code itself does with it.
#
# Nothing here touches a real home folder, a real agent folder or a real Claude Code setup: every check runs under a temp HOME
# with temp agent folders and a temp plugin vendor folder. The real `claude` CLI is used when it is installed (plugin validate;
# a session started with a dead API address, which still runs the SessionStart hooks); without it those checks are skipped and
# the skip is printed.
#
# 1  a fresh install: settings.json names the local marketplace, enables the plugin AND registers every hook (through the hooks/
#    link, fixed text that never changes per release); the plugin itself registers no hooks
# 2  every hook, run from the release with CLAUDE_PROJECT_DIR set to a temp agent, reads and writes there, never in the release
# 3  plugin-move up then down returns settings.json, hooks/ and scripts/ byte for byte; up twice is a no-op; the runner enforces
#    the zone rule (and the checks themselves fail when the code is broken on purpose)
# 4  the marketplace resolves through the `current` symlink: swap current to a second release and the plugin path follows
# 5  claude plugin validate passes on the built plugin
# 6  memory/, wiki/ and .learnings/ are not written by install or migrate (hashed, with modification times, before and after)
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
SB="$(cd "$SB" && pwd -P)" || exit 2      # macOS: $TMPDIR is under /var, a link to /private/var; every path below must be the real one
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'chmod -R u+w "$SB" 2>/dev/null; rm -rf "$SB"' EXIT
# macOS ships no `timeout` (GNU coreutils has one). Without it every `timeout N claude ...` below fails with 127 before claude
# starts and writes no debug log. A real one is kept; otherwise a perl stand-in goes on PATH (an executable: `env` calls it too).
if ! command -v timeout >/dev/null 2>&1; then
  command -v perl >/dev/null 2>&1 || { echo "test-plugin.sh needs timeout or perl; neither is on PATH" >&2; exit 2; }
  mkdir -p "$SB/bin"
  cat > "$SB/bin/timeout" <<'PL'
#!/usr/bin/perl
# timeout SECONDS COMMAND...: exit 124 when the time runs out, else the command's own status
my $s = shift; my $pid = fork() // die "fork: $!"; if (!$pid) { exec @ARGV; exit 127 }
$SIG{ALRM} = sub { kill 'TERM', $pid; sleep 1; kill 'KILL', $pid; waitpid $pid, 0; exit 124 }; alarm $s;
waitpid $pid, 0; exit($? & 127 ? 128 + ($? & 127) : $? >> 8);
PL
  chmod +x "$SB/bin/timeout"; export PATH="$SB/bin:$PATH"
fi
REALHOME="$HOME"
ORIGPATH="$PATH"
fresh_home(){ # $1 = name: an empty fake HOME with every Talos and Claude variable cleared
  export HOME="$SB/$1"; rm -rf "$HOME"; mkdir -p "$HOME"
  unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CHRONOS_RUN TALOS_UNATTENDED TALOS_APP_HOME TALOS_KIT_HOME XDG_STATE_HOME XDG_DATA_HOME
  export XDG_CONFIG_HOME="$HOME/.config" TALOS_VENDOR_DIR="$HOME/.local/share/talos"
}
# hash_tree PATH...: names, modes, link targets and bytes. hash_data PATH...: the same plus sizes and modification times.
hash_tree(){ python3 - "$@" <<'PY'
import hashlib, os, sys
h = hashlib.sha256()
for root in sys.argv[1:]:
    if os.path.islink(root):
        h.update(b"L" + os.readlink(root).encode()); continue
    if not os.path.exists(root):
        h.update(b"absent"); continue
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn + [d for d in dn if os.path.islink(os.path.join(dp, d))]):
            p = os.path.join(dp, n); h.update(os.path.relpath(p, root).encode() + b"\0")
            if os.path.islink(p): h.update(b"L" + os.readlink(p).encode())
            else: h.update(oct(os.stat(p).st_mode & 0o777).encode() + open(p, "rb").read())
print(h.hexdigest())
PY
}
hash_data(){ python3 - "$@" <<'PY'
import hashlib, os, sys
h = hashlib.sha256()
for root in sys.argv[1:]:
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn):
            p = os.path.join(dp, n); st = os.stat(p)
            h.update(("%s|%d|%d|" % (os.path.relpath(p, root), st.st_size, st.st_mtime_ns)).encode() + open(p, "rb").read())
print(h.hexdigest())
PY
}
marker(){ sed -n "s/^$2=//p" "$1/.talos-version" | head -1; }
vendor_release(){ ls -d "$1"/releases/*/talos-kit | head -1; }

# ================================================================ 1. a fresh install
fresh_home h1; A="$HOME/agent"; V="$TALOS_VENDOR_DIR/kit"
out="$(bash "$KIT/install.sh" --agent-dir "$A" --no-chronos 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "install.sh builds the plugin release and a working agent (--no-chronos)" || no "install.sh exited $rc" "$(printf '%s' "$out" | tail -4)"
REL="$(vendor_release "$V")"
python3 - "$A" "$V" "$KIT" <<'PY' && ok "settings.json names the local marketplace (a directory source), enables talos@talos-local and registers the kit's hooks" || no "settings.json is not the plugin layout"
import json, os, sys
a, v, kit = sys.argv[1:4]
s = json.load(open(os.path.join(a, ".claude/settings.json")))
assert s["extraKnownMarketplaces"] == {"talos-local": {"source": {"source": "directory", "path": v}}}, s["extraKnownMarketplaces"]
assert s["enabledPlugins"] == {"talos@talos-local": True}, s["enabledPlugins"]
t = json.load(open(os.path.join(kit, "templates/dot-claude/settings.json")))
assert s["hooks"] == t["hooks"], "settings.json does not register the template's hooks"
assert s["permissions"] == t["permissions"] and s["statusLine"] == t["statusLine"], "permissions or statusLine changed"
m = json.load(open(os.path.join(v, ".claude-plugin/marketplace.json")))
assert m["name"] == "talos-local" and m["plugins"] == [{"name": "talos", "source": "./current/talos-kit", "description": m["plugins"][0]["description"]}], m
assert os.readlink(os.path.join(v, "current")) == "releases/" + open(os.path.join(kit, "VERSION")).read().strip()
assert os.path.realpath(os.path.join(v, m["plugins"][0]["source"])) == os.path.realpath(os.path.join(v, "current", "talos-kit"))
PY
python3 - "$REL" <<'PY' && ok "the plugin registers no hooks: its hooks.json is absent or empty, so a guard is never registered twice (settings.json owns them)" || no "the plugin still registers hooks"
import json, os, sys
p = os.path.join(sys.argv[1], "hooks", "hooks.json")
assert not os.path.exists(p) or not (json.load(open(p)).get("hooks") or {}), "hooks.json registers hooks"
PY
python3 - "$A" <<'PY' && ok "every settings.json hook command goes through \$CLAUDE_PROJECT_DIR/hooks/ (the link) and the guards keep the fail-closed wrapper (unattended + missing file = exit 2)" || no "settings.json hook commands are not the fixed hooks/ text"
import json, os, re, sys
s = json.load(open(os.path.join(sys.argv[1], ".claude/settings.json")))
n = g = 0
for es in s["hooks"].values():
    for e in es:
        for h in e["hooks"]:
            c = h["command"]; n += 1
            assert "CLAUDE_PLUGIN_ROOT" not in c and "$CLAUDE_PROJECT_DIR/hooks/" in c, c[:80]
            if "Talos safety guard" in c:
                g += 1; assert "exit 2" in c
assert n >= 15 and g >= 5, (n, g)
PY
{ [ -L "$A/hooks" ] && [ -L "$A/scripts" ] && [ "$(readlink "$A/hooks")" = "$V/current/talos-kit/hooks" ] && [ "$(readlink "$A/scripts")" = "$V/current/talos-kit/scripts" ]; } \
  && ok "the agent's hooks/ and scripts/ are links into current/talos-kit/ (so the statusLine command keeps working)" || no "links wrong" "$(ls -la "$A" | grep -E ' (hooks|scripts) ')"
[ "$(marker "$A" version)" = "$(tr -d ' \t\r\n' < "$KIT/VERSION")" ] && [ -n "$(marker "$A" migration)" ] \
  && [ "$(marker "$A" migration)" = "$(python3 "$KIT/scripts/talos-migrate.py" status --agent "$A" --release "$KIT" | sed -n 's/^applied //p' | tail -1)" ] \
  && ok ".talos-version holds version= and migration=<last id>; talos-migrate sees nothing pending on a fresh agent" || no ".talos-version wrong" "$(cat "$A/.talos-version")"
out="$(python3 "$A/scripts/talos-migrate.py" up --agent "$A" 2>&1)"; printf '%s' "$out" | grep -q 'nothing to do' && ok "talos-migrate up on a fresh agent has nothing to do" || no "up on a fresh agent did something" "$out"
{ [ -x "$A/hooks/session-start.py" ] && [ -d "$REL/skills/talos-agora" ] && [ -f "$REL/agents/grunt.md" ] && [ -x "$REL/bin/talos-migrate" ] && [ ! -e "$A/.claude/skills" ] && [ ! -e "$A/.claude/agents" ] \
  && [ -f "$A/.claude/rules/talos-defaults.md" ] && [ -f "$A/CLAUDE.md" ] && [ ! -e "$REL/CLAUDE.md" ] && [ ! -d "$REL/memory" ] && [ ! -d "$REL/wiki" ]; } \
  && ok "the release holds hooks, skills, agents, bin; the agent keeps CLAUDE.md and the floor rules; no data folders in the release" || no "release or agent layout wrong"
FRESH_DATA="$(cd "$A" && hash_tree memory wiki .learnings)"

# ================================================================ 2. every hook, run from the release
R1="$(cd "$REL" && pwd -P)"; mkdir -p "$SB/probe1"
out="$(python3 "$KIT/scripts/fixtures/plugin-hook-probes.py" "$R1" "$SB/probe1" 2>&1)"; rc=$?
printf '%s\n' "$out" | sed 's/^/    | /' | grep -E 'FAIL' | head -12
[ "$rc" = 0 ] && ok "hook probes: all $(printf '%s\n' "$out" | grep -c '  ok ') checks pass (every hook run from the release with CLAUDE_PROJECT_DIR set to a temp agent)" || no "hook probes failed (rc=$rc)"
# the probes must be able to fail: break the code on purpose and see them go red
mut(){ rm -rf "$SB/mut"; mkdir -p "$SB/mut"; cp -R "$R1" "$SB/mut/talos-kit"; chmod -R u+w "$SB/mut"; }
mut; sed -i.orig 's/^    ROOT = find_agent_root()$/    ROOT = CODE_ROOT/' "$SB/mut/talos-kit/hooks/_talos_common.py"; rm -f "$SB/mut/talos-kit/hooks/_talos_common.py.orig"
cmp -s "$R1/hooks/_talos_common.py" "$SB/mut/talos-kit/hooks/_talos_common.py" && no "[mutation] the harness patch did not apply"
python3 "$KIT/scripts/fixtures/plugin-hook-probes.py" "$SB/mut/talos-kit" "$SB/probe-mut1" >/dev/null 2>&1 && no "[mutation] hooks that use their own folder as the agent (old _talos_common) still pass the probes" || ok "[mutation] the old rule in _talos_common (root = own folder) turns the probes red"
mut; sed -i.orig 's/^PROJECT_DIR = _find_project_dir()$/PROJECT_DIR = CODE_ROOT/' "$SB/mut/talos-kit/hooks/session-start.py"; rm -f "$SB/mut/talos-kit/hooks/session-start.py.orig"
python3 "$KIT/scripts/fixtures/plugin-hook-probes.py" "$SB/mut/talos-kit" "$SB/probe-mut2" >/dev/null 2>&1 && no "[mutation] session-start with root = own folder still passes the probes" || ok "[mutation] the old rule in session-start turns the probes red"

# ================================================================ 3. plugin-move
# a legacy agent: what install.sh made before the plugin layout (every hook copied in, settings.json from the template), plus
# an owner's own hook and permission grant
legacy_agent(){ local d="$1"
  mkdir -p "$d"; ( cd "$KIT" && tar --exclude='./.git' --exclude='__pycache__' --exclude='*.pyc' --exclude='./scripts/fixtures' --exclude='./docs' \
      --exclude='./.releaseignore' --exclude='./bin' --exclude='./migrations' -cf - . ) | ( cd "$d" && tar -xf - )
  mkdir -p "$d/.claude" "$d/memory/briefs"; cp "$d/templates/dot-claude/settings.json" "$d/.claude/settings.json"
  printf '# Written by install.sh.\nversion=1.0.0\nkind=git-checkout\ninstalled=2026-10-01\n' > "$d/.talos-version"
  python3 "$d/scripts/render-default.py" --into "$d" >/dev/null
  printf '#!/usr/bin/env python3\nprint("{}")\n' > "$d/hooks/my-own.py"; printf '#!/bin/sh\necho mine\n' > "$d/scripts/my-tool.sh"
  python3 - "$d/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR/hooks/my-own.py\""}]})
s["permissions"]["allow"] = ["Bash(ls)"]
json.dump(s, open(p, "w"), indent=2)
PY
}
fresh_home h3; export TALOS_APP_HOME="$HOME/app"; mkdir -p "$TALOS_APP_HOME/last-good"
LA="$HOME/legacy"; legacy_agent "$LA"; V3="$TALOS_VENDOR_DIR/kit"
python3 "$KIT/scripts/plugin-release.py" build --vendor "$V3" --activate >/dev/null 2>&1 && ok "plugin-release.py builds a release and activates it" || no "plugin-release.py build failed"
REL3="$(vendor_release "$V3")"
cp -p "$LA/.claude/settings.json" "$SB/settings.orig"; H_HOOKS="$(hash_tree "$LA/hooks")"; H_SCRIPTS="$(hash_tree "$LA/scripts")"; H_DATA="$(cd "$LA" && hash_data memory wiki .learnings)"
ID="$(ls "$REL3/migrations" | sed -n 's/\.sh$//p' | tail -1)"
out="$(cd "$LA" && python3 "$REL3/scripts/talos-migrate.py" up --agent "$LA" 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "talos-migrate up runs plugin-move" || no "up exited $rc" "$out"
python3 - "$LA" "$V3" "$ID" <<'PY' && ok "after up: marketplace and enabledPlugins added, the kit's hook entries untouched, the owner's hook points at custom/hooks/ (and finds _talos_common), permissions kept" || no "settings.json after up is wrong"
import json, os, sys
a, v, i = sys.argv[1:4]
s = json.load(open(os.path.join(a, ".claude/settings.json")))
assert s["extraKnownMarketplaces"]["talos-local"]["source"] == {"source": "directory", "path": v}
assert s["enabledPlugins"]["talos@talos-local"] is True and s["permissions"]["allow"] == ["Bash(ls)"] and "statusLine" in s
cmds = [h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"]]
t = json.load(open(os.path.join(a, "templates/dot-claude/settings.json")))
tc = [h["command"] for es in t["hooks"].values() for e in es for h in e["hooks"]]
assert [c for c in cmds if "custom/hooks" not in c] == tc, "the kit's hook entries changed"
mine = [c for c in cmds if "custom/hooks" in c]
assert len(mine) == 1 and mine[0].endswith('python3 "$CLAUDE_PROJECT_DIR/custom/hooks/my-own.py"') and "PYTHONPATH" in mine[0], mine
assert os.path.isfile(os.path.join(a, "custom/hooks/my-own.py")) and os.path.isfile(os.path.join(a, "custom/scripts/my-tool.sh"))
for d in ("hooks", "scripts"):
    assert os.readlink(os.path.join(a, d)) == v + "/current/talos-kit/" + d and os.path.isdir(os.path.join(a, ".talos-pre-plugin", d))
assert open(os.path.join(a, ".talos-version")).read().count("migration=" + i) == 1
PY
{ cmp -s "$LA/.claude/settings.json.bak-$ID" "$SB/settings.orig" && printf '%s' "$out" | grep -q "touches .claude/settings.json (outside the Talos zone)"; } \
  && ok "the one touch outside the zone (settings.json) keeps a .bak with the original bytes and prints a line" || no "no .bak or no line for settings.json" "$out"
LG="$(ls "$TALOS_APP_HOME/last-good" | head -1)"
{ [ -n "$LG" ] && cmp -s "$TALOS_APP_HOME/last-good/$LG/.claude/settings.json" "$SB/settings.orig" && grep -q "\"agent_dir\": \"$LA\"" "$TALOS_APP_HOME/last-good/$LG/meta.json"; } \
  && ok "the settings were saved in the restore-last-good store first (original bytes, agent folder recorded)" || no "last-good store not written" "$(ls -R "$TALOS_APP_HOME" | head)"
if [ -f "$KIT/../apps/bridge/src/cli.ts" ] && command -v bun >/dev/null 2>&1 && [ -d "$KIT/../node_modules" ]; then
  lst="$(cd "$KIT/.." && TALOS_APP_HOME="$TALOS_APP_HOME" bun run apps/bridge/src/cli.ts restore-last-good --list --agent-dir "$LA" 2>&1)"
  printf '%s' "$lst" | grep -q "from $LA" && printf '%s' "$lst" | grep -q '\.claude/settings\.json' && ok "talos-app restore-last-good --list reads the version plugin-move saved (same format as the bridge's own saves)" || no "the bridge does not list the saved version" "$lst"
else echo "  skip restore-last-good compatibility (needs the repo's bridge, bun and node_modules)"; fi
H_AFTER_UP="$(hash_tree "$LA" 2>/dev/null)"
out="$(cd "$LA" && python3 "$LA/scripts/talos-migrate.py" up --agent "$LA" 2>&1)"
{ printf '%s' "$out" | grep -q 'nothing to do' && [ "$(hash_tree "$LA")" = "$H_AFTER_UP" ]; } && ok "up twice: the second run is a no-op (the whole agent folder is byte for byte the same)" || no "second up changed something" "$out"
out="$(TALOS_AGENT="$LA" TALOS_RELEASE="$REL3" TALOS_KIT_HOME="$V3" TALOS_MIGRATION_ID="$ID" TALOS_DIRECTION=up bash -c 'set -euo pipefail; source "$TALOS_RELEASE/migrations/'"$ID"'.sh"; up' 2>&1)"
{ [ "$(hash_tree "$LA")" = "$H_AFTER_UP" ]; } && ok "up() itself is idempotent: run again directly it changes nothing" || no "a direct second up() changed the agent folder" "$out"
out="$(cd "$LA" && python3 "$LA/scripts/talos-migrate.py" down --agent "$LA" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && cmp -s "$LA/.claude/settings.json" "$SB/settings.orig" && [ "$(hash_tree "$LA/hooks")" = "$H_HOOKS" ] && [ "$(hash_tree "$LA/scripts")" = "$H_SCRIPTS" ] \
  && [ ! -L "$LA/hooks" ] && [ ! -L "$LA/scripts" ] && [ ! -e "$LA/.talos-pre-plugin" ]; } \
  && ok "up then down: settings.json, hooks/ and scripts/ are byte for byte what they were (modes too); no link or .talos-pre-plugin left" || no "down did not restore exactly (rc=$rc)" "$out"
{ [ -z "$(marker "$LA" migration)" ] && [ "$(cd "$LA" && hash_data memory wiki .learnings)" = "$H_DATA" ]; } && ok "down puts migration= back to empty and leaves memory/, wiki/, .learnings/ untouched (content and modification times)" || no "marker or data changed by up/down"
{ [ -f "$LA/custom/hooks/my-own.py" ] && printf '%s' "$out" | grep -q 'custom/ was left'; } && ok "down keeps the owner's custom/ copies (nothing outside the zone is deleted) and says so" || no "custom/ handling wrong" "$out"
# again, then the owner edits settings.json after the move: down undoes only Talos's own changes
python3 "$LA/scripts/talos-migrate.py" up --agent "$LA" >/dev/null 2>&1
python3 - "$LA/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p)); s["model"] = "custom-model"; s["permissions"]["allow"].append("Bash(pwd)"); json.dump(s, open(p, "w"), indent=2)
PY
python3 "$LA/scripts/talos-migrate.py" down --agent "$LA" >/dev/null 2>&1
python3 - "$LA/.claude/settings.json" "$SB/settings.orig" <<'PY' && ok "down after the owner edited settings.json: the edits stay, the kit's hooks come back, the plugin keys go" || no "semantic down wrong"
import json, sys
now, orig = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
assert now["model"] == "custom-model" and now["permissions"]["allow"] == ["Bash(ls)", "Bash(pwd)"]
assert "extraKnownMarketplaces" not in now and "enabledPlugins" not in now
assert now["hooks"] == orig["hooks"], "hooks differ"
PY
ls "$LA/.claude" | grep -q 'bak-.*-down' && ok "down keeps a .bak of the settings.json it replaced" || no "no -down .bak"
# no last-good store: the .bak is the saved copy, and the output says so
fresh_home h3b; LB="$HOME/legacy"; legacy_agent "$LB"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$TALOS_VENDOR_DIR/kit" --activate >/dev/null 2>&1
out="$(cd "$LB" && python3 "$(vendor_release "$TALOS_VENDOR_DIR/kit")/scripts/talos-migrate.py" up --agent "$LB" 2>&1)"
{ printf '%s' "$out" | grep -q 'restore-last-good store is not reachable' && ls "$LB/.claude" | grep -q "settings.json.bak-$ID"; } && ok "without a restore-last-good store the .bak next to settings.json is the saved copy, and plugin-move says so" || no "no-store path wrong" "$out"

# the old upgrade path must not write through the links into the shared release
out="$(bash "$KIT/scripts/upgrade.sh" --into "$A" --dry-run 2>&1)"; rc=$?
{ [ "$rc" = 2 ] && printf '%s' "$out" | grep -q 'link into a Talos plugin release'; } && ok "upgrade.sh refuses an agent whose hooks/ and scripts/ are links into a release (it would write into the shared release)" || no "upgrade.sh did not refuse (rc=$rc)" "$out"
python3 "$KIT/scripts/settings-merge.py" --agent-dir "$A" 2>&1 | grep -q 'is already registered' && ok "settings-merge.py works on a plugin agent as on any other: its settings.json registers the hooks, so it finds nothing to add" || no "settings-merge.py output for a plugin agent" "$(python3 "$KIT/scripts/settings-merge.py" --agent-dir "$A" 2>&1 | head -4)"

# the runner checks the zone rule and the contract (and these checks fail when the runner is broken: see the mutations below)
fresh_home h3c; python3 "$KIT/scripts/plugin-release.py" build --vendor "$TALOS_VENDOR_DIR/kit" --activate >/dev/null 2>&1
R2="$SB/r2/talos-kit"; rm -rf "$SB/r2"; mkdir -p "$SB/r2"; cp -R "$(vendor_release "$TALOS_VENDOR_DIR/kit")" "$R2"; chmod -R u+w "$SB/r2"
mini(){ rm -rf "$HOME/mini"; mkdir -p "$HOME/mini/memory" "$HOME/mini/wiki"; echo state > "$HOME/mini/memory/STATE.md"; echo "# me" > "$HOME/mini/CLAUDE.md"; printf 'version=1\nmigration=%s\n' "$ID" > "$HOME/mini/.talos-version"; }
newmig(){ printf '#!/usr/bin/env bash\n%s\n' "$2" > "$R2/migrations/$1.sh"; }
runmig(){ out="$(python3 "$R2/scripts/talos-migrate.py" up --agent "$HOME/mini" --release "$R2" 2>&1)"; rc=$?; }
mini; newmig 202612010000-touch-data 'up() { echo more >> "$TALOS_AGENT/memory/STATE.md"; }
down() { :; }'
runmig; { [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'BROKEN RULE.*memory/STATE.md' && [ "$(marker "$HOME/mini" migration)" = "$ID" ]; } && ok "a migration that writes into memory/ is stopped and .talos-version is not advanced" || no "memory/ write not caught (rc=$rc)" "$out"
rm -f "$R2"/migrations/2026120*; mini; newmig 202612010001-no-bak 'up() { echo more >> "$TALOS_AGENT/CLAUDE.md"; }
down() { :; }'
runmig; { [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'BROKEN RULE.*CLAUDE.md.*without a matching' && [ "$(marker "$HOME/mini" migration)" = "$ID" ]; } && ok "a change outside the zone with no .bak is stopped" || no "missing .bak not caught (rc=$rc)" "$out"
rm -f "$R2"/migrations/2026120*; mini; newmig 202612010002-with-bak 'up() { cp -p "$TALOS_AGENT/CLAUDE.md" "$TALOS_AGENT/CLAUDE.md.bak-$TALOS_MIGRATION_ID"; echo "migrate: $TALOS_MIGRATION_ID touches CLAUDE.md"; echo more >> "$TALOS_AGENT/CLAUDE.md"; }
down() { :; }'
runmig; { [ "$rc" = 0 ] && [ "$(marker "$HOME/mini" migration)" = "202612010002-with-bak" ]; } && ok "the same change with its .bak is accepted and the marker moves to the new id" || no "a proper migration was refused (rc=$rc)" "$out"
rm -f "$R2"/migrations/2026120*; mini; newmig 202612010003-no-down 'up() { :; }'
runmig; { [ "$rc" = 2 ] && printf '%s' "$out" | grep -q 'neither down() nor'; } && ok "a migration with neither down() nor '# down: none (reason)' breaks the contract and is not run" || no "contract not enforced (rc=$rc)" "$out"
rm -f "$R2"/migrations/2026120*; mini; newmig 202612010004-no-down-ok '# down: none (it only prints)
up() { echo hello; }'
runmig; [ "$rc" = 0 ] && ok "'# down: none (reason)' satisfies the contract" || no "down: none refused" "$out"
rm -f "$R2"/migrations/2026120*; python3 "$R2/scripts/talos-migrate.py" check --release "$R2" >/dev/null 2>&1 && ok "every migration the release ships keeps the contract (talos-migrate check)" || no "a shipped migration breaks the contract"
sed -i.orig 's/    if bad:$/    if False:/' "$R2/scripts/talos-migrate.py"; rm -f "$R2/scripts/talos-migrate.py.orig"; mini; newmig 202612010000-touch-data 'up() { echo more >> "$TALOS_AGENT/memory/STATE.md"; }
down() { :; }'
runmig; [ "$rc" = 0 ] && ok "[mutation] with the runner's zone check switched off, the memory/ write goes through, so the check above really guards it" || no "[mutation] the zone-check test cannot fail" "$out"

# 6 (install half). the plugin steps wrote nothing into the data folders: an agent installed the old way (tar copy + render) has the same ones
fresh_home h6; OLDAGENT="$HOME/old"; legacy_agent "$OLDAGENT"
{ [ "$(cd "$OLDAGENT" && hash_tree memory wiki .learnings)" != "" ] && [ "$FRESH_DATA" = "$(cd "$OLDAGENT" && hash_tree memory wiki .learnings)" ]; } \
  && ok "memory/, wiki/ and .learnings/ of a fresh plugin install equal the data-only copy byte for byte (the plugin steps added nothing to them)" || no "install changed the data folders" "$FRESH_DATA vs $(cd "$OLDAGENT" && hash_tree memory wiki .learnings)"

# ================================================================ 7. review fixes (each check below failed before its fix)
# R1-3. no --agent and no agent folder around: refuse, change nothing (never fall back to the working directory)
fresh_home h7; V7="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7" --activate >/dev/null 2>&1; REL7="$(vendor_release "$V7")"
mkdir -p "$HOME/work/sub"; echo keep > "$HOME/work/note.txt"; H7="$(hash_tree "$HOME")"; bad7=""
for c in up down status; do
  for w in "$HOME" "$HOME/work/sub"; do
    out="$(cd "$w" && python3 "$REL7/scripts/talos-migrate.py" $c 2>&1)"; rc=$?
    { [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'not an agent folder; pass --agent'; } || bad7="$bad7 $c@$w(rc=$rc)"
  done
done
{ [ -z "$bad7" ] && [ "$(hash_tree "$HOME")" = "$H7" ] && [ ! -e "$HOME/.talos-version" ] && [ ! -e "$HOME/.claude" ]; } && ok "talos-migrate up/down/status with no --agent and no .talos-version around (cwd = HOME or below it) refuses with 'not an agent folder; pass --agent' and changes nothing" || no "talos-migrate fell back to the working directory ($bad7)" "$out"

# R2-7. run from a kit source checkout (no .talos-version in it) without --agent: refuse, even with cwd = the checkout
H7k="$(hash_tree "$KIT")"; bad7=""
for c in up down status; do
  out="$(cd "$KIT" && env -u CLAUDE_PROJECT_DIR python3 "$KIT/scripts/talos-migrate.py" $c 2>&1)"; rc=$?
  { [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'not an agent folder; pass --agent'; } || bad7="$bad7 $c(rc=$rc)"
done
{ [ -z "$bad7" ] && [ "$(hash_tree "$KIT")" = "$H7k" ]; } && ok "talos-migrate up/down/status run from a kit source checkout with no --agent refuses 'not an agent folder; pass --agent' and changes nothing in the checkout" || no "talos-migrate treated a kit source checkout as an agent ($bad7)" "$out"

# R2-3. the gazetteer keys its state folder on the resolved agent path, like the hooks (macOS: /var is a link to /private/var)
fresh_home h7g; mkdir -p "$HOME/real/hooks" "$HOME/real/scripts" "$HOME/real/wiki"; ln -s real "$HOME/via"
cp "$KIT"/hooks/*.py "$HOME/real/hooks/"; cp "$KIT/scripts/wiki-gazetteer.py" "$HOME/real/scripts/"        # no _agent_root.py beside it: the fallback path
export XDG_STATE_HOME="$HOME/st"; GZ_OUT="$(cd "$HOME/via" && python3 "$HOME/via/scripts/wiki-gazetteer.py" 2>&1)"
GZ_WANT="$(cd "$HOME/real" && python3 -c 'import sys; sys.path.insert(0,"hooks"); import _talos_common as C; print(C.state_dir())')"
unset XDG_STATE_HOME
{ [ -f "$GZ_WANT/gazetteer.json" ] && [ "$(ls "$HOME/st/talos" | wc -l | tr -d ' ')" = 1 ]; } && ok "wiki-gazetteer reached through a symlinked agent path writes to the same state folder the hooks use" || no "the gazetteer used a different state folder than the hooks ($(ls "$HOME/st/talos" 2>&1 | tr '\n' ' ') vs $GZ_WANT)" "$GZ_OUT"

# a legacy agent with owner hooks written in every spelling, plus files the kit does not ship (nested, dot files)
legacy_agent2(){ local d="$1"; legacy_agent "$d"
  local real; real="$(cd "$d" && pwd -P)"
  mkdir -p "$d/hooks/sub"
  for n in own-a own-b own-c own-d own-e own-f own-g; do printf '#!/usr/bin/env python3\nimport _talos_common as C\nprint(C.ROOT)\n' > "$d/hooks/$n.py"; done
  printf '#!/usr/bin/env python3\nimport _talos_common as C\nprint(C.ROOT)\n' > "$d/hooks/sub/own-h.py"
  mkdir -p "$d/hooks/lib" "$d/scripts/tools/deep" "$d/scripts/memory"
  echo 'x = 1' > "$d/hooks/lib/helper.py"; echo 'k=v' > "$d/hooks/.local-conf"; echo 'echo deep' > "$d/scripts/tools/deep/x.sh"
  echo 'print(1)' > "$d/scripts/memory/my-extra.py"; echo '# my edit' >> "$d/scripts/wiki-lint.py"
  python3 - "$d/.claude/settings.json" "$real" <<'PY'
import json, os, sys
p, real = sys.argv[1:3]; s = json.load(open(p)); rel = os.path.relpath(real, os.path.realpath(os.path.expanduser("~")))
for c in ('python3 "$CLAUDE_PROJECT_DIR"/hooks/own-a.py', 'python3 ${CLAUDE_PROJECT_DIR}/hooks/own-b.py', 'python3 hooks/own-c.py',
          'python3 %s/hooks/own-d.py' % real, 'python3 ./hooks/own-e.py', 'python3 ~/%s/hooks/own-f.py' % rel,
          'python3 $HOME/%s/hooks/own-g.py' % rel, 'python3 hooks/sub/own-h.py', 'python3 %s/hooks/agent-log.py' % real):
    s["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": c}]})
json.dump(s, open(p, "w"), indent=2)
PY
}

# R1-5 + R1-13. owner hooks in every spelling follow to custom/hooks and still find _talos_common; kit hooks by absolute path stay;
# every file only the owner had is copied (nested, dot files) or named in a printed line
fresh_home h7c; export TALOS_APP_HOME="$HOME/app"; LC="$HOME/legacy"; legacy_agent2 "$LC"; V7c="$TALOS_VENDOR_DIR/kit"
python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7c" --activate >/dev/null 2>&1; REL7c="$(vendor_release "$V7c")"
cp -p "$LC/.claude/settings.json" "$SB/settings.7c"; H_HOOKS7="$(hash_tree "$LC/hooks")"; H_SCRIPTS7="$(hash_tree "$LC/scripts")"
LCREAL="$(cd "$LC" && pwd -P)"
out="$(python3 "$REL7c/scripts/talos-migrate.py" up --agent "$LC" 2>&1)"; rc=$?; ID7="$(ls "$REL7c/migrations" | sed -n 's/\.sh$//p' | tail -1)"
[ "$rc" = 0 ] && ok "up on an agent with owner hooks in four spellings and extra nested/dot files succeeds" || no "up exited $rc" "$out"
python3 - "$LC" "$LCREAL" <<'PY' && ok "owner hooks written as \"\$CLAUDE_PROJECT_DIR\"/hooks/x, \${CLAUDE_PROJECT_DIR}/hooks/x, relative hooks/x and <agent>/hooks/x all point at custom/hooks now; the kit's hook by absolute path is left alone" || no "owner hook commands were not all moved"
import json, os, sys
a, real = sys.argv[1:3]
s = json.load(open(os.path.join(a, ".claude/settings.json")))
cmds = [h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"]]
for n in ("own-a", "own-b", "own-c", "own-d", "own-e", "own-f", "own-g", "sub/own-h"):
    c = [x for x in cmds if n + ".py" in x]
    assert len(c) == 1 and "custom/hooks/" + n + ".py" in c[0] and not __import__("re").search(r"(?<!custom/)hooks/" + n, c[0]), c
assert "python3 %s/hooks/agent-log.py" % real in cmds, "the kit hook by absolute path was changed"
PY
bad7=""
for n in own-a own-b own-c own-d own-e own-f own-g sub/own-h; do
  c="$(python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); print([h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"] if sys.argv[2] in h["command"]][0])' "$LC/.claude/settings.json" "$n.py")"
  got="$(cd "$LC" && env -u PYTHONPATH CLAUDE_PROJECT_DIR="$LC" sh -c "$c" 2>&1)"; [ "$got" = "$LCREAL" ] || bad7="$bad7 $n[$got]"
done
[ -z "$bad7" ] && ok "each moved owner hook runs from custom/hooks and still imports _talos_common (it prints the agent folder)" || no "an owner hook cannot find _talos_common or the agent" "$bad7"
python3 - "$LC" "$out" <<'PY' && ok "every owner file that exists only in the old hooks/ or scripts/ (nested folders, dot files, files inside folders the kit ships) is copied to custom/ or named in a printed line" || no "an owner file was left only in .talos-pre-plugin without a line"
import os, sys
a, out = sys.argv[1:3]
want = ["hooks/lib/helper.py", "hooks/.local-conf", "scripts/tools/deep/x.sh", "scripts/memory/my-extra.py"]
for w in want:
    assert os.path.isfile(os.path.join(a, "custom", w)), "not copied: " + w
rel = os.path.realpath(os.path.join(a, "hooks"))
rel = os.path.dirname(rel)
for d in ("hooks", "scripts"):
    for dp, dn, fn in os.walk(os.path.join(a, ".talos-pre-plugin", d)):
        dn[:] = [x for x in dn if x != "__pycache__"]
        for n in fn:
            p = os.path.join(dp, n); r = os.path.relpath(p, os.path.join(a, ".talos-pre-plugin"))
            same = os.path.isfile(os.path.join(rel, r)) and open(os.path.join(rel, r), "rb").read() == open(p, "rb").read()
            if same or os.path.exists(os.path.join(a, "custom", r)): continue
            assert r in out, "left only in .talos-pre-plugin with no line: " + r
PY
out2="$(python3 "$REL7c/scripts/talos-migrate.py" down --agent "$LC" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && cmp -s "$LC/.claude/settings.json" "$SB/settings.7c" && [ "$(hash_tree "$LC/hooks")" = "$H_HOOKS7" ] && [ "$(hash_tree "$LC/scripts")" = "$H_SCRIPTS7" ]; } && ok "down after all of that: settings.json, hooks/ and scripts/ are byte for byte what they were" || no "down did not restore (rc=$rc)" "$out2"

# R1-4. plugin-move.json is written once, before the settings change; a second up (through a symlinked TALOS_KIT_HOME) does not replace it
fresh_home h7d; LD="$HOME/legacy"; legacy_agent "$LD"; V7d="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7d" --activate >/dev/null 2>&1; REL7d="$(vendor_release "$V7d")"
cp -p "$LD/.claude/settings.json" "$SB/settings.7d"
python3 "$REL7d/scripts/talos-migrate.py" up --agent "$LD" >/dev/null 2>&1; ln -s "$V7d" "$HOME/vlink"
REC1="$(cat "$LD/.talos-pre-plugin/plugin-move.json")"; S1="$(cat "$LD/.claude/settings.json")"
out="$(TALOS_AGENT="$LD" TALOS_RELEASE="$REL7d" TALOS_KIT_HOME="$HOME/vlink" TALOS_MIGRATION_ID="$ID7" TALOS_DIRECTION=up bash -c 'set -euo pipefail; source "$TALOS_RELEASE/migrations/'"$ID7"'.sh"; up' 2>&1)"
{ [ "$(cat "$LD/.talos-pre-plugin/plugin-move.json")" = "$REC1" ] && [ "$(cat "$LD/.claude/settings.json")" = "$S1" ]; } && ok "up again through a symlinked TALOS_KIT_HOME changes neither plugin-move.json nor settings.json" || no "a second up replaced the record or rewrote settings.json" "$out"
out="$(python3 "$REL7d/scripts/talos-migrate.py" down --agent "$LD" 2>&1)"
cmp -s "$LD/.claude/settings.json" "$SB/settings.7d" && ok "up, up again, down: settings.json is back to its original bytes" || no "down after a second up did not restore the original settings.json" "$out"
# a crash between the two writes (record first, then settings), then a re-run, then down
fresh_home h7e; LE="$HOME/legacy"; legacy_agent "$LE"; V7e="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7e" --activate >/dev/null 2>&1; REL7e="$(vendor_release "$V7e")"
cp -p "$LE/.claude/settings.json" "$SB/settings.7e"
python3 - "$REL7e/scripts/plugin-settings.py" "$LE" "$REL7e" "$V7e" "$ID7" <<'PY'
import argparse, importlib.util, sys
path, agent, rel, vendor, mig = sys.argv[1:6]
spec = importlib.util.spec_from_file_location("ps", path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
n = [0]; real = m.write_atomic
def boom(*a, **k):
    n[0] += 1
    if n[0] == 2:
        raise RuntimeError("crash between the record and the settings write")
    return real(*a, **k)
m.write_atomic = boom
try:
    m.cmd_to_plugin(argparse.Namespace(agent=agent, release=rel, kit_home=vendor, migration=mig))
except RuntimeError:
    pass
PY
python3 "$REL7e/scripts/talos-migrate.py" up --agent "$LE" >/dev/null 2>&1; rc=$?
out="$(python3 "$REL7e/scripts/talos-migrate.py" down --agent "$LE" 2>&1)"
{ [ "$rc" = 0 ] && cmp -s "$LE/.claude/settings.json" "$SB/settings.7e"; } && ok "a crash between the two writes, a re-run of up, then down: settings.json is back to its original bytes" || no "crash-then-rerun lost the original settings.json (up rc=$rc)" "$out"

# R1-6. down is crash-safe and re-runnable
fresh_home h7f; export TALOS_APP_HOME="$HOME/app"; LF="$HOME/legacy"; legacy_agent "$LF"; V7f="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7f" --activate >/dev/null 2>&1; REL7f="$(vendor_release "$V7f")"
cp -p "$LF/.claude/settings.json" "$SB/settings.7f"; HH="$(hash_tree "$LF/hooks")"; HS="$(hash_tree "$LF/scripts")"
down7(){ python3 "$REL7f/scripts/talos-migrate.py" down --agent "$LF" 2>&1; }
python3 "$REL7f/scripts/talos-migrate.py" up --agent "$LF" >/dev/null 2>&1
rm "$LF/hooks"; mv "$LF/.talos-pre-plugin/scripts" "$LF/scripts.tmp-restore"        # a crash: hooks/ link gone, scripts/ half swapped
out="$(down7)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(hash_tree "$LF/hooks")" = "$HH" ] && [ "$(hash_tree "$LF/scripts")" = "$HS" ] && [ ! -L "$LF/hooks" ] && [ ! -L "$LF/scripts" ] && cmp -s "$LF/.claude/settings.json" "$SB/settings.7f" && [ -z "$(marker "$LF" migration)" ]; } \
  && ok "down re-run after a crash (hooks/ link removed before the saved folder came back; scripts/ half swapped) finishes: both folders byte for byte, settings restored, marker cleared" || no "down is not re-runnable after a crash (rc=$rc)" "$out"
python3 "$REL7f/scripts/talos-migrate.py" up --agent "$LF" >/dev/null 2>&1; rm -rf "$LF/.talos-pre-plugin/hooks"; rm "$LF/hooks"
out="$(down7)"; rc=$?
{ [ "$rc" != 0 ] && [ -n "$(marker "$LF" migration)" ] && printf '%s' "$out" | grep -q 'hooks/'; } && ok "down refuses to clear the marker when hooks/ cannot be put back (saved folder gone), and says which" || no "down cleared the marker with hooks/ missing (rc=$rc)" "$out"

# R1-7. down on a fresh plugin install (nothing was moved) refuses plainly and keeps the marker
fresh_home h7g; LG="$HOME/agent"; bash "$KIT/install.sh" --agent-dir "$LG" --no-chronos >/dev/null 2>&1
HG="$(hash_tree "$LG/.claude" "$LG/hooks" "$LG/scripts")"; MG="$(marker "$LG" migration)"
out="$(python3 "$LG/scripts/talos-migrate.py" down --agent "$LG" 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ "$(marker "$LG" migration)" = "$MG" ] && [ -n "$MG" ] && [ -L "$LG/hooks" ] && [ "$(hash_tree "$LG/.claude" "$LG/hooks" "$LG/scripts")" = "$HG" ] \
  && printf '%s' "$out" | grep -q 'installed on the plugin layout' && ! printf '%s' "$out" | grep -q 'back to the layout with hooks/'; } \
  && ok "down on a fresh plugin install refuses with a plain line, keeps the marker, claims no success, changes nothing" || no "down on a fresh install did something or claimed success (rc=$rc)" "$out"

# R1-8. live writes (a running session's .learnings, logs, stamps) are not a broken rule; a real one says the marker was not advanced and how to recover
fresh_home h7h; V7h="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7h" --activate >/dev/null 2>&1
R7h="$SB/r7h/talos-kit"; rm -rf "$SB/r7h"; mkdir -p "$SB/r7h"; cp -R "$(vendor_release "$V7h")" "$R7h"; chmod -R u+w "$SB/r7h"
mini7(){ rm -rf "$HOME/mini"; mkdir -p "$HOME/mini/memory" "$HOME/mini/.learnings" "$HOME/mini/logs"; echo state > "$HOME/mini/memory/STATE.md"; echo "# me" > "$HOME/mini/CLAUDE.md"; printf 'version=1\nmigration=%s\n' "$ID7" > "$HOME/mini/.talos-version"; }
mini7; printf '#!/usr/bin/env bash\nup() { echo "$(date) live" >> "$TALOS_AGENT/.learnings/LEARNINGS.md"; echo x >> "$TALOS_AGENT/logs/run.log"; echo 1 > "$TALOS_AGENT/memory/.last-lint"; }\ndown() { :; }\n' > "$R7h/migrations/202612010000-live.sh"
out="$(python3 "$R7h/scripts/talos-migrate.py" up --agent "$HOME/mini" --release "$R7h" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(marker "$HOME/mini" migration)" = 202612010000-live ]; } && ok "a session writing .learnings/, a log and a memory stamp while a migration runs is not a broken rule" || no "live-write paths tripped the zone check (rc=$rc)" "$out"
rm -f "$R7h"/migrations/202612010000-live.sh; mini7; printf '#!/usr/bin/env bash\nup() { echo more >> "$TALOS_AGENT/CLAUDE.md"; }\ndown() { :; }\n' > "$R7h/migrations/202612010001-bad.sh"
out="$(python3 "$R7h/scripts/talos-migrate.py" up --agent "$HOME/mini" --release "$R7h" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && printf '%s' "$out" | grep -q 'BROKEN RULE' && printf '%s' "$out" | grep -qi 'marker was not advanced' && printf '%s' "$out" | grep -q 'talos-migrate up' && ! printf '%s' "$out" | grep -q 'Undo with: talos-migrate down'; } \
  && ok "a broken rule after a migration ran says the marker was not advanced and gives the recovery (not 'talos-migrate down')" || no "the broken-rule message is wrong (rc=$rc)" "$out"

# R1-14. snapshot() skips sockets/FIFOs and unreadable files, counts and prints them, never raises
mkdir -p "$SB/snap/agent"; echo ok > "$SB/snap/agent/a.txt"; echo no > "$SB/snap/agent/secret.txt"; mkfifo "$SB/snap/agent/pipe"
out="$(timeout 30 python3 - "$R7h/scripts/talos-migrate.py" "$SB/snap/agent" <<'PY' 2>&1
import builtins, importlib.util, sys
spec = importlib.util.spec_from_file_location("tm", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
real = builtins.open
def fake(p, *a, **k):
    if str(p).endswith("secret.txt"):
        raise PermissionError(13, "denied", p)
    return real(p, *a, **k)
builtins.open = fake
skipped = []
snap = m.snapshot(sys.argv[2], skipped)
assert set(snap) == {"a.txt"}, snap
assert sorted(skipped) == ["pipe", "secret.txt"], skipped
print("snapshot-ok")
PY
)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q snapshot-ok; } && ok "snapshot() skips a FIFO and an unreadable file (reported to the caller), neither hangs nor raises" || no "snapshot() raised or hung on a special/unreadable file (rc=$rc)" "$out"
mini7; mkfifo "$HOME/mini/pipe"; printf '#!/usr/bin/env bash\nup() { echo hi; }\ndown() { :; }\n' > "$R7h/migrations/202612010002-fine.sh"; rm -f "$R7h"/migrations/202612010001-bad.sh
out="$(timeout 60 python3 "$R7h/scripts/talos-migrate.py" up --agent "$HOME/mini" --release "$R7h" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && printf '%s' "$out" | grep -q '1 file(s) not checked' && printf '%s' "$out" | grep -q 'pipe'; } && ok "a migration run over an agent with a FIFO finishes and prints the skipped file" || no "the runner hung or did not name the skipped file (rc=$rc)" "$out"
rm -f "$R7h"/migrations/202612010002-fine.sh

# R1-10. a fresh install never moves a current link other agents use
fresh_home h7i; export TALOS_VENDOR_DIR="$HOME/.local/share/talos"; V7i="$TALOS_VENDOR_DIR/kit"
mkkit(){ rm -rf "$1"; mkdir -p "$1"; ( cd "$KIT" && tar --exclude='./.git' --exclude='__pycache__' -cf - . ) | ( cd "$1" && tar -xf - ); printf '%s\n' "$2" > "$1/VERSION"; }
mkkit "$SB/kit7a" 1.0.0-cur-a; mkkit "$SB/kit7b" 1.0.0-cur-b
bash "$SB/kit7a/install.sh" --agent-dir "$HOME/agentA" --no-chronos >/dev/null 2>&1
out="$(bash "$SB/kit7b/install.sh" --agent-dir "$HOME/agentB" --no-chronos 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(readlink "$V7i/current")" = releases/1.0.0-cur-a ] && [ -d "$V7i/releases/1.0.0-cur-b" ] && printf '%s' "$out" | grep -q 'another agent on this Mac uses release 1.0.0-cur-a' && [ -L "$HOME/agentB/hooks" ]; } \
  && ok "installing a second agent from another kit version leaves current on the first, says so, and still builds the new release" || no "a fresh install moved or ignored current (rc=$rc, current=$(readlink "$V7i/current"))" "$(printf '%s' "$out" | tail -4)"

# R2-1. the agent installed beside a current it did not move runs against THAT release: its settings.json comes from current's template
# and .talos-version names current's version. (kit 7c has one more guard in its template; the identical kits above cannot see this.)
mkkit "$SB/kit7c" 1.0.0-cur-c
python3 - "$SB/kit7c/templates/dot-claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["hooks"]["PreToolUse"].append({"matcher": "Bash", "hooks": [{"type": "command", "command": "python3 \"$CLAUDE_PROJECT_DIR\"/hooks/new-guard-from-c.py"}]})
json.dump(s, open(p, "w"), indent=2)
PY
out="$(bash "$SB/kit7c/install.sh" --agent-dir "$HOME/agentC" --no-chronos 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(readlink "$V7i/current")" = releases/1.0.0-cur-a ] && ! grep -q new-guard-from-c "$HOME/agentC/.claude/settings.json" \
  && cmp -s "$HOME/agentA/.claude/settings.json" "$HOME/agentC/.claude/settings.json" && grep -q '^version=1.0.0-cur-a$' "$HOME/agentC/.talos-version" \
  && ! grep -q 'cur-c' "$HOME/agentC/.talos-version"; } \
  && ok "an agent installed beside a current it did not move gets current's own settings.json template and version (not the newer kit's); it runs the release it follows" || no "the new kit's template or version was stamped onto an agent that follows an older release (rc=$rc)" "$(grep -c new-guard-from-c "$HOME/agentC/.claude/settings.json" 2>&1) / $(cat "$HOME/agentC/.talos-version" 2>&1 | tr '\n' ' ')"
printf '%s' "$out" | grep -q 'uses release 1.0.0-cur-a' && ok "and the install says which release the agent runs, and how to move all agents together" || no "the install did not say which release the agent runs" "$(printf '%s' "$out" | grep -i note)"

# R2-4. a dangling current (its release folder is gone) counts as absent: a fresh install repairs it
fresh_home h7k; V7k="$TALOS_VENDOR_DIR/kit"; mkdir -p "$V7k"; ln -s releases/gone "$V7k/current"
out="$(bash "$SB/kit7a/install.sh" --agent-dir "$HOME/agentD" --no-chronos 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(readlink "$V7k/current")" = releases/1.0.0-cur-a ] && [ -d "$V7k/current/talos-kit/hooks" ] && grep -q '^version=1.0.0-cur-a$' "$HOME/agentD/.talos-version" && [ -f "$HOME/agentD/hooks/session-start.py" ]; } \
  && ok "a current link pointing at a missing release is repaired by a fresh install (pointed at the new release), and the agent works" || no "a dangling current was kept (rc=$rc, current=$(readlink "$V7k/current"))" "$(printf '%s' "$out" | tail -4)"

# R1-11/12. CLAUDE_PROJECT_DIR naming a missing folder or a plugin release fails closed in the hooks, the way session-start does
fresh_home h7j; V7j="$TALOS_VENDOR_DIR/kit"; python3 "$KIT/scripts/plugin-release.py" build --vendor "$V7j" --activate >/dev/null 2>&1; R7j="$(vendor_release "$V7j")"
mkdir -p "$HOME/cwdagent/memory"; printf 'version=1\n' > "$HOME/cwdagent/.talos-version"; bad7=""
for bad in "$HOME/does-not-exist" "$R7j"; do
  out="$(cd "$HOME/cwdagent" && CLAUDE_PROJECT_DIR="$bad" TALOS_UNATTENDED=1 sh -c 'printf "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | python3 "$0/hooks/append-only-guard.py"' "$R7j" 2>&1)"; rc=$?
  [ "$rc" = 2 ] || bad7="$bad7 guard-unattended($bad):rc=$rc"
  out="$(cd "$HOME/cwdagent" && CLAUDE_PROJECT_DIR="$bad" sh -c 'printf "{\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}" | python3 "$0/hooks/append-only-guard.py"' "$R7j" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'not an agent folder'; } || bad7="$bad7 guard-attended($bad):rc=$rc"
  out="$(cd "$HOME/cwdagent" && CLAUDE_PROJECT_DIR="$bad" python3 -c 'import sys; sys.path.insert(0, sys.argv[1] + "/scripts"); import _agent_root; _agent_root.agent_root(sys.argv[1] + "/scripts/x.py")' "$R7j" 2>&1)"; rc=$?
  [ "$rc" != 0 ] && printf '%s' "$out" | grep -q 'not an agent folder' || bad7="$bad7 scripts($bad)"
done
[ -z "$bad7" ] && [ ! -d "$HOME/state" ] && ok "CLAUDE_PROJECT_DIR = a missing folder or a release: a guard blocks (exit 2) when unattended, refuses without acting otherwise, scripts/_agent_root.py refuses; nothing is written" || no "a bad CLAUDE_PROJECT_DIR was followed or allowed:$bad7" "$out"

# R1-11/12 (data scripts). watcher.py and wiki-gazetteer.py point _talos_common at the agent folder they computed
for s in watcher wiki-gazetteer; do
  grep -Eq "^ +C\.ROOT = (ROOT|REPO)( |$)" "$KIT/scripts/$s.py" && ok "$s.py sets C.ROOT from the agent folder it computed" || no "$s.py leaves C.ROOT at the hooks module's own guess"
done

# ================================================================ 4. current: swap it and the plugin path follows
fresh_home h4; V4="$TALOS_VENDOR_DIR/kit"
mkkit(){ # $1 = folder, $2 = version: a copy of the kit whose release carries a probe hook that records which release ran
  rm -rf "$1"; mkdir -p "$1"; ( cd "$KIT" && tar --exclude='./.git' --exclude='__pycache__' -cf - . ) | ( cd "$1" && tar -xf - ); printf '%s\n' "$2" > "$1/VERSION"
  printf '%s\n' '{"hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": "cat \"${CLAUDE_PLUGIN_ROOT}/VERSION\" > \"$PWD/.probe-version\""}]}]}}' > "$1/hooks/hooks.json"
}
mkkit "$SB/kitA" 1.0.0-probe-a; mkkit "$SB/kitB" 1.0.0-probe-b; : > "$SB/kitB/scripts/MARKER-B"
python3 "$KIT/scripts/plugin-release.py" build --source "$SB/kitA" --vendor "$V4" --activate >/dev/null 2>&1; python3 "$KIT/scripts/plugin-release.py" build --source "$SB/kitB" --vendor "$V4" >/dev/null 2>&1
M_BEFORE="$(cat "$V4/.claude-plugin/marketplace.json")"; PA="$(cd "$V4/current/talos-kit" && pwd -P)"
mkdir -p "$HOME/agent4"; ln -s "$V4/current/talos-kit/scripts" "$HOME/agent4/scripts"
{ [ "$(readlink "$V4/current")" = releases/1.0.0-probe-a ] && [ ! -e "$HOME/agent4/scripts/MARKER-B" ] && case "$PA" in */releases/1.0.0-probe-a/talos-kit) true ;; *) false ;; esac; } && ok "current -> release A: the marketplace source ./current/talos-kit resolves to A, and an agent's scripts/ link shows A" || no "A not resolved" "$PA"
python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V4" --version 1.0.0-probe-b >/dev/null 2>&1; PB="$(cd "$V4/current/talos-kit" && pwd -P)"
{ case "$PB" in */releases/1.0.0-probe-b/talos-kit) true ;; *) false ;; esac; [ -e "$HOME/agent4/scripts/MARKER-B" ] && [ "$(cat "$V4/.claude-plugin/marketplace.json")" = "$M_BEFORE" ] && [ -f "$PB/hooks/hooks.json" ]; } \
  && ok "swap current to release B: the plugin root and the agent's scripts/ link follow; marketplace.json is untouched" || no "B not followed" "$PB"
python3 "$KIT/scripts/plugin-release.py" build --source "$SB/kitB" --vendor "$V4" >/dev/null 2>&1 && ok "building the same release again (same content) is a no-op" || no "rebuild of an identical release failed"
printf 'changed\n' >> "$SB/kitB/hooks/agent-log.py"; python3 "$KIT/scripts/plugin-release.py" build --source "$SB/kitB" --vendor "$V4" >/dev/null 2>&1 && no "a release was overwritten with different content" || ok "a release is immutable: the same version with different content is refused"
CLAUDE="$(command -v claude || true)"
if [ -n "$CLAUDE" ]; then
  # The real thing: a session in an agent folder whose settings.json names the vendor as a local-folder marketplace. Claude Code
  # loads a relative-path plugin of such a marketplace in place, through the `current` symlink. A dead API address is fine: the
  # SessionStart hooks run before any request, and the probe hook records which release ran.
  p4(){ # $1 = HOME for this run; the project (an agent folder) lives in it
    mkdir -p "$1/proj/.claude"
    python3 - "$1" "$V4" <<'PY'
import json, os, sys
home, vendor = sys.argv[1:3]; proj = home + "/proj"
json.dump({"extraKnownMarketplaces": {"talos-local": {"source": {"source": "directory", "path": vendor}}}, "enabledPlugins": {"talos@talos-local": True}},
          open(proj + "/.claude/settings.json", "w"))
open(proj + "/.talos-version", "w").write("version=1\n")
json.dump({"hasCompletedOnboarding": True, "projects": {proj: {"hasTrustDialogAccepted": True}}}, open(home + "/.claude.json", "w"))
PY
  }
  run_claude(){ # $1 = HOME, $2 = debug log: start a session, wait for the probe file, stop it
    rm -f "$1/proj/.probe-version"
    ( cd "$1/proj" && HOME="$1" XDG_STATE_HOME="$1/state" ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://127.0.0.1:9 PATH="$ORIGPATH" \
        timeout 60 claude -p hi --debug-file "$2" </dev/null >/dev/null 2>&1 ) &
    local pid=$! i=0
    while [ $i -lt "${CL_WAIT:-100}" ] && [ ! -s "$1/proj/.probe-version" ]; do sleep 0.5; i=$((i+1)); done
    sleep 1; pkill -P $pid 2>/dev/null; kill $pid 2>/dev/null; wait $pid 2>/dev/null
  }
  H4="$SB/claude4"; mkdir -p "$H4"; p4 "$H4"
  python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V4" --version 1.0.0-probe-a >/dev/null 2>&1; run_claude "$H4" "$SB/dbg-a.log"
  VA="$(cat "$H4/proj/.probe-version" 2>/dev/null)"
  python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V4" --version 1.0.0-probe-b >/dev/null 2>&1; run_claude "$H4" "$SB/dbg-b.log"
  VB="$(cat "$H4/proj/.probe-version" 2>/dev/null)"
  { [ "$VA" = 1.0.0-probe-a ] && [ "$VB" = 1.0.0-probe-b ]; } \
    && ok "[claude] a real session loads the plugin through the marketplace and current: its SessionStart hook ran from release A, then from B after the swap" || no "[claude] the session did not follow current (A='$VA' B='$VB')" "$(grep -iE 'talos|plugin' "$SB/dbg-b.log" 2>/dev/null | head -5)"
  grep -q "talos-kit/hooks/hooks.json" "$SB/dbg-b.log" && grep -q "/current/talos-kit" "$SB/dbg-b.log" && ok "[claude] its debug log shows the plugin read in place through .../current/talos-kit (not a copy in ~/.claude/plugins/cache)" || no "[claude] plugin not read in place" "$(grep -i 'hooks.json' "$SB/dbg-b.log" | head -3)"
  [ ! -d "$H4/.claude/plugins/cache/talos-local" ] && ok "[claude] nothing was copied into the plugin cache" || no "[claude] a cached copy exists"
  # An explicit `claude plugin install` of the same plugin makes a cache copy, but a session still reads the folder in place.
  ( cd "$H4/proj" && HOME="$H4" claude plugin marketplace add "$V4" >/dev/null 2>&1; HOME="$H4" claude plugin install talos@talos-local >/dev/null 2>&1 )
  python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V4" --version 1.0.0-probe-a >/dev/null 2>&1; run_claude "$H4" "$SB/dbg-inst-a.log"; IA="$(cat "$H4/proj/.probe-version" 2>/dev/null)"
  python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V4" --version 1.0.0-probe-b >/dev/null 2>&1; run_claude "$H4" "$SB/dbg-inst-b.log"; IB="$(cat "$H4/proj/.probe-version" 2>/dev/null)"
  { [ "$IA" = 1.0.0-probe-a ] && [ "$IB" = 1.0.0-probe-b ]; } && ok "[claude] even after an explicit claude plugin install (a cache copy exists), a session follows current: the plugin is still read in place" || no "[claude] an installed plugin stopped following current (A='$IA' B='$IB')"
  # Workspace trust, and why the guards are registered in settings.json. In a folder nobody ever trusted, `claude -p` (what Chronos
  # runs) skips a plugin that only project settings enable ("Skipping orphaned enabledPlugins entry", "Registered 0 hooks"), so a
  # guard registered by the plugin would not exist there. Hooks written in the agent's own settings.json do run. So: a fresh
  # install in a never-trusted folder still registers every hook, and a `current` link that points nowhere still registers them
  # (the command itself then fails closed when the run is unattended).
  fresh_home h5; A5="$HOME/agent"; V5="$TALOS_VENDOR_DIR/kit"; bash "$KIT/install.sh" --agent-dir "$A5" --no-chronos >/dev/null 2>&1
  printf '{"hasCompletedOnboarding": true}\n' > "$HOME/.claude.json"                                      # this folder is never trusted
  NH5="$(python3 -c 'import json,sys; print(sum(len(e["hooks"]) for e in json.load(open(sys.argv[1]))["hooks"]["SessionStart"] if "startup" in (e.get("matcher") or "startup")))' "$A5/.claude/settings.json")"
  # Claude Code logs a finished settings hook as "Hooks: SessionStart:startup [command hook N] finished" (older) or
  # "Hooks: [<command text>] finished with status N" (2.1.318); count either, only for the SessionStart commands in settings.json
  ran5(){ python3 - "$1" "$A5/.claude/settings.json" <<'PY'
import json, re, sys
log, settings = sys.argv[1:3]
cmds = [h["command"] for e in json.load(open(settings))["hooks"]["SessionStart"] if "startup" in (e.get("matcher") or "startup") for h in e["hooks"]]
n = 0
for line in open(log, errors="replace"):
    if "Hooks:" not in line or "] finished" not in line:
        continue
    if re.search(r"SessionStart:startup \[command hook [0-9]+\] finished", line) or any("[" + c + "] finished" in line for c in cmds):
        n += 1
print(n)
PY
  }
  claude5(){ ( cd "$A5" && HOME="$HOME" XDG_STATE_HOME="$HOME/state" ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://127.0.0.1:9 PATH="$ORIGPATH" "$@" timeout 25 claude -p hi --debug-file "$LOG5" </dev/null >/dev/null 2>&1 ); }
  LOG5="$SB/dbg-untrusted.log"; claude5 env
  { [ "$NH5" -ge 2 ] && [ "$(ran5 "$LOG5")" = "$NH5" ] && grep -q 'Skipping orphaned enabledPlugins' "$LOG5" && ls "$HOME/state/talos" 2>/dev/null | grep -q '^agent-'; } \
    && ok "[claude] untrusted folder, claude -p (the plugin is skipped there): all $NH5 SessionStart hooks from settings.json still ran and wrote the agent's state" \
    || no "[claude] claude -p in a never-trusted folder did not run the settings.json hooks (ran $(ran5 "$LOG5") of $NH5)" "$(grep -iE 'orphaned|Skipping|Hooks: SessionStart' "$LOG5" | cut -c1-160 | head -4)"
  rm -rf "$HOME/state"; ln -sfn releases/does-not-exist "$V5/current"                                  # the active release is gone
  LOG5="$SB/dbg-brokenlink.log"; claude5 env
  { [ "$(ran5 "$LOG5")" = "$NH5" ] && ! ls "$HOME/state/talos" >/dev/null 2>&1; } && ok "[claude] a current link pointing at a missing release: claude -p still runs all $NH5 registered SessionStart commands (they find no script and do nothing, no crash, no state written)" || no "[claude] a broken current link left Claude Code with no hooks (ran $(ran5 "$LOG5") of $NH5)" "$(grep -iE 'orphaned|Skipping|Hooks: SessionStart' "$LOG5" | cut -c1-160 | head -4)"
  gcmd="$(python3 -c 'import json,sys; print([h["command"] for e in json.load(open(sys.argv[1]))["hooks"]["PreToolUse"] for h in e["hooks"] if "pre-tool-guard.py" in h["command"]][0])' "$A5/.claude/settings.json")"
  # the guard with its release gone, through a real claude -p that makes a Bash tool call (a local fake API answers with the call)
  python3 "$KIT/scripts/fixtures/fake-anthropic.py" "$SB/fake.port" "$SB/fake.req" & FAKEPID=$!
  fi_=0; while [ ! -s "$SB/fake.port" ] && [ $fi_ -lt 50 ]; do sleep 0.2; fi_=$((fi_+1)); done; FP="$(cat "$SB/fake.port" 2>/dev/null)"
  guard_run(){ # $1 = extra env assignment; leaves the last request the fake API got in $SB/fake.last
    : > "$SB/fake.req"
    ( cd "$A5" && env "$1" HOME="$HOME" XDG_STATE_HOME="$HOME/state" ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL="http://127.0.0.1:$FP" PATH="$ORIGPATH" \
        timeout 60 claude -p hi --permission-mode bypassPermissions </dev/null >/dev/null 2>&1 )
    grep -F '"tool_result"' "$SB/fake.req" | tail -1 > "$SB/fake.last"
  }
  guard_run CHRONOS_RUN=1; U5="$(cat "$SB/fake.last")"
  guard_run X=1; A5R="$(cat "$SB/fake.last")"
  kill $FAKEPID 2>/dev/null; wait $FAKEPID 2>/dev/null
  { printf '%s' "$U5" | grep -q 'unattended, so the action is blocked' && printf '%s' "$U5" | grep -q '"is_error": *true' && printf '%s' "$A5R" | grep -q 'guard-probe' && ! printf '%s' "$A5R" | grep -q 'the action is blocked'; } \
    && ok "[claude] with its release gone, the Bash guard fails closed in a claude -p tool call when unattended (the tool result is the guard's error) and lets the same call through in an interactive-style run" || no "[claude] the guard did not fail closed through a real tool call (fake API port '$FP')" "unattended: $(printf '%s' "$U5" | cut -c1-300) | attended: $(printf '%s' "$A5R" | cut -c1-300)"
  python3 "$KIT/scripts/plugin-release.py" activate --vendor "$V5" --version "$(tr -d ' \t\r\n' < "$KIT/VERSION")" >/dev/null 2>&1

  # and the real built release, from a fresh install: every hook registered, skills and agents loaded, hooks wrote under the agent's own name
  fresh_home h1b; A1="$HOME/agent"; bash "$KIT/install.sh" --agent-dir "$A1" --no-chronos >/dev/null 2>&1
  python3 - "$HOME" "$A1" <<'PY'
import json, sys
home, a = sys.argv[1:3]
json.dump({"hasCompletedOnboarding": True, "projects": {a: {"hasTrustDialogAccepted": True}}}, open(home + "/.claude.json", "w"))
PY
  ( cd "$A1" && HOME="$HOME" XDG_STATE_HOME="$HOME/state" ANTHROPIC_API_KEY=sk-ant-fake ANTHROPIC_BASE_URL=http://127.0.0.1:9 PATH="$ORIGPATH" timeout 25 claude -p hi --debug-file "$SB/dbg-real.log" </dev/null >/dev/null 2>&1 )
  RR="$(vendor_release "$TALOS_VENDOR_DIR/kit")"
  nh="$NH5"
  na="$(ls "$RR/agents" | wc -l | tr -d ' ')"; ns="$(ls -d "$RR/skills"/*/ | wc -l | tr -d ' ')"
  { [ "$(ran5 "$SB/dbg-real.log")" = "$nh" ] && grep -q "Loaded $na agents from plugin talos" "$SB/dbg-real.log" && grep -q "Loaded $ns skills from plugin talos" "$SB/dbg-real.log"; } \
    && ok "[claude] a fresh install in a real session: $nh SessionStart hooks ran from settings.json, $na agents and $ns skills loaded from the plugin" || no "[claude] the real release did not load as expected" "$(grep -iE 'Registered|Loaded [0-9]+ (agents|skills) from plugin talos|talos' "$SB/dbg-real.log" | head -6)"
  states="$(ls "$HOME/state/talos" 2>/dev/null | tr '\n' ' ')"
  case "$states" in "agent-"*" ") [ "$(echo "$states" | wc -w | tr -d ' ')" = 1 ] && ok "[claude] the hooks Claude Code ran wrote state under the agent's name only ($states)" || no "[claude] state folders: $states" ;; *) no "[claude] no hook state under the agent's name (state: '$states')" ;; esac

  # 5. claude plugin validate
  v="$(HOME="$SB/claude4" claude plugin validate "$RR" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$v" | grep -q 'Validation passed'; } && ok "[claude] claude plugin validate passes on the built plugin ($(claude --version 2>/dev/null | head -1))" || no "[claude] plugin validate failed (rc=$rc)" "$(printf '%s' "$v" | tail -5)"
  v="$(HOME="$SB/claude4" claude plugin validate "$TALOS_VENDOR_DIR/kit" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$v" | grep -q 'Validation passed'; } && ok "[claude] claude plugin validate passes on the marketplace folder (its one warning: the source goes through the current symlink, which validation never follows)" || no "[claude] marketplace validate failed (rc=$rc)" "$(printf '%s' "$v" | tail -5)"
else
  echo "  skip claude plugin validate and the real-session checks (the claude CLI is not installed here)"
fi
export HOME="$REALHOME"
echo "  plugin: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
