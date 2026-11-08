#!/usr/bin/env bash
# test-update.sh -- `talos update`, `talos rollback` and `talos restore` (kit/bin/talos-update, scripts/talos-update.py), end to end.
#
# Everything is real: a real signed bundle (ssh-keygen -Y sign/verify), a real kernel flock, real kill -9, real releases under a
# temp vendor folder, a real installed agent folder, and the real entry point (bin/talos-update, run with a pty for stdin and
# stdout the way the owner's Terminal does). Nothing touches the real home folder, a real agent, ~/.config/talos or any tmux
# socket: HOME, XDG_*, TALOS_APP_HOME and the vendor folder are all under one temp directory.
#
#  1  dry run changes nothing and says what would change; update swaps, migrates, reconciles hooks, copies the four Talos files
#  2  the owner's files are hashed (bytes, size, mtime) and unchanged; memory/ written DURING the update does not fail it
#  3  a release whose start check fails rolls back; settings.json is byte-identical, migrations are undone newest first
#  4  two runs at once: one winner (kernel flock), the loser exits 3; the lock outlives a killed updater while its child runs
#  5  kill -9 at the start of every step, then a second run recovers; before the swap nothing live had changed
#  6  signatures: unsigned, wrong key, tampered, wrong namespace, a release that brings its own key; the CURRENT release's keys rule
#  7  the swap of `current` is atomic (a reader never sees it missing); rollback runs migration down newest first; down: none refuses
#  8  who may run it: not without a terminal; hostile archives are refused after the signature and before anything is unpacked
#  9  restore: Shared from last-good, Yours from git, Talos from the release; hostile paths refused
# 10  time: a peer slower than the timeout, a migration past its limit, SIGTERM mid-migration (child stopped, rolled back)
# 11  R2-6 hook reconcile (add, rename, remove, owner-edited), R2-8 down re-run byte-exact, R2-9 non-guard hooks never exit 2
# 12  app merge (conflict stops, clean merge goes), relay skew only prints, newest three releases kept
unset PYTHONDONTWRITEBYTECODE      # run the way an owner's machine does: a stray .pyc in a staged release would change its content hash
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="${TALOS_TEST_KIT:-$(cd "$HERE/.." && pwd)}"
FX="$HERE/fixtures"
D="20261105"      # the day part of the test migrations' ids (<day><4 digits>); written in two pieces so no long bare number sits in this file
PASS=0; FAIL=0
T_LAP=$SECONDS
lap(){ printf '  .. %s: %s s\n' "$1" "$((SECONDS - T_LAP))"; T_LAP=$SECONDS; }
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$(<<<"$2" head -12 | cut -c1-240)"; }
SB="$(mktemp -d)" || exit 2
SB="$(cd "$SB" && pwd -P)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
BG_PIDS=""
trap 'for p in $BG_PIDS; do kill "$p" 2>/dev/null; done; chmod -R u+w "$SB" 2>/dev/null; rm -rf "$SB"' EXIT
command -v ssh-keygen >/dev/null 2>&1 || { echo "  skip test-update.sh: ssh-keygen is not installed (macOS and OpenSSH ship it)"; exit 0; }
REALHOME="$HOME"
export HOME="$SB/h"; mkdir -p "$HOME"
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CHRONOS_RUN TALOS_UNATTENDED TALOS_APP_HOME TALOS_KIT_HOME XDG_STATE_HOME XDG_DATA_HOME CLAUDECODE
export XDG_CONFIG_HOME="$HOME/.config" TALOS_VENDOR_DIR="$HOME/.local/share/talos" TALOS_APP_HOME="$HOME/app"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export TALOS_TEST_LOG="$SB/test.log" TALOS_TEST_HOLD="$SB/hold"
A="$HOME/agent"; V="$TALOS_VENDOR_DIR/kit"; SRC="$SB/src"
V1="$(tr -d ' \t\r\n' < "$KIT/VERSION")"; V2="1.3.0-test"
BIN(){ echo "$V/current/talos-kit/bin/talos-update"; }

hash_any(){ python3 - "$@" <<'PY'
import hashlib, os, sys
h = hashlib.sha256()
def one(p, rel):
    if os.path.islink(p): h.update(b"L" + rel.encode() + os.readlink(p).encode())
    elif os.path.isfile(p): h.update(b"F" + rel.encode() + oct(os.stat(p).st_mode & 0o777).encode() + open(p, "rb").read())
    else: h.update(b"absent" + rel.encode())
for root in sys.argv[1:]:
    if os.path.islink(root) or not os.path.isdir(root): one(root, root); continue
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for n in sorted(fn + [d for d in dn if os.path.islink(os.path.join(dp, d))]):
            if n == ".lock": continue            # the lock file holds the pid of the last run: not state
            p = os.path.join(dp, n); one(p, os.path.relpath(p, root))
print(h.hexdigest())
PY
}
sha(){ shasum -a 256 "$1" | cut -d' ' -f1; }
marker(){ sed -n "s/^$1=//p" "$A/.talos-version" | head -1; }
cur(){ readlink "$V/current"; }
runtty(){ python3 "$FX/tty-run.py" --timeout 90 "$@"; }
upd(){ runtty -- "$(BIN)" update --agent "$A" --source "$SRC" "$@"; }
alive(){ kill -0 "$1" 2>/dev/null; }
fast_ps(){ ps -p "$1" -o pid= 2>/dev/null | tr -d ' '; }

# ----------------------------------------------------------------------------------------------- fixtures
python3 "$FX/update-fixture.py" keys "$SB/keys" || { echo "cannot make keys"; exit 2; }
K="$SB/keys"
python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit1" --version "$V1" --allowed "$K/allowed1" || exit 2
publish(){ # publish VERSION KEYNAME OUTDIR [make-kit options...]: a signed bundle of a kit built from the real one
  local v="$1" key="$2" out="$3"; shift 3
  python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit-$v" --version "$v" --allowed "$K/allowed1" "$@" || return 1
  rm -rf "$SB/pub-$v"
  python3 "$SB/kit-$v/scripts/plugin-release.py" build --source "$SB/kit-$v" --vendor "$SB/pub-$v" >/dev/null || return 1
  python3 "$SB/kit-$v/scripts/plugin-release.py" pack --vendor "$SB/pub-$v" --version "$v" --key "$K/$key" --out "$out" >/dev/null
}
M1="${D}0001:first:hold"; M2="${D}0002:second:plain"
publish "$V2" key1 "$SRC" --migration "$M1" --migration "$M2" --hook "UserPromptSubmit||new-guard.py" --rewrite session-start.py --drop claim-gate.py \
  --notes "Test release notes line one." --min-relay newrelay || { echo "cannot publish the test release"; exit 2; }

# the pristine world: kit1 installed into $A (vendor, agent folder, settings), with an owner's hook and files, settings in 4-space JSON
HOME_PRISTINE="$SB/pristine"
bash "$SB/kit1/install.sh" --agent-dir "$A" --no-chronos >/dev/null 2>&1 || { echo "kit1 install.sh failed"; exit 2; }
mkdir -p "$A/custom/hooks" "$A/memory" "$A/wiki" "$TALOS_APP_HOME/last-good"
printf '#!/usr/bin/env python3\nprint("{}")\n' > "$A/custom/hooks/my-own.py"
printf 'owner note\n' > "$A/memory/note.md"; printf 'state\n' > "$A/memory/STATE.md"; printf 'owner persona\n' > "$A/CLAUDE.md"; printf 'secret=1\n' > "$A/.env"
python3 - "$A/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
s["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/custom/hooks/my-own.py"'}]})
s["permissions"]["allow"] = ["Bash(ls)"]
json.dump(s, open(p, "w"), indent=4)      # not the kit's own rendering: any rewrite shows in the bytes
PY
( umask 077; : > "$V/.lock" )      # the lock file an update creates: part of the pristine world, so hashes compare like with like
cp -pR "$HOME" "$HOME_PRISTINE"
reset_world(){ chmod -R u+w "$HOME" 2>/dev/null; rm -rf "$HOME"; cp -pR "$HOME_PRISTINE" "$HOME"; : > "$TALOS_TEST_LOG"; rm -f "$TALOS_TEST_HOLD"; }
SET0="$A/.claude/settings.json"
NEWMIG="${D}0002-second"

lap "before section 1"
# ================================================================ 1. dry run, then a real update
reset_world
W0="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
out="$(upd --dry-run 2>&1)"; rc=$?
[ "$rc" = 0 ] && ok "update --dry-run exits 0 on the real entry point (bin/talos-update, with a terminal)" || no "dry run exited $rc" "$out"
{ <<<"$out" grep -q "$V2" && <<<"$out" grep -q "${D}0001-first" && <<<"$out" grep -q "${D}0002-second" \
  && <<<"$out" grep -q 'Test release notes line one' && <<<"$out" grep -qi 'dry run'; } \
  && ok "the dry run names the new version, the pending migrations and the release notes" || no "dry run output is missing the version, migrations or notes" "$out"
{ [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W0" ] && [ ! -s "$TALOS_TEST_LOG" ] && [ ! -e "$TALOS_APP_HOME/agent-request.json" ] \
  && [ -z "$(ls -A "$V/releases" | grep -v "^$V1\$")" ]; } \
  && ok "the dry run left the vendor folder, current, settings.json, links, marker and releases/ byte for byte as they were, ran no migration and asked for no restart" || no "the dry run changed something" "$(ls -A "$V/releases") | $(cat "$TALOS_TEST_LOG")"
<<<"$out" grep -q 'newrelay' && <<<"$out" grep -qi 'railway' && ok "the dry run prints the relay note (the release's min_relay is not what this Mac knows the relay runs): press Update in Railway" \
  || no "no relay note in the dry run" "$out"

reset_world
cp -p "$SET0" "$SB/settings.before"
CLA0="$(sha "$A/CLAUDE.md")"; DEF0="$(sha "$A/.claude/rules/talos-defaults.md")"; echo "# owner edit" >> "$A/wiki/README.md"; HY0="$(python3 "$FX/update-fixture.py" yours "$A")"
touch "$TALOS_TEST_HOLD"
runtty --pidfile "$SB/pid1" -- "$(BIN)" update --agent "$A" --source "$SRC" > "$SB/out1" 2>&1 &
BG1=$!; BG_PIDS="$BG_PIDS $BG1"
for _ in $(seq 1 100); do grep -q "pid" "$TALOS_TEST_LOG" 2>/dev/null && break; sleep 0.1; done
grep -q "up ${D}0001 pid" "$TALOS_TEST_LOG" && ok "the first migration is running (held open), the update is mid-way" || no "the update never reached the first migration" "$(cat "$SB/out1")"
# a second session writes memory/ and the owner's files while the update is mid-way (a tracked file edited, a new file, a dot file, .learnings)
echo "live write" >> "$A/memory/STATE.md"; echo "new" > "$A/memory/new-note.md"; echo "x" > "$A/memory/.last-lint"; mkdir -p "$A/.learnings"; echo "e" >> "$A/.learnings/ERRORS.md"
HYMID="$(python3 "$FX/update-fixture.py" yours "$A")"; python3 "$FX/update-fixture.py" yours "$A" --list > "$SB/yours.mid"
# 4. a second update at once: one winner
out2="$(upd 2>&1)"; rc2=$?
{ [ "$rc2" = 3 ] && <<<"$out2" grep -qi 'update already running' && <<<"$out2" grep -q "pid $(cat "$SB/pid1")"; } && ok "two at once: the second run exits 3 with 'update already running' naming the pid that holds it" || no "the second run was not refused (rc=$rc2)" "$out2"
out2="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc2=$?
{ [ "$rc2" = 3 ] && <<<"$out2" grep -qi 'already running'; } && ok "rollback during an update is refused by the same lock (exit 3)" || no "rollback was not refused during an update (rc=$rc2)" "$out2"
out2="$(runtty -- "$(BIN)" restore --agent "$A" CLAUDE.md 2>&1)"; rc2=$?
[ "$rc2" = 3 ] && ok "restore during an update is refused by the same lock (exit 3)" || no "restore was not refused during an update (rc=$rc2)" "$out2"
rm -f "$TALOS_TEST_HOLD"; wait "$BG1"; rc=$?
[ "$rc" = 0 ] && ok "the held update finishes (exit 0) after the live writes to memory/, .learnings/ and the dot files" || no "update failed after memory/ writes (rc=$rc)" "$(cat "$SB/out1")"
cat "$SB/out1" | sed 's/^/    | /' | tail -25
{ [ "$(cur)" = "releases/$V2" ] && [ "$(marker version)" = "$V2" ] && [ "$(marker migration)" = "$NEWMIG" ]; } && ok "current -> releases/$V2, and .talos-version holds version=$V2 and migration=$NEWMIG" || no "state after update" "$(cur) $(cat "$A/.talos-version")"
[ "$(grep -c '^up ' "$TALOS_TEST_LOG")" = 2 ] && [ "$(sed -n 's/^up \([0-9]*\).*/\1/p' "$TALOS_TEST_LOG" | tr '\n' ' ')" = "${D}0001 ${D}0002 " ] \
  && ok "both migrations ran once, in order" || no "migration log wrong" "$(cat "$TALOS_TEST_LOG")"
python3 - "$A" "$V" "$V2" <<'PY' && ok "settings.json now matches the new release's hook list (R2-6): the new guard added, session-start.py's entry renamed, claim-gate.py's entries removed; the owner's hook, permissions and statusLine kept" || no "settings.json was not reconciled with the release"
import json, os, sys
a, v, ver = sys.argv[1:4]
s = json.load(open(os.path.join(a, ".claude/settings.json")))
cmds = [(ev, h["command"]) for ev, es in s["hooks"].items() for e in es for h in e["hooks"]]
assert any("hooks/new-guard.py" in c for ev, c in cmds if ev == "UserPromptSubmit"), "new-guard.py not added"
assert not any("hooks/claim-gate.py" in c for ev, c in cmds), "claim-gate.py still registered"
assert any("hooks/session-start.py" in c and c.endswith("# revision 2") for ev, c in cmds), "session-start.py's command not renamed"
assert any("custom/hooks/my-own.py" in c for ev, c in cmds), "the owner's hook is gone"
assert s["permissions"]["allow"] == ["Bash(ls)"] and "statusLine" in s
t = json.load(open(os.path.join(v, "releases", ver, "talos-kit", "templates/dot-claude/settings.json")))
tc = sorted(h["command"] for es in t["hooks"].values() for e in es for h in e["hooks"])
sc = sorted(c for ev, c in cmds if "custom/hooks" not in c)
assert tc == sc, "settings.json's kit hooks differ from the release template"
PY
[ -f "$A/hooks/new-guard.py" ] && [ "$(readlink "$A/hooks")" = "$V/current/talos-kit/hooks" ] && ok "hooks/ still links through current, which now holds the new guard script" || no "hooks link or new guard script missing"
[ -f "$SET0.bak-update-$V1-to-$V2" ] && cmp -s "$SET0.bak-update-$V1-to-$V2" "$SB/settings.before" && ok "settings.json, which an update does touch (Shared), kept a .bak with the original bytes" || no "no .bak of settings.json" "$(ls "$A/.claude")"
HYAFTER="$(python3 "$FX/update-fixture.py" yours "$A")"; python3 "$FX/update-fixture.py" yours "$A" --list > "$SB/yours.after"
{ [ "$HYMID" = "$HYAFTER" ] && [ "$(sha "$A/CLAUDE.md")" = "$CLA0" ] && [ "$(cat "$A/.env")" = "secret=1" ]; } && ok "the owner's files (CLAUDE.md, .env, memory/, wiki/, custom/, .learnings/: bytes, size and mtime hashed) are exactly what they were before the update" || no "a Yours file changed during the update" "$(diff "$SB/yours.mid" "$SB/yours.after")"
[ "$(sha "$A/.claude/rules/talos-defaults.md")" = "$(sha "$V/current/talos-kit/agent-files/.claude/rules/talos-defaults.md")" ] \
  && ok "the in-folder Talos files are the new release's copies (talos-defaults.md replaced atomically)" || no "talos-defaults.md not refreshed"
[ -f "$A/wiki/README.md.bak-update-$V2" ] && grep -q '# owner edit' "$A/wiki/README.md.bak-update-$V2" && ok "a Talos file the owner had edited (wiki/README.md) is replaced only with the edited bytes kept next to it" || no "no .bak for the edited wiki/README.md" "$(ls "$A/wiki")"
python3 - "$TALOS_APP_HOME/agent-request.json" <<'PY' && ok "the agent is restarted through the existing request file: {v:1, control_id, action:restart, ts} in mode 0600, valid for the Mac app's reader" || no "agent-request.json missing or malformed"
import json, os, re, stat, sys, time
p = sys.argv[1]; d = json.load(open(p)); st = os.stat(p)
assert d["v"] == 1 and d["action"] == "restart" and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", d["control_id"]), d
assert abs(d["ts"] - time.time() * 1000) < 120000 and stat.S_IMODE(st.st_mode) == 0o600
assert set(d) == {"v", "control_id", "action", "ts"}, d
PY
{ [ -z "$(ls -A "$V/releases" | grep -E '^\.')" ] && [ -z "$(ls -A "$V" | grep -E '^\.(dl|tmp|update)|journal|\.tmp\.')" ] && [ ! -e "$V/update-journal.json" ]; } \
  && ok "no temp folder, partial release or journal is left behind" || no "leftovers in the vendor folder" "$(ls -A "$V" "$V/releases")"
[ -z "$(find "$V/releases" -name __pycache__ -o -name '*.pyc' | head -1)" ] && ok "no bytecode cache was written into any release (a release is only ever the files it was built from)" || no "a __pycache__ or .pyc is inside a release" "$(find "$V/releases" -name __pycache__ | head -3)"
out="$(upd 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && <<<"$out" grep -qi 'already up to date'; } && ok "updating again says 'already up to date' (exit 0) and restarts nothing new" || no "second update: rc=$rc" "$out"

lap "before section 3"
# ================================================================ 3. a release whose start check fails rolls back
reset_world; SRC3="$SB/src3"
publish "1.4.0-bad" key1 "$SRC3" --migration "${D}0010:bad-one:plain" --migration "${D}0011:bad-two:plain" --hook "UserPromptSubmit||bad-guard.py" --drop claim-gate.py --rewrite session-start.py --check-fail \
  || { echo "cannot publish the bad release"; exit 2; }
cp -p "$SET0" "$SB/settings.before3"
S3="$(hash_any "$A/.claude/settings.json")"; H3="$(hash_any "$A/hooks" "$A/scripts" "$A/.talos-version" "$A/.claude/rules" "$A/wiki")"; CUR3="$(cur)"; HY3="$(python3 "$FX/update-fixture.py" yours "$A")"
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC3" 2>&1)"; rc=$?
[ "$rc" = 1 ] && ok "a release whose start check fails: the update exits 1" || no "bad release: exit $rc, expected 1" "$out"
<<<"$out" grep -qi 'start check' && <<<"$out" grep -qi 'rolled back to' && ok "and says which check failed and that it rolled back to $V1" || no "no clear message" "$out"
{ [ "$(hash_any "$A/.claude/settings.json")" = "$S3" ] && cmp -s "$SET0" "$SB/settings.before3"; } && ok "settings.json is byte-identical to before (4-space formatting and all), though the update had rewritten its hooks" || no "settings.json bytes changed by a failed update" "$(diff "$SB/settings.before3" "$SET0" | head -5)"
{ [ "$(cur)" = "$CUR3" ] && [ "$(hash_any "$A/hooks" "$A/scripts" "$A/.talos-version" "$A/.claude/rules" "$A/wiki")" = "$H3" ] && [ "$(python3 "$FX/update-fixture.py" yours "$A")" = "$HY3" ]; } \
  && ok "current, the links, .talos-version, the four Talos files and every owner file are as before" || no "state after rollback differs" "$(cur) / $(hash_any "$A/hooks" "$A/scripts") $(hash_any "$A/.talos-version") $(hash_any "$A/.claude/rules") $(hash_any "$A/wiki") vs $H3 / $(python3 "$FX/update-fixture.py" yours "$A") $HY3"
[ "$(cat "$TALOS_TEST_LOG" | tr '\n' ',')" = "up ${D}0010,up ${D}0011,down ${D}0011,down ${D}0010," ] \
  && ok "migration down ran for both migrations, newest first" || no "migration order in the log" "$(cat "$TALOS_TEST_LOG")"
[ ! -e "$TALOS_APP_HOME/agent-request.json" ] && [ ! -e "$V/update-journal.json" ] && ok "no restart was requested for a release that never started, and the journal is cleared" || no "restart request or journal left after a failed update"

lap "before section 4"
# an exception nobody planned for after the swap rolls back too, with the settings bytes restored
reset_world; S3b="$(hash_any "$A/.claude/settings.json")"; C3b="$(cur)"
out="$(TALOS_UPDATE_DIE_AT=boom:migrate upd 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && <<<"$out" grep -q 'unexpected RuntimeError' && <<<"$out" grep -qi 'rolled back to' && [ "$(cur)" = "$C3b" ] && [ "$(hash_any "$A/.claude/settings.json")" = "$S3b" ] && [ ! -e "$V/update-journal.json" ]; } \
  && ok "an unplanned exception after the swap (injected at the migrate step) rolls back like any failure: exit 1, settings.json byte-identical, journal cleared" || no "an unexpected exception was not rolled back (rc=$rc)" "$out"

# ================================================================ 4. the lock outlives a killed updater while its child runs
reset_world; touch "$TALOS_TEST_HOLD"
runtty --pidfile "$SB/pid4" -- "$(BIN)" update --agent "$A" --source "$SRC" > "$SB/out4" 2>&1 &
BG4=$!; BG_PIDS="$BG_PIDS $BG4"
for _ in $(seq 1 100); do grep -q "pid" "$TALOS_TEST_LOG" 2>/dev/null && break; sleep 0.1; done
MPID="$(sed -n "s/^up ${D}0001 pid \([0-9]*\)/\1/p" "$TALOS_TEST_LOG" | head -1)"
kill -9 "$(cat "$SB/pid4")" 2>/dev/null; wait "$BG4" 2>/dev/null; BG4RC=$?
{ [ "$BG4RC" = 137 ] && [ -n "$MPID" ] && alive "$MPID"; } && ok "kill -9 on the updater mid-migration (exit 137): the migration it started is still running, an orphan" || no "could not set up the orphan (rc=$BG4RC, pid '$MPID')"
out="$(upd 2>&1)"; rc=$?
{ [ "$rc" = 3 ] && <<<"$out" grep -qi 'already running'; } && ok "a new update is still refused while the orphaned migration runs: the child inherited the lock, so nothing else can start half-way through it" || no "the lock did not outlive the killed updater (rc=$rc)" "$out"
rm -f "$TALOS_TEST_HOLD"
for _ in $(seq 1 100); do alive "$MPID" || break; sleep 0.1; done
for _ in $(seq 1 60); do out="$(upd 2>&1)"; rc=$?; [ "$rc" = 3 ] || break; sleep 0.2; done      # the orphaned migration runner finishes its own work first
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V2" ] && [ "$(marker migration)" = "$NEWMIG" ]; } && ok "once the orphan is gone, the next update resumes the interrupted one and finishes it" || no "recovery after the orphan (rc=$rc)" "$out"

lap "before section 5"
# ================================================================ 5. kill -9 at the start of every step, then recover
for STEP in fetch verify unpack selftest journal swap files reconcile migrate migrate-after-1 check prune restart; do
  reset_world
  S5="$(hash_any "$A/.claude/settings.json")"; M5="$(marker migration)"; C5="$(cur)"; P5="$(hash_any "$A/hooks" "$A/scripts")"
  out="$(TALOS_UPDATE_DIE_AT=$STEP upd 2>&1)"; rc=$?
  if [ "$rc" != 137 ]; then no "[$STEP] expected the updater to die by SIGKILL (137), got $rc" "$out"; continue; fi
  case "$STEP" in
    fetch|verify|unpack|selftest|journal)
      { [ "$(cur)" = "$C5" ] && [ "$(hash_any "$A/.claude/settings.json")" = "$S5" ] && [ "$(marker migration)" = "$M5" ] && [ "$(hash_any "$A/hooks" "$A/scripts")" = "$P5" ] && [ ! -s "$TALOS_TEST_LOG" ]; } \
        && live=ok || live=bad ;;
    swap) { [ "$(hash_any "$A/.claude/settings.json")" = "$S5" ] && [ "$(marker migration)" = "$M5" ]; } && live=ok || live=bad ;;
    *) live=ok ;;
  esac
  if [ "$STEP" = prune ]; then [ ! -e "$TALOS_APP_HOME/agent-request.json" ] && ok "[prune] the restart is requested only after prune has run (killed at prune: no request yet)" || no "[prune] a restart was requested before prune ran"; fi
  [ "$live" = ok ] && ok "[$STEP] killed with SIGKILL at the start of the step: nothing live was changed beyond what that step had reached" || no "[$STEP] live state changed before the swap" "$(cur)"
  if [ "$STEP" = migrate ]; then
    J5="$(hash_any "$V" "$A/.claude/settings.json" "$A/.talos-version")"
    out="$(upd --dry-run 2>&1)"; rc=$?
    { [ "$rc" = 0 ] && <<<"$out" grep -qi 'interrupted and is waiting' && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/.talos-version")" = "$J5" ]; } \
      && ok "[$STEP] a dry run with an interrupted update waiting does not resume it (it says so and changes nothing)" || no "[$STEP] a dry run resumed or ignored the interrupted update (rc=$rc)" "$out"
  fi
  out="$(upd 2>&1)"; rc=$?
  R="$(printf '%s' "$out" | tail -3)"
  python3 - "$A" "$V" "$V2" "$TALOS_TEST_LOG" "$NEWMIG" "${D}0001" "${D}0002" <<'PY'
import json, os, re, sys
a, v, ver, log, newmig, m1, m2 = sys.argv[1:8]
assert os.readlink(os.path.join(v, "current")) == "releases/" + ver
m = dict(l.strip().split("=", 1) for l in open(os.path.join(a, ".talos-version")) if "=" in l and not l.startswith("#"))
assert m["version"] == ver and m["migration"] == newmig, m
ups = [l.split()[1] for l in open(log) if l.startswith("up ")]
assert ups == [m1, m2], ups          # each migration ran exactly once across the killed run and the recovery
s = json.load(open(os.path.join(a, ".claude/settings.json")))
assert any("hooks/new-guard.py" in h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"])
assert not os.path.exists(os.path.join(v, "update-journal.json"))
junk = [n for n in os.listdir(os.path.join(v, "releases")) if n.startswith(".")] + [n for n in os.listdir(v) if re.match(r"^(\.dl|\.tmp|current\.tmp)", n)]
assert not junk, junk
PY
  [ "$?" = 0 ] && [ "$rc" = 0 ] && ok "[$STEP] the next run recovers: current, marker, settings.json and migrations (each run once) all match the new release; no leftovers" || no "[$STEP] recovery failed (rc=$rc)" "$R"
done

lap "before section 6"
# ================================================================ 6. signatures
sigworld(){ reset_world; rm -rf "$SRC6"; mkdir -p "$SRC6"; cp "$SRC/talos-kit-$V2.tar.gz" "$SRC/talos-kit-$V2.tar.gz.sig" "$SRC/latest.json" "$SRC6/"; chmod u+w "$SRC6"/*
  W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"; }
SRC6="$SB/src6"
refused(){ # refused LABEL EXPECTED-TEXT: the last `upd` result in $out/$rc was refused and nothing changed
  local label="$1" want="$2"
  if [ "$rc" != 0 ] && <<<"$out" grep -qi "$want" && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W6" ] && [ ! -s "$TALOS_TEST_LOG" ] && [ ! -e "$TALOS_APP_HOME/agent-request.json" ]; then
    ok "$label: refused (exit $rc), and the vendor folder, settings, links and marker are untouched"
  else no "$label: not refused cleanly (rc=$rc)" "$out"; fi; }
UPD6(){ runtty -- "$(BIN)" update --agent "$A" --source "$SRC6" "$@"; }
sigworld; out="$(UPD6 2>&1)"; rc=$?; [ "$rc" = 0 ] && ok "the properly signed release installs (control for the refusals below)" || no "the signed control release did not install (rc=$rc)" "$out"
sigworld; rm -f "$SRC6/talos-kit-$V2.tar.gz.sig"; out="$(UPD6 2>&1)"; rc=$?; refused "an UNSIGNED release (no .sig)" "no signature"
sigworld; rm -f "$SRC6/talos-kit-$V2.tar.gz.sig"; ssh-keygen -q -Y sign -f "$K/key2" -n talos-kit-release "$SRC6/talos-kit-$V2.tar.gz" 2>/dev/null; out="$(UPD6 2>&1)"; rc=$?; refused "a release signed by a WRONG key (not in the current allowed_signers)" "signature"
sigworld; python3 - "$SRC6/talos-kit-$V2.tar.gz" <<'PY'
import sys
p = sys.argv[1]; b = bytearray(open(p, "rb").read()); b[len(b) // 2] ^= 0xFF; open(p, "wb").write(bytes(b))
PY
out="$(UPD6 2>&1)"; rc=$?; refused "a TAMPERED bundle (one byte flipped after signing)" "signature"
sigworld; rm -f "$SRC6/talos-kit-$V2.tar.gz.sig"; ssh-keygen -q -Y sign -f "$K/key1" -n file "$SRC6/talos-kit-$V2.tar.gz" 2>/dev/null; out="$(UPD6 2>&1)"; rc=$?; refused "a signature made for another namespace (-n file)" "signature"
sigworld; cp "$SRC6/talos-kit-$V2.tar.gz.sig" "$SB/sig-ok"; printf 'garbage\n' > "$SRC6/talos-kit-$V2.tar.gz.sig"; out="$(UPD6 2>&1)"; rc=$?; refused "a garbage .sig file" "signature"
# an installed release that lists no signing key cannot verify anything (a source checkout ships none)
sigworld; chmod -R u+w "$V/releases/$V1/talos-kit" && : > "$V/releases/$V1/talos-kit/allowed_signers"; W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
out="$(UPD6 2>&1)"; rc=$?; refused "an installed release with NO signing key in allowed_signers" "no signing key"
# a release that carries its OWN allowed_signers (the attacker's key) and is signed by that key: only the CURRENT release's keys count
EVIL="$SB/evil"; mkdir -p "$EVIL"
python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit-evil" --version "1.9.0-evil" --allowed "$K/allowed2" >/dev/null
rm -rf "$SB/pub-evil"; python3 "$SB/kit-evil/scripts/plugin-release.py" build --source "$SB/kit-evil" --vendor "$SB/pub-evil" >/dev/null
python3 "$SB/kit-evil/scripts/plugin-release.py" pack --vendor "$SB/pub-evil" --version 1.9.0-evil --key "$K/key2" --out "$EVIL" >/dev/null
reset_world; SRC6="$EVIL"; W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
out="$(UPD6 2>&1)"; rc=$?; refused "a release signed by the key IT lists in its own allowed_signers (verification uses the CURRENT release's list)" "signature"
# rotation: v2 signed by the old key ships the new key list; then the old key is no longer accepted
ROT="$SB/rot"; mkdir -p "$ROT"; publish "1.5.0-rot" key1 "$ROT" >/dev/null && python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit-rot" --version "1.5.0-rot" --allowed "$K/allowed2" >/dev/null \
  && rm -rf "$SB/pub-rot" && python3 "$SB/kit-rot/scripts/plugin-release.py" build --source "$SB/kit-rot" --vendor "$SB/pub-rot" >/dev/null && python3 "$SB/kit-rot/scripts/plugin-release.py" pack --vendor "$SB/pub-rot" --version 1.5.0-rot --key "$K/key1" --out "$ROT" >/dev/null
reset_world; SRC6="$ROT"; out="$(UPD6 2>&1)"; rc=$?
[ "$rc" = 0 ] && grep -q 'ssh-ed25519' "$V/current/talos-kit/allowed_signers" && ok "key rotation: a release signed by the current key may bring the next key list" || no "rotation release did not install (rc=$rc)" "$out"
ROT2="$SB/rot2"; mkdir -p "$ROT2"; python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit-rot2" --version "1.6.0-old" --allowed "$K/allowed1" >/dev/null && rm -rf "$SB/pub-rot2" \
  && python3 "$SB/kit-rot2/scripts/plugin-release.py" build --source "$SB/kit-rot2" --vendor "$SB/pub-rot2" >/dev/null && python3 "$SB/kit-rot2/scripts/plugin-release.py" pack --vendor "$SB/pub-rot2" --version 1.6.0-old --key "$K/key1" --out "$ROT2" >/dev/null
SRC6="$ROT2"; W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"; : > "$TALOS_TEST_LOG"; rm -f "$TALOS_APP_HOME/agent-request.json"
out="$(UPD6 2>&1)"; rc=$?; refused "after the rotation the OLD key is refused" "signature"
# a release older than the one installed is not an update (a replayed old signed bundle)
reset_world; SRC6="$SB/src6o"; mkdir -p "$SRC6"; python3 "$FX/update-fixture.py" make-kit "$KIT" "$SB/kit-old" --version "1.0.0-old" --allowed "$K/allowed1" >/dev/null && rm -rf "$SB/pub-old" \
  && python3 "$SB/kit-old/scripts/plugin-release.py" build --source "$SB/kit-old" --vendor "$SB/pub-old" >/dev/null && python3 "$SB/kit-old/scripts/plugin-release.py" pack --vendor "$SB/pub-old" --version 1.0.0-old --key "$K/key1" --out "$SRC6" >/dev/null
W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"; out="$(UPD6 2>&1)"; rc=$?
{ [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W6" ] && [ "$(cur)" = "releases/$V1" ]; } && ok "a validly signed but OLDER release (replay) does not replace the installed one (rc=$rc: $(printf '%s' "$out" | tail -1 | cut -c1-80))" || no "an older signed release replaced the installed one" "$out"
# a bundle whose name says one version and whose contents say another
reset_world; SRC6="$SB/src6m"; mkdir -p "$SRC6"; cp "$SRC/talos-kit-$V2.tar.gz" "$SRC/talos-kit-$V2.tar.gz.sig" "$SRC6/"; echo '{"version":"9.9.9-lie","bundle":"talos-kit-9.9.9-lie.tar.gz"}' > "$SRC6/latest.json"
cp "$SRC6/talos-kit-$V2.tar.gz" "$SRC6/talos-kit-9.9.9-lie.tar.gz"; cp "$SRC6/talos-kit-$V2.tar.gz.sig" "$SRC6/talos-kit-9.9.9-lie.tar.gz.sig"
W6="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"; out="$(UPD6 2>&1)"; rc=$?; refused "a signed bundle announced as another version than it contains" "version"

lap "before section 7"
# ================================================================ 7. atomic swap, rollback order, down: none
reset_world
python3 - "$V" "$V1" "$V2" "$KIT" "$SRC" 2> "$SB/swap.err" <<'PY'
import importlib.util, os, subprocess, sys, tarfile, threading, shutil
v, v1, v2, kit, src = sys.argv[1:6]
# put the second release next to the first by unpacking the signed bundle's tree the way an update would
spec = importlib.util.spec_from_file_location("pr", os.path.join(v, "current", "talos-kit", "scripts", "plugin-release.py"))
pr = importlib.util.module_from_spec(spec); spec.loader.exec_module(pr)
top = os.path.join(v, "releases", v2); os.makedirs(top)
with tarfile.open(os.path.join(src, "talos-kit-%s.tar.gz" % v2)) as t:
    t.extractall(top)
stop = False; seen = set(); bad = []
reads = [0, 0]                               # lookups, lookups that failed at the first try
def look(link):
    seen.add(os.readlink(link)); os.stat(os.path.join(link, "talos-kit", "hooks"))
def reader():
    link = os.path.join(v, "current")
    while not stop:
        reads[0] += 1
        for attempt in range(4):             # `current` gone for 4 lookups in a row is a gap, however the swap was done
            try:
                look(link); break
            except Exception as e:
                last = repr(e)
                if attempt == 0: reads[1] += 1
        else:
            bad.append(last)
th = threading.Thread(target=reader); th.start()
import io, contextlib
with contextlib.redirect_stdout(io.StringIO()):
    for i in range(1500):
        pr.activate(v, (v1, v2)[i % 2])
stop = True; th.join()
assert not bad, (len(bad), bad[:3])
# macOS: rename(2) over a symlink makes about a third of concurrent lookups fail (EINVAL); renamex_np RENAME_SWAP, which the swap uses
# there, none when idle and a few per thousand when the machine is loaded. More than 2% means the swap is not the one that is used.
assert reads[1] * 50 < reads[0], "lookups that failed during a swap: %d of %d" % (reads[1], reads[0])
assert seen == {"releases/" + v1, "releases/" + v2}, seen
PY
[ "$?" = 0 ] && ok "the swap of current is one rename: a reader polling in a tight loop through 1,500 swaps never saw it missing or dangling" || no "current was missing or dangling during a swap" "$(tail -3 "$SB/swap.err" 2>/dev/null)"
grep -n "os.replace\|os.rename" "$KIT/scripts/plugin-release.py" "$KIT/scripts/talos-update.py" 2>/dev/null | grep -q 'link' && ok "the swap code renames a fresh link over current (no remove-then-create)" || no "no rename-over for the current link"

reset_world; out="$(upd 2>&1)"; rc=$?; : > "$TALOS_TEST_LOG"
out="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V1" ] && [ "$(marker version)" = "$V1" ]; } && ok "talos rollback (no argument) goes back to the previous release" || no "rollback (rc=$rc)" "$out"
[ "$(tr '\n' ',' < "$TALOS_TEST_LOG")" = "down ${D}0002,down ${D}0001," ] && ok "rollback ran migration down for both migrations the old release does not have, NEWEST first" || no "rollback down order" "$(cat "$TALOS_TEST_LOG")"
python3 - "$A" "$SB/settings.before" <<'PY' && ok "settings.json's hook list is back to the old release's (reconciled in reverse), the owner's entries kept" || no "settings.json after rollback"
import json, sys
a, orig = sys.argv[1:3]
now = json.load(open(a + "/.claude/settings.json")); was = json.load(open(orig))
assert now == was, "settings differ from before the update"
PY
{ [ -f "$TALOS_APP_HOME/agent-request.json" ] && [ -z "$(ls -A "$V" | grep -E '^\.(dl|tmp)')" ]; } && ok "a manual rollback asks for a restart, and leaves nothing behind" || no "rollback left a mess or no restart request"
out="$(runtty -- "$(BIN)" rollback --agent "$A" "$V2" 2>&1)"; rc=$?
[ "$rc" != 0 ] && ok "rollback to a version that is not older than the current one is refused ('$V2' is newer than $V1): exit $rc" || no "a rollback to a newer version was accepted"
out="$(runtty -- "$(BIN)" rollback --agent "$A" 0.0.0-nothere 2>&1)"; rc=$?; { [ "$rc" != 0 ] && <<<"$out" grep -qi 'no release'; } && ok "rollback to a version that is not installed is refused with 'no release'" || no "rollback to a missing version: rc=$rc" "$out"
# a down that fails stops the rollback: current is not swapped, the marker says how far it got
reset_world; SRC7="$SB/src7"; publish "1.7.0-bd" key1 "$SRC7" --migration "${D}0020:one:plain" --migration "${D}0021:two:baddown" >/dev/null
runtty -- "$(BIN)" update --agent "$A" --source "$SRC7" >/dev/null 2>&1; : > "$TALOS_TEST_LOG"
out="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc=$?
{ [ "$rc" = 4 ] && [ "$(cur)" = "releases/1.7.0-bd" ] && <<<"$out" grep -q "${D}0021" && [ "$(marker migration)" = "${D}0021-two" ]; } && ok "a failing migration down stops the rollback (exit 4): current is not swapped, the marker still says ${D}0021-two, the message names it" || no "failing down handling (rc=$rc)" "$out"
# down: none refuses before anything runs
reset_world; SRC7="$SB/src7n"; publish "1.7.1-nd" key1 "$SRC7" --migration "${D}0030:one:plain" --migration "${D}0031:two:nodown" >/dev/null
runtty -- "$(BIN)" update --agent "$A" --source "$SRC7" >/dev/null 2>&1; : > "$TALOS_TEST_LOG"; H7="$(hash_any "$V" "$A/.claude/settings.json" "$A/.talos-version")"
out="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && <<<"$out" grep -q "${D}0031" && <<<"$out" grep -qi 'cannot be undone' && [ ! -s "$TALOS_TEST_LOG" ] && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/.talos-version")" = "$H7" ]; } && ok "a migration marked '# down: none' makes rollback refuse up front (exit 1): no down ran, nothing changed, the message names it" || no "down: none handling (rc=$rc)" "$out"

lap "before section 8"
# ================================================================ 8. who may run it, hostile archives
reset_world; W8="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
for verb in "update --source $SRC" "update --dry-run --source $SRC" "rollback" "restore CLAUDE.md"; do
  out="$("$(BIN)" $verb --agent "$A" </dev/null 2>&1)"; rc=$?
  { [ "$rc" = 2 ] && <<<"$out" grep -qi 'only runs in Terminal'; } && ok "'${verb%% --source*}' without a terminal is refused (exit 2): an agent's Bash tool has none" || no "'$verb' ran without a terminal (rc=$rc)" "$out"
done
out="$(CLAUDECODE=1 runtty -- "$(BIN)" update --agent "$A" --source "$SRC" 2>&1)"; rc=$?
{ [ "$rc" = 2 ] && <<<"$out" grep -qi 'claude code'; } && ok "even with a (faked) terminal, a process inside a Claude Code session (CLAUDECODE set) is refused" || no "update ran inside a Claude Code session (rc=$rc)" "$out"
[ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W8" ] && [ ! -e "$TALOS_APP_HOME/agent-request.json" ] && ok "none of those refusals changed anything or wrote a restart request" || no "a refused run changed something"
python3 - "$SRC" "$SB" "$K" <<'PY'
import io, json, os, subprocess, sys, tarfile
src, sb, keys = sys.argv[1:4]
ver = "1.8.0-hostile"
def bundle(name, mutate):
    out = os.path.join(sb, "src-" + name); os.makedirs(out, exist_ok=True)
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w:gz") as t:
        def add(ti, data=None):
            t.addfile(ti, io.BytesIO(data) if data is not None else None)
        base = tarfile.TarInfo("talos-kit/.talos-release"); body = b"version=%s\nkind=plugin-release\ncontent_sha256=00\n" % ver.encode(); base.size = len(body); add(base, body)
        mutate(add, t)
    p = os.path.join(out, "talos-kit-%s.tar.gz" % ver); open(p, "wb").write(raw.getvalue())
    subprocess.run(["ssh-keygen", "-q", "-Y", "sign", "-f", os.path.join(keys, "key1"), "-n", "talos-kit-release", p], check=True)
    json.dump({"version": ver, "bundle": os.path.basename(p)}, open(os.path.join(out, "latest.json"), "w"))
def trav(add, t):
    ti = tarfile.TarInfo("talos-kit/../../escaped.txt"); ti.size = 1; add(ti, b"x")
def absolute(add, t):
    ti = tarfile.TarInfo("/tmp/escaped-abs.txt"); ti.size = 1; add(ti, b"x")
def symlink(add, t):
    ti = tarfile.TarInfo("talos-kit/evil"); ti.type = tarfile.SYMTYPE; ti.linkname = "/etc"; add(ti)
def device(add, t):
    ti = tarfile.TarInfo("talos-kit/dev"); ti.type = tarfile.CHRTYPE; add(ti)
def toplevel(add, t):
    ti = tarfile.TarInfo("other/file"); ti.size = 1; add(ti, b"x")
for n, f in (("trav", trav), ("abs", absolute), ("sym", symlink), ("dev", device), ("top", toplevel)):
    bundle(n, f)
PY
for n in trav abs sym dev top; do
  reset_world; : > "$TALOS_TEST_LOG"; W8="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
  out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SB/src-$n" 2>&1)"; rc=$?
  case "$n" in sym|dev) why='not a plain file or folder' ;; *) why='not a plain path' ;; esac
  { [ "$rc" != 0 ] && <<<"$out" grep -q "$why" && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W8" ] && [ ! -e "$SB/escaped.txt" ] && [ ! -e /tmp/escaped-abs.txt ] && [ ! -e "$HOME/escaped.txt" ]; } \
    && ok "a correctly SIGNED but hostile archive ($n: $(printf '%s' "$out" | tail -1 | cut -c1-70)) is refused and nothing outside the release folder is written" || no "hostile archive $n was not refused (rc=$rc)" "$out"
done

lap "before section 9"
# ================================================================ 9. restore
reset_world
( cd "$A" && git init -q . && printf '.talos-pre-plugin/\n' > .gitignore && git add -A >/dev/null 2>&1 && git commit -q -m base ) || echo "git setup failed"
echo "owner persona, edited" > "$A/CLAUDE.md"
out="$(runtty -- "$(BIN)" restore --agent "$A" CLAUDE.md 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cat "$A/CLAUDE.md")" = "owner persona" ] && grep -q 'edited' "$A/CLAUDE.md.bak-restore"* 2>/dev/null; } && ok "restore of a Yours file comes from git (HEAD); the edit it replaced is kept as CLAUDE.md.bak-restore-*" || no "restore CLAUDE.md (rc=$rc)" "$out"
rm -f "$A/memory/note.md"; out="$(runtty -- "$(BIN)" restore --agent "$A" memory/note.md 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cat "$A/memory/note.md")" = "owner note" ]; } && ok "a deleted memory/ note comes back from git" || no "restore of a deleted file (rc=$rc)" "$out"
echo "untracked" > "$A/memory/untracked.md"; out="$(runtty -- "$(BIN)" restore --agent "$A" memory/untracked.md 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ "$(cat "$A/memory/untracked.md")" = "untracked" ] && <<<"$out" grep -qi 'git'; } && ok "a file git never saw is refused with a message (nothing deleted or overwritten)" || no "restore of an untracked file (rc=$rc)" "$out"
cp -p "$SET0" "$SB/settings.good"; python3 "$V/current/talos-kit/scripts/plugin-settings.py" save-last-good --agent "$A" >/dev/null
echo '{"broken": true}' > "$SET0"
out="$(runtty -- "$(BIN)" restore --agent "$A" .claude/settings.json 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && cmp -s "$SET0" "$SB/settings.good" && <<<"$out" grep -qi 'last-good'; } && ok "restore of settings.json (Shared) comes from the app's last-good store, byte for byte; the broken one is kept as .bak-restore-*" || no "restore settings.json (rc=$rc)" "$out"
LG="$(ls "$TALOS_APP_HOME/last-good" | tail -1)"; python3 - "$TALOS_APP_HOME/last-good/$LG/meta.json" "$SB/other-agent" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p)); m["agent_dir"] = sys.argv[2]; json.dump(m, open(p, "w"))
PY
echo '{"broken": 2}' > "$SET0"; out="$(runtty -- "$(BIN)" restore --agent "$A" .claude/settings.json 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && grep -q '"broken": 2' "$SET0"; } && ok "a last-good version saved for ANOTHER agent folder is never used (agent_dir must match)" || no "restored another agent's settings (rc=$rc)" "$out"
rm -f "$A/.claude/rules/talos-defaults.md"; out="$(runtty -- "$(BIN)" restore --agent "$A" .claude/rules/talos-defaults.md 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(sha "$A/.claude/rules/talos-defaults.md")" = "$(sha "$V/current/talos-kit/agent-files/.claude/rules/talos-defaults.md")" ]; } && ok "a Talos file comes from the current release" || no "restore of a Talos file (rc=$rc)" "$out"
for bad in "../outside.txt" "/etc/hosts" ".git/config" "memory/../../x" "-rf" "hooks/session-start.py"; do
  out="$(runtty -- "$(BIN)" restore --agent "$A" -- "$bad" 2>&1)"; rc=$?
  [ "$rc" != 0 ] && ok "restore refuses the path '$bad' (exit $rc)" || no "restore accepted '$bad'" "$out"
done
# a path that leaves the agent folder through a symlink: .claude is a link to a folder outside, and the settings would be restored into it
cp -p "$SB/settings.good" "$SET0"; python3 "$V/current/talos-kit/scripts/plugin-settings.py" save-last-good --agent "$A" >/dev/null      # a good saved copy exists for this agent
mkdir -p "$SB/outside"; mv "$A/.claude" "$SB/claude-real"; ln -s "$SB/outside" "$A/.claude"
out="$(runtty -- "$(BIN)" restore --agent "$A" .claude/settings.json 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ -z "$(ls -A "$SB/outside")" ]; } && ok "a path that leaves the agent folder through a symlink is refused, and nothing was written outside" || no "restore followed a symlink out of the agent folder (rc=$rc)" "$(ls "$SB/outside") $out"
rm "$A/.claude"; mv "$SB/claude-real" "$A/.claude"

lap "before section 10"
# ================================================================ 10. time
reset_world; cat > "$SB/slow.py" <<'PY'
import http.server, socketserver, sys, time
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("latest.json"):
            time.sleep(30)
        self.send_response(404); self.end_headers()
s = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H); s.daemon_threads = True
open(sys.argv[1], "w").write(str(s.server_address[1])); s.serve_forever()
PY
python3 "$SB/slow.py" "$SB/slow.port" & SLOWPID=$!; BG_PIDS="$BG_PIDS $SLOWPID"
for _ in $(seq 1 50); do [ -s "$SB/slow.port" ] && break; sleep 0.1; done
W10="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"; T0=$SECONDS
out="$(TALOS_UPDATE_NET_TIMEOUT=2 runtty -- "$(BIN)" update --agent "$A" --source "http://127.0.0.1:$(cat "$SB/slow.port")/" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && [ $((SECONDS - T0)) -lt 20 ] && <<<"$out" grep -qi 'timed out' && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W10" ]; } \
  && ok "a peer slower than the timeout: the update gives up after the timeout (not 30 s), says 'timed out', exit 1, nothing changed" || no "slow peer (rc=$rc, $((SECONDS - T0)) s)" "$out"
kill "$SLOWPID" 2>/dev/null
out="$(runtty -- "$(BIN)" update --agent "$A" --source "http://example.com/talos/" 2>&1)"; rc=$?; { [ "$rc" != 0 ] && <<<"$out" grep -qi 'https'; } && ok "plain http is refused for any host but loopback (the release signature protects the bundle, not the version check)" || no "plain http to a remote host was attempted (rc=$rc)" "$out"
out="$(TALOS_UPDATE_NET_TIMEOUT=2 runtty -- "$(BIN)" update --agent "$A" --source "http://127.0.0.1:9/" 2>&1)"; rc=$?; [ "$rc" = 1 ] && ok "an unreachable source is exit 1 with the reason, never 'up to date'" || no "unreachable source: rc=$rc" "$out"
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SB/nonexistent" 2>&1)"; rc=$?; { [ "$rc" = 1 ] && ! <<<"$out" grep -qi 'up to date'; } && ok "a source folder that does not exist is an error, not 'up to date'" || no "missing source: rc=$rc" "$out"
# a migration past its limit is stopped with its whole process group, and the update rolls back
reset_world; SRC10="$SB/src10"; publish "1.9.1-slow" key1 "$SRC10" --migration "${D}0040:slow:slow" >/dev/null
out="$(TALOS_UPDATE_STEP_TIMEOUT=3 runtty -- "$(BIN)" update --agent "$A" --source "$SRC10" 2>&1)"; rc=$?
SPID="$(sed -n "s/^up ${D}0040 pid \([0-9]*\)/\1/p" "$TALOS_TEST_LOG" | head -1)"; sleep 0.5
{ [ "$rc" = 1 ] && <<<"$out" grep -qi 'timed out' && [ "$(cur)" = "releases/$V1" ] && [ -n "$SPID" ] && ! alive "$SPID"; } && ok "a migration past the step limit is killed (process gone), the update rolls back to $V1 (exit 1)" || no "slow migration (rc=$rc, pid '$SPID' alive=$(alive "$SPID" && echo yes || echo no))" "$out"
# SIGTERM mid-migration: the child is stopped and the update rolls back
reset_world; touch "$TALOS_TEST_HOLD"
runtty --pidfile "$SB/pid10" -- "$(BIN)" update --agent "$A" --source "$SRC" > "$SB/out10" 2>&1 &
BG10=$!; BG_PIDS="$BG_PIDS $BG10"
for _ in $(seq 1 100); do grep -q "pid" "$TALOS_TEST_LOG" 2>/dev/null && break; sleep 0.1; done
MPID="$(sed -n "s/^up ${D}0001 pid \([0-9]*\)/\1/p" "$TALOS_TEST_LOG" | head -1)"
kill -TERM "$(cat "$SB/pid10")"; wait "$BG10"; rc=$?; sleep 0.3
{ [ "$rc" != 0 ] && [ -n "$MPID" ] && ! alive "$MPID" && [ "$(cur)" = "releases/$V1" ] && [ ! -e "$V/update-journal.json" ] && [ ! -e "$TALOS_APP_HOME/agent-request.json" ]; } \
  && ok "SIGTERM mid-migration (rc=$rc): the migration process is stopped, the update rolled back to $V1, no journal, no restart request" || no "SIGTERM handling (rc=$rc, child alive=$(alive "$MPID" && echo yes || echo no))" "$(cat "$SB/out10")"
rm -f "$TALOS_TEST_HOLD"

lap "before section 11"
# ================================================================ 11. R2-6 reconcile, R2-8 byte-exact down re-run, R2-9 non-guard hooks
PS="$KIT/scripts/plugin-settings.py"
mkrel(){ # mkrel DIR 'python expr building hooks': a release folder with only the settings template and hook files
  mkdir -p "$1/templates/dot-claude" "$1/hooks"; python3 - "$1" "$2" <<'PY'
import json, os, sys
d, spec = sys.argv[1:3]; hooks = json.loads(spec)
t = {"hooks": {}}
for ev, items in hooks.items():
    t["hooks"][ev] = []
    for matcher, script, extra in items:
        e = {"hooks": [{"type": "command", "command": 'python3 "$CLAUDE_PROJECT_DIR/hooks/%s"%s' % (script, extra)}]}
        if matcher: e["matcher"] = matcher
        t["hooks"][ev].append(e)
        open(os.path.join(d, "hooks", script), "w").write("#")
json.dump(t, open(os.path.join(d, "templates/dot-claude/settings.json"), "w"), indent=2)
PY
}
RC="$SB/rc"; rm -rf "$RC"; mkdir -p "$RC/agent/.claude"
mkrel "$RC/old" '{"PreToolUse":[["Bash","guard-a.py",""],["Bash","guard-gone.py",""],["Write","guard-edit.py",""]],"Stop":[["","stop-a.py",""]]}'
mkrel "$RC/new" '{"PreToolUse":[["Bash","guard-a.py",""],["Bash","guard-b.py",""],["Write","guard-edit.py"," --strict"]],"Stop":[["","stop-a.py",""]],"SessionStart":[["startup","boot.py",""]]}'
python3 - "$RC" <<'PY'
import json, sys
rc = sys.argv[1]
t = json.load(open(rc + "/old/templates/dot-claude/settings.json"))
t["permissions"] = {"allow": ["Bash(ls)"]}; t["statusLine"] = {"type": "command", "command": "x"}
t["hooks"]["Stop"].append({"hooks": [{"type": "command", "command": "echo owner"}]})
json.dump(t, open(rc + "/agent/.claude/settings.json", "w"), indent=3)
PY
out="$(python3 "$PS" reconcile --agent "$RC/agent" --old-release "$RC/old" --new-release "$RC/new" --migration t1 2>&1)"; rc=$?
python3 - "$RC/agent/.claude/settings.json" <<'PY' && ok "reconcile (R2-6): adds a new guard, adds a new event, renames an edited command, removes a dropped guard; permissions, statusLine and the owner's own hook untouched" || no "reconcile result wrong (rc=$rc)" "$out"
import json, sys
s = json.load(open(sys.argv[1]))
cmds = {ev: [h["command"] for e in es for h in e["hooks"]] for ev, es in s["hooks"].items()}
assert any("guard-b.py" in c for c in cmds["PreToolUse"]), cmds
assert not any("guard-gone.py" in c for c in cmds["PreToolUse"]), cmds
assert any("guard-edit.py" in c and c.endswith("--strict") for c in cmds["PreToolUse"]), cmds
assert any("boot.py" in c for c in cmds["SessionStart"]), cmds
assert "echo owner" in cmds["Stop"] and s["permissions"] == {"allow": ["Bash(ls)"]} and s["statusLine"]["command"] == "x"
assert sum("guard-a.py" in c for c in cmds["PreToolUse"]) == 1, "guard-a duplicated"
PY
H11="$(sha "$RC/agent/.claude/settings.json")"; out="$(python3 "$PS" reconcile --agent "$RC/agent" --old-release "$RC/old" --new-release "$RC/new" --migration t1 2>&1)"
{ [ "$(sha "$RC/agent/.claude/settings.json")" = "$H11" ] && <<<"$out" grep -qi 'already matches'; } && ok "reconcile twice: the second run changes nothing (file bytes identical) and says so" || no "second reconcile changed the file" "$out"
# an owner-edited kit entry is kept, and said so; an owner-removed one is not put back
python3 - "$RC/agent/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]; s = json.load(open(p))
for es in s["hooks"].values():
    for e in es:
        for h in e["hooks"]:
            if "guard-a.py" in h["command"]: h["command"] += " --owner-flag"
s["hooks"]["Stop"] = [e for e in s["hooks"]["Stop"] if not any("stop-a.py" in h["command"] for h in e["hooks"])]
json.dump(s, open(p, "w"), indent=2)
PY
mkrel "$RC/new2" '{"PreToolUse":[["Bash","guard-a.py"," --v3"],["Bash","guard-b.py",""],["Write","guard-edit.py"," --strict"]],"Stop":[["","stop-a.py",""]],"SessionStart":[["startup","boot.py",""]]}'
out="$(python3 "$PS" reconcile --agent "$RC/agent" --old-release "$RC/new" --new-release "$RC/new2" --migration t2 2>&1)"
python3 - "$RC/agent/.claude/settings.json" <<'PY' && <<<"$out" grep -qi 'kept your' && ok "an entry the owner edited is kept as theirs (and reported); an entry the owner removed stays removed" || no "owner edits not respected" "$out"
import json, sys
s = json.load(open(sys.argv[1])); cmds = [h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"]]
assert any("guard-a.py" in c and c.endswith("--owner-flag") for c in cmds), cmds
assert not any("stop-a.py" in c for c in cmds), cmds
PY
# a settings.json that is not JSON is an error that leaves the file alone
printf 'not json' > "$RC/agent/.claude/settings.json"; out="$(python3 "$PS" reconcile --agent "$RC/agent" --old-release "$RC/old" --new-release "$RC/new" --migration t3 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ "$(cat "$RC/agent/.claude/settings.json")" = "not json" ]; } && ok "reconcile on a settings.json that is not JSON fails (exit $rc) and leaves it alone" || no "reconcile on broken JSON (rc=$rc)" "$out"
# R2-8
R8="$SB/r8"; rm -rf "$R8"; mkdir -p "$R8/agent/.claude" "$R8/rel/hooks"; printf '{ "z": 1,\n   "hooks": {} }\n' > "$R8/agent/.claude/settings.json"; mkdir -p "$R8/kit"
python3 "$PS" to-plugin --agent "$R8/agent" --release "$R8/rel" --kit-home "$R8/kit" --migration m8 >/dev/null 2>&1
cp -p "$R8/agent/.talos-pre-plugin/plugin-move.json" "$R8/state.json"
python3 "$PS" from-plugin --agent "$R8/agent" --migration m8 >/dev/null 2>&1
ORIG="$(sha "$R8/agent/.claude/settings.json")"; [ "$ORIG" = "$(sha "$R8/agent/.claude/settings.json.bak-m8")" ] || echo "   (control: restored bytes differ from the .bak)"
cp "$R8/state.json" "$R8/agent/.talos-pre-plugin/plugin-move.json"      # the crash: settings written back, the record not yet removed
rm -f "$R8/agent/.claude/settings.json.bak-m8-down"
out="$(python3 "$PS" from-plugin --agent "$R8/agent" --migration m8 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(sha "$R8/agent/.claude/settings.json")" = "$ORIG" ] && <<<"$out" grep -qi 'already back' && ! <<<"$out" grep -qi 'had changed since'; } \
  && ok "R2-8: a down re-run after a crash between the settings write and the record removal leaves the original bytes (not re-rendered JSON) and says it was already done" || no "R2-8: down re-run re-rendered settings.json (rc=$rc)" "$out"
# R2-9
R9="$SB/r9"; rm -rf "$R9"; mkdir -p "$R9"; reset_world
for h in hands-free.py channel-debt.py claim-gate.py memory-reflex.py session-start.py agent-log.py; do
  out="$(echo '{}' | CHRONOS_RUN=1 CLAUDE_PROJECT_DIR="$R9/nowhere" python3 "$V/current/talos-kit/hooks/$h" check 2>&1 >/dev/null)"; rc=$?
  [ "$rc" != 2 ] && ok "R2-9: $h with a bad CLAUDE_PROJECT_DIR in an unattended run does not exit 2 (exit $rc), so a Stop hook cannot loop the job" || no "R2-9: $h exits 2 (a Stop hook would block the turn again and again)" "$out"
done
for h in action-rules.py append-only-guard.py timeline-guard.py check-vault.py bsd-sed-guard.py compaction-guard.py; do
  out="$(echo '{}' | CHRONOS_RUN=1 CLAUDE_PROJECT_DIR="$R9/nowhere" python3 "$V/current/talos-kit/hooks/$h" 2>&1 >/dev/null)"; rc=$?
  [ "$rc" = 2 ] && ok "R2-9: the guard $h still fails closed (exit 2) in an unattended run with a bad CLAUDE_PROJECT_DIR" || no "R2-9: guard $h no longer fails closed (exit $rc)" "$out"
done

lap "before section 12"
# ================================================================ 12. app merge, relay skew, retention
APPT="$SB/app"; rm -rf "$APPT"; mkdir -p "$APPT/up"
( cd "$APPT/up" && git init -q -b main . && echo base > file.txt && echo keep > other.txt && git add -A && git commit -q -m base )
git clone -q "$APPT/up" "$APPT/mine"; ( cd "$APPT/mine" && git checkout -q -b mine && echo "my change" > file.txt && git commit -qam mine )
( cd "$APPT/up" && echo "their change" > file.txt && git commit -qam theirs )
( cd "$APPT/mine" && git fetch -q origin main )
reset_world; MH="$(git -C "$APPT/mine" rev-parse HEAD)"; MS="$(git -C "$APPT/mine" status --porcelain)"; W12="$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")"
out="$(upd --app-repo "$APPT/mine" --app-ref origin/main 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && <<<"$out" grep -q 'file.txt' && <<<"$out" grep -qi 'conflict' && [ "$(git -C "$APPT/mine" rev-parse HEAD)" = "$MH" ] && [ -z "$(git -C "$APPT/mine" status --porcelain)" ] \
  && [ "$(cat "$APPT/mine/file.txt")" = "my change" ] && [ "$(git -C "$APPT/mine" worktree list | wc -l | tr -d ' ')" = 1 ] && [ ! -e "$APPT/mine/.git/MERGE_HEAD" ] \
  && [ "$(hash_any "$V" "$A/.claude/settings.json" "$A/hooks" "$A/scripts" "$A/.talos-version")" = "$W12" ]; } \
  && ok "a changed app and a conflicting upstream stops the update (exit 1) before anything swaps: the conflicting file is named, the app's HEAD and files are untouched, the side worktree is gone, the merge is aborted" || no "app conflict handling (rc=$rc)" "$out"
( cd "$APPT/up" && git reset -q --hard HEAD~1 && echo "their other" > other.txt && git commit -qam theirs2 ); ( cd "$APPT/mine" && git fetch -q origin main )
out="$(upd --app-repo "$APPT/mine" --app-ref origin/main 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cat "$APPT/mine/other.txt")" = "their other" ] && [ "$(cat "$APPT/mine/file.txt")" = "my change" ] && [ "$(cur)" = "releases/$V2" ]; } && ok "a clean merge goes through: upstream's change is merged into the app branch and the kit updates" || no "clean app merge (rc=$rc)" "$out"
# relay skew prints the card text and never blocks
reset_world; out="$(upd --relay-version oldrelay 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && <<<"$out" grep -qi 'railway' && <<<"$out" grep -q 'newrelay'; } && ok "relay older than the release's min_relay: the run prints 'update the relay in Railway' and still succeeds" || no "relay skew (rc=$rc)" "$out"
# the newest three releases are kept (never the current one or the one just left)
reset_world; for v in 1.3.1-a 1.3.2-b 1.3.3-c 1.3.4-d; do SRCR="$SB/srcr"; publish "$v" key1 "$SRCR" >/dev/null; runtty -- "$(BIN)" update --agent "$A" --source "$SRCR" >/dev/null 2>&1; done
n="$(ls "$V/releases" | wc -l | tr -d ' ')"
{ [ "$n" = 3 ] && [ "$(cur)" = "releases/1.3.4-d" ] && [ -d "$V/releases/1.3.3-c" ]; } && ok "after four updates exactly the newest three releases remain (current and the previous among them)" || no "retention: $n releases" "$(ls "$V/releases")"
find "$V/releases" -maxdepth 1 -mindepth 1 ! -perm -u+w >/dev/null 2>&1 && ok "releases stay read-only" || no "a release is writable"

# ================================================================ 13. the Opus review
lap "before section 13"
GITA(){ ( cd "$A" && git init -q . && printf '.talos-pre-plugin/\n' > .gitignore && git add -A >/dev/null 2>&1 && git commit -q -m base ); }
# R1-3: restore takes one regular file, never a folder
reset_world; GITA
echo "edited" > "$A/memory/note.md"; echo "edited" > "$A/memory/STATE.md"; mkdir -p "$A/memory/briefs"; echo x > "$A/memory/briefs/b.md"; ( cd "$A" && git add memory/briefs/b.md && git commit -q -m b )
out="$(runtty -- "$(BIN)" restore --agent "$A" memory 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ "$(cat "$A/memory/note.md")" = edited ] && [ "$(cat "$A/memory/STATE.md")" = edited ] && <<<"$out" grep -qi 'not a single file'; } && ok "R1-3: restore of a folder is refused (a git tree is not a file): the owner's edits in it are still there" || no "R1-3: restore of a folder was not refused (rc=$rc)" "$out"
rm -rf "$A/memory/briefs"; out="$(runtty -- "$(BIN)" restore --agent "$A" memory/briefs 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ ! -e "$A/memory/briefs" ]; } && ok "R1-3: a folder that is gone from the disk is not brought back either" || no "R1-3: a deleted folder was restored (rc=$rc)" "$out"
echo "first edit" > "$A/CLAUDE.md"; o1="$(runtty -- "$(BIN)" restore --agent "$A" CLAUDE.md 2>&1)"; echo "second edit" > "$A/CLAUDE.md"; o2="$(runtty -- "$(BIN)" restore --agent "$A" CLAUDE.md 2>&1)"
{ [ "$(ls "$A"/CLAUDE.md.bak-restore-* 2>/dev/null | wc -l | tr -d ' ')" = 2 ] && grep -q 'first edit' "$A"/CLAUDE.md.bak-restore-* && grep -q 'second edit' "$A"/CLAUDE.md.bak-restore-*; } && ok "R1-3: every restore writes its own backup first (two restores in one second keep both edits)" || no "R1-3: a backup was overwritten" "$o1 / $o2 / $(ls "$A" | grep CLAUDE)"

# a Talos file whose place has been taken by a folder is not "restored" over it either
rm -f "$A/.claude/rules/talos-defaults.md"; mkdir -p "$A/.claude/rules/talos-defaults.md"; echo keep > "$A/.claude/rules/talos-defaults.md/mine.txt"
out="$(runtty -- "$(BIN)" restore --agent "$A" .claude/rules/talos-defaults.md 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && [ -f "$A/.claude/rules/talos-defaults.md/mine.txt" ] && <<<"$out" grep -q 'not a single file' && ! <<<"$out" grep -q Traceback; } && ok "R1-3: a folder where a Talos file belongs is refused with a plain message, and nothing in it is touched" || no "R1-3: a folder was replaced by a restore (rc=$rc)" "$out"
rm -rf "$A/.claude/rules/talos-defaults.md"

# R1-4: update, rollback, update: no backup is ever overwritten
reset_world; echo "# edit one" >> "$A/wiki/README.md"; runtty -- "$(BIN)" update --agent "$A" --source "$SRC" >/dev/null 2>&1
echo "# edit two" >> "$A/wiki/README.md"; runtty -- "$(BIN)" rollback --agent "$A" >/dev/null 2>&1
echo "# edit three" >> "$A/wiki/README.md"; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && ( for e in one two three; do grep -q "# edit $e" "$A"/wiki/README.md.bak-* || exit 1; done ) && ! grep -q '# edit' "$A/wiki/README.md"; } && ok "R1-4: update, rollback, update: all three of the owner's edits survive in separate backups; no backup was overwritten" || no "R1-4: an owner's edit was lost (rc=$rc)" "$(ls "$A/wiki")"

# R1-6: two agents share `current`: A's update does not strand B
reset_world; B="$HOME/agentB"; bash "$SB/kit1/install.sh" --agent-dir "$B" --no-chronos >/dev/null 2>&1
runtty -- "$(BIN)" update --agent "$A" --source "$SRC" >/dev/null 2>&1; : > "$TALOS_TEST_LOG"
out="$(runtty -- "$(BIN)" update --agent "$B" --source "$SRC" 2>&1)"; rc=$?
python3 - "$B" "$V2" "${D}0002-second" <<'EOFPY' && okB=1 || okB=0
import json, sys
b, ver, mig = sys.argv[1:4]
m = dict(l.strip().split("=", 1) for l in open(b + "/.talos-version") if "=" in l and not l.startswith("#"))
assert m["version"] == ver and m["migration"] == mig, m
s = json.load(open(b + "/.claude/settings.json"))
assert any("new-guard.py" in h["command"] for es in s["hooks"].values() for e in es for h in e["hooks"]), "hook list not reconciled"
EOFPY
{ [ "$rc" = 0 ] && [ "$okB" = 1 ] && ! <<<"$out" grep -qi 'already up to date' && [ "$(cur)" = "releases/$V2" ]; } && ok "R1-6: agent B, whose marker lagged the shared current, was brought up to date (migrations, hook list, marker); it was not told 'already up to date'" || no "R1-6: agent B was left behind (rc=$rc)" "$out"
out="$(runtty -- "$(BIN)" update --agent "$B" --source "$SRC" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && <<<"$out" grep -qi 'already up to date'; } && ok "R1-6: once caught up, B really is up to date" || no "R1-6: second run for B (rc=$rc)" "$out"

# R1-7: rollback with a journal of another agent is refused
reset_world; B="$HOME/agentB"; bash "$SB/kit1/install.sh" --agent-dir "$B" --no-chronos >/dev/null 2>&1
TALOS_UPDATE_DIE_AT=migrate runtty -- "$(BIN)" update --agent "$A" --source "$SRC" >/dev/null 2>&1; W13="$(hash_any "$V" "$B/.claude/settings.json" "$B/.talos-version")"
out="$(runtty -- "$(BIN)" rollback --agent "$B" 2>&1)"; rc=$?
{ [ "$rc" = 2 ] && <<<"$out" grep -qi 'another agent' && [ "$(hash_any "$V" "$B/.claude/settings.json" "$B/.talos-version")" = "$W13" ]; } && ok "R1-7: talos rollback --agent B with A's interrupted update waiting is refused (exit 2), nothing changed" || no "R1-7: rollback for another agent's journal went ahead (rc=$rc)" "$out"

# R1-8: a migration that fails half way is undone with its own down
reset_world; SRC13="$SB/src13"; publish "1.6.0-half" key1 "$SRC13" --migration "${D}0050:half:half" >/dev/null
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC13" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && [ "$(tr '\n' ',' < "$TALOS_TEST_LOG")" = "up ${D}0050,down ${D}0050," ] && [ ! -e "$TALOS_TEST_LOG.half" ] && [ "$(cur)" = "releases/$V1" ]; } && ok "R1-8: a migration whose up failed after leaving a file behind has its own down run (the file is gone), then the update rolls back" || no "R1-8: half-done migration not undone (rc=$rc)" "$(cat "$TALOS_TEST_LOG") $out"

# R1-10: with --live a deletion under memory/ still fails the update
reset_world; SRC13="$SB/src13d"; publish "1.6.1-del" key1 "$SRC13" --migration "${D}0060:del:delmem" >/dev/null
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC13" 2>&1)"; rc=$?
{ [ "$rc" = 1 ] && <<<"$out" grep -q 'memory/note.md' && <<<"$out" grep -qi 'deleted' && [ "$(cur)" = "releases/$V1" ]; } && ok "R1-10: a migration that deletes a file under memory/ is caught even in --live mode: the update fails and rolls back, the message names the file" || no "R1-10: a deletion under memory/ went unnoticed (rc=$rc)" "$out"

# R1-9: trust-key, the one way a first signing key reaches an existing install
reset_world; KF="$K/key2.pub"; SRC13="$SB/src13k"; publish "1.6.2-k2" key2 "$SRC13" >/dev/null
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC13" 2>&1)"; rc=$?; [ "$rc" != 0 ] && ok "R1-9: before trusting it, a release signed by key2 is refused" || no "R1-9: untrusted key accepted"
out="$("$(BIN)" trust-key "$KF" </dev/null 2>&1)"; rc=$?; { [ "$rc" = 2 ] && [ ! -e "$V/trusted_signers" ]; } && ok "R1-9: trust-key without a terminal is refused (exit 2)" || no "R1-9: trust-key ran without a terminal (rc=$rc)" "$out"
out="$(CLAUDECODE=1 runtty --send y -- "$(BIN)" trust-key "$KF" 2>&1)"; rc=$?; { [ "$rc" = 2 ] && [ ! -e "$V/trusted_signers" ]; } && ok "R1-9: trust-key inside a Claude Code session is refused" || no "R1-9: trust-key ran inside a Claude Code session (rc=$rc)" "$out"
out="$(runtty --send n -- "$(BIN)" trust-key "$KF" 2>&1)"; rc=$?; { [ "$rc" = 1 ] && [ ! -e "$V/trusted_signers" ] && <<<"$out" grep -q 'SHA256:'; } && ok "R1-9: trust-key shows the fingerprint and, answered n, adds nothing (exit 1)" || no "R1-9: declined trust-key (rc=$rc)" "$out"
for bad in "$K/key2" "$A/CLAUDE.md"; do out="$(runtty --send y -- "$(BIN)" trust-key "$bad" 2>&1)"; rc=$?; { [ "$rc" != 0 ] && [ ! -e "$V/trusted_signers" ]; } && ok "R1-9: trust-key refuses ${bad##*/} (a private key or not a key)" || no "R1-9: trust-key accepted ${bad##*/}" "$out"; done
cat "$K/key1.pub" "$K/key2.pub" > "$SB/two.pub"; out="$(runtty --send y -- "$(BIN)" trust-key "$SB/two.pub" 2>&1)"; rc=$?; { [ "$rc" != 0 ] && [ ! -e "$V/trusted_signers" ]; } && ok "R1-9: a file with two keys is refused (one key, one decision)" || no "R1-9: two keys accepted" "$out"
out="$(runtty --send y -- "$(BIN)" trust-key "$KF" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && grep -q 'namespaces="talos-kit-release"' "$V/trusted_signers" && [ "$(stat -f %Lp "$V/trusted_signers" 2>/dev/null || stat -c %a "$V/trusted_signers")" = 600 ]; } && ok "R1-9: answered y, trust-key records the key in VENDOR/trusted_signers (mode 600), outside the immutable release" || no "R1-9: trust-key y (rc=$rc)" "$out"
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC13" 2>&1)"; rc=$?; { [ "$rc" = 0 ] && [ "$(cur)" = "releases/1.6.2-k2" ]; } && ok "R1-9: after trust-key, the key2 release installs: the first key needs no reinstall" || no "R1-9: trusted key2 release did not install (rc=$rc)" "$out"
[ -z "$(find "$V/releases" -name trusted_signers)" ] && ok "R1-9: no release was modified to add the key" || no "R1-9: a release holds trusted_signers"

# (a) SessionStart: the live release must still match its recorded content hash
reset_world
ss(){ ( cd "$A" && echo '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ); }
ss | grep -q 'RELEASE INTEGRITY' && no "(a) a pristine release warned" || ok "(a) SessionStart: an untouched release gives no integrity warning"
chmod -R u+w "$V/releases/$V1"; echo "# tampered" >> "$V/releases/$V1/talos-kit/hooks/action-rules.py"
ss | grep -q 'RELEASE INTEGRITY' && ss | grep -q 'does not match' && ok "(a) SessionStart: a release file changed after it was signed and installed is announced at the top of the session context" || no "(a) a tampered release was not announced"

# R1-11: a pre-release sorts before its final release
python3 - "$KIT/scripts/plugin-release.py" <<'EOFPY' && ok "R1-11: version order: 1.5.0-rc1 < 1.5.0 < 1.5.1-rc1; 1.10.0 > 1.9.0; 1.3.0-test > 1.2.0-cli" || no "R1-11: pre-release ordering is wrong"
import importlib.util, sys
spec = importlib.util.spec_from_file_location("pr", sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
k = m.version_key
assert k("1.5.0-rc1") < k("1.5.0") < k("1.5.1-rc1") and k("1.10.0") > k("1.9.0") and k("1.3.0-test") > k("1.2.0-cli") and k("1.5.0-rc1") < k("1.5.0-rc2")
EOFPY
reset_world; SRCR="$SB/srcrc"; publish "1.7.0-rc1" key1 "$SRCR" >/dev/null; runtty -- "$(BIN)" update --agent "$A" --source "$SRCR" >/dev/null 2>&1
publish "1.7.0" key1 "$SRCR" >/dev/null; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRCR" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/1.7.0" ]; } && ok "R1-11: from 1.7.0-rc1 the final 1.7.0 is an update" || no "R1-11: 1.7.0 was not offered after 1.7.0-rc1 (rc=$rc)" "$out"
python3 - "$SRCR" <<'EOFPY'
import json, sys
json.dump({"version": "1.7.0-rc1", "bundle": "talos-kit-1.7.0-rc1.tar.gz"}, open(sys.argv[1] + "/latest.json", "w"))
EOFPY
out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRCR" 2>&1)"; rc=$?; { [ "$rc" = 0 ] && <<<"$out" grep -qi 'not newer' && [ "$(cur)" = "releases/1.7.0" ]; } && ok "R1-11: the pre-release is not offered once the final is installed" || no "R1-11: rc1 replaced the final (rc=$rc)" "$out"

# R1-13: the bytes that were verified are the bytes that are unpacked
python3 - "$KIT/scripts" "$SRC" "$K" <<'EOFPY' && ok "R1-13: unpack_verified refuses bytes the signature does not cover and extracts nothing; it unpacks exactly the bytes it verified" || no "R1-13: verified and unpacked bytes can differ"
import os, sys, tempfile
scripts, src, keys = sys.argv[1:4]
sys.path.insert(0, scripts)
sys.dont_write_bytecode = True
import importlib.util
spec = importlib.util.spec_from_file_location("tu", os.path.join(scripts, "talos-update.py")); tu = importlib.util.module_from_spec(spec); spec.loader.exec_module(tu)
data = open(os.path.join(src, "talos-kit-1.3.0-test.tar.gz"), "rb").read(); sig = open(os.path.join(src, "talos-kit-1.3.0-test.tar.gz.sig"), "rb").read()
d = tempfile.mkdtemp(); allowed = os.path.join(keys, "allowed1")
bad = bytearray(data); bad[len(bad) // 2] ^= 1
stage = os.path.join(d, "bad")
try:
    tu.unpack_verified(bytes(bad), sig, allowed, "x.tar.gz", stage); raise SystemExit("tampered bytes were accepted")
except tu.Stop:
    assert not os.path.exists(stage), "something was extracted from unverified bytes"
good = tu.unpack_verified(data, sig, allowed, "x.tar.gz", os.path.join(d, "good"))
assert os.path.isfile(os.path.join(good, ".talos-release"))
EOFPY

# ================================================================ 14. the one-check (R2-1, R2-2, R2-3)
lap "before section 14"
two_agents(){ reset_world; B="$HOME/agentB"; bash "$SB/kit1/install.sh" --agent-dir "$B" --no-chronos >/dev/null 2>&1
  runtty -- "$(BIN)" update --agent "$A" --source "$SRC" >/dev/null 2>&1; runtty -- "$(BIN)" update --agent "$B" --source "$SRC" >/dev/null 2>&1; : > "$TALOS_TEST_LOG"; }
mv_of(){ sed -n 's/^version=//p' "$1/.talos-version"; }
# R2-1 order 1: A first. A is not left to strand B: current stays for B until B is rolled back too; the last agent swaps
two_agents
out="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V2" ] && [ "$(mv_of "$A")" = "$V1" ] && [ "$(mv_of "$B")" = "$V2" ] && <<<"$out" grep -q "Agent $B is on $V2" && <<<"$out" grep -q "rollback --agent $B"; } && ok "R2-1: rolling back A while B is on $V2 leaves current alone (B still needs it), says so and names the command for B" || no "R2-1: A's rollback stranded B or stayed silent (rc=$rc)" "$out"
out="$(runtty -- "$(BIN)" rollback --agent "$B" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V1" ] && [ "$(mv_of "$A")" = "$V1" ] && [ "$(mv_of "$B")" = "$V1" ] && [ "$(sed -n 's/^migration=//p' "$B/.talos-version")" = "$(sed -n 's/^migration=//p' "$A/.talos-version")" ]; } && ok "R2-1: then B's rollback is the last one: it swaps current back, and both agents are on $V1 with the same migration marker" || no "R2-1: the last rollback did not finish the job (rc=$rc)" "$out"
# order 2: B first
two_agents
out="$(runtty -- "$(BIN)" rollback --agent "$B" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V2" ] && [ "$(mv_of "$B")" = "$V1" ] && [ "$(mv_of "$A")" = "$V2" ] && <<<"$out" grep -q "Agent $A is on $V2"; } && ok "R2-1: the other order: B first leaves current for A" || no "R2-1: B-first rollback (rc=$rc)" "$out"
out="$(runtty -- "$(BIN)" rollback --agent "$A" 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(cur)" = "releases/$V1" ] && [ "$(mv_of "$A")" = "$V1" ] && [ "$(mv_of "$B")" = "$V1" ]; } && ok "R2-1: and A, the last, swaps current: both on $V1" || no "R2-1: A's final rollback (rc=$rc)" "$out"
[ "$(grep -c '^down ' "$TALOS_TEST_LOG")" = 4 ] && ok "R2-1: each agent's own migrations were undone exactly once (4 downs in all, 2 per agent)" || no "R2-1: down count" "$(cat "$TALOS_TEST_LOG")"

# R2-2: trusted_signers must be mode 600, ours, and only the lines trust-key writes
reset_world; SRC14="$SB/src14"; publish "1.6.3-k2" key2 "$SRC14" >/dev/null; runtty --send y -- "$(BIN)" trust-key "$K/key2.pub" >/dev/null 2>&1
TS="$V/trusted_signers"; W14="$(hash_any "$V" "$A/.talos-version")"
chmod 644 "$TS"; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC14" 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && <<<"$out" grep -q 'trusted_signers' && <<<"$out" grep -qi 'mode 600' && [ "$(cur)" = "releases/$V1" ]; } && ok "R2-2: a trusted_signers that is not mode 600 is refused, and says why" || no "R2-2: a group-readable trusted_signers was used (rc=$rc)" "$out"
chmod 600 "$TS"; echo 'x namespaces="talos-kit-release" ssh-ed25519 AAAA' >> "$TS"; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC14" 2>&1)"; rc=$?
{ [ "$rc" != 0 ] && <<<"$out" grep -qi 'format' && [ "$(cur)" = "releases/$V1" ]; } && ok "R2-2: a line trust-key would not have written (another principal) refuses the whole file" || no "R2-2: a foreign line in trusted_signers was used (rc=$rc)" "$out"
printf '%s\n' "$(sed -n 1p "$TS")" > "$SB/ts.one"; cp "$SB/ts.one" "$TS"; chmod 600 "$TS"; printf '# comment\n' >> "$TS"; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC14" 2>&1)"; rc=$?
[ "$rc" != 0 ] && ok "R2-2: even a comment line is refused: exactly the format trust-key writes" || no "R2-2: a comment line was accepted"
cp "$SB/ts.one" "$TS"; chmod 600 "$TS"; out="$(runtty -- "$(BIN)" update --agent "$A" --source "$SRC14" 2>&1)"; rc=$?; { [ "$rc" = 0 ] && [ "$(cur)" = "releases/1.6.3-k2" ]; } && ok "R2-2: the untouched file works" || no "R2-2: the good file was refused (rc=$rc)" "$out"
# the SessionStart notice: once per change
reset_world; runtty --send y -- "$(BIN)" trust-key "$K/key2.pub" >/dev/null 2>&1
ss(){ ( cd "$A" && echo '{"source":"startup"}' | CLAUDE_PROJECT_DIR="$A" python3 hooks/session-start.py 2>/dev/null ); }
ss | grep -q 'TRUSTED SIGNING KEYS' && ss | grep -q 'TRUSTED SIGNING KEYS' && no "R2-2: the notice repeats every session" || ok "R2-2: the first session after trusted_signers changed passes a one-line notice (and the next one does not repeat it)"
reset_world; runtty --send y -- "$(BIN)" trust-key "$K/key2.pub" >/dev/null 2>&1; n="$(ss | python3 -c 'import json,sys; c=json.load(sys.stdin)["hookSpecificOutput"]["additionalContext"]; print(c[c.index("TRUSTED SIGNING KEYS"):].split("\n")[0])')"
<<<"$n" grep -q 'SHA256:' && ok "R2-2: the notice is one line and carries the key fingerprint" || no "R2-2: notice has no fingerprint" "$n"

# R2-3: if undoing a failed catch-up fails, it is HALF, never "as it was"
reset_world; B="$HOME/agentB"; bash "$SB/kit1/install.sh" --agent-dir "$B" --no-chronos >/dev/null 2>&1; SRC14="$SB/src14b"
publish "1.6.4-bd" key1 "$SRC14" --migration "${D}0070:one:baddownb" --migration "${D}0071:two:failupb" >/dev/null
runtty -- "$(BIN)" update --agent "$A" --source "$SRC14" >/dev/null 2>&1; : > "$TALOS_TEST_LOG"
out="$(runtty -- "$(BIN)" update --agent "$B" --source "$SRC14" 2>&1)"; rc=$?
{ [ "$rc" = 4 ] && <<<"$out" grep -qi 'undoing it failed' && ! <<<"$out" grep -q 'as it was'; } && ok "R2-3: a catch-up whose undo fails exits 4 (HALF) and does not claim the folder is as it was" || no "R2-3: failed undo reported as success (rc=$rc)" "$out"

export HOME="$REALHOME"
echo "  update: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
