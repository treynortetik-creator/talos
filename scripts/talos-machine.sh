#!/usr/bin/env bash
# The machine's fleet name, for anything the gate writes or suggests where others can read it (a handoff branch, the push
# lease's wait ref). It comes only from TALOS_MACHINE and must be one of the fleet's names: a host name can carry a person's
# name, and refs and branches on origin must never (the privacy rule). Unset or unknown: one plain line, and no name.
#
#   . scripts/talos-machine.sh; me="$(talos_machine)" || exit 1
TALOS_FLEET='cyclops lemnos delphi hestia titan'
talos_machine() {
  local m="${TALOS_MACHINE:-}"
  case "$m" in
    '' | *[!a-z]*) ;; # one lowercase word, or it is not a fleet name
    *) case " $TALOS_FLEET " in *" $m "*)
      printf '%s\n' "$m"
      return 0
      ;;
    esac ;;
  esac
  # the value itself is not repeated: it may be a host name
  printf 'gate: set TALOS_MACHINE to this machine'"'"'s fleet name (one of: %s), never its host name\n' "$TALOS_FLEET" >&2
  return 1
}
