#!/usr/bin/env bash
# The Talos WSL distro's own settings, run as root inside it (docs/WINDOWS-PLAN.md section 8). install.ps1 calls it; the
# owner's add-folder.ps1 calls `folder-add`. Everything it reads or writes is under $TALOS_WSL_ROOT (empty: the real /), so
# scripts/windows-distro.test.ts runs it against a scratch folder; TALOS_WSL_MOUNT and TALOS_WSL_UMOUNT stand in for
# mount(8) and umount(8) there.
#
#   talos-wsl.sh wsl-conf                     interop and automount off, systemd on, default user talos, fstab mounts on
#   talos-wsl.sh root-setup                   the talos user (uid 1000, never in sudo), packages, the isolation unit, linger
#   talos-wsl.sh isolate-mounts               no WSLg (/mnt/wslg, the X11 socket), a private /mnt/wsl (the boot unit runs it)
#   talos-wsl.sh isolation                    exit 1 unless every one of those holds, and interop and the drives are off
#   talos-wsl.sh protect-add 'C:\Folder'      a Windows folder no share may be, hold or sit inside (Talos's own files)
#   talos-wsl.sh folder-add [--read-only] 'C:\Some\Folder'   one Windows folder at /mnt/win/<name> (prints that path last)
#   talos-wsl.sh folder-remove /mnt/win/<name>
#   talos-wsl.sh folder-list                  /mnt/win/<name><TAB>C:\Some\Folder, one a line
#   talos-wsl.sh hold                         what the keep-alive runs: sleeps while isolated (checked every 60 s), exits 1 saying why when not
#   talos-wsl.sh run -- <cmd> [args]          the command, only while isolated (what Windows-side launches go through)
#   talos-wsl.sh status                       isolated=<yes|no>, then supervisor=<word> main=<state> launch=<root's word> (the tray);
#                                             not isolated: the agent is stopped
#   talos-wsl.sh give-back-interop            WSL's interop entry registered again if this distro's start took it (uninstall.ps1)
#   talos-wsl.sh launch-check                 how Talos starts Claude now, as JSON, and whether the owner approved it (launch.py)
#   talos-wsl.sh launch-approve <fingerprint> approve that start, only if it is still the one shown (/etc/talos/launch-approved)
#   talos-wsl.sh launch-approve-install       install.ps1's only approval: the install's own launch, worked out by root,
#                                             only before the supervisor's first start (launch.py approve-install)
#   talos-wsl.sh relay-set https://host       the install's relay URL, root's own (/etc/talos/relay: what pairing checks against)
#   talos-wsl.sh relay-key                    BRIDGE_PUBKEY=<the key the first install saw>, then `changed` if bridge.key is no longer it
#   talos-wsl.sh signin                       sign in to Claude (signin.py: JSON lines out, the code in), only while isolated
#   talos-wsl.sh pair                         pair a phone (pair.py: JSON lines out, the answer in), only while isolated
#   talos-wsl.sh restart                      start or restart Talos (the tray): one word, restarted | not-isolated | failed
#   talos-wsl.sh restore                      restore last good setup, then restart (the tray): fixed words only
#   talos-wsl.sh signout                      the Claude token goes
#   talos-wsl.sh kit-update                   root's sealed copy of the kit talos built, its record, and Claude Code's policy
#                                             (kit.py: the tray's "Update the kit", and install before the first start);
#                                             one fixed word, only while isolated
#   talos-wsl.sh units                        what root-setup writes to /etc (the boot unit, the user manager gate, logins)
#
# No Windows folder is shared by default (owner, 2026-11-11): interop off means a Linux process cannot start a Windows one,
# automount off means C: is not under /mnt; only the folders the owner adds, one by one, are mounted.
set -euo pipefail

# The TALOS_WSL_* names are the test's stand-ins, for a run as an ordinary user against a scratch root:
#   ROOT, MOUNT, UMOUNT, WSLINFO, UID, GID, STARTED, HOLD_CHECK_S, SYSTEMCTL, LOGINCTL, LAUNCH, KIT.
# As root every one is ignored (Pantheon on bbdcdd36, as Fable R5-5 for pair.py): a WSLENV entry or anything else that
# reaches root's environment cannot point root at another file, program or folder. EUID is bash's own, not from PATH.
if [ "$EUID" -eq 0 ]; then
  for v in $(compgen -v TALOS_WSL_ || true); do unset "$v"; done
fi

R="${TALOS_WSL_ROOT:-}"
MOUNT="${TALOS_WSL_MOUNT:-mount}"
UMOUNT="${TALOS_WSL_UMOUNT:-umount}"
WSLINFO="${TALOS_WSL_WSLINFO:-/usr/bin/wslinfo}"
USER_NAME=talos
MARK='# written by Talos (apps/windows/distro/talos-wsl.sh); the previous file, if any, is wsl.conf.before-talos'

die() {
  echo "talos-wsl: $*" >&2
  exit 1
}
owner_ids() {
  OWN_UID="${TALOS_WSL_UID:-$(id -u "$USER_NAME" 2>/dev/null || echo 1000)}"
  OWN_GID="${TALOS_WSL_GID:-$(id -g "$USER_NAME" 2>/dev/null || echo 1000)}"
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

conf_text() {
  cat <<EOF
$MARK
[boot]
systemd=true
[user]
default=$USER_NAME
[interop]
enabled=false
appendWindowsPath=false
[automount]
enabled=false
mountFsTab=true
EOF
}

wsl_conf() {
  local f="$R/etc/wsl.conf" want
  want="$(conf_text)"
  if [ -f "$f" ] && [ "$(cat "$f")" = "$want" ]; then
    echo "wsl.conf already set"
    return
  fi
  # one backup of a file Talos did not write; never overwritten by a later run
  if [ -f "$f" ] && ! grep -qF "$MARK" "$f" && [ ! -e "$f.before-talos" ]; then cp -p "$f" "$f.before-talos"; fi
  printf '%s\n' "$want" >"$f.talos-tmp"
  mv "$f.talos-tmp" "$f"
  echo "wsl.conf written (it takes effect when the distro starts again)"
}

# ---- isolation from Windows -----------------------------------------------------------------------------------------

# WSLg (the GUI bridge: X11 and Wayland sockets, the clipboard, sound) lives at /mnt/wslg and is bound to /tmp/.X11-unix;
# /mnt/wsl is shared by every distro on the PC. Neither is for Talos: WSLg is unmounted, and /mnt/wsl is covered with a
# private tmpfs, mounted as `talos-private` so /proc/mounts tells it from the shared one. Per distro: the owner's other
# distros keep theirs. WSL points /etc/resolv.conf at /mnt/wsl/resolv.conf (found live on Titan: covering it left the distro
# with no DNS), so its nameserver and search lines, which WSL writes before systemd starts, are carried into the private one.
# Every one of these mounts is made private in this distro (--make-rprivate), parents first, before anything is unmounted or
# covered, and a mount that cannot be made private stops it all: they are in a shared peer group that reaches WSL's own VM,
# and a mount or unmount made on them as they are propagates out, an unmount through the PARENT's group (Fable, R2-1). Found
# live on Titan: a tmpfs mounted straight onto /mnt/wsl reached the VM, and from then no distro on the PC could start
# (Wsl/Service/CreateInstance/E_UNEXPECTED) until `wsl --shutdown`. It ends by checking `isolation` against /proc/mounts as
# it is then, so the boot unit fails, and what needs it does not start, if anything is left.
WSLG_MOUNTS='$2 ~ /^\/mnt\/wslg(\/|$)/ || $2 == "/tmp/.X11-unix" { print $2 }'
# wsl.conf turns interop off: the LAST `enabled` in any [interop] section (as WSL reads it, the last one wins) is exactly
# `false`, in any case. Only a # comment is cut, and spaces only around the key and the value (R5-1): `en abled`, `fal se`
# or a `;` in the value are not `false`. Anything else, 1, 0, yes, a typo, none at all, counts as on: a value WSL might read
# as true is never taken for off (R4-6).
interop_off_in_conf() {
  [ -f "$R/etc/wsl.conf" ] || return 1
  awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    { line = $0; sub(/#.*$/, "", line); line = trim(line) }
    line ~ /^\[.*\]$/ { sect = tolower(trim(substr(line, 2, length(line) - 2))); next }
    sect == "interop" && index(line, "=") {
      key = tolower(trim(substr(line, 1, index(line, "=") - 1)))
      if (key == "enabled") off = (tolower(trim(substr(line, index(line, "=") + 1))) == "false")
    }
    END { exit !off }' "$R/etc/wsl.conf"
}
# a file's modification time in epoch seconds, on GNU (the distro) and BSD (a Mac running the tests) alike (R4-4)
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
# wsl.conf is older than this start of the distro, so what it says is what WSL applied. The start is the distro's own PID 1
# (the VM's boot time plus PID 1's start), not /proc/uptime, which is the shared VM's (found live: every wsl.conf looked
# newer than "the start"). TALOS_WSL_STARTED (epoch seconds) stands in for it in tests. The boot time is wall-clock
# (btime) and the comparison is with a file's wall-clock mtime, so a large step of the clock between boot and now can make
# this pass or refuse wrongly (R4-7); the distro restarts, and WSL syncs the clock, often enough for that to be rare.
distro_started() {
  if [ -n "${TALOS_WSL_STARTED:-}" ]; then
    echo "$TALOS_WSL_STARTED"
    return
  fi
  local btime ticks hz
  btime="$(awk '$1 == "btime" { print $2 }' /proc/stat)"
  ticks="$(awk '{ sub(/^.*\) /, ""); print $20 }' /proc/1/stat)"
  hz="$(getconf CLK_TCK)"
  echo $((btime + ticks / hz))
}
interop_conf_applied() {
  [ "$(mtime "$R/etc/wsl.conf")" -le "$(distro_started)" ]
}
mounted_at() { awk -v m="$1" '$2 == m { found = 1 } END { exit !found }' "$R/proc/mounts"; }
# the source and type of the mount on top at /mnt/wsl (the last line for it), e.g. "talos-private tmpfs"
wsl_top() { awk '$2 == "/mnt/wsl" { top = $1 " " $3 } END { print top }' "$R/proc/mounts"; }

# WSL's binfmt entry for Windows programs, given back to the owner's other distros. It is ONE entry for the whole VM (R4-2),
# and WSL itself takes it out when a distro with interop off starts (found live on Titan, 2026-11-12: every start of this
# distro, or of the CI runner's, left the owner's Ubuntu with "Exec format error" for every .exe). So at each boot, if it
# is gone, it is registered again, exactly as WSL's own systemd-binfmt drop-in does. Only ever `register`, only when it is
# missing; never removed or changed (R4-2). Interop in THIS distro stays off: wsl.conf says so, and WSL then serves no
# Windows program here whatever the entry says (`isolation`).
give_back_interop() {
  local d="$R/proc/sys/fs/binfmt_misc"
  [ -e "$d/register" ] || return 0
  [ -e "$d/WSLInterop" ] && return 0
  printf '%s\n' ':WSLInterop:M::MZ::/init:P' >"$d/register" 2>/dev/null ||
    echo "talos-wsl: could not give WSL's interop entry back to the other distros (their .exe files fail until: wsl --shutdown)" >&2
}

# The IPv4 default gateway (WSL's NAT gateway), from the route table, dotted; nothing when there is none. The kernel writes
# it as little-endian hex (Gateway column of the 00000000 destination); of several default routes (a VPN's beside eth0),
# the lowest Metric wins, as it does for the kernel.
default_gateway() {
  awk 'function h(s) { return (index("0123456789ABCDEF", substr(s, 1, 1)) - 1) * 16 + index("0123456789ABCDEF", substr(s, 2, 1)) - 1 }
    $2 == "00000000" && length($3) == 8 && toupper($3) !~ /[^0-9A-F]/ && $3 != "00000000" && (best == "" || $7 + 0 < m) {
      best = toupper($3); m = $7 + 0 }
    END { if (best != "") printf "%d.%d.%d.%d\n", h(substr(best, 7, 2)), h(substr(best, 5, 2)), h(substr(best, 3, 2)), h(substr(best, 1, 2)) }' \
    "$R/proc/net/route" 2>/dev/null || true
}
# WSL's DNS tunnel (the 10.255.255.254 it writes) can stop answering while Windows stays online (found live on Titan,
# 2026-11-14: every distro lost names; WSL's NAT gateway and Windows still answered). The gateway is added as a second
# nameserver with short timeouts, so a dead tunnel costs a lookup about 2 s and nothing stops: the tunnel stays first,
# nothing changes while it answers within 2 s, and the owner's own WSL settings are never touched.
dns_with_fallback() {
  local gw
  printf '%s\n' "$1"
  gw="$(default_gateway)"
  [ -n "$gw" ] || return 0
  # already named (spacing aside): nothing added
  printf '%s\n' "$1" | awk -v gw="$gw" '$1 == "nameserver" && $2 == gw { f = 1 } END { exit !f }' && return 0
  printf 'nameserver %s\noptions timeout:2 attempts:2\n' "$gw"
}

isolate_mounts() {
  local m dns i
  give_back_interop
  # Interop in this distro is what wsl.conf says, which `isolation` checks.
  # parents first: /mnt/wslg before /mnt/wslg/distro
  for m in $(awk "$WSLG_MOUNTS" "$R/proc/mounts" | sort -u); do
    $MOUNT --make-rprivate "$R$m" || die "could not make $m private; nothing was unmounted (an unmount would reach other distros)"
  done
  # then the deepest first, so no parent is busy
  for m in $(awk "$WSLG_MOUNTS" "$R/proc/mounts" | sort -ru); do
    mounted_at "$m" || continue # a parent's lazy unmount took it already
    $UMOUNT -l "$R$m" || die "could not unmount $m"
  done
  if [ "$(wsl_top)" != "talos-private tmpfs" ]; then
    dns="$(grep -E '^(nameserver|search) ' "$R/mnt/wsl/resolv.conf" 2>/dev/null || true)"
    for i in 1 2 3 4; do
      mounted_at /mnt/wsl || break
      $MOUNT --make-rprivate "$R/mnt/wsl" || die "could not make /mnt/wsl private; nothing was mounted on it"
      $UMOUNT -l "$R/mnt/wsl" || die "could not unmount the shared /mnt/wsl"
    done
    mounted_at /mnt/wsl && die "/mnt/wsl is still mounted after 4 unmounts"
    mkdir -p "$R/mnt/wsl"
    $MOUNT -t tmpfs -o size=64k,mode=755 talos-private "$R/mnt/wsl"
    $MOUNT --make-private "$R/mnt/wsl"
    if [ -n "$dns" ]; then dns_with_fallback "$dns" >"$R/mnt/wsl/resolv.conf"; fi
  fi
  isolation
}

# Exit 1, saying which, unless: interop is off, no whole Windows drive is mounted at /mnt/<letter> (an empty /mnt/c folder is
# not a mount; a share at /mnt/win/<name> is fine), nothing of WSLg is mounted, the mount on top at /mnt/wsl is the private
# tmpfs (what /proc/mounts says, never a file in it: R2-4) holding nothing but the DNS lines, and WSL's networking is not
# mirrored (which shares the PC's localhost with every distro; install.ps1 refuses it too, this catches it set later: R2-9).
# The boot unit runs it, and so does every start of a user manager, the supervisor's included (root-setup).
isolation() {
  local bad=0 drives wslg extra mode
  # Interop: what decides it is wsl.conf, which WSL reads when the distro starts ([interop] enabled=false: WSL then serves
  # no Windows program; found live, every .exe, and /init with WSL_INTEROP set, failed). WSL's binfmt entry for .exe files
  # is no sign either way: WSL registers it at start even with interop off, sometimes after the boot unit has taken it out
  # (found live), so it counts only where wsl.conf leaves interop on. wsl.conf is root's; the agent cannot change it.
  if ! interop_off_in_conf; then
    echo "talos-wsl: interop is on (Linux processes can start Windows programs): $R/etc/wsl.conf does not turn it off" >&2
    bad=1
  elif ! interop_conf_applied; then
    echo "talos-wsl: interop may be on (Linux processes can start Windows programs): wsl.conf changed after the distro started, and counts only from its next start" >&2
    bad=1
  fi
  mode="$("$WSLINFO" --networking-mode 2>/dev/null | tr -d '\r' || true)"
  case "$mode" in
  mirrored)
    echo "talos-wsl: WSL's networking is mirrored (this PC's localhost is shared with every distro); set networkingMode=nat in .wslconfig, then wsl --shutdown" >&2
    bad=1
    ;;
  nat | bridged | virtioproxy | none) ;;
  *)
    echo "talos-wsl: cannot tell WSL's networking mode (wslinfo said '$mode'); WSL 2.4 or later is needed" >&2
    bad=1
    ;;
  esac
  drives="$(awk '$2 ~ /^\/mnt\/[a-z]$/ { print $2 }' "$R/proc/mounts" | tr '\n' ' ')"
  if [ -n "$drives" ]; then
    echo "talos-wsl: Windows drives are mounted: $drives" >&2
    bad=1
  fi
  wslg="$(awk "$WSLG_MOUNTS" "$R/proc/mounts" | tr '\n' ' ')"
  if [ -n "$wslg" ]; then
    echo "talos-wsl: WSLg is mounted (Windows' screen, clipboard and sound): $wslg" >&2
    bad=1
  fi
  if [ "$(wsl_top)" != "talos-private tmpfs" ]; then
    echo "talos-wsl: /mnt/wsl is the one every distro shares, not Talos's private one" >&2
    bad=1
  else
    # from /: find fails when it cannot get back to a working directory the caller cannot read (found live: as talos from
    # root's home, `isolation` ended with no word)
    extra="$(cd / && find "$R/mnt/wsl" -mindepth 1 -maxdepth 1 ! -name resolv.conf 2>/dev/null | head -3 | tr '\n' ' ')"
    if [ -n "$extra" ]; then
      echo "talos-wsl: the private /mnt/wsl holds more than WSL's DNS lines: $extra" >&2
      bad=1
    fi
  fi
  # a share of Talos's own files still mounted (one in use when protect-add took it out of fstab: R3-1)
  local p
  p="$(mounted_protected)"
  if [ -n "$p" ]; then
    echo "talos-wsl: a share of Talos's own files is still mounted: $p; restart the distro (wsl --terminate <distro>)" >&2
    bad=1
  fi
  [ "$bad" = 0 ] || exit 1
  # Not "isolated" from everything (R3-3): WSL 2 runs every distro in one network namespace, so a service on 127.0.0.1 in the
  # owner's other distros (Docker, a database, a dev server) is reachable from this one, and the other way round.
  echo "isolated from Windows: interop off, no Windows drive, no WSLg, a private /mnt/wsl, NAT networking" \
    "(localhost is still shared with this PC's other WSL distros)"
}

# The mounted shares (/mnt/win/<name>) that are, hold or sit inside a protected folder, as "<at> (<folder>)". /proc/mounts
# writes the source's backslashes and spaces as \134 and \040.
mounted_protected() {
  local f src at low p
  f="$(protected_file)"
  [ -f "$f" ] && [ -f "$R/proc/mounts" ] || return 0
  awk '$2 ~ /^\/mnt\/win\// { print $1 "\t" $2 }' "$R/proc/mounts" | while IFS=$'\t' read -r src at; do
    src="$(printf '%s' "$src" | sed 's/\\134/\\/g; s/\\040/ /g; s/\\011/\t/g; s|/|\\|g')"
    low="$(lower "$src")"
    while IFS= read -r p; do
      if [ -n "$p" ] && overlaps "$low" "$p"; then
        printf '%s (%s) ' "$at" "$src"
        break
      fi
    done <"$f"
  done
  # a share that is not protected must not end the caller (set -e): found live, an ordinary share made `isolation` exit 1
  # with no word
  return 0
}

# What the keep-alive runs (R3-2): the distro is held only while it is cut off from Windows. A broken isolation ends it,
# saying why, at once or within HOLD_CHECK_S while it holds (R4-8); keepalive.ps1 logs that and tells the owner.
HOLD_CHECK_S="${TALOS_WSL_HOLD_CHECK_S:-60}"
refused() {
  # the pipeline fails (isolation does), and under set -e that would end it with the pipeline's status: exit 1 on purpose
  # (R5-6)
  (isolation) 2>&1 | sed 's/^/refused: /' >&2 || true
  exit 1
}
hold() {
  while true; do
    (isolation) >/dev/null 2>&1 || {
      stop_agent
      refused
    }
    # any interop-off distro's start (talos-ci's, a second Talos's) takes WSL's one VM-wide entry away from the others:
    # while Talos runs, it is given back within a minute here, and within 30 s by the tray's status (found live, R2)
    give_back_interop
    sleep "$HOLD_CHECK_S"
  done
}

# The agent stopped, by root, when the distro is found not cut off from Windows at runtime (Fable R1-2 on edb035b3): the
# user manager's gate only keeps it from STARTING then; one already running would go on with Windows in reach. talos's
# whole user manager (the supervisor and everything it started) and any login session of talos's go. --no-block, so a
# status poll stays quick; the next poll sees it stopped. In the test root (TALOS_WSL_ROOT) these default to `true`: a
# test never stops the real machine's sessions.
SYSTEMCTL="${TALOS_WSL_SYSTEMCTL:-$([ -n "$R" ] && echo true || echo systemctl)}"
LOGINCTL="${TALOS_WSL_LOGINCTL:-$([ -n "$R" ] && echo true || echo loginctl)}"
stop_agent() {
  local uid
  uid="$(id -u "$USER_NAME" 2>/dev/null)" || return 0
  timeout -k 5 5 "$SYSTEMCTL" stop --no-block "user@$uid.service" >/dev/null 2>&1 || true
  timeout -k 5 5 "$LOGINCTL" terminate-user "$USER_NAME" >/dev/null 2>&1 || true
}

# For the tray (Windows step 2), every 30 s, two lines (Fable R1-1 on edb035b3):
#   isolated=<yes|no>                     first, and at once: root's own check (`isolation`, the same as the boot unit's
#                                         and the user manager's gate), nothing the agent can slow down
#   supervisor=<systemd's word> main=<Main's state>
# The second line asks talos's own user manager and reads a file of talos's, each under a few seconds' `timeout`: the agent
# can stall its user manager (SIGSTOP), and a stalled answer is `unknown`, never a wait past the tray's 8 s. It never fails
# itself, and only the expected words pass (anything else, a garbled or hostile answer, is `unknown`). Not cut off from
# Windows: the agent is stopped first (stop_agent). Run as root (the tray asks with -u root).
status() {
  local uid sup main isolated=yes
  (isolation) >/dev/null 2>&1 || isolated=no
  echo "isolated=$isolated"
  if [ "$isolated" = yes ]; then give_back_interop; else stop_agent; fi
  uid="$(id -u "$USER_NAME" 2>/dev/null || echo none)"
  sup="$(timeout -k 5 3 runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user is-active talos-supervisor.service 2>/dev/null | head -1 || true)"
  case "$sup" in
  active | activating | deactivating | inactive | failed | reloading) ;;
  *) sup=unknown ;;
  esac
  # Main's own state, as the supervisor writes it (Hestia's run/main-state: running, starting, stopped, signin, or
  # waiting:<why>), read as talos (a link there cannot make root read anything) and only in those words; else unknown
  main="$(timeout -k 5 2 runuser -u "$USER_NAME" -- head -c 64 "$(app_home)/run/main-state" 2>/dev/null | head -1 || true)"
  case "$main" in
  main=running | main=starting | main=stopped | main=signin) main="${main#main=}" ;;
  main=waiting:trust | main=waiting:mcp_consent | main=waiting:dev_channels | main=waiting:api_key | main=waiting:bypass | main=waiting:unknown) main="${main#main=}" ;;
  *) main=unknown ;;
  esac
  # whether a launch waits for the owner's approval, from root's own check (launch.py state; Fable R3-5 on a44344c2),
  # never from talos's files: approved | pending | unapprovable | none, else unknown
  local launch
  launch="$(timeout -k 5 3 /usr/bin/python3 -I "${TALOS_WSL_LAUNCH:-/opt/talos-wsl/launch.py}" state 2>/dev/null | head -1 || true)"
  case "$launch" in
  approved | pending | unapprovable | none) ;;
  *) launch=unknown ;;
  esac
  echo "supervisor=$sup main=$main launch=$launch"
}

# The supervisor's folder for talos ($TALOS_APP_HOME's default, apps/bridge/src/config.ts)
app_home() { printf '%s/.config/talos/app' "$(getent passwd "$USER_NAME" | cut -d: -f6)"; }

# Sign in to Claude (the tray's "Sign in to Claude"): signin.py runs `claude setup-token` as talos in its own pty and
# writes the token itself; Windows gets only the link and a result (JSON lines). Only while isolated, like `run`.
signin() {
  (isolation) >/dev/null 2>&1 || refused
  exec /usr/bin/python3 -I /opt/talos-wsl/signin.py
}
# Pair a phone (the tray's "Pair a phone"): pair.py runs `talos-app enroll --json` as talos in its own pty and passes on
# only the events its contract names, checked; the tray's answer comes back as one line. Only while isolated, like `run`.
pair() {
  (isolation) >/dev/null 2>&1 || refused
  exec /usr/bin/python3 -I /opt/talos-wsl/pair.py
}
# Start or restart Talos (the tray's "Start Talos" / "Restart Talos"), as root, only while the distro is cut off from
# Windows and only when root's own launch state says approved. talos's user manager is started if it is not running (after the distro was not cut off from Windows, root
# stopped it: stop_agent), then the supervisor is restarted. It prints ONE fixed word, never anything of talos's (Fable R4-1
# on f1699c11): restarted | not-isolated | not-approved | failed.
launch_approved() {
  [ "$(timeout -k 5 10 /usr/bin/python3 -I "${TALOS_WSL_LAUNCH:-/opt/talos-wsl/launch.py}" state 2>/dev/null | head -1)" = approved ]
}
restart_talos() {
  (isolation) >/dev/null 2>&1 || {
    echo not-isolated
    exit 1
  }
  # never a start of a launch the owner has not approved (Fable R7-1 on 9612c7d7): root's own word (launch.py state), not
  # talos's; "Approve this change" comes first
  launch_approved || {
    echo not-approved
    exit 1
  }
  local uid
  uid="$(id -u "$USER_NAME" 2>/dev/null)" || {
    echo failed
    exit 1
  }
  timeout -k 5 20 "$SYSTEMCTL" start "user@$uid.service" >/dev/null 2>&1 || true
  if timeout -k 5 30 runuser -u "$USER_NAME" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user restart talos-supervisor.service >/dev/null 2>&1; then
    echo restarted
  else
    echo failed
    exit 1
  fi
}

# Restore last good setup (the tray's, as the Mac's menu bar has: SupervisorRecovery.swift), as root, only while cut off
# from Windows: `talos-app restore-last-good --yes --newest-start` as talos, on the install's agent folder, then a restart.
# talos's output is only read to tell which outcome it was; what is printed is fixed words, one a line:
# restored (then restart_talos's word) | nothing-to-do | nothing-saved | not-isolated | not-approved | failed.
restore_last_good() {
  (isolation) >/dev/null 2>&1 || {
    echo not-isolated
    exit 1
  }
  launch_approved || {
    echo not-approved
    exit 1
  }
  local home out
  home="$(getent passwd "$USER_NAME" | cut -d: -f6)"
  [ -n "$home" ] || {
    echo failed
    exit 1
  }
  # the whole pipeline under one group time limit (Fable R7-2): a child of talos-app holding stdout open cannot keep root
  # waiting; and a clean environment, a fixed list (R7-4), as pair.py gives enroll
  out="$(timeout -k 5 95 sh -c 'runuser -u "$1" -- env -i HOME="$2" USER="$1" LOGNAME="$1" PATH="$2/.bun/bin:$2/.local/bin:/usr/local/bin:/usr/bin:/bin" "$2/.bun/bin/talos-app" restore-last-good --yes --newest-start --agent-dir "$2/talos-agent" 2>&1 </dev/null | head -c 65536' sh "$USER_NAME" "$home" || true)"
  if printf '%s\n' "$out" | grep -q '^restore-last-good: restored '; then
    echo restored
    restart_talos
  elif printf '%s\n' "$out" | grep -q 'already matches'; then
    echo nothing-to-do
  elif printf '%s\n' "$out" | grep -q 'nothing saved yet'; then
    echo nothing-saved
  else
    echo failed
    exit 1
  fi
}

# Sign out: the token goes (as talos); the supervisor then shows main=signin and the tray says "not signed in"
signout() {
  runuser -u "$USER_NAME" -- rm -f "$(app_home)/claude-oauth-token"
  echo "signed out"
}

# run -- <command>: the command, as whoever called this, only while the distro is cut off from Windows (R4-1). What Windows
# starts in the distro (`wsl -d <distro> -- <cmd>`, `--exec`) gets no login shell, so the login check below never sees it:
# install.ps1 prints the sign-in through this, and claude itself is wrapped (claude_wrapper).
run_gated() {
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || die "usage: talos-wsl.sh run -- <command> [args]"
  (isolation) >/dev/null 2>&1 || refused
  exec "$@"
}

# systemd-binfmt in this distro (found live on Titan, 2026-11-12): WSL writes its own override for it only where interop is
# on, so here the stock unit runs `systemd-binfmt --unregister` at shutdown, which clears EVERY binfmt entry in the VM,
# WSL's one Windows-program entry included (every other distro then fails each .exe). This drop-in clears that ExecStop,
# and makes its start give the entry back instead (only when missing; R4-2's rule).
binfmt_dropin() {
  cat <<'EOF'
# written by Talos (apps/windows/distro/talos-wsl.sh): never unregister WSL's VM-wide binfmt entries at shutdown
[Service]
ExecStop=
ExecStart=
ExecStart=/opt/talos-wsl/talos-wsl.sh give-back-interop
EOF
}

# /usr/local/bin/claude, root's: what `wsl -d <distro> -- claude` (no login shell, so no ~/.local/bin on PATH) finds first.
# It runs the user's own Claude Code only while the distro is cut off from Windows (R4-1). Sessions the supervisor starts
# use the login PATH, inside the gated user manager.
claude_wrapper() {
  cat <<'EOF'
#!/bin/sh
# written by Talos (apps/windows/distro/talos-wsl.sh): Claude Code only while this distro is cut off from Windows
exec /opt/talos-wsl/talos-wsl.sh run -- "$HOME/.local/bin/claude" "$@"
EOF
}

# Logins (R3-2): a `wsl -d <distro>` login shell as talos while isolation is broken is refused, saying why; root's still
# works, to look into it. Not everything is a login (R4-1): a command Windows starts (`wsl -d <distro> -- <cmd>`, `--exec`)
# skips this; the owner's own commands are theirs to start, and the ones Talos prints or wraps (the sign-in, claude) go
# through `run`. Cron and at are masked (root-setup); the agent itself runs only in the gated user manager.
login_gate() {
  cat <<'EOF'
# written by Talos (apps/windows/distro/talos-wsl.sh): no login as talos while the distro is not cut off from Windows
if [ "$(id -u)" != 0 ] && ! /opt/talos-wsl/talos-wsl.sh isolation >/dev/null 2>&1; then
  echo "This Talos distro is not cut off from Windows right now, so it does not let you in:" >&2
  /opt/talos-wsl/talos-wsl.sh isolation 2>&1 | sed 's/^talos-wsl: /  /' >&2
  echo "Restart it from Windows (wsl --terminate <distro>), or as root: journalctl -u talos-isolate" >&2
  exit 1
fi
EOF
}

# After what WSL itself sets up at boot: tmpfiles recreates /tmp/.X11-unix, then WSL's generated wslg.service binds WSLg
# there again (it exists "to prevent tmp.mount from hiding /tmp/.X11-unix"); run before them and they would undo it (R2-2).
isolate_unit() {
  cat <<'EOF'
# written by Talos (apps/windows/distro/talos-wsl.sh): no WSLg, a private /mnt/wsl, before anyone logs in
[Unit]
Description=Talos: no WSLg, a private /mnt/wsl
DefaultDependencies=no
After=local-fs.target tmp.mount systemd-tmpfiles-setup.service wslg.service
Before=sysinit.target systemd-user-sessions.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/opt/talos-wsl/talos-wsl.sh isolate-mounts

[Install]
WantedBy=sysinit.target
EOF
}

# Every user manager (the supervisor's, talos's, is one) needs the isolation unit to have succeeded, and checks isolation
# again as root when it starts: a failed or undone isolation starts no agent, and the journal says why (R2-2). A drop-in for
# the user@ template, root's: the supervisor's own unit lives in talos's home, which the agent can change.
user_gate() {
  cat <<'EOF'
# written by Talos (apps/windows/distro/talos-wsl.sh): no user manager, so no agent, without isolation from Windows
[Unit]
Requires=talos-isolate.service
After=talos-isolate.service

[Service]
ExecStartPre=+/opt/talos-wsl/talos-wsl.sh isolation
EOF
}

# ---- Windows folders -------------------------------------------------------------------------------------------------

# 'C:\Users\x\' -> 'C:\Users\x' (backslashes, the drive upper case, no trailing backslash or stray quote); refuses what is
# not a plain drive path: relative, UNC, device paths, `.` and `..`, a doubled separator.
normalize() {
  local p="${1//\//\\}"
  # a quoted argument that ended in a backslash ("C:\x\") arrives as C:\x" from Windows: the quote is not a name
  while [ -n "$p" ] && [[ "${p: -1}" == '"' || "${p: -1}" == "'" ]]; do p="${p%?}"; done
  case "$p" in
  \\\\*) die "not shared: a network or device path ($1); use a folder on a local drive" ;;
  esac
  [[ "$p" =~ ^[A-Za-z]:(\\|$) ]] || die "not shared: not a full Windows path with a drive letter ($1)"
  case "\\$p\\" in
  *\\..\\* | *\\.\\*) die "not shared: the path climbs with . or .. ($1)" ;;
  esac
  while [ "${#p}" -gt 3 ] && [ "${p: -1}" = '\' ]; do p="${p%\\}"; done
  case "${p:2}" in
  *\\\\*) die "not shared: a doubled separator in the path ($1)" ;;
  esac
  # the drive letter upper case with tr: GNU sed's \U is not in BSD sed (macOS wrote "UC:/...")
  printf '%s%s' "$(printf '%s' "${p:0:1}" | tr '[:lower:]' '[:upper:]')" "${p:1}"
}

# The folders no thread gets, whatever the case or the way they are written. add-folder.ps1 resolves the real, long path
# first (no 8.3 name, no link in any part); these hold for what reaches the distro anyway.
refuse_system() {
  local low comp
  low="$(lower "$1")"
  [[ "$low" =~ ^[a-z]:\\?$ ]] && die "not shared: a whole drive ($1)"
  IFS='\' read -r -a parts <<<"${low:3}"
  for comp in "${parts[@]}"; do
    [[ "$comp" =~ ~[0-9] ]] && die "not shared: a short 8.3 name ($comp); give the folder's full name ($1)"
    [[ "$comp" =~ [.\ ]$ ]] && die "not shared: a name that ends in a dot or a space ($comp), which Windows ignores ($1)"
    case "$comp" in
    appdata | 'application data' | 'local settings' | 'all users' | .ssh | .aws | .gnupg | .azure | .kube | .docker | .config)
      die "not shared: $comp holds programs' own data, keys or secrets ($1)" ;;
    esac
  done
  [[ "$low" =~ ^[a-z]:\\(windows|windows\.old|programdata|program\ files|program\ files\ \(x86\)|\$recycle\.bin|system\ volume\ information|recovery|boot|documents\ and\ settings)(\\|$) ]] &&
    die "not shared: a system folder ($1)"
  [[ "$low" =~ ^[a-z]:\\users$ ]] && die "not shared: every user's profile ($1)"
  [[ "$low" =~ ^[a-z]:\\users\\[^\\]+$ ]] && die "not shared: a whole profile; pick a folder inside it ($1)"
  return 0
}

protected_file() { printf '%s' "$R/etc/talos-wsl/protected"; }

# Talos's own files on the Windows side (the clone, %LOCALAPPDATA%\Talos): a share must not be one, hold one, or sit inside
# one, or the agent could rewrite what Windows runs as the owner.
# overlaps <a> <b>: two folded Windows paths where one is the other or holds it
overlaps() { [ "$1" = "$2" ] || [[ "$1" == "$2\\"* ]] || [[ "$2" == "$1\\"* ]]; }

refuse_protected() {
  local low p f
  low="$(lower "$1")"
  f="$(protected_file)"
  [ -f "$f" ] || return 0
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    overlaps "$low" "$p" && die "not shared: it is, holds or sits inside Talos's own files ($p)"
  done <"$f"
  return 0
}

# A protected folder is also taken out of any share already there (R2-5): an install over an older one, where the clone
# was shared before protection existed, leaves no share of it behind. A share in use cannot be unmounted (R3-1): its fstab
# line goes all the same, so it is not mounted again, it is said to be still mounted, and the exit is 3, "restart the
# distro": install.ps1 restarts it next, and until then `isolation` refuses (a protected share still mounted).
protect_add() {
  [ $# -eq 1 ] || die "usage: protect-add 'C:\\Folder'"
  local win low f at src rc=0
  win="$(normalize "$1")"
  low="$(lower "$win")"
  f="$(protected_file)"
  mkdir -p "$(dirname "$f")"
  touch "$f"
  if grep -qxF "$low" "$f"; then
    echo "already protected: $win"
  else
    printf '%s\n' "$low" >>"$f"
    echo "protected: $win"
  fi
  while IFS=$'\t' read -r at src; do
    overlaps "$low" "$(lower "$src")" || continue
    if unshare_at "$at"; then
      drop_line "$at"
      echo "it was shared at $at; no longer"
    else
      drop_line "$at"
      echo "it was shared at $at and is in use, so it stays mounted until the distro restarts; it is not shared again after"
      rc=3
    fi
  done < <(folder_list)
  return "$rc"
}

# the fstab source: forward slashes, spaces and tabs escaped as fstab wants
fstab_source() {
  local s="${1//\\//}"
  s="${s// /\\040}"
  printf '%s' "${s//$'\t'/\\011}"
}
# the other way, for folder-list
windows_path() {
  local s="${1//\\040/ }"
  s="${s//\\011/$'\t'}"
  printf '%s' "${s//\//\\}"
}

folder_name() {
  local base="${1##*\\}" n
  n="$(lower "$base" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  printf '%s' "${n:-folder}"
}

fstab_file() { printf '%s' "$R/etc/fstab"; }
mode_word() { if [ "$1" = ro ]; then echo read-only; else echo read-write; fi; }

# A share that holds, or sits inside, one already shared in the other mode is refused, naming it (R3-4): a read-write share
# of a parent makes a read-only child writable through it, and a read-only share inside a read-write one is writable anyway.
refuse_mixed_overlap() {
  local low mode="$2" at src opts
  low="$(lower "$1")"
  while IFS=$'\t' read -r at src opts; do
    [ "${opts%%,*}" = "$mode" ] && continue
    # the share itself, when it is the one changing mode, is not in its own way
    [ "$(lower "$src")" = "$low" ] && continue
    overlaps "$low" "$(lower "$src")" || continue
    if [ "$mode" = rw ]; then
      die "not shared: $src is shared read-only at $at, and a read-write share here would make it writable; share this read-only too, or remove that one first"
    else
      die "not shared read-only: $src is shared read-write at $at, so this would be writable through it anyway; share it read-write, or make that one read-only first"
    fi
  done < <(awk '$3 == "drvfs" && $2 ~ /^\/mnt\/win\// { print $2 "\t" $1 "\t" $4 }' "$(fstab_file)" | while IFS=$'\t' read -r at src opts; do
    printf '%s\t%s\t%s\n' "$at" "$(windows_path "$src")" "$opts"
  done)
}

# Unmounted (not lazily: a share in use is not left writable behind its own removal), or already not mounted. A share whose
# folder was deleted on Windows fails to mount at boot (nofail), so "not mounted" is not an error.
unshare_at() {
  $UMOUNT "$R$1" 2>/dev/null && return 0
  [ -f "$R/proc/mounts" ] && ! mounted_at "$1"
}
drop_line() {
  local f
  f="$(fstab_file)"
  awk -v m="$1" '!($3 == "drvfs" && $2 == m)' "$f" >"$f.talos-tmp"
  mv "$f.talos-tmp" "$f"
  rmdir "$R$1" 2>/dev/null || true
}

# change_mode <win> <at> <old opts> <new mode>: a share already there, mounted again read-only or read-write, and its fstab
# line to match. The unmount is not lazy: a folder the thread has a file open in is refused, not left writable behind a
# read-only mount point. Nothing changes unless the new mount is up.
change_mode() {
  local win="$1" at="$2" old="$3" mode="$4" new f
  new="$mode,${old#*,}"
  f="$(fstab_file)"
  $UMOUNT "$R$at" ||
    die "could not unmount $win (a file in it may be open in the distro), so it stays $(mode_word "${old%%,*}"); close what uses it and try again"
  if ! $MOUNT -t drvfs -o "$new" "$win" "$R$at"; then
    # the old mode back; if that fails too, say so (R3-6): it is not mounted now, and fstab still has the old line
    $MOUNT -t drvfs -o "$old" "$win" "$R$at" ||
      die "could not mount $win $(mode_word "$mode"), nor $(mode_word "${old%%,*}") again: it is not mounted now; fstab still shares it $(mode_word "${old%%,*}"), so it comes back so when the distro restarts"
    die "could not mount $win $(mode_word "$mode"); it is mounted $(mode_word "${old%%,*}") again, as before"
  fi
  TALOS_AT="$at" TALOS_NEW="$new" awk 'BEGIN { OFS = " " } $3 == "drvfs" && $2 == ENVIRON["TALOS_AT"] { $4 = ENVIRON["TALOS_NEW"] } { print }' "$f" >"$f.talos-tmp"
  mv "$f.talos-tmp" "$f"
  echo "shared $win ($(mode_word "$mode")), was $(mode_word "${old%%,*}")"
  echo "$at"
}

folder_add() {
  local mode=rw
  if [ "${1:-}" = --read-only ]; then
    mode=ro
    shift
  fi
  [ $# -eq 1 ] || die "usage: folder-add [--read-only] 'C:\\Some\\Folder'"
  owner_ids
  local win src f name base i line existing opts at
  win="$(normalize "$1")"
  refuse_system "$win"
  refuse_protected "$win"
  src="$(fstab_source "$win")"
  f="$(fstab_file)"
  touch "$f"
  # already shared (Windows folds case): in the same mode, say where and change nothing; in the other, change it (R2-3)
  # ENVIRON, not -v: awk -v would turn the escaped \040 back into a space and never match the stored line
  existing="$(TALOS_SRC="$src" awk '$3 == "drvfs" && tolower($1) == tolower(ENVIRON["TALOS_SRC"]) { print $2 " " $4; exit }' "$f")"
  if [ -n "$existing" ]; then
    at="${existing%% *}"
    opts="${existing#* }"
    if [ "${opts%%,*}" = "$mode" ]; then
      echo "already shared ($(mode_word "$mode"))"
      echo "$at"
      return
    fi
    # a mode change is a share in the new mode: the same overlap rule first (R4-3)
    refuse_mixed_overlap "$win" "$mode"
    change_mode "$win" "$at" "$opts" "$mode"
    return
  fi
  refuse_mixed_overlap "$win" "$mode"
  base="$(folder_name "$win")"
  name="$base"
  i=2
  while awk -v m="/mnt/win/$name" '$2 == m { found = 1 } END { exit !found }' "$f"; do
    name="$base-$i"
    i=$((i + 1))
  done
  at="/mnt/win/$name"
  # nofail: a shared folder deleted on the Windows side must not stop the distro's start (measured on Titan: without it, WSL
  # also fails to start talos's systemd user session, which is the session that runs the supervisor)
  opts="$mode,metadata,nofail,uid=$OWN_UID,gid=$OWN_GID,umask=022,fmask=011"
  # mounted first: fstab gets the line only for a folder that mounts, so a bad one is never left for every start to trip on
  mkdir -p "$R$at"
  if ! $MOUNT -t drvfs -o "$opts" "$win" "$R$at"; then
    rmdir "$R$at" 2>/dev/null || true
    die "could not mount $win (is it there, and a folder?); nothing was changed"
  fi
  line="$src $at drvfs $opts 0 0"
  if ! { cp -p "$f" "$f.talos-tmp" && printf '%s\n' "$line" >>"$f.talos-tmp" && mv "$f.talos-tmp" "$f"; }; then
    $UMOUNT "$R$at" 2>/dev/null || true
    rmdir "$R$at" 2>/dev/null || true
    rm -f "$f.talos-tmp"
    die "could not record the share in fstab; it was unmounted again"
  fi
  echo "shared $win ($([ "$mode" = ro ] && echo read-only || echo read-write))"
  echo "$at"
}

folder_remove() {
  [ $# -eq 1 ] || die "usage: folder-remove /mnt/win/<name>"
  local at="$1" f
  [[ "$at" =~ ^/mnt/win/[a-z0-9-]+$ ]] || die "not a shared Windows folder: $at"
  f="$(fstab_file)"
  [ -f "$f" ] && awk -v m="$at" '$3 == "drvfs" && $2 == m { found = 1 } END { exit !found }' "$f" ||
    die "no Windows folder is shared at $at"
  # a share that cannot be unmounted stays shared, fstab line and all, and says so (R3-1): never "no longer shared" while it
  # is still live and writable
  unshare_at "$at" ||
    die "$at is in use in the distro (a file in it may be open), so it stays shared; close what uses it and try again, or restart the distro"
  drop_line "$at"
  echo "no longer shared: $at"
}

folder_list() {
  local f
  f="$(fstab_file)"
  [ -f "$f" ] || return 0
  awk '$3 == "drvfs" && $2 ~ /^\/mnt\/win\// { print $2 "\t" $1 }' "$f" | while IFS=$'\t' read -r at src; do
    printf '%s\t%s\n' "$at" "$(windows_path "$src")"
  done
}

# ---- the user and the packages ---------------------------------------------------------------------------------------

# The agent runs as talos: uid 1000 (the one WSL gives the default user), and never an administrator. A distro where uid 1000
# is someone else, or where talos can use sudo, is not one Talos set up: refused, nothing changed.
check_user() {
  local who groups g
  who="$(getent passwd 1000 | cut -d: -f1 || true)"
  [ -z "$who" ] || [ "$who" = "$USER_NAME" ] || die "uid 1000 is '$who' in this distro, not $USER_NAME; this is not a distro Talos made"
  if id -u "$USER_NAME" >/dev/null 2>&1; then
    [ "$(id -u "$USER_NAME")" = 1000 ] || die "$USER_NAME is not uid 1000 here"
    groups=" $(id -nG "$USER_NAME") "
    for g in sudo admin wheel root; do
      [[ "$groups" != *" $g "* ]] || die "$USER_NAME is in the $g group: the agent would be an administrator"
    done
  fi
}

# put_unit <function> <path>: the function's text at path, root-owned, rewritten only when it changed
put_unit() {
  mkdir -p "$(dirname "$2")"
  "$1" >"$2.tmp"
  if cmp -s "$2.tmp" "$2"; then rm -f "$2.tmp"; else mv "$2.tmp" "$2"; fi
}

root_setup() {
  [ -z "$R" ] || die "root-setup changes the real distro; it does not take TALOS_WSL_ROOT"
  [ "$(id -u)" -eq 0 ] || die "root-setup runs as root"
  check_user
  id -u "$USER_NAME" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --uid 1000 "$USER_NAME"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq git curl ca-certificates tmux python3 python3-venv build-essential unzip jq xz-utils >/dev/null
  mkdir -p /mnt/win
  put_unit isolate_unit /etc/systemd/system/talos-isolate.service
  # talos's own user manager only (uid 1000): root's logins never depend on it
  put_unit user_gate "/etc/systemd/system/user@$(id -u "$USER_NAME").service.d/talos-isolation.conf"
  put_unit login_gate /etc/profile.d/00-talos-isolation.sh
  put_unit binfmt_dropin /etc/systemd/system/systemd-binfmt.service.d/talos.conf
  put_unit claude_wrapper /usr/local/bin/claude
  chmod 755 /usr/local/bin/claude
  # cron and at would start talos's jobs whatever isolation says (R3-2)
  if [ -d /run/systemd/system ]; then
    systemctl disable --now -q cron.service atd.service 2>/dev/null || true
    systemctl mask -q cron.service atd.service
  else
    ln -sf /dev/null /etc/systemd/system/cron.service
    ln -sf /dev/null /etc/systemd/system/atd.service
  fi
  # The unit is enabled whenever systemd runs (Ubuntu 24.04's own image already has it on), but started, and linger turned on
  # (which starts talos's user manager, which needs the unit), only once the new wsl.conf has taken effect: before the
  # restart C: is still mounted, and the unit's own check would rightly fail (found live on Titan). The test for "after the
  # restart" is isolation itself, not the interop entry alone: apt restarting systemd-binfmt drops that entry while C: is
  # still mounted (also found live). If isolation fails after the restart for any other reason, install.ps1's next step
  # (`isolation`) stops the install and says why.
  if [ -d /run/systemd/system ]; then
    systemctl daemon-reload
    systemctl enable -q talos-isolate.service
  fi
  if [ -d /run/systemd/system ] && (isolation) >/dev/null 2>&1; then
    systemctl start talos-isolate.service
    # logind can still be starting right after the restart (R3-9): a few tries, then the linger file itself is the proof
    local i
    for i in 1 2 3 4 5; do
      loginctl enable-linger "$USER_NAME" 2>/dev/null && [ -e "/var/lib/systemd/linger/$USER_NAME" ] && break
      sleep 1
    done
    [ -e "/var/lib/systemd/linger/$USER_NAME" ] || die "linger did not turn on for $USER_NAME, so Talos would stop with the last window"
  else
    echo "the isolation unit runs, and linger is turned on, after the restart"
  fi
  echo "root setup done"
}

case "${1:-}" in
wsl-conf) wsl_conf ;;
root-setup) root_setup ;;
isolate-mounts) isolate_mounts ;;
isolation) isolation ;;
protect-add) shift && protect_add "$@" ;;
folder-add) shift && folder_add "$@" ;;
folder-remove) shift && folder_remove "$@" ;;
folder-list) folder_list ;;
# what root-setup writes to /etc/systemd, for reading and for scripts/windows-distro.test.ts
units)
  isolate_unit
  echo '----'
  user_gate
  echo '----'
  login_gate
  echo '----'
  claude_wrapper
  echo '----'
  binfmt_dropin
  ;;
hold) hold ;;
run) shift && run_gated "$@" ;;
status) status ;;
give-back-interop) give_back_interop ;;
launch-check) exec /usr/bin/python3 -I /opt/talos-wsl/launch.py check ;;
relay-key) exec /usr/bin/python3 -I /opt/talos-wsl/launch.py relay-key ;;
relay-set) shift && exec /usr/bin/python3 -I /opt/talos-wsl/launch.py relay-set "${1:-}" ;;
launch-approve-install) exec /usr/bin/python3 -I /opt/talos-wsl/launch.py approve-install ;;
launch-approve) shift && exec /usr/bin/python3 -I /opt/talos-wsl/launch.py approve "${1:-}" ;;
signin) signin ;;
pair) pair ;;
restart) restart_talos ;;
restore) restore_last_good ;;
# root's copy of the kit (kit.py, which checks isolation itself too, again right before it seals): only while cut off from
# Windows, like every verb the tray runs; its stdout is one fixed word
kit-update)
  (isolation) >/dev/null 2>&1 || {
    echo not-isolated
    exit 1
  }
  exec /usr/bin/python3 -I "${TALOS_WSL_KIT:-/opt/talos-wsl/kit.py}" install
  ;;
signout) signout ;;
*) die "usage: talos-wsl.sh wsl-conf | root-setup | isolate-mounts | isolation | protect-add 'C:\\Folder' | folder-add [--read-only] 'C:\\Folder' | folder-remove /mnt/win/<name> | folder-list" ;;
esac
