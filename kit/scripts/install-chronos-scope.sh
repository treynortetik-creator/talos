# Sourced by the root install.sh (step 4): whose Chronos is on this Mac, and so what the kit may do to it.
# The kit's record (~/.config/talos/chronos-dir) names the Chronos Talos set up:
#   - this clone's apps/chronos: Talos's own and current, nothing to install again (CHRONOS_ADD=0);
#   - the clone an older kit made (~/.local/share/talos/chronos): Talos's own, moved to apps/chronos (config and jobs kept);
#   - no record but a config (made by hand), or a record naming any other folder (--chronos-path, a Chronos of your own):
#     the owner's, never taken over (CHRONOS_FOREIGN=1). Not by a plain run, not by a feature flag on an existing agent
#     (--with-vault, --with-memory-search), and not by --with-chronos either (the Mac app passes it on every Create). Only
#     --reinstall-chronos (or a --chronos-path DIR you name) says "take it over". The kit then gets --no-chronos: no jobs
#     registered, none turned on, no session hook.
# One rule for both installers (the root install.sh sources this file, and so does kit/install.sh), so a direct kit call and the
# root installer agree on whose Chronos a record names.
# A new run that stopped before the scheduler was in place leaves a marker (install-chronos-marker.sh): the record then names a Chronos
# that is Talos's own and NOT finished, so the next run finishes it (its installer runs again) and never calls it hand-made.
# shellcheck source=install-chronos-marker.sh
. "$(dirname "${BASH_SOURCE[0]}")/install-chronos-marker.sh"

# chronos_handmade_after_unfinished AGENT_DIR: 0 when a run of Talos stopped before its Chronos was in place (the marker is there) and a
# Chronos was made by hand since: the config's workspace is an existing folder that is not this agent folder and has no .talos-version.
# A Talos folder is always stamped before Chronos runs and Chronos's installer always makes its workspace, so that folder is not one
# Talos made: the Chronos is the owner's and is left alone. Only while the marker is present; an agent folder that Talos kept (stamped)
# or the same workspace is Talos's and gets finished. A Chronos whose jobs.json holds a talos- job is never hand-made (Talos finished it
# once: a takeover keeps the owner's workspace).
chronos_handmade_after_unfinished() {
  local cfg="${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}" w a
  chronos_marker_present || return 1
  [ -f "$cfg" ] || return 1
  # a Chronos that Talos ever finished holds talos- jobs; one made by hand after an unfinished run holds none (an unreadable or bad
  # jobs.json says nothing: the answer is then the workspace's, below)
  python3 -c 'import json, os, sys
try:
    jobs = json.load(open(os.path.join(os.path.dirname(sys.argv[1]), "jobs.json")))
    sys.exit(0 if any(isinstance(j, dict) and str(j.get("id", "")).startswith("talos-") for j in jobs) else 1)
except Exception:
    sys.exit(1)' "$cfg" 2>/dev/null && return 1
  w="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("workspace") or "")' "$cfg" 2>/dev/null)" || return 1
  case "$w" in "~"|"~/"*) w="$HOME${w#\~}" ;; esac
  { [ -n "$w" ] && [ -d "$w" ]; } || return 1
  [ ! -f "$w/.talos-version" ] || return 1
  w="$(cd "$w" && pwd -P)" || return 1
  a="$(cd "$1" 2>/dev/null && pwd -P)" || a="$1"
  [ "$w" != "$a" ]
}

# chronos_record_is_ours REC BUNDLED VENDOR: 0 when REC names a Chronos Talos set up: this clone's apps/chronos (BUNDLED), the older
# Talos clone (VENDOR), or the apps/chronos of another Talos checkout (its kit/install.sh is there). A folder that is gone
# (an unplugged disk) says nothing about whose it was, so it is left alone. An empty record, and a record naming any other folder, are not Talos's.
chronos_record_is_ours() {
  local r="$1" p
  [ -n "$r" ] || return 1
  if [ "$r" = "$2" ] || [ "$r" = "$3" ]; then return 0; fi
  case "$r" in
    */apps/chronos) p="${r%/apps/chronos}"; if [ -f "$p/kit/install.sh" ]; then return 0; fi ;;
  esac
  return 1
}

# Needs: CHRONOS, REPO, KIT_ARGS, KIT_CHRONOS_ONLY, KARGS, and the installer's `say` and `fail`. Sets: _rec, CHRONOS_ADD, CHRONOS_FOREIGN.
chronos_scope() {
  local _a _explicit=0 _whose
  CHRONOS_ADD="$CHRONOS"; CHRONOS_FOREIGN=0
  _rec="$(cat "${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-dir" 2>/dev/null || true)"
  for _a in ${KIT_ARGS[@]+"${KIT_ARGS[@]}"}; do case "$_a" in --reinstall-chronos|--chronos-path) _explicit=1 ;; esac; done
  if [ "$CHRONOS" = 1 ] && [ -f "${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}" ]; then
    if [ "$_rec" = "$REPO/apps/chronos" ]; then
      if chronos_marker_present; then :   # Talos's own, not finished: its installer runs again
      else CHRONOS_ADD=0; fi   # a rerun changes nothing
    elif chronos_record_is_ours "$_rec" "$REPO/apps/chronos" "${TALOS_VENDOR_DIR:-$HOME/.local/share/talos}/chronos"; then :   # moves to this copy
    elif [ "$_explicit" != 1 ]; then CHRONOS_ADD=0; CHRONOS_FOREIGN=1; fi
    if [ "$CHRONOS_FOREIGN" != 1 ] && [ "$_explicit" != 1 ] && chronos_handmade_after_unfinished "$AGENT_DIR"; then CHRONOS_ADD=0; CHRONOS_FOREIGN=1; _rec=""; fi
  fi
  [ "$CHRONOS" = 1 ] && [ "$CHRONOS_FOREIGN" != 1 ] || KARGS+=(--no-chronos)
  [ "$CHRONOS_FOREIGN" = 1 ] || return 0
  if [ -z "$_rec" ]; then _whose="was set up by hand"; else _whose="runs from $_rec"; fi
  [ ${#KIT_CHRONOS_ONLY[@]} -gt 0 ] && fail 2 "this Mac's Chronos $_whose, so Talos leaves it alone and ${KIT_CHRONOS_ONLY[*]} would change it. To let Talos take it over (it moves to this clone's copy; its config and jobs are kept), add --reinstall-chronos. Nothing was changed."
  say "   Chronos: this Mac's Chronos $_whose, so Talos left it alone (no jobs registered, none turned on, no session hook)."
  say "   To let Talos take it over (it moves to this clone's copy; its config and jobs are kept): ./install.sh --reinstall-chronos"
}

# The closing "Chronos:" line of the install's summary.
chronos_closing_line() {
  if [ "$CHRONOS_FOREIGN" = 1 ]; then echo "left alone: this Mac's Chronos is not Talos's, so no jobs were added to it. ./install.sh --reinstall-chronos moves it to this clone's copy (config and jobs kept)"
  elif [ "$CHRONOS" = 1 ] && chronos_marker_present; then echo "not added: the agent is complete but the scheduler is not in place yet. ./install.sh (the same command, again) finishes it; $(chronos_log_path) says what stopped it (SETUP.md, step 9.1)"
  elif [ "$CHRONOS" = 1 ]; then echo 'installed; its jobs are off until you enable them (SETUP.md, step 9.1)'
  else echo 'not with this install (--no-chronos), or not on macOS; ./install.sh on a Mac adds it (SETUP.md, step 9.1)'; fi
}

# kit/install.sh, when no apps/chronos sits beside the kit (a kit copy inside an agent folder or a plugin release): which Chronos to use, decided
# before anything is written. Whose Chronos it is comes FIRST; only then is "no bundled Chronos" a reason to stop.
# chronos_shipped_dir REC VENDOR CFG REINSTALL: prints the folder to use and returns 0 (Talos's own, its folder complete: no move);
# returns 3 when the Chronos on this Mac is not Talos's (the caller leaves it alone, as in the repo); returns 1 with one plain message
# when there is none to use (no Chronos, or a record whose folder is gone, or --reinstall-chronos over one that is not ours).
chronos_shipped_dir() {
  local rec="$1" vendor="$2" cfg="$3" reinstall="$4" f
  if [ -f "$cfg" ]; then
    # BUNDLED is empty: a record can never equal a bundled folder that does not exist
    if chronos_record_is_ours "$rec" "" "$vendor"; then
      for f in install.sh bin/chronos lib/chronoslib.py; do [ -e "$rec/$f" ] || { rec=""; break; }; done
      if [ -n "$rec" ]; then printf '%s\n' "$rec"; return 0; fi
    elif [ "$reinstall" != 1 ]; then return 3; fi
  fi
  echo "this copy of the kit has no Chronos beside it (it is inside an agent folder, or in a clone older than the bundled Chronos): run ./install.sh in an up-to-date Talos clone, or add --no-chronos (or --chronos-path DIR). Nothing was changed." >&2
  return 1
}
