#!/usr/bin/env bash
# Talos inside its WSL distro, as the `talos` user (docs/WINDOWS-PLAN.md section 8). install.ps1 runs it after talos-wsl.sh.
#
#   setup-user.sh --bundle /var/tmp/talos-install/talos-src.bundle [--origin URL] [--relay-url https://host] [--dry-run]
#                 [--no-start]      everything but starting the supervisor: install.ps1 has root copy the kit first
#                                   (talos-wsl.sh kit-update), since a thread session's hook comes only from root's copy
#   setup-user.sh --only-start      step 4 alone, after root's kit-update: the supervisor's first start
#
# 1. Node, pnpm, bun and Claude Code under ~/.local (no sudo), unless present. Each is a pinned version, and each download is
#    checked against a SHA-256 written here (R1-6): a list fetched from the same server would vouch for nothing. No script
#    from the network is run. Moving a version means changing its hash here, in a reviewed commit.
# 2. This repo at ~/talos-app, from the git bundle install.ps1 made of the Windows clone: no credential ever enters the
#    distro. `origin` is set to the Windows clone's origin, for reading only; pulling it later needs the owner's own login.
# 3. ./install.sh --yes --no-app (the Linux install: the agent folder, the MCP server, the bridge with --relay-url).
# 4. The supervisor's systemd user unit, enabled and started (linger keeps it running with nobody logged in).
# Every step checks what is already there, so a second run changes nothing that is right.
set -euo pipefail

NODE_VERSION=24.22.2
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 # node-v24.22.2-linux-x64.tar.xz
BUN_VERSION=1.4.4
BUN_SHA256=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c # bun-linux-x64.zip
PNPM_VERSION=10.33.0 # package.json packageManager; scripts/windows-distro.test.ts checks the two agree
PNPM_SHA256=8d4e8f7d778e8ac482022e2577011706a872542f6f6f233e795a4d9f978ea8b5 # pnpm-linux-x64, the standalone binary
CLAUDE_VERSION=2.1.322
CLAUDE_SHA256=bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478 # linux-x64/claude
CHRONOS_COMMIT=670c94c1e51dd7680209f7dae52d31a8c5147be2 # Chronos 0.5.1 (public main, PR #9)
CHRONOS_SHA256=66ceab1478b24b71d79331edd1c98860088fe3d2331759717adf11fd3cf54f8f # codeload tar.gz of that commit
BUNDLE=''
ORIGIN=''
RELAY=''
DRY=0
START=yes
while [ $# -gt 0 ]; do
  case "$1" in
  --bundle) BUNDLE="$2" && shift 2 ;;
  --origin) ORIGIN="$2" && shift 2 ;;
  --relay-url) RELAY="$2" && shift 2 ;;
  --dry-run) DRY=1 && shift ;;
  --no-start) START=no && shift ;;
  --only-start) START=only && shift ;;
  *) echo "setup-user: an unknown option (not shown)" >&2 && exit 64 ;;
  esac
done
[ -n "$BUNDLE" ] || [ "$START" = only ] || {
  echo "setup-user: --bundle is required" >&2
  exit 64
}
# R1-5: a URL with a login in it (https://user:token@host/...) keeps only the host and path; nothing here prints a secret.
ORIGIN="$(printf '%s' "$ORIGIN" | sed -E 's#^([a-z][a-z0-9+.-]*://)[^/@]*@#\1#')"
[ "$(id -un)" = talos ] || {
  echo "setup-user: runs as talos" >&2
  exit 1
}

step() { echo "== $*"; }
run() { if [ "$DRY" = 1 ]; then echo "would run: $1"; else "$@"; fi; } # the command's name only (R1-5)
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$HOME/.bun/bin:$PATH"
REPO="$HOME/talos-app"

fetch_pinned() { # fetch_pinned <url> <sha256> <out>: the file, or nothing and a failure
  curl -fsSL --proto '=https' "$1" -o "$3"
  echo "$2  $3" | sha256sum -c --quiet - || {
    rm -f "$3"
    echo "setup-user: $1 is not the file this script pins (SHA-256 differs); nothing was installed from it" >&2
    return 1
  }
}

if [ "$START" != only ]; then
step "toolchain"
if [ "$(node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  d="$(mktemp -d)"
  run fetch_pinned "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$d/node.tar.xz"
  run mkdir -p "$HOME/.local/node"
  run tar -xJf "$d/node.tar.xz" -C "$HOME/.local/node" --strip-components=1
  rm -rf "$d"
fi
if [ "$(pnpm -v 2>/dev/null)" != "$PNPM_VERSION" ]; then
  # the standalone binary, not `npm install -g`: npm would run the package's install scripts and take whatever the registry says
  run mkdir -p "$HOME/.local/bin"
  run fetch_pinned "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/pnpm-linux-x64" "$PNPM_SHA256" "$HOME/.local/bin/pnpm.part"
  run chmod 755 "$HOME/.local/bin/pnpm.part"
  run mv -f "$HOME/.local/bin/pnpm.part" "$HOME/.local/bin/pnpm"
fi
# The standalone pnpm has no node-gyp of its own (found live on Titan: better-sqlite3's build stopped at "node-gyp: not
# found"). The pinned Node ships one inside its npm; a launcher for it, so nothing more is downloaded.
gyp="$HOME/.local/node/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
if [ "$DRY" = 1 ]; then echo "would write $HOME/.local/bin/node-gyp"; elif [ ! -x "$HOME/.local/bin/node-gyp" ]; then
  [ -f "$gyp" ] || {
    echo "setup-user: Node's own node-gyp is not at $gyp" >&2
    exit 1
  }
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$HOME/.local/node/bin/node" "$gyp" >"$HOME/.local/bin/node-gyp"
  chmod 755 "$HOME/.local/bin/node-gyp"
fi
if ! bun --version 2>/dev/null | grep -q "^$BUN_VERSION$"; then
  d="$(mktemp -d)"
  run fetch_pinned "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-linux-x64.zip" "$BUN_SHA256" "$d/bun.zip"
  run unzip -q -o "$d/bun.zip" -d "$d"
  run mkdir -p "$HOME/.bun/bin"
  run install -m 755 "$d/bun-linux-x64/bun" "$HOME/.bun/bin/bun"
  rm -rf "$d"
fi
for f in "$HOME/.profile" "$HOME/.bashrc"; do
  grep -q 'talos: toolchain' "$f" 2>/dev/null ||
    run sh -c "printf '%s\n' '# talos: toolchain' 'export PATH=\"\$HOME/.local/bin:\$HOME/.local/node/bin:\$HOME/.bun/bin:\$PATH\"' >> '$f'"
done
# Claude Code for Linux: the pinned release binary, checked, then its own `install` (the launcher in ~/.local/bin; what
# Anthropic's install.sh does after its download, without running that script). Signing in is the owner's, once: install.ps1
# says how at the end. It does not update itself (R3-8): an update would replace the checked binary with one nobody
# checked, so the auto-updater is off, in the login environment the supervisor's sessions start from and in Claude Code's
# own settings. A newer version comes with a new pin here, and this script run again.
for f in "$HOME/.profile" "$HOME/.bashrc"; do
  grep -q 'talos: claude updates' "$f" 2>/dev/null ||
    run sh -c "printf '%s\n' '# talos: claude updates come with a new pin (apps/windows/distro/setup-user.sh)' 'export DISABLE_AUTOUPDATER=1' >> '$f'"
done
export DISABLE_AUTOUPDATER=1
if [ "$DRY" = 1 ]; then echo "would turn off Claude Code's auto-updater in ~/.claude/settings.json"; else
  mkdir -p "$HOME/.claude"
  python3 - "$HOME/.claude/settings.json" <<'PY'
import json, os, sys
p = sys.argv[1]
s = json.load(open(p)) if os.path.exists(p) else {}
env = s.setdefault('env', {})
if env.get('DISABLE_AUTOUPDATER') != '1' or s.get('autoUpdates') is not False:
    env['DISABLE_AUTOUPDATER'] = '1'
    s['autoUpdates'] = False
    open(p + '.tmp', 'w').write(json.dumps(s, indent=2) + '\n')
    os.replace(p + '.tmp', p)
PY
fi
if [ "$(claude --version 2>/dev/null | cut -d' ' -f1)" != "$CLAUDE_VERSION" ]; then
  d="$(mktemp -d)"
  run fetch_pinned "https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION/linux-x64/claude" "$CLAUDE_SHA256" "$d/claude"
  run chmod 755 "$d/claude"
  # the version named, so `install` sets up this checked binary's own version, not whatever "latest" is then (R2-6)
  run "$d/claude" install "$CLAUDE_VERSION"
  rm -rf "$d"
fi

# >>> update_repo (scripts/windows-distro.test.ts runs this function on its own)
# The checkout becomes this release. It is Talos's own code (the agent's work is in the agent folder), so a checkout that has
# moved on its own (a commit in it, or files edited and not committed) never stops an update: what it had is kept first,
# its commits as the branch talos-before-<time> and any uncommitted edits as a stash of the same name, and one plain line
# says so. Before, Setup stopped there with git's own words ("Not possible to fast-forward") and wsl exit 128.
update_repo() {
  if [ ! -d "$REPO/.git" ]; then
    run git clone -q "$BUNDLE" "$REPO"
    return
  fi
  run git -C "$REPO" fetch -q "$BUNDLE" "+HEAD:refs/remotes/bundle/HEAD"
  if [ "$DRY" = 1 ]; then
    echo "would make $REPO this release (keeping anything of its own first)"
    return
  fi
  # git as this step uses it: no hooks or fsmonitor from the checkout's own config, and a name of its own for the stash (a
  # fresh distro has none)
  local G=(git -C "$REPO" -c core.hooksPath=/dev/null -c core.fsmonitor=false -c user.name=Talos -c user.email=talos@localhost)
  # Nothing else runs git in this checkout while Setup runs: a lock left by one that died goes, and a merge, rebase,
  # cherry-pick or revert left half-done is given up (the commits it started from stay, and are kept below)
  rm -f "$REPO/.git/index.lock"
  local op
  for op in merge rebase cherry-pick revert; do "${G[@]}" "$op" --abort >/dev/null 2>&1 || true; done
  "${G[@]}" merge -q --ff-only refs/remotes/bundle/HEAD >/dev/null 2>&1 || true
  # done only when it IS the release, and clean: a checkout ahead of it, or edits a fast-forward leaves in place, are not
  if [ "$("${G[@]}" rev-parse HEAD 2>/dev/null)" = "$("${G[@]}" rev-parse refs/remotes/bundle/HEAD)" ] &&
    [ -z "$("${G[@]}" status --porcelain)" ]; then
    return
  fi
  local keep
  keep="talos-before-$(date -u +%Y%m%d-%H%M%S)-$$"
  "${G[@]}" branch -f "$keep" HEAD
  if [ -n "$("${G[@]}" status --porcelain)" ]; then "${G[@]}" stash push -q -u -m "$keep"; fi
  "${G[@]}" reset -q --hard refs/remotes/bundle/HEAD
  echo "   $REPO had changes of its own: they are kept (branch $keep, and a stash of that name for any not committed), and it is now this release"
}
# <<< update_repo
step "this repo at $REPO"
update_repo
[ -z "$ORIGIN" ] || run git -C "$REPO" remote set-url origin "$ORIGIN"

step "the Linux install"
args=(--yes --no-app)
[ -z "$RELAY" ] || args+=(--relay-url "$RELAY")
[ "$DRY" = 0 ] || args+=(--dry-run)
(cd "$REPO" && ./install.sh "${args[@]}")

step "Chronos (scheduled jobs)"
# >>> install_chronos
# Chronos, the scheduler, as on a Mac: one commit's tarball, checked against the SHA-256 pinned above like the toolchain
# (R1-6), then its own install.sh as talos. Its runtime goes to ~/.local/share/chronos, where the bridge looks
# (apps/bridge/src/schedules/discovery.ts). A fresh install's jobs are Talos's to run: session_runner talos,
# approval_required true, which is what `talos-app schedules adopt` sets on a Mac. Without it the bridge only shows jobs
# (session_runner_conflict). Jobs the owner already had before Chronos came here are left as they are. A run that stops
# between the install and that switch makes the switch on the next run (the .talos-adopt mark, kept beside jobs.json). The
# runtime or the config folder gone (either one) is installed again.
install_chronos() {
  local d out pin="$HOME/.local/share/chronos/.talos-pin" jobs="$HOME/.config/chronos/jobs.json"
  local mark="$HOME/.config/chronos/.talos-adopt"
  if [ "$(cat "$pin" 2>/dev/null)" != "$CHRONOS_COMMIT" ] || [ ! -e "$jobs" ]; then
    if [ ! -e "$jobs" ] && [ "$DRY" = 0 ]; then
      mkdir -p "$(dirname "$mark")"
      : >"$mark"
    fi
    d="$(mktemp -d)"
    run fetch_pinned "https://codeload.github.com/treynortetik-creator/chronos/tar.gz/$CHRONOS_COMMIT" "$CHRONOS_SHA256" \
      "$d/chronos.tgz" || { rm -rf "$d"; return 1; }
    run tar -xzf "$d/chronos.tgz" -C "$d"
    run "$d/chronos-$CHRONOS_COMMIT/install.sh" --quiet --no-ui --workspace "$HOME/chronos-workspace"
    rm -rf "$d"
    [ "$DRY" = 1 ] || printf '%s\n' "$CHRONOS_COMMIT" >"$pin"
  fi
  if [ -e "$mark" ]; then
    if [ "$DRY" = 1 ]; then echo "would hand Chronos's jobs to Talos (session_runner talos)"; return 0; fi
    # Chronos's own answer, not only its exit: {"ok": true, ...} (a refusal is {"error": ...}); the mark stays otherwise
    out="$("$HOME/.local/share/chronos/bin/chronos" api config set session_runner talos approval_required true)"
    printf '%s' "$out" | grep -Eq '"ok": *true' || {
      echo "setup-user: Chronos did not take the switch to Talos; run Setup again" >&2
      return 1
    }
    rm -f "$mark"
    echo "Chronos: set up for Talos"
  fi
}
# <<< install_chronos
install_chronos
fi # START != only

step "the supervisor"
# its settings: the agent folder and the same mod and channel flags the Mac app gets in desktop.json (install.sh APP_FLAGS).
# Written once; an owner's own supervisor.json is never overwritten.
conf="$HOME/.config/talos/app/supervisor.json"
# >>> repin_claude
# A kept supervisor.json (Setup run again) still names the Claude Code an earlier Setup pinned (WINPROTO-3, 2026-11-16): the
# new pinned version was installed but never launched. When its claude_path is exactly an earlier pinned default
# ($HOME/.local/share/claude/versions/<x.y.z>) and not this one, only that field moves to this version; the launch then
# differs from the approved one, so the tray asks the owner to approve it again. A path the owner set himself is kept.
repin_claude() {
  local conf="$1" want="$2" old v
  old="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("claude_path", ""))' "$conf" 2>/dev/null)" || old=""
  v="${old#"$HOME/.local/share/claude/versions/"}"
  case "$v" in
  "$old" | "" | *[!0-9.]* | .* | *. | *..*)
    echo "supervisor.json: kept as it is"
    return 0
    ;;
  esac
  if [ "$old" = "$want" ]; then
    echo "supervisor.json: kept as it is"
    return 0
  fi
  if [ "$DRY" = 1 ]; then
    echo "would move supervisor.json's Claude Code from $v to ${want##*/}"
    return 0
  fi
  python3 -I - "$conf" "$want" <<'PY' || { echo "setup-user: could not move supervisor.json to Claude Code ${want##*/}" >&2; return 1; }
import json, os, sys
p, want = sys.argv[1], sys.argv[2]
with open(p, encoding="utf-8") as f:
    d = json.load(f)
d["claude_path"] = want
tmp = p + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    f.write(json.dumps(d, indent=2) + "\n")
os.replace(tmp, p)
PY
  echo "supervisor.json: Claude Code moves from $v to ${want##*/}; approve the change in the tray (Approve this change)"
}
# <<< repin_claude
if [ -f "$conf" ]; then
  CLAUDE_REAL="$HOME/.local/share/claude/versions/$CLAUDE_VERSION"
  if [ "$(realpath -e "$CLAUDE_REAL" 2>/dev/null)" = "$CLAUDE_REAL" ]; then
    repin_claude "$conf" "$CLAUDE_REAL"
  else
    echo "supervisor.json: kept as it is (Claude Code $CLAUDE_VERSION is not at $CLAUDE_REAL)"
  fi
else
  run mkdir -p "$(dirname "$conf")"
  if [ "$DRY" = 1 ]; then echo "would write $conf"; else
    # claude_path: the pinned version's own real path (no link anywhere in it), as both sides of the launch approval
    # require; root approves exactly this launch before the supervisor first starts (launch.py install_defaults)
    CLAUDE_REAL="$HOME/.local/share/claude/versions/$CLAUDE_VERSION"
    [ "$(realpath -e "$CLAUDE_REAL" 2>/dev/null)" = "$CLAUDE_REAL" ] || {
      echo "setup-user: Claude Code $CLAUDE_VERSION is not at $CLAUDE_REAL" >&2
      exit 1
    }
    # written by the very function root's install approval approves (launch.py install-defaults; Fable R4-5), so a flag
    # added in one place can never differ from what root approved
    python3 -I /opt/talos-wsl/launch.py install-defaults >"$conf.tmp"
    [ "$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["claude_path"])' "$conf.tmp")" = "$CLAUDE_REAL" ] || {
      echo "setup-user: the install's launch does not name Claude Code $CLAUDE_VERSION at $CLAUDE_REAL" >&2
      rm -f "$conf.tmp"
      exit 1
    }
    mv "$conf.tmp" "$conf"
    chmod 600 "$conf"
    echo "supervisor.json: written"
  fi
fi
unit="$HOME/.config/systemd/user/talos-supervisor.service"
run mkdir -p "$(dirname "$unit")"
if [ "$DRY" = 1 ]; then
  echo "would write $unit and enable it"
else
  (cd "$REPO" && bun run apps/bridge/src/cli.ts supervise unit) >"$unit.tmp"
  if cmp -s "$unit.tmp" "$unit"; then rm -f "$unit.tmp"; else mv "$unit.tmp" "$unit"; fi
  if [ "$START" = no ] && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable talos-supervisor.service
    echo "supervisor: enabled, not started yet (root copies the kit first)"
  elif systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    systemctl --user enable talos-supervisor.service
    systemctl --user restart talos-supervisor.service
    # "active" the instant after a start proves nothing: a supervisor that cannot read its settings exits and is
    # restarted every few seconds. It has to stay up, with no NEW restart (the count survives a restart), for 10 s.
    before="$(systemctl --user show talos-supervisor.service -p NRestarts --value)"
    sleep 10
    state="$(systemctl --user is-active talos-supervisor.service || true)"
    after="$(systemctl --user show talos-supervisor.service -p NRestarts --value)"
    if [ "$state" = active ] && [ "$after" = "$before" ]; then echo "supervisor: running"; else
      echo "setup-user: the supervisor is not staying up ($state, $((after - before)) restarts in 10 s). Its log:" >&2
      journalctl --user -u talos-supervisor.service --no-pager -n 8 >&2 || true
      exit 1
    fi
  else
    echo "supervisor: the unit is written; it starts once systemd runs (after the distro restarts)"
  fi
fi
echo "== Talos is set up in this distro"
