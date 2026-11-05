#!/usr/bin/env bash
# Talos installer: a working agent from a fresh clone of this repo.
#
#   ./install.sh [--agent-dir PATH] [--no-app] [--dry-run] [--yes] [--with-chronos] [--repoint]
#
#   --agent-dir PATH  where the agent lives (default ~/talos-agent). Must be new, empty, or already a Talos agent.
#                     Any other non-empty folder is refused, and an existing CLAUDE.md is never overwritten.
#   --no-app          terminal only: skip the Mac menu-bar app (the only mode on Linux)
#   --dry-run         print every step and change nothing
#   --yes             no confirmation prompt (required when there is no terminal to ask on)
#   --repoint         an agent whose .mcp.json or start-talos.sh points at ANOTHER clone of this repo is refused unless you
#                     pass this; it then points both at this clone
#   --with-chronos    also install Chronos, the scheduler (macOS; fetches it from GitHub). Off by default.
#
# Steps: prerequisites; JS dependencies of this clone; the agent folder (the kit, default CLAUDE.md); a first git commit
# there; the talos-app MCP server for that folder; a launch script that loads the Talos mod with --plugin-dir; the Mac app
# and, only if the app is not running and the file already exists, its desktop.json (agent folder plus the same --plugin-dir
# and channel flags); otherwise the exact Settings change is printed for you to make. The Mac app is never quit by this script.
# The installer never deletes anything inside an agent folder. A failed kit copy is left for you to move aside.
# Run it twice and the second run changes nothing and says so. A failed step stops and says what was already done.
#
# Exit codes: 0 ok, 1 a step failed or the folder was refused, 2 bad usage or app not possible here, 3 missing prerequisites.
# Test hooks (not for normal use): TALOS_INSTALL_OS overrides `uname -s`; TALOS_INSTALL_DESKTOP_SCRIPTS overrides
# apps/desktop/scripts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$REPO/kit"
MOD="$REPO/plugins/talos-app-mod"
CLI=(bun run "$REPO/apps/bridge/src/cli.ts")
DESKTOP="${TALOS_INSTALL_DESKTOP_SCRIPTS:-$REPO/apps/desktop/scripts}"
OS="${TALOS_INSTALL_OS:-$(uname -s)}"

AGENT_DIR="$HOME/talos-agent"; WANT_APP=1; DRY=0; YES=0; CHRONOS=0; REPOINT=0
usage() { awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) [ $# -ge 2 ] || { echo "--agent-dir needs a path" >&2; exit 2; }; AGENT_DIR="$2"; shift 2 ;;
    --no-app) WANT_APP=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --with-chronos) CHRONOS=1; shift ;;
    --repoint) REPOINT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

DONE=()      # steps that changed something
CHANGED=0
CURRENT="starting"
say()  { printf '%s\n' "$*"; }
step() { CURRENT="$1"; printf '\n== %s\n' "$1"; }
plan() { printf '   would: %s\n' "$*"; }
skip() { printf '   ok, already done: %s\n' "$*"; }
did()  { CHANGED=1; DONE+=("$1"); }
fail() {
  local code="$1"; shift
  printf '\nFAILED at "%s": %s\n' "$CURRENT" "$*" >&2
  if [ ${#DONE[@]} -gt 0 ]; then printf 'Already done (left in place): %s\n' "$(IFS=';'; echo "${DONE[*]}")" >&2
  else echo "Nothing had been changed yet." >&2; fi
  echo "Fix the problem and run ./install.sh again; finished steps are skipped." >&2
  exit "$code"
}

case "$AGENT_DIR" in "~"|"~/"*) AGENT_DIR="$HOME${AGENT_DIR#\~}" ;; esac
case "$AGENT_DIR" in /*) ;; *) AGENT_DIR="$PWD/$AGENT_DIR" ;; esac

if [ "$WANT_APP" = 1 ] && [ "$OS" != Darwin ]; then
  echo "The Mac app needs macOS; this is $OS. Run ./install.sh --no-app for the terminal-only install." >&2
  exit 2
fi
[ "$DRY" = 1 ] && say "DRY RUN: nothing will be changed."

# ---------------------------------------------------------------- 1. prerequisites
step "1/7 Prerequisites"
MISSING=()
need() { # name, hint
  if command -v "$1" >/dev/null 2>&1; then say "   found $1: $(command -v "$1")"
  else say "   MISSING $1"; MISSING+=("$1: $2"); fi
}
need git "install git (macOS: xcode-select --install; Linux: your package manager)"
need python3 "install Python 3.9 or newer (macOS: xcode-select --install; Linux: your package manager)"
need node "install Node 24 (https://nodejs.org or a version manager)"
need pnpm "run: corepack enable   (corepack ships with Node; or npm install -g pnpm)"
need bun "install Bun 1.3 or newer: https://bun.sh"
need claude "install Claude Code: https://claude.com/claude-code, then run claude once to sign in"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  case "$NODE_MAJOR" in ''|*[!0-9]*) NODE_MAJOR=0 ;; esac
  [ "$NODE_MAJOR" -ge 24 ] || [ "$NODE_MAJOR" = 0 ] || say "   note: this repo targets Node 24; you have Node $NODE_MAJOR"
fi
if [ "$WANT_APP" = 1 ]; then
  need swift "install the Xcode command line tools: xcode-select --install"
  if command -v xcode-select >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then say "   found Xcode command line tools"
  else say "   MISSING Xcode command line tools"; MISSING+=("xcode tools: run xcode-select --install and accept the dialog (it can take a while)"); fi
fi
[ -d "$MOD" ] || MISSING+=("the Talos mod folder $MOD is not in this clone: re-clone the repo")
[ -d "$KIT" ] || MISSING+=("the kit folder $KIT is not in this clone: re-clone the repo")
if [ ${#MISSING[@]} -gt 0 ]; then
  printf '\nCannot continue. Missing:\n' >&2
  for m in "${MISSING[@]}"; do printf '  - %s\n' "$m" >&2; done
  echo "Install what is listed, then run ./install.sh again. Nothing was changed." >&2
  exit 3
fi

# ---------------------------------------------------------------- 2. the agent folder is safe to use
step "2/7 Agent folder"
say "   $AGENT_DIR"
PARENT="$(dirname "$AGENT_DIR")"
case "$AGENT_DIR/" in "$REPO"/*) fail 1 "the agent folder cannot be inside this clone ($REPO); memory must not live in a git checkout with a remote." ;; esac
case "$REPO/" in "$AGENT_DIR"/*) fail 1 "the agent folder cannot contain this clone." ;; esac
ALREADY=0; VERIFY_WARNED=0
if [ -e "$AGENT_DIR" ]; then
  [ -d "$AGENT_DIR" ] || fail 1 "$AGENT_DIR exists and is not a folder."
  if [ -f "$AGENT_DIR/.talos-version" ]; then ALREADY=1; say "   already a Talos agent (.talos-version found); it will not be reinstalled and CLAUDE.md is left as it is."
  elif [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null | grep -v '^\.DS_Store$' || true)" ]; then
    # Never resumed and never cleared: a half-copied folder looks exactly like somebody's own, so the owner moves it aside.
    fail 1 "$AGENT_DIR exists, is not empty and is not a Talos agent. Nothing was touched. Pick a new folder with --agent-dir. If it is a partial copy from an earlier run of this script, move it aside (for example: mv $AGENT_DIR $AGENT_DIR.partial) and run ./install.sh again."
  else say "   exists and is empty"; fi
else say "   does not exist yet"; fi

# An existing agent that points at ANOTHER clone of this repo is not silently moved to this one. Fails closed: if either
# file is there but cannot be read or understood, that counts as "unknown" and is refused too, unless --repoint is given.
if [ "$ALREADY" = 1 ] && [ "$REPOINT" != 1 ]; then
  OTHER="$(AGENT_DIR="$AGENT_DIR" REPO="$REPO" python3 - <<'PYEOF' || echo "check: the clone check itself crashed"
import json, os
agent, repo = os.environ["AGENT_DIR"], os.environ["REPO"]
real = os.path.realpath
mine = real(os.path.join(repo, "apps", "bridge"))
out = []
# .mcp.json: the talos-app server --cwd argument. No file, or no talos-app entry, means nothing points anywhere yet.
f = os.path.join(agent, ".mcp.json")
if os.path.lexists(f):
    try:
        entry = json.load(open(f))["mcpServers"].get("talos-app")
        if entry is not None:
            a = entry["args"]
            if not isinstance(a, list):
                raise ValueError("args is not a list")
            i = a.index("--cwd")
            cwd = a[i + 1]
            if not isinstance(cwd, str) or not cwd:
                raise ValueError("--cwd has no folder")
            if real(cwd) != mine:
                out.append(".mcp.json: " + cwd)
    except Exception as e:
        out.append(".mcp.json: cannot tell which clone it points at (" + type(e).__name__ + ")")
# start-talos.sh: the "# talos-clone: <path>" comment this installer writes. A launch script that is not ours is not checked.
f = os.path.join(agent, "start-talos.sh")
if os.path.lexists(f):
    try:
        text = open(f).read()
        if "Written by the Talos install.sh." in text:
            lines = [l[len("# talos-clone: "):] for l in text.split("\n") if l.startswith("# talos-clone: ")]
            if len(lines) != 1 or not lines[0]:
                raise ValueError("no single talos-clone line")
            if real(lines[0]) != real(repo):
                out.append("start-talos.sh: " + lines[0])
    except Exception as e:
        out.append("start-talos.sh: cannot tell which clone it points at (" + type(e).__name__ + ")")
for l in out:
    print(l)
PYEOF
)"
  if [ -n "$OTHER" ]; then
    printf '%s\n' "$OTHER" >&2
    fail 1 "this agent is set up from a different clone of the repo, or this installer cannot tell which (listed above). This clone is $REPO. Nothing was changed. To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at."
  fi
fi

if [ "$DRY" != 1 ] && [ "$YES" != 1 ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\nInstall Talos into %s? [y/N] ' "$AGENT_DIR"
    read -r reply || reply=n
    case "$reply" in y|Y|yes|YES) ;; *) echo "Stopped. Nothing was changed."; exit 1 ;; esac
  else
    echo "There is no terminal to ask on, so this will not go ahead silently. Run ./install.sh --yes to confirm, or --dry-run to preview. Nothing was changed." >&2
    exit 2
  fi
fi

# ---------------------------------------------------------------- 3. dependencies of this clone
step "3/7 Dependencies of this clone"
if [ -d "$REPO/node_modules" ] && [ -d "$REPO/apps/bridge/node_modules" ]; then skip "pnpm install (node_modules present)"
elif [ "$DRY" = 1 ]; then plan "pnpm install --frozen-lockfile in $REPO"
else
  (cd "$REPO" && pnpm install --frozen-lockfile) || fail 1 "pnpm install --frozen-lockfile failed in $REPO."
  did "installed dependencies"
fi

# ---------------------------------------------------------------- 4. the kit
step "4/7 The agent (kit, default CLAUDE.md, first commit)"
if [ "$ALREADY" = 1 ]; then skip "the kit is installed in $AGENT_DIR"
elif [ "$DRY" = 1 ]; then
  plan "bash kit/install.sh --agent-dir $AGENT_DIR$([ "$CHRONOS" = 1 ] || echo ' --no-chronos')   (builds the Talos plugin release under ~/.local/share/talos/kit, copies the data and docs, renders the default CLAUDE.md)"
else
  mkdir -p "$PARENT" || fail 1 "could not create $PARENT."
  KARGS=(--agent-dir "$AGENT_DIR"); [ "$CHRONOS" = 1 ] || KARGS+=(--no-chronos)
  if ! bash "$KIT/install.sh" "${KARGS[@]}"; then
    if [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null || true)" ]; then
      did "started copying the kit into $AGENT_DIR (it holds a partial copy)"
      fail 1 "The kit copy stopped part-way. $AGENT_DIR now holds a partial copy. Move it aside (for example: mv $AGENT_DIR $AGENT_DIR.partial) and run ./install.sh again."
    fi
    fail 1 "the kit installer failed before copying anything (its output is above). Fix that, then run ./install.sh again."
  fi
  did "installed the kit into $AGENT_DIR"
fi
HAS_COMMIT=0
if [ "$DRY" != 1 ] && [ -d "$AGENT_DIR/.git" ] && git -C "$AGENT_DIR" rev-parse --verify -q HEAD >/dev/null 2>&1; then HAS_COMMIT=1; fi
if [ "$HAS_COMMIT" = 1 ]; then skip "git repository with a first commit in the agent folder"
elif [ "$DRY" = 1 ]; then plan "git init + a first commit in $AGENT_DIR (the kit's verify-install asks for it)"
else
  GIT_ID=()
  [ -n "$(git config user.name 2>/dev/null)" ] || GIT_ID+=(-c user.name=Talos)
  [ -n "$(git config user.email 2>/dev/null)" ] || GIT_ID+=(-c user.email=talos@example.com)
  if [ ! -d "$AGENT_DIR/.git" ]; then
    ( cd "$AGENT_DIR" && git init -q ) || fail 1 "git init failed in $AGENT_DIR."
    did "ran git init in $AGENT_DIR"
  fi
  ( cd "$AGENT_DIR" && git add memory wiki .claude CLAUDE.md && git ${GIT_ID[@]+"${GIT_ID[@]}"} commit -qm "day zero" ) \
    || fail 1 "the first commit failed in $AGENT_DIR (git init had already run there; the folder has no commits yet). Fix git, then run ./install.sh again: it retries the commit."
  did "first git commit in $AGENT_DIR"
fi
# A fresh install must pass verify-install. An agent that existed before this run may have been tuned by its owner
# (a rewritten CLAUDE.md, an edited hook): its failures are reported as warnings and do not stop the install.
if [ "$DRY" = 1 ]; then plan "bash $AGENT_DIR/scripts/verify-install.sh$([ "$ALREADY" = 1 ] && echo '   (warnings only: the agent already existed)')"
else
  VLOG="$(mktemp)" || fail 1 "mktemp failed, so verify-install.sh could not be run."
  if ! bash "$AGENT_DIR/scripts/verify-install.sh" >"$VLOG" 2>&1; then
    if [ "$ALREADY" = 1 ]; then
      { printf '   WARNING: the kit'"'"'s verify-install.sh reports problems in %s (an agent that existed before this run, so the install goes on):\n' "$AGENT_DIR"
        sed $'s/\x1b\\[[0-9;]*m//g' "$VLOG" | grep FAIL | sed 's/^/     /' || true; } >&2
      echo "   WARNING: see above; run bash $AGENT_DIR/scripts/verify-install.sh for the detail."
      VERIFY_WARNED=1
    else
      sed $'s/\x1b\\[[0-9;]*m//g' "$VLOG" | grep FAIL >&2 || true; rm -f "$VLOG"
      fail 1 "the kit's verify-install.sh reports problems in $AGENT_DIR."
    fi
  else say "   verify-install.sh: all checks pass"; fi
  rm -f "$VLOG"
fi

# ---------------------------------------------------------------- 5. MCP server
step "5/7 The talos-app MCP server for this folder"
if [ "$DRY" = 1 ]; then plan "talos-app install-mcp --agent-dir $AGENT_DIR   (writes $AGENT_DIR/.mcp.json)"
else
  OUT="$("${CLI[@]}" install-mcp --agent-dir "$AGENT_DIR" 2>&1)" || { printf '%s\n' "$OUT" >&2; fail 1 "talos-app install-mcp failed."; }
  case "$OUT" in
    "already up to date"*) skip "$OUT" ;;
    *) say "   $OUT"; did "registered the talos-app MCP server" ;;
  esac
fi

# ---------------------------------------------------------------- 6. launch script with the Talos mod
step "6/7 Launch script (the Talos mod via --plugin-dir)"
LAUNCH="$AGENT_DIR/start-talos.sh"
MARK="# Written by the Talos install.sh."
launch_text() {
  printf '#!/usr/bin/env bash\n%s Re-run ./install.sh to refresh it; delete it any time.\n' "$MARK"
  printf '# talos-clone: %s\n' "$REPO"
  printf '# Starts the agent with the talos-app channel and the Talos mod (--plugin-dir). Extra arguments go to claude.\n'
  printf 'exec bun run %q start --agent-dir %q -- --plugin-dir %q "$@"\n' "$REPO/apps/bridge/src/cli.ts" "$AGENT_DIR" "$MOD"
}
if [ "$DRY" = 1 ]; then plan "write $LAUNCH: talos-app start --agent-dir $AGENT_DIR -- --plugin-dir $MOD"
elif [ -f "$LAUNCH" ] && [ "$(launch_text)" = "$(cat "$LAUNCH")" ]; then skip "$LAUNCH"
elif [ -f "$LAUNCH" ] && ! grep -qF "$MARK" "$LAUNCH"; then say "   $LAUNCH exists and is not ours; left alone."
else
  if [ -f "$LAUNCH" ]; then  # ours but changed since: keep the old copy before refreshing it
    BAK="$LAUNCH.bak-$(date +%Y%m%d%H%M%S)"
    cp -p "$LAUNCH" "$BAK" || fail 1 "could not back up $LAUNCH before refreshing it."
    say "   kept the previous $LAUNCH as $BAK"
  fi
  launch_text > "$LAUNCH" && chmod +x "$LAUNCH" || fail 1 "could not write $LAUNCH."
  did "wrote $LAUNCH"
  say "   wrote $LAUNCH"
fi

# ---------------------------------------------------------------- 7. Mac app
step "7/7 Mac app"
APP_DEST="$HOME/Applications/Talos.app"
APP_ID="app.talos.desktop"
DESKTOP_JSON="$HOME/Library/Application Support/Talos/desktop.json"
# The mod and channel flags the Mac app has to start claude with (it reads desktop.json, not start-talos.sh).
APP_FLAGS=(--plugin-dir "$MOD" --dangerously-load-development-channels server:talos-app)

# Is a Talos running, and from where? Asked of the system by bundle id; nothing is started or quit.
APP_RUNNING=0; APP_RUNNING_PATH=""
if [ "$WANT_APP" = 1 ] && command -v osascript >/dev/null 2>&1 \
   && [ "$(osascript -e "application id \"$APP_ID\" is running" 2>/dev/null || echo false)" = true ]; then
  APP_RUNNING=1
  if command -v lsappinfo >/dev/null 2>&1; then
    APP_RUNNING_PATH="$(lsappinfo info -only bundlepath -app "$APP_ID" 2>/dev/null | sed -n 's/.*="\(.*\)"$/\1/p' | head -1 || true)"
  fi
  [ -n "$APP_RUNNING_PATH" ] || APP_RUNNING_PATH="(path unknown)"
fi

APP_NOTE=""
if [ "$WANT_APP" != 1 ]; then say "   skipped (--no-app)"
else
  if [ "$APP_RUNNING" = 1 ]; then
    APP_NOTE="Talos is running from $APP_RUNNING_PATH. It was not quit: an update will apply on the next app start."
    say "   $APP_NOTE"
  fi
  if [ -d "$APP_DEST" ]; then skip "$APP_DEST is installed (to update it later run talos-app update, then re-run the two scripts in apps/desktop/scripts)"
  elif [ "$DRY" = 1 ]; then plan "$DESKTOP/build-app.sh --release, then $DESKTOP/install.sh --no-open --no-quit (into ~/Applications)"
  else
    bash "$DESKTOP/build-app.sh" --release || fail 1 "the Mac app build failed (output above)."
    did "built the Mac app"
    # --no-quit always: this script never asks a running Talos to quit.
    bash "$DESKTOP/install.sh" --no-open --no-quit || fail 1 "installing the Mac app failed (output above)."
    did "installed $APP_DEST"
    [ "$APP_RUNNING" = 1 ] && say "   the new build is on disk; it takes effect on the next app start (quit it from its menu when you like)."
  fi

  # desktop.json: the file the app reads to decide which agent to start and with what arguments. Written only when the app is
  # not running (a running app rewrites the file from memory) and the file already exists (a missing file means the app uses
  # its pre-setup values, which a new file holding only these keys would wipe). Otherwise the Settings change is printed.
  if [ "$DRY" = 1 ]; then plan "if Talos is not running and $DESKTOP_JSON exists: merge agent_dir=$AGENT_DIR and ${APP_FLAGS[*]} into it (old file backed up first); otherwise print the Settings change to make by hand"
  else
    DJ_OUT="$(DJ="$DESKTOP_JSON" AGENT_DIR="$AGENT_DIR" MOD="$MOD" REPOINT="$REPOINT" RUNNING="$APP_RUNNING" python3 - <<'PYEOF'
import json, os, shutil, sys, tempfile, time
dj, agent, mod, repoint = os.environ["DJ"], os.environ["AGENT_DIR"], os.environ["MOD"], os.environ["REPOINT"] == "1"
running = os.environ["RUNNING"] == "1"
real = lambda p: os.path.realpath(os.path.expanduser(p))
CH, SRV = "--dangerously-load-development-channels", "server:talos-app"
want = ["--plugin-dir", mod, CH, SRV]
def instructions(why):
    print("MANUAL " + why)
    print("MANUAL In Talos > Settings, set the agent folder to " + agent + " and add these launch arguments:")
    print("MANUAL   --plugin-dir " + mod + " " + CH + " " + SRV)
if running:
    instructions("Talos is running, and a running app overwrites desktop.json from memory, so a file edit now would be lost. desktop.json was not touched.")
    sys.exit(0)
if not os.path.exists(dj):
    instructions(dj + " does not exist yet. A new file holding only these keys would wipe the pre-setup values of the app, so none was created.")
    sys.exit(0)
# A symlinked file is updated through to its target; the link itself is never replaced.
target = os.path.realpath(dj)
try:
    with open(target) as f:
        cfg = json.load(f)
except Exception:
    instructions(dj + " is not valid JSON, so it was left alone.")
    sys.exit(0)
if not isinstance(cfg, dict):
    instructions(dj + " is not a JSON object, so it was left alone.")
    sys.exit(0)
cur = cfg.get("agent_dir")
if cur is not None and not isinstance(cur, str):
    instructions(dj + " has an agent_dir that is not text, so it was left alone.")
    sys.exit(0)
if cur is not None and real(cur) != real(agent):
    instructions(dj + " points the app at a different agent folder (" + cur + "), so it was left alone.")
    sys.exit(0)
args = cfg.get("args", [])
if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
    instructions(dj + " has an args value that is not a list of strings, so it was left alone.")
    sys.exit(0)
new_args = list(args)
# a --plugin-dir for the Talos mod from another clone: replaced only with --repoint, otherwise reported
for i, a in enumerate(new_args):
    if a == "--plugin-dir" and i + 1 < len(new_args) and new_args[i + 1].rstrip("/").endswith("/plugins/talos-app-mod") and real(new_args[i + 1]) != real(mod):
        if repoint:
            new_args[i + 1] = mod
        else:
            instructions(dj + " loads the Talos mod from another clone (" + new_args[i + 1] + "); it was left alone. Re-run with --repoint to move it.")
            sys.exit(0)
has_mod = any(a == "--plugin-dir" and i + 1 < len(new_args) and real(new_args[i + 1]) == real(mod) for i, a in enumerate(new_args)) \
    or any(a.startswith("--plugin-dir=") and real(a.split("=", 1)[1]) == real(mod) for a in new_args)
has_ch = any(a == CH and i + 1 < len(new_args) and new_args[i + 1] == SRV for i, a in enumerate(new_args)) or (CH + "=" + SRV) in new_args
if not has_mod:
    new_args += ["--plugin-dir", mod]
if not has_ch:
    new_args += [CH, SRV]
if cur is None:
    cfg["agent_dir"] = agent
cfg["args"] = new_args
if new_args == args and cur is not None:
    print("SAME")
    sys.exit(0)
stamp = time.strftime("%Y%m%d-%H%M%S")
bak = target + ".bak-" + stamp
n = 0
while os.path.exists(bak):
    n += 1
    bak = target + ".bak-" + stamp + "-" + str(n)
shutil.copy2(target, bak)
print("BACKUP " + bak)
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(target), prefix=".desktop.json.")
try:
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
print("WROTE")
PYEOF
)" || fail 1 "could not update $DESKTOP_JSON (nothing in it was changed unless a backup is listed next to it)."
    DJ_STATE=SAME
    while IFS= read -r line; do
      case "$line" in
        SAME) ;;
        WROTE) DJ_STATE=WROTE ;;
        BACKUP\ *) say "   backed up the old file to ${line#BACKUP }" ;;
        MANUAL\ *) printf '   %s\n' "${line#MANUAL }" ;;
      esac
    done <<EOF
$DJ_OUT
EOF
    case "$DJ_STATE" in
      WROTE) did "set the Mac app to start $AGENT_DIR with the Talos mod and channel (desktop.json)"; say "   updated $DESKTOP_JSON" ;;
      *) case "$DJ_OUT" in *MANUAL*) ;; *) skip "$DESKTOP_JSON" ;; esac ;;
    esac
  fi
fi

# ---------------------------------------------------------------- done
printf '\n== Done\n'
if [ "$DRY" = 1 ]; then say "Dry run finished. Nothing was changed."
elif [ "$CHANGED" = 0 ]; then say "Nothing to change: everything was already set up."
else say "Set up: $(IFS=';'; echo "${DONE[*]}")"; fi
if [ "$VERIFY_WARNED" = 1 ]; then say "Note: verify-install.sh reported problems in the existing agent (warnings above)."; fi
[ -z "$APP_NOTE" ] || say "$APP_NOTE"
cat <<EOF

What next:
  Terminal:  $LAUNCH
$([ "$WANT_APP" = 1 ] && printf '  Mac app:   open ~/Applications/Talos.app\n')  First run: tell the agent "Read BOOTSTRAP.md and set me up." The interview is optional.
  Phone:     docs/SETUP.md covers the relay and pairing.
  Update:    bun run $(printf '%q' "$REPO/apps/bridge/src/cli.ts") update
EOF
exit 0
