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
