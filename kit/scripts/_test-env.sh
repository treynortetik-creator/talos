# _test-env.sh -- sourced by every kit test script (not run). Bash 3.2 safe.
# WHY: on 2026-11-15 a kit test run from inside a thread session sent real cards to the owner's phone: the session's
# TALOS_APP_HOME, worker thread and nonce were still in the environment, so the hooks under test reached the live hub. A test
# now (1) scrubs every Talos/Claude session variable here, (2) marks itself with TALOS_TEST_SANDBOX (its temp dir) once that
# dir exists (talos_test_sandbox), and (3) refuses to run if either hook would still resolve an app folder outside it.
TALOS_TEST_ORIG_APP_HOME="${TALOS_APP_HOME:-}"
for _tv in $(compgen -e | grep '^TALOS_APP_'); do unset "$_tv"; done
unset _tv TALOS_SESSION_ROLE TALOS_UNATTENDED CLAUDE_PID CLAUDE_CODE_SESSION_ATTENDED CHRONOS_RUN CHRONOS_CONFIG
unset CLAUDE_PROJECT_DIR TALOS_KIT_HOME TALOS_VENDOR_DIR
# no kit test may download a uv (memory/setup.sh fetches one on a Mac with no Python 3.10+); the test of the fetch unsets this per call
export TALOS_MEMSEARCH_NO_UV_FETCH=1

talos_test_sandbox() {
  local dir
  [ -n "${1:-}" ] || { echo "REFUSING: no sandbox dir given" >&2; exit 3; }
  dir="$(cd "$1" && pwd -P)" || { echo "REFUSING: no sandbox folder '$1'" >&2; exit 3; }
  export TALOS_TEST_SANDBOX="$dir"
  python3 -I - "$dir" "${TALOS_TEST_ORIG_APP_HOME:-}" <<'PY' || exit 3
import os, pwd, sys
box = os.path.realpath(sys.argv[1])
orig = sys.argv[2]
named = os.environ.get("TALOS_APP_HOME")
found = []
# action-rules.py app_home(): TALOS_APP_HOME, else the account's home when HOME is it
if named:
    found.append(named)
else:
    acct = pwd.getpwuid(os.getuid()).pw_dir
    if os.path.realpath(os.path.expanduser("~")) == os.path.realpath(acct):
        found.append(os.path.join(acct, ".config", "talos", "app"))
# permission-relay.py app_home(): TALOS_APP_HOME, else ~/.config/talos/app
found.append(named or os.path.join(os.path.expanduser("~"), ".config", "talos", "app"))
for p in found:
    rp = os.path.realpath(p)
    if rp != box and not rp.startswith(box + os.sep):
        sys.stderr.write("REFUSING: this test would reach the Talos app folder at %s; its sandbox is not sealed\n" % p)
        sys.exit(3)
    if orig:
        ro = os.path.realpath(orig)
        if rp == ro or rp.startswith(ro + os.sep):
            sys.stderr.write("REFUSING: this test would reach the Talos app folder at %s; its sandbox is not sealed\n" % p)
            sys.exit(3)
PY
}

# talos_fake_chronos DIR: the stand-in Chronos that scripts/test-install.sh installs against, the same four small files as
# scripts/fixtures/fake-chronos (an installed agent folder does not carry that folder, so the test makes its own; test-install.sh checks the two agree).
talos_fake_chronos() {
  mkdir -p "$1/bin" "$1/hooks" "$1/lib"
  cat > "$1/install.sh" <<'FAKE'
#!/bin/bash
# A stand-in for Chronos's installer, used ONLY by scripts/test-install.sh. It writes a config and an empty
# jobs.json under $HOME and records the arguments it was given. It never touches launchd.
set -eu
ws=""; noload=0; quiet=0
# (accepts --quiet like Chronos 0.2.1+: the grep in Talos's install.sh looks for that word in THIS file)
while [ $# -gt 0 ]; do case "$1" in --workspace) ws="$2"; shift 2 ;; --no-load) noload=1; shift ;; --quiet) quiet=1; shift ;; *) shift ;; esac; done
cfg="${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}"
mkdir -p "$(dirname "$cfg")" "$HOME/.chronos"
printf '{\n  "workspace": "%s",\n  "jobs_file": "~/.config/chronos/jobs.json",\n  "jobs_dir": "~/.config/chronos/jobs",\n  "notify": ""\n}\n' "$ws" > "$cfg"
echo "[]" > "$HOME/.config/chronos/jobs.json"; mkdir -p "$HOME/.config/chronos/jobs"
echo "install.sh --workspace $ws noload=$noload quiet=$quiet" >> "$HOME/.chronos/fake-install.log"
# like the real installer: write the tick plist. Talos reads the version from the runtime this plist names, never from its own clone.
DIR="$(cd "$(dirname "$0")" && pwd)"; AGENTS="${CHRONOS_LAUNCHAGENTS_DIR:-$HOME/Library/LaunchAgents}"; mkdir -p "$AGENTS"
printf '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>io.github.chronos.tick</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>%s/bin/chronos-tick.sh</string></array></dict></plist>\n' "$DIR" > "$AGENTS/io.github.chronos.tick.plist"
if [ "$quiet" = 1 ]; then echo "chronos 0.2.2 installed: fake"
else echo "no jobs yet: created an empty jobs.json"; echo "Chronos is installed."; fi
FAKE
  chmod 755 "$1/install.sh"
  printf '#!/bin/bash\necho "fake chronos"\n' > "$1/bin/chronos"; chmod 755 "$1/bin/chronos"
  printf '#!/usr/bin/env python3\nprint("{}")\n' > "$1/hooks/chronos-session-start.py"; chmod 755 "$1/hooks/chronos-session-start.py"
  printf '# fake\nVERSION = "0.2.2"\n' > "$1/lib/chronoslib.py"
}

# talos_copy_kit SRC DEST: a copy of a kit folder for a test that edits the copy. Links are copied AS links: a link in an owner's folder
# that leads out of it (a vault) is never followed, which would copy whatever it points at into the temp folder. The one exception is a
# shipped kit's own scripts/ and hooks/ links (the plugin layout: they lead into the release, .../talos-kit/<name>): they become real
# folders of the same files, so a file the test removes from the copy is the copy's own and never the release's.
talos_copy_kit() {
  local src="$1" dest="$2" d t
  cp -R "$src" "$dest" || return 1
  for d in scripts hooks; do
    [ -L "$dest/$d" ] || continue
    t="$(cd "$dest/$d" 2>/dev/null && pwd -P)" || continue
    case "$t" in */talos-kit/"$d") rm "$dest/$d" && cp -R "$t" "$dest/$d" || return 1 ;; esac
  done
  chmod -R u+w "$dest"
}
