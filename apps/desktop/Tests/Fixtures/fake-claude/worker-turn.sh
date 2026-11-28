# A thread session whose turn lasts until $FAKE_TOOL_DIR/turn-done exists, and that starts a tool of its own in a session of its own
# (as Claude Code starts a Bash tool: a SIGKILL of the session's group leaves it running). Used by CutTurnWorkerTests.
#   early.<n>.pid  a process started with the session, before any turn (a server an earlier turn left on purpose)
#   tool.<n>.pid   the tool the turn started
#   rerun.<n>      this start was asked to resume a cut turn (its first line: the two names it was given)
# Every process it starts has this launch's TALOS_APP_WORKER_NONCE in its environment, as a real tool does.
. "$(dirname "$0")/lib.sh"
td="${FAKE_TOOL_DIR:?FAKE_TOOL_DIR is required}"
mkdir -p "$td"
n="${FAKE_START_N:-0}"
# FAKE_TOOL_BIN: a sleep the test copied and signed itself. Apple's own binaries (/bin/sleep, /bin/zsh) are restricted: the kernel does not
# show their environment to anyone, so the nonce on them cannot be read. A tool such as node, python or a build is not restricted.
# own_session <pid file> <argv...>: start argv in a session of its own and write its pid only once setsid() has run (written to a
# temporary name and renamed), so a test that reads the pid and kills the session's group at once can never catch it still inside.
own_session() { local f=$1; shift
  /usr/bin/perl -e 'use POSIX; POSIX::setsid() > 0 or die "setsid: $!"; my $f = shift; open(my $o, ">", "$f.tmp") or die; print $o "$$\n"; close $o; rename("$f.tmp", $f) or die; exec @ARGV or die' "$f" "$@" </dev/null >/dev/null 2>&1 &
  local i=0; while [ ! -s "$f" ] && [ $i -lt 200 ]; do sleep 0.02; i=$((i+1)); done; }
detach() { own_session "$1" "${FAKE_TOOL_BIN:-/bin/sleep}" "${FAKE_MAX_LIFETIME:-120}"; }
[ -n "${FAKE_WORKER_ENV_LOG:-}" ] && env | sort > "$FAKE_WORKER_ENV_LOG.$TALOS_APP_WORKER_THREAD"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
detach "$td/early.$n.pid"
# the start of a process is kept to the second: the turn must begin a clear second after this one (the reap's bound has a second of slack,
# and the bound is the last quiet look before the turn, which on a loaded machine can be one taken early: 2.5 s keeps the early server outside it)
sleep 2.5
printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
# the turn's output goes on a row above the box (a dot at column 60 of row 1), never into the box the pointer is typed into
# The tool the turn starts, in a session of its own as Claude Code starts a Bash command. FAKE_TOOL_SHAPE:
#   zsh    /bin/zsh -c "<xsleep> 120; /bin/sleep 120"  a shell with a child whose environment is readable and one that is Apple's
#   apple  /bin/zsh -c "/bin/sleep 120; /bin/sleep 121"  nothing in the group shows its environment (the nonce cannot find it)
#   (none) one bare sleep, as before
tool() {
  case "${FAKE_TOOL_SHAPE:-bare}" in
    zsh) own_session "$1" /bin/zsh -c "${FAKE_TOOL_BIN:-/bin/sleep} 120; /bin/sleep 120" ;;
    apple) own_session "$1" /bin/zsh -c "/bin/sleep 120; /bin/sleep 121" ;;
    *) detach "$1" ;;
  esac
}
busy() { while fake_alive && [ ! -f "$td/turn-done" ]; do printf '\0337\033[1;60H.\0338'; sleep 0.1; done; }
# FAKE_PLAN=1: the status row under the box says plan mode, as Claude Code's does
box() {
  if [ -n "${FAKE_PLAN:-}" ]; then
    local rule='────────────────────────────────────────────────'
    printf '%s\n\342\235\257\302\240 \n%s\n  \342\217\270 plan mode on (shift+tab to cycle)\n' "$rule" "$rule"; printf '\033[3A\033[3G'
  else typing_box; fi
}
printf '\033[2J\033[Hworking\n'; box
if [ "${CLAUDE_CODE_RESUME_INTERRUPTED_TURN:-}" = "1" ]; then
  printf '%s %s\n' "$CLAUDE_CODE_RESUME_INTERRUPTED_TURN" "${CLAUDE_CODE_RESUME_REASON:-}" > "$td/rerun.$n"
  busy
fi
while IFS= read -r line; do
  printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
  tool "$td/tool.$n.pid"
  printf '\033[2J\033[Hworking\n'; box
  busy
  printf '\033[2J\033[H\n'; box
done
