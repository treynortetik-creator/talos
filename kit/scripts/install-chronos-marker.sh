# Sourced by kit/install.sh (and by install-chronos-scope.sh, for the root installer): what is kept when the scheduler (Chronos) could
# not be added to a new agent, so the agent is still complete and a later run can finish the scheduler.
#
# THE MARKER: ${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-not-added.json, mode 600 in a folder of mode 700, written by a
# temp file in the same folder and a rename. It holds exactly {"v":1,"reason":"<code>","at":"<UTC time>"} and nothing else: no
# path and no text of the person's. It means "the scheduler is not (fully) there"; a rerun of ./install.sh finishes it.
#   reason: unfinished (a run began and was killed or stopped before it said more), missing (this clone has no Chronos), python,
#   config, plist, launchctl, not-loaded (Chronos's installer exit codes 10 to 15: the list is in the header of apps/chronos/install.sh and nowhere else), installer (any other
#   exit), jobs, hook, delivery.
# It is PRESENT when anything is at that path (a file, a bad or unreadable file, a directory, a link, a dangling link): presence is
# tested with -e or -L and the content is never parsed, so a damaged marker still says "not added" and a rerun still finishes the
# scheduler. A write never follows a link. A marker that cannot be written or removed is reported in one plain line and the install
# carries on; it never fails because of it. Removed only by a run that has seen the tick loaded and registered the jobs and the
# hook (a --no-load run only removes one it made itself), and by uninstall.sh.
# The functions need the caller's `say`. They never fail (return 0), except chronos_marker_clear and chronos_tick_loaded.

chronos_state_dir() { printf '%s' "${XDG_CONFIG_HOME:-$HOME/.config}/talos"; }
chronos_marker_path() { printf '%s/chronos-not-added.json' "$(chronos_state_dir)"; }
chronos_record_path() { printf '%s/chronos-dir' "$(chronos_state_dir)"; }
chronos_log_path() { printf '%s/chronos-not-added.log' "$(chronos_state_dir)"; }
chronos_marker_present() { local m; m="$(chronos_marker_path)"; [ -e "$m" ] || [ -L "$m" ]; }

# a folder for the marker, record and log: made if missing, mode 700 (best effort)
chronos_state_dir_make() { local d; d="$(chronos_state_dir)"; mkdir -p "$d" 2>/dev/null || true; chmod 700 "$d" 2>/dev/null || true; }

# chronos_marker_write CODE: tmp + rename, never through a link, one plain line when it cannot
chronos_marker_write() {
  local d m t; d="$(chronos_state_dir)"; m="$(chronos_marker_path)"
  chronos_state_dir_make
  if ! t="$(mktemp "$d/.chronos-not-added.XXXXXX" 2>/dev/null)"; then
    say "   (could not record that the scheduler is not added: $d cannot be written)"; return 0
  fi
  if ! { printf '{"v":1,"reason":"%s","at":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$t"; } 2>/dev/null || ! chmod 600 "$t" 2>/dev/null; then
    rm -f "$t"; say "   (could not record that the scheduler is not added: $d cannot be written)"; return 0
  fi
  # a link is replaced by the file, never written through (mv onto a link to a folder would move into the folder)
  if [ -L "$m" ]; then rm -f "$m" 2>/dev/null || true; elif [ -d "$m" ]; then rmdir "$m" 2>/dev/null || true; fi
  if { [ -d "$m" ] && [ ! -L "$m" ]; } || ! mv -f "$t" "$m" 2>/dev/null; then
    rm -f "$t"; say "   (could not replace $m; remove it by hand. It still says the scheduler is not added.)"
  fi
  return 0
}

# chronos_marker_clear: 0 when nothing is left at the marker path afterwards
chronos_marker_clear() {
  local m; m="$(chronos_marker_path)"
  chronos_marker_present || return 0
  if [ -d "$m" ] && [ ! -L "$m" ]; then rmdir "$m" 2>/dev/null || true; else rm -f "$m" 2>/dev/null || true; fi
  if chronos_marker_present; then
    say "   (could not remove $m; remove it by hand. Until then the install says the scheduler is not added.)"; return 1
  fi
  return 0
}

# the kit's record of the Chronos it set up: written whole through a temp file; with an empty argument the record is removed
chronos_record_set() {
  local r t d; r="$(chronos_record_path)"; d="$(chronos_state_dir)"
  if [ -z "${1:-}" ]; then rm -f "$r" 2>/dev/null || true; return 0; fi
  chronos_state_dir_make
  if [ -d "$r" ] && [ ! -L "$r" ]; then say "   (could not write $r: it is a folder)"; return 0; fi
  if t="$(mktemp "$d/.chronos-dir.XXXXXX" 2>/dev/null)" && printf '%s\n' "$1" > "$t" 2>/dev/null && mv -f "$t" "$r" 2>/dev/null; then :
  else [ -z "${t:-}" ] || rm -f "$t"; say "   (could not write $r)"; fi
  return 0
}

# Ownership first, before anything touches a Chronos folder, config, plist or launchctl (the caller has already refused a Chronos
# that is not Talos's): the marker ("unfinished", only when none is there; a reason already there is kept), then the record. A
# run killed at any later point is then recognised as Talos's own, not finished, and the next run finishes it.
# chronos_claim DIR PREV; sets CLAIM_NEW=1 when this call made the marker. The record is written only when there is none: a recorded one
# (Talos's own, an older clone about to move) already makes the next run recognise it, and a failed move must keep the previous record,
# also after a kill.
chronos_claim() {
  CLAIM_NEW=0
  if ! chronos_marker_present; then chronos_marker_write unfinished; chronos_marker_present && CLAIM_NEW=1; fi
  if [ -z "${2:-}" ]; then chronos_record_set "$1"; fi
}
# an explicit --chronos-path or takeover that failed: the record is what it was, and a marker this run made goes
chronos_unclaim() {
  chronos_record_set "${1:-}"
  if [ "${CLAIM_NEW:-0}" = 1 ]; then chronos_marker_clear || true; fi
  return 0
}

chronos_reason_for_exit() {
  case "$1" in 10) echo python ;; 11) echo config ;; 12) echo plist ;; 13|14) echo launchctl ;; 15) echo not-loaded ;; *) echo installer ;; esac
}
chronos_reason_words() {
  case "$1" in
    missing) echo "this copy of Talos has no Chronos" ;;
    python) echo "python3 is missing or too old for it" ;;
    config) echo "its settings could not be written" ;;
    plist) echo "its launchd files could not be written" ;;
    launchctl) echo "macOS would not load it" ;;
    not-loaded) echo "macOS did not start it" ;;
    jobs) echo "its jobs could not be registered" ;;
    hook) echo "its session hook could not be registered" ;;
    delivery) echo "its notify command could not be set up" ;;
    *) echo "its installer failed" ;;
  esac
}

# Is the tick loaded? launchd can lag behind a bootstrap: asked for a few seconds (CHRONOS_PRINT_TRIES shortens it, test mode only).
chronos_tick_loaded() {
  local n=0 tries=10
  [ "${CHRONOS_TEST_MODE:-}" != 1 ] || tries="${CHRONOS_PRINT_TRIES:-10}"
  while [ "$n" -lt "$tries" ]; do
    if launchctl print "gui/$(id -u)/io.github.chronos.tick" >/dev/null 2>&1; then return 0; fi
    n=$((n + 1)); sleep 1
  done
  return 1
}

# A failure of the scheduler on a NEW install is never fatal (SOFT=1): the marker gets the reason, the failing step's whole output
# goes to a log (mode 600), one plain line says what happened and how to add the scheduler later, and the install goes on.
# chronos_not_added CODE OUTPUT AGENT_DIR ROOT_INSTALL; sets SCHED_FAILED=1.
chronos_not_added() {
  local code="$1" out="$2" log; log="$(chronos_log_path)"
  SCHED_FAILED=1
  chronos_marker_write "$code"
  chronos_state_dir_make
  rm -f "$log" 2>/dev/null || true
  if ( umask 077; printf '%s\n' "$out" > "$log" ) 2>/dev/null; then chmod 600 "$log" 2>/dev/null || true
  else log="(no log: $(chronos_state_dir) cannot be written)"; fi
  say "   Your agent is complete, but the scheduler (Chronos) was not added: $(chronos_reason_words "$code"). Add it later with: bash \"$4\" --agent-dir \"$3\". What happened: $log"
}
