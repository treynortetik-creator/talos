# Sourced by install.sh and uninstall.sh. bash 3.2 and BSD tools only.
# chronos_launchd_refused: returns 0 when the launchctl that would run is the system one (/bin/launchctl) and HOME is not this user's
# real home from the user database. A pretend HOME means the plist is not this user's, so loading it into (or removing it from) their
# login session is never right. Both pairs are compared as FILES (`-ef`: the same device and inode), never as spellings: a link, a
# /private alias, a home on another disk, and a case-insensitive volume (macOS: /users/Alex and /Users/alex are one folder) all compare
# equal when they are. It refuses only when both sides exist and differ: anything unreadable returns 1, as if the guard were not there.
# So it fails OPEN (a real user is never refused for what could not be read), and it is the second wall, not the only one: the tests
# that run an installer also keep a refusing launchctl first on PATH. Keep both.
# No python: the user database is asked with the shell's own ~user. bash 3.2 and BSD tools only.
# Tests (CHRONOS_TEST_MODE=1 only): CHRONOS_SYSTEM_LAUNCHCTL names the launchctl that counts as "the system one", and
# CHRONOS_REAL_HOME stands in for the user database's home (set but empty = unreadable).
chronos_launchd_refused() {
  local found system real u
  found="$(command -v launchctl 2>/dev/null)" || return 1
  system=/bin/launchctl
  if [ "${CHRONOS_TEST_MODE:-}" = 1 ] && [ -n "${CHRONOS_SYSTEM_LAUNCHCTL:-}" ]; then system="$CHRONOS_SYSTEM_LAUNCHCTL"; fi
  { [ -e "$found" ] && [ -e "$system" ] && [ "$found" -ef "$system" ]; } || return 1
  if [ "${CHRONOS_TEST_MODE:-}" = 1 ] && [ "${CHRONOS_REAL_HOME+x}" = x ]; then real="$CHRONOS_REAL_HOME"
  else
    u="$(id -un 2>/dev/null)" || return 1
    case "$u" in ''|*[!A-Za-z0-9._-]*) return 1 ;; esac
    real="$(eval "printf '%s' ~$u")"
  fi
  { [ -n "$real" ] && [ -d "$real" ] && [ -n "${HOME:-}" ] && [ -d "$HOME" ]; } || return 1
  ! [ "$HOME" -ef "$real" ]
}
