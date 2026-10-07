#!/bin/bash
# Talos installer (macOS, Claude Code CLI).
#
#   ./install.sh [--agent-dir DIR] [--chronos-path DIR | --no-chronos] [options]
#
# What it does, in order. Every step is skipped cleanly if it has already happened:
#   1. checks python3, git and the claude CLI
#   2. copies this kit into your agent folder (default ~/my-agent): a COPY, never the clone itself, so
#      your memory and wiki never sit inside a git checkout that has a remote
#   3. installs the hooks' settings (.claude/settings.json) and stamps .talos-version
#   4. Chronos, the scheduler: clones it at a pinned commit (or uses --chronos-path), then runs
#      Chronos's own installer with the agent folder as its workspace
#   5. registers the Talos jobs in Chronos, all DISABLED until your agent has finished setup
#   6. optionally wires a delivery command (--notify macos | telegram)
#
# Skip Chronos entirely with --no-chronos. You lose scheduled jobs and nothing else.
#
#   --agent-dir DIR       where the agent will live (default ~/my-agent). Must not exist or must be empty.
#   --chronos-path DIR    use this local Chronos checkout instead of cloning
#   --chronos-repo URL    clone source (default: the Chronos repo on GitHub)
#   --chronos-ref SHA     commit to pin (default: the one this kit was tested with)
#   --no-chronos          do not install Chronos and do not register jobs
#   --no-jobs             install Chronos but do not register the Talos jobs
#   --full-access-jobs    register the Claude jobs WITHOUT the tool restriction: their scheduled runs then skip
#                         permission prompts and can do anything your account can. Off by default; the shipped jobs
#                         are restricted to a short tool list (README, "Scheduled jobs are restricted by default").
#                         You can also switch one job later: scripts/talos-jobs.py access <job> --full ...
#   --reinstall-chronos   run Chronos's installer even if a Chronos config already exists
#   --set-chronos-workspace  when Chronos is already configured with a different workspace, point it at this
#                         agent folder (atomic edit, file mode kept). Without it the installer only warns.
#   --notify KIND         macos | telegram | none (default none). Only sets Chronos's `notify` if it is empty.
#   --no-load             tell Chronos not to load its launchd agents (write the plists, load nothing)
#   --no-session-hook     do not register the Chronos SessionStart hook in the agent's settings
#   --allow-protected-folder   allow an agent folder under ~/Desktop, ~/Documents or ~/Downloads. The install then
#                         WARNS: every Claude Code auto-update triggers a macOS "would like to access files in your
#                         Desktop folder" prompt that silently blocks background runs until you click Allow.
#                         Prefer a folder outside them, for example ~/agent.
#   --allow-synced-folder      allow an agent folder inside Google Drive, OneDrive, Dropbox or iCloud
#   --with-memory-search  also enable semantic memory search: runs scripts/memory/setup.sh after the install (a shared
#                         Python 3.10+ venv of about 160 MB, an embedding model of about 210 MB, and an index of
#                         the agent's notes). Opt-in: without it, search is grep and the link graph. A stock Mac
#                         has only Python 3.9: if no 3.10+ is found the install still succeeds and prints the one
#                         command that fixes it (brew install uv) and how to add search afterwards.
#   --embed-model M       base (default, about 210 MB) | small (about 67 MB); only with --with-memory-search
#   --global-pointer      also add a small marked block to your GLOBAL ~/.claude/CLAUDE.md telling every Claude Code
#                         session on this Mac where this agent's memory lives and how to search it. It edits a file
#                         that applies to ALL your projects, so it is opt-in; ./uninstall.sh removes exactly that block.
#   --with-voice          also install the Kokoro neural voice for scripts/tts.sh (about 350 MB; needs Python 3.10+).
#                         Without it, tts.sh uses macOS `say` and needs nothing. Speech-to-text is separate:
#                         bash scripts/voice/setup.sh --stt
#   --with-vault DIR      also create a private personal vault at DIR from optional/personal/: a second folder for
#                         your personal life that the agent may read but must never copy into work notes. DIR must
#                         be new or empty, outside this agent folder and outside any synced or work storage. The
#                         installer records it for hooks/check-vault.py and prints the block to add to CLAUDE.md.
#   --dry-run             print the plan and change nothing
#   -h, --help            this text
#
# Environment (for tests): TALOS_VENDOR_DIR overrides where Chronos is cloned
# (default ~/.local/share/talos/chronos); XDG_CONFIG_HOME moves ~/.config; CHRONOS_CONFIG and
# CHRONOS_LAUNCHAGENTS_DIR are honoured by Chronos itself.
set -eu

KIT="$(cd "$(dirname "$0")" && pwd)"
# The Chronos commit this kit was tested with (Chronos has no release tags yet). Bump it deliberately.
CHRONOS_PINNED_REF="ac21e923c13e166df39d4bdb5fdd7551209711c6"
CHRONOS_DEFAULT_REPO="https://github.com/treynortetik-creator/chronos"

AGENT_DIR="$HOME/my-agent"; CHRONOS_PATH=""; CHRONOS_REPO="$CHRONOS_DEFAULT_REPO"; CHRONOS_REF="$CHRONOS_PINNED_REF"
DO_CHRONOS=1; DO_JOBS=1; FULL_JOBS=0; REINSTALL=0; SET_WS=0; MEMSEARCH=0; EMBED=base; VAULT=""; VOICE=0; GPOINTER=0; NOTIFY=none; NOLOAD=0; SESSION_HOOK=1; PROTECTED_OK=0; SYNCED_OK=0; DRY=0

usage() { awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; }
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:?--agent-dir needs a value}"; shift 2 ;;
    --chronos-path) CHRONOS_PATH="${2:?--chronos-path needs a value}"; shift 2 ;;
    --chronos-repo) CHRONOS_REPO="${2:?}"; shift 2 ;;
    --chronos-ref) CHRONOS_REF="${2:?}"; shift 2 ;;
    --no-chronos) DO_CHRONOS=0; shift ;;
    --no-jobs) DO_JOBS=0; shift ;;
    --full-access-jobs) FULL_JOBS=1; shift ;;
    --reinstall-chronos) REINSTALL=1; shift ;;
    --set-chronos-workspace) SET_WS=1; shift ;;
    --with-memory-search) MEMSEARCH=1; shift ;;
    --with-voice) VOICE=1; shift ;;
    --global-pointer) GPOINTER=1; shift ;;
    --with-vault) VAULT="${2:?--with-vault needs a folder}"; shift 2 ;;
    --embed-model) EMBED="${2:?--embed-model needs base or small}"; shift 2 ;;
    --notify) NOTIFY="${2:?}"; shift 2 ;;
    --no-load) NOLOAD=1; shift ;;
    --no-session-hook) SESSION_HOOK=0; shift ;;
    --allow-protected-folder) PROTECTED_OK=1; shift ;;
    --allow-synced-folder) SYNCED_OK=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done
case "$NOTIFY" in none|macos|telegram) ;; *) echo "--notify must be macos, telegram or none" >&2; exit 2 ;; esac
case "$EMBED" in base|small) ;; *) echo "--embed-model must be base or small" >&2; exit 2 ;; esac
[ "$DO_CHRONOS" = 1 ] || DO_JOBS=0

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
plan() { printf '   would: %s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then plan "$*"; else "$@"; fi; }

# ---------------------------------------------------------------- 1. preflight
step "Checking this Mac"
[ "$(uname -s)" = "Darwin" ] || { echo "Talos needs macOS (Chronos uses launchd). Use --no-chronos for a session-only agent on another system, at your own risk." >&2; [ "$DO_CHRONOS" = 0 ] || exit 1; }
PY="$(command -v python3 || true)"
[ -n "$PY" ] || { echo "python3 not found. Run: xcode-select --install  (accept the dialog; it can take 15-40 minutes and looks frozen), then re-run this." >&2; exit 1; }
"$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || { echo "Python 3.9 or newer is required." >&2; exit 1; }
command -v git >/dev/null 2>&1 || { echo "git not found. Run: xcode-select --install" >&2; exit 1; }
if command -v claude >/dev/null 2>&1; then say "   claude CLI: $(command -v claude)"
else say "   warning: the 'claude' CLI is not on PATH. Install Claude Code (https://claude.com/claude-code) and run 'claude' once to log in before you start the agent or any scheduled job."; fi
say "   python3: $PY ($("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"

# ---------------------------------------------------------------- 2. the agent folder
step "Agent folder"
case "$AGENT_DIR" in "~"|"~/"*) AGENT_DIR="$HOME${AGENT_DIR#\~}" ;; esac
case "$AGENT_DIR" in /*) ;; *) AGENT_DIR="$PWD/$AGENT_DIR" ;; esac
# The parent is resolved on its own line: `A="$(cd ... && pwd)/$(basename ...)" || die` never fires, because the
# exit status of an assignment comes from the LAST command substitution (basename), so a missing parent used to
# silently turn into the filesystem root.
PARENT="$(cd "$(dirname "$AGENT_DIR")" 2>/dev/null && pwd)" || { echo "the parent folder of $AGENT_DIR does not exist. Create it first, or pick another --agent-dir." >&2; exit 1; }
AGENT_DIR="$PARENT/$(basename "$AGENT_DIR")"
say "   $AGENT_DIR"
case "$AGENT_DIR/" in "$KIT"/*) echo "refusing: the agent folder cannot be this kit's own folder or inside it." >&2; exit 1 ;; esac
case "$KIT/" in "$AGENT_DIR"/*) echo "refusing: the agent folder cannot contain this kit." >&2; exit 1 ;; esac
case "$AGENT_DIR" in
  *CloudStorage*|*"Google Drive"*|*OneDrive*|*Dropbox*|*"Mobile Documents"*)
    if [ "$SYNCED_OK" != 1 ]; then
      echo "refusing: $AGENT_DIR looks like cloud-synced storage. Two processes editing memory/ mid-sync corrupts it." >&2
      echo "Pick a plain folder in your home directory (the default ~/my-agent), or pass --allow-synced-folder if you know why." >&2
      exit 1
    fi ;;
esac
case "$AGENT_DIR" in "$HOME/Desktop"/*|"$HOME/Documents"/*|"$HOME/Downloads"/*)
  if [ "$DO_CHRONOS" = 1 ] && [ "$PROTECTED_OK" != 1 ]; then
    echo "refusing: macOS privacy (TCC) can stop launchd jobs from reading files under Desktop, Documents and Downloads," >&2
    echo "so scheduled jobs would fail silently. Use ~/my-agent or ~/agent, or pass --allow-protected-folder (or --no-chronos)." >&2
    exit 1
  fi
  say "   WARNING: this folder is inside a macOS-protected folder (Desktop, Documents or Downloads)."
  say "   Every Claude Code auto-update will make macOS ask \"would like to access files in your Desktop folder\","
  say "   and until you click Allow, background runs (scheduled jobs) are silently blocked."
  say "   Put the agent outside those folders to avoid it, for example ~/agent (re-run with --agent-dir ~/agent). Continuing anyway." ;;
esac
if [ -e "$AGENT_DIR" ]; then
  if [ -f "$AGENT_DIR/.talos-version" ]; then
    echo "$AGENT_DIR already has a Talos install (see .talos-version). To take a newer kit version, run:" >&2
    echo "    bash $KIT/scripts/upgrade.sh --into \"$AGENT_DIR\" --dry-run" >&2
    exit 1
  fi
  if [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null | grep -v '^\.DS_Store$' || true)" ]; then
    echo "refusing: $AGENT_DIR exists and is not empty. Pick a new folder, or empty it first." >&2
    exit 1
  fi
fi

# the personal vault, validated BEFORE anything is written
if [ -n "$VAULT" ]; then
  case "$VAULT" in "~"|"~/"*) VAULT="$HOME${VAULT#\~}" ;; esac
  case "$VAULT" in /*) ;; *) VAULT="$PWD/$VAULT" ;; esac
  _vparent="$(cd "$(dirname "$VAULT")" 2>/dev/null && pwd)" || { echo "the parent folder of the vault $VAULT does not exist" >&2; exit 1; }
  VAULT="$_vparent/$(basename "$VAULT")"
  case "$VAULT/" in "$AGENT_DIR"/*|"$KIT"/*) echo "refusing: the vault cannot be inside the agent folder or the kit (it would travel with their git history)." >&2; exit 1 ;; esac
  case "$AGENT_DIR/" in "$VAULT"/*) echo "refusing: the vault cannot contain the agent folder." >&2; exit 1 ;; esac
  case "$VAULT" in
    *CloudStorage*|*"Google Drive"*|*OneDrive*|*Dropbox*|*"Mobile Documents"*|*iCloud*)
      echo "refusing: $VAULT looks like synced or company storage. The whole point of the vault is that it is NOT there." >&2
      echo "Pick a plain folder in your home directory, for example ~/private-agent-vault." >&2; exit 1 ;;
  esac
  case "$VAULT" in "$HOME/Desktop"/*|"$HOME/Documents"/*)
    if [ "$SYNCED_OK" != 1 ]; then
      echo "refusing: $VAULT is under ~/Desktop or ~/Documents, which iCloud's 'Desktop & Documents' setting may sync to other devices" >&2
      echo "(and to your employer, if it manages this Mac). Pick a plain folder like ~/private-agent-vault, or pass --allow-synced-folder." >&2; exit 1
    fi ;;
  esac
  if [ -e "$VAULT" ] && [ -n "$(ls -A "$VAULT" 2>/dev/null | grep -v '^\.DS_Store$' || true)" ]; then
    echo "refusing: $VAULT exists and is not empty." >&2; exit 1
  fi
fi

VERSION="$(tr -d ' \t\r\n' < "$KIT/VERSION" 2>/dev/null || echo unknown)"
COMMIT="$(git -C "$KIT" rev-parse --short HEAD 2>/dev/null || echo none)"
say "   kit version $VERSION (commit $COMMIT)"

run mkdir -p "$AGENT_DIR"
if [ "$DRY" = 1 ]; then
  plan "copy the kit into $AGENT_DIR (excluding .git and caches)"
else
  # tar pipe: portable, preserves dotfiles and modes, and lets us exclude without rsync
  ( cd "$KIT" && tar --exclude='./.git' --exclude='.DS_Store' --exclude='__pycache__' --exclude='*.pyc' \
        --exclude='./scripts/fixtures' --exclude='./docs' --exclude='./.releaseignore' -cf - . ) \
    | ( cd "$AGENT_DIR" && tar -xf - )
  chmod +x "$AGENT_DIR"/hooks/*.py "$AGENT_DIR"/scripts/*.sh "$AGENT_DIR"/scripts/*.py "$AGENT_DIR"/install.sh "$AGENT_DIR"/uninstall.sh "$AGENT_DIR"/notify/*.sh 2>/dev/null || true
  mkdir -p "$AGENT_DIR/.claude" "$AGENT_DIR/memory" "$AGENT_DIR/memory/briefs"
  cp "$AGENT_DIR/templates/dot-claude/settings.json" "$AGENT_DIR/.claude/settings.json"
  "$PY" -m json.tool "$AGENT_DIR/.claude/settings.json" >/dev/null
  {
    printf '# Written by install.sh. What this folder is running.\n'
    printf 'version=%s\n' "$VERSION"
    printf 'kind=git-checkout\n'
    printf 'source_commit=%s\n' "$COMMIT"
    printf 'installed=%s\n' "$(date +%Y-%m-%d)"
  } > "$AGENT_DIR/.talos-version"
  say "   copied the kit, wrote .claude/settings.json and .talos-version"
fi

# ---------------------------------------------------------------- 3. Chronos
CHRONOS_DIR=""; CHRONOS_RUNTIME=""; CHRONOS_RAN=0
CFG="${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}"
if [ "$DO_CHRONOS" = 1 ]; then
  step "Chronos (the scheduler)"
  if [ -n "$CHRONOS_PATH" ]; then
    case "$CHRONOS_PATH" in "~"|"~/"*) CHRONOS_PATH="$HOME${CHRONOS_PATH#\~}" ;; esac
    CHRONOS_DIR="$(cd "$CHRONOS_PATH" 2>/dev/null && pwd)" || { echo "--chronos-path $CHRONOS_PATH does not exist" >&2; exit 1; }
    for f in install.sh bin/chronos lib/chronoslib.py; do
      [ -e "$CHRONOS_DIR/$f" ] || { echo "$CHRONOS_DIR does not look like a Chronos checkout (no $f)" >&2; exit 1; }
    done
    say "   using local Chronos at $CHRONOS_DIR"
  else
    VENDOR="${TALOS_VENDOR_DIR:-$HOME/.local/share/talos}"
    CHRONOS_DIR="$VENDOR/chronos"
    if [ "$DRY" = 1 ]; then
      plan "git clone $CHRONOS_REPO $CHRONOS_DIR, then check out $CHRONOS_REF (detached)"
    else
      mkdir -p "$VENDOR"
      if [ -d "$CHRONOS_DIR/.git" ]; then
        say "   Chronos already cloned at $CHRONOS_DIR"
        git -C "$CHRONOS_DIR" fetch --quiet origin 2>/dev/null || true
      else
        say "   cloning $CHRONOS_REPO"
        git clone --quiet "$CHRONOS_REPO" "$CHRONOS_DIR" || {
          echo >&2
          echo "Could not clone Chronos. If the repository is private you need access (gh auth login), or pass a" >&2
          echo "local checkout with --chronos-path DIR, or skip it with --no-chronos." >&2
          exit 1
        }
      fi
      git -C "$CHRONOS_DIR" checkout --quiet --detach "$CHRONOS_REF" || { echo "commit $CHRONOS_REF not found in the Chronos clone" >&2; exit 1; }
      HEADSHA="$(git -C "$CHRONOS_DIR" rev-parse HEAD)"
      case "$HEADSHA" in "$CHRONOS_REF"*) ;; *) echo "Chronos HEAD $HEADSHA is not the pinned $CHRONOS_REF; refusing" >&2; exit 1 ;; esac
      say "   Chronos pinned at $HEADSHA"
    fi
  fi
  # Chronos copies its runtime out of Desktop/Documents/Downloads on its own (TCC); mirror that rule so the
  # SessionStart hook points at the copy that actually exists.
  CHRONOS_RUNTIME="$CHRONOS_DIR"
  case "$CHRONOS_DIR" in "$HOME/Desktop"/*|"$HOME/Documents"/*|"$HOME/Downloads"/*) CHRONOS_RUNTIME="$HOME/.local/share/chronos" ;; esac

  if [ -f "$CFG" ] && [ "$REINSTALL" != 1 ]; then
    say "   Chronos is already configured ($CFG): not running its installer again."
    say "   NOTE: that means the Chronos launchd runs may be OLDER than the pinned clone. Talos reads the version of the one launchd"
    say "   actually runs; the restricted jobs need 0.2.2 and are skipped if it is older or unknown (--reinstall-chronos updates it)."
    # Chronos cd's into its OWN workspace before it starts `claude -p`, so a job's CLAUDE.md, hooks and the
    # pre-tool guard load from THAT folder, not from the agent folder. The job prompt tells the agent to cd
    # to its folder, but that happens after the session has already started. If the two differ, say so loudly.
    CUR_WS="$("$PY" - "$CFG" <<'PYEOF'
import json, os, sys
try:
    c = json.load(open(sys.argv[1]))
    print(os.path.realpath(os.path.expanduser(str(c.get("workspace") or ""))) if c.get("workspace") else "")
except Exception:
    print("")
PYEOF
)"
    REAL_AGENT="$(cd "$AGENT_DIR" 2>/dev/null && pwd -P || echo "$AGENT_DIR")"
    if [ -n "$CUR_WS" ] && [ "$CUR_WS" != "$REAL_AGENT" ]; then
      if [ "$SET_WS" = 1 ] && [ "$DRY" != 1 ]; then
        CFGP="$CFG" WSP="$AGENT_DIR" "$PY" - <<'PYEOF'
import json, os
p = os.environ["CFGP"]; c = json.load(open(p)); c["workspace"] = os.environ["WSP"]
mode = os.stat(p).st_mode & 0o777
tmp = p + ".tmp.%d" % os.getpid()
json.dump(c, open(tmp, "w"), indent=2); open(tmp, "a").write("\n")
os.chmod(tmp, mode); os.replace(tmp, p)
PYEOF
        say "   set Chronos's workspace to $AGENT_DIR (was $CUR_WS)"
      else
        say "   WARNING: Chronos's workspace is $CUR_WS, not this agent folder."
        say "   Scheduled runs start there, so this agent's CLAUDE.md, hooks and pre-tool guard do NOT load for them."
        say "   Fix: re-run with --set-chronos-workspace (changes Chronos's config), or edit \"workspace\" in $CFG."
        say "   If you run more than one agent, jobs for the others need a per-job workspace (a newer Chronos)."
      fi
    else
      say "   Chronos's workspace already matches this agent folder."
    fi
  else
    CARGS=(--workspace "$AGENT_DIR")
    [ "$NOLOAD" = 1 ] && CARGS+=(--no-load)
    # Chronos 0.2.1+ has --quiet (one summary line). An older --chronos-path checkout does not: then show its output labelled.
    grep -q -- '--quiet' "$CHRONOS_DIR/install.sh" 2>/dev/null && CARGS+=(--quiet)
    if [ "$DRY" = 1 ]; then plan "$CHRONOS_DIR/install.sh ${CARGS[*]}"
    else
      say "   running Chronos's installer (its own output is indented and labelled below)"
      if COUT="$("$CHRONOS_DIR/install.sh" "${CARGS[@]}" 2>&1)"; then CRC=0; else CRC=$?; fi
      printf '%s\n' "$COUT" | sed 's/^/   chronos: /'
      [ "$CRC" = 0 ] || { echo "Chronos's installer failed (exit $CRC); see its output above." >&2; exit "$CRC"; }
      CHRONOS_RAN=1
    fi
  fi
fi

# remember where Chronos came from, so uninstall.sh can find its own uninstaller
if [ "$DO_CHRONOS" = 1 ] && [ "$DRY" != 1 ]; then
  mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/talos"; chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/talos"
  printf '%s\n' "$CHRONOS_DIR" > "${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-dir"
  # and where the agent lives, so uninstall.sh finds the right settings.json without being told
  printf '%s\n' "$AGENT_DIR" > "${XDG_CONFIG_HOME:-$HOME/.config}/talos/agent-dir"
fi

# ---------------------------------------------------------------- 4. delivery
if [ "$DO_CHRONOS" = 1 ] && [ "$NOTIFY" != none ]; then
  step "Delivery ($NOTIFY)"
  TCFG="${XDG_CONFIG_HOME:-$HOME/.config}/talos"
  if [ "$DRY" = 1 ]; then plan "copy notify/$NOTIFY.sh to $TCFG/notify/ and set Chronos's notify command if it is empty"
  else
    mkdir -p "$TCFG/notify"; chmod 700 "$TCFG"
    cp "$KIT/notify/$NOTIFY.sh" "$TCFG/notify/$NOTIFY.sh"; chmod +x "$TCFG/notify/$NOTIFY.sh"
    if [ "$NOTIFY" = telegram ]; then
      cp "$KIT/notify/notify.env.example" "$TCFG/notify.env.example"
      say "   Telegram needs a token and chat id in $TCFG/notify.env (chmod 600). Copy notify.env.example"
      say "   next to it and fill it in yourself. The installer never asks for, reads or stores a token."
    fi
    if [ -f "$CFG" ]; then
      TCMD="$TCFG/notify/$NOTIFY.sh" CFGP="$CFG" "$PY" - <<'PYEOF'
import json, os, sys
p = os.environ["CFGP"]; cmd = os.environ["TCMD"]
c = json.load(open(p))
if str(c.get("notify") or "").strip():
    print("   Chronos already has a notify command (%s); left as it is." % c["notify"])
else:
    c["notify"] = cmd
    mode = os.stat(p).st_mode & 0o777
    tmp = p + ".tmp.%d" % os.getpid()
    json.dump(c, open(tmp, "w"), indent=2); open(tmp, "a").write("\n")
    os.chmod(tmp, mode); os.replace(tmp, p)
    print("   set Chronos notify to %s" % cmd)
PYEOF
    else
      say "   no Chronos config yet; set \"notify\" to $TCFG/notify/$NOTIFY.sh in it by hand."
    fi
  fi
fi

# ---------------------------------------------------------------- 5. jobs and hook
if [ "$DO_JOBS" = 1 ]; then
  step "Talos jobs"
  if [ "$DRY" = 1 ]; then plan "register talos-morning-brief, talos-weekly-wiki-lint, talos-weekly-snapshot, talos-memory-index, talos-state-sweep in Chronos (all disabled)"
  elif [ "$FULL_JOBS" = 1 ]; then
    say "   --full-access-jobs: the Claude jobs will run with permission prompts SKIPPED when you enable them."
    "$PY" "$KIT/scripts/talos-jobs.py" register --agent-dir "$AGENT_DIR" --kit-dir "$KIT" --full-access
  else "$PY" "$KIT/scripts/talos-jobs.py" register --agent-dir "$AGENT_DIR" --kit-dir "$KIT"; fi
fi
if [ "$DO_CHRONOS" = 1 ] && [ "$SESSION_HOOK" = 1 ]; then
  step "Chronos session hook"
  if [ "$DRY" = 1 ]; then plan "register $CHRONOS_RUNTIME/hooks/chronos-session-start.py in $AGENT_DIR/.claude/settings.json"
  elif [ -f "$CHRONOS_RUNTIME/hooks/chronos-session-start.py" ]; then
    "$PY" "$KIT/scripts/talos-jobs.py" hook-add --agent-dir "$AGENT_DIR" --chronos-dir "$CHRONOS_RUNTIME"
  else
    say "   Chronos runtime not found at $CHRONOS_RUNTIME (its installer may not have run); skipped."
  fi
fi

# ---------------------------------------------------------------- 5b. personal vault (opt-in)
if [ -n "$VAULT" ]; then
  step "Personal vault"
  if [ "$DRY" = 1 ]; then
    plan "create $VAULT from optional/personal/ (mode 700), add an empty _guard-terms.txt, record it in ~/.config/talos/vault-dir"
  else
    mkdir -p "$VAULT" && chmod 700 "$VAULT"
    ( cd "$KIT/optional/personal" && tar --exclude='.DS_Store' --exclude='_guard-terms.txt.example' -cf - . ) | ( cd "$VAULT" && tar -xf - )
    cp "$KIT/optional/personal/_guard-terms.txt.example" "$VAULT/_guard-terms.txt"
    mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/talos"; chmod 700 "${XDG_CONFIG_HOME:-$HOME/.config}/talos"
    printf '%s\n' "$VAULT" > "${XDG_CONFIG_HOME:-$HOME/.config}/talos/vault-dir"
    say "   created $VAULT"
    say "   Next, in your agent (it asks for a yes before it edits CLAUDE.md):  My personal vault is at $VAULT. Read its CLAUDE.md."
    say "   It will show you this block to add to the END of the agent's CLAUDE.md:"
    say ""
    say "       ## Personal vault"
    say "       - Lives at: $VAULT"
    say "       - May read for context. Never copy contents into any work note, commit, message, or artifact;"
    say "         re-read the vault's own CLAUDE.md before writing there."
    say "       - Health, money, family conflict, anything intimate: surface only when explicitly asked."
    say ""
    say "   Optional tripwire: put terms that only appear in your private life (one per line) in $VAULT/_guard-terms.txt;"
    say "   hooks/check-vault.py then asks before such a term is written outside the vault. You write that file; the kit ships none."
  fi
fi

# ---------------------------------------------------------------- 6. semantic memory search (opt-in)
if [ "$MEMSEARCH" = 1 ]; then
  step "Semantic memory search ($EMBED model)"
  if [ "$DRY" = 1 ]; then
    bash "$KIT/scripts/memory/setup.sh" --agent-dir "$KIT" --as-agent-dir "$AGENT_DIR" --embed-model "$EMBED" --dry-run $([ "$DO_JOBS" = 1 ] || echo --no-job)
  else
    _mrc=0
    bash "$AGENT_DIR/scripts/memory/setup.sh" --agent-dir "$AGENT_DIR" --embed-model "$EMBED" $([ "$DO_JOBS" = 1 ] || echo --no-job) || _mrc=$?
    if [ "$_mrc" = 3 ]; then
      say "   Semantic search was NOT enabled: it needs Python 3.10+ and this Mac only has Apple's 3.9. The install itself is fine."
      say "   Run this one command, then add search:"
      say "       brew install uv && bash $AGENT_DIR/scripts/memory/setup.sh"
      say "   (no Homebrew: curl -LsSf https://astral.sh/uv/install.sh | sh, open a new terminal, then the setup.sh line above)"
    elif [ "$_mrc" != 0 ]; then
      say "   Semantic search was NOT enabled (setup.sh exited $_mrc). The install itself is fine; search is grep + links."
      say "   Add it later with:  bash $AGENT_DIR/scripts/memory/setup.sh"
    fi
  fi
fi

# ---------------------------------------------------------------- 6b. global pointer (opt-in)
if [ "$GPOINTER" = 1 ]; then
  step "Global pointer (~/.claude/CLAUDE.md)"
  if [ "$DRY" = 1 ]; then "$PY" "$KIT/scripts/global-pointer.py" add --agent-dir "$HOME" --dry-run | sed 's/^/   /' | sed "s#$HOME#<agent folder>#"
    plan "append the block above (with your agent folder's path) to $HOME/.claude/CLAUDE.md, after a one-time backup"
  else "$PY" "$KIT/scripts/global-pointer.py" add --agent-dir "$AGENT_DIR"; fi
fi

# ---------------------------------------------------------------- 7. Kokoro voice (opt-in)
if [ "$VOICE" = 1 ]; then
  step "Kokoro voice"
  if [ "$DRY" = 1 ]; then
    bash "$KIT/scripts/voice/setup.sh" --kokoro --dry-run
  else
    _vrc=0
    bash "$AGENT_DIR/scripts/voice/setup.sh" --kokoro || _vrc=$?
    [ "$_vrc" = 0 ] || say "   The Kokoro voice was NOT installed (exit $_vrc). tts.sh still works with macOS say. Retry: bash $AGENT_DIR/scripts/voice/setup.sh --kokoro"
  fi
fi

# ---------------------------------------------------------------- done
step "Done"
if [ "$DRY" = 1 ]; then say "Dry run: nothing was changed."; exit 0; fi
say "Agent folder: $AGENT_DIR"
if [ "$DO_CHRONOS" = 1 ]; then
  say "Chronos:      $CHRONOS_DIR   (config: $CFG)"
  if [ "$MEMSEARCH" = 1 ] && [ "${_mrc:-1}" = 0 ] && [ "$DO_JOBS" = 1 ]; then say "Jobs:         disabled until setup is finished, except talos-memory-index (--with-memory-search turned it on). List them: python3 $AGENT_DIR/scripts/talos-jobs.py list"
  else say "Jobs:         disabled until setup is finished. List them: python3 $AGENT_DIR/scripts/talos-jobs.py list"; fi
else
  say "Chronos:      skipped (--no-chronos). Your agent works; nothing runs on a schedule."
fi
if [ "$NOLOAD" = 1 ] && [ "$CHRONOS_RAN" = 1 ]; then
  _ag="${CHRONOS_LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"
  say ""
  say "Chronos is installed but NOT running (--no-load), and nothing serves its web UI yet. To start it by hand:"
  say "  scheduler, every 5 minutes:  launchctl bootstrap gui/\$(id -u) $_ag/io.github.chronos.tick.plist"
  say "  web UI (then open http://127.0.0.1:4747/, or the port you chose):"
  say "                                launchctl bootstrap gui/\$(id -u) $_ag/io.github.chronos.ui.plist"
  say "                   or, in a terminal:  CHRONOS_CONFIG=$CFG python3 $CHRONOS_RUNTIME/ui/server.py"
fi
cat <<EOF

Next:
  cd "$AGENT_DIR" && claude
  then say:  Read BOOTSTRAP.md and set me up.

When setup is finished, check it with:  bash $AGENT_DIR/scripts/verify-install.sh
(Run before setup, it lists the setup steps that have not happened yet as FAIL. That is expected.)
EOF
