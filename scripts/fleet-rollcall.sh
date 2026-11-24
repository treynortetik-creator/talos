#!/usr/bin/env bash
# Read-only: who in the fleet has published a status line, and how old it is.
#
#   scripts/fleet-rollcall.sh [--json]
#
# Reads origin's refs/fleet/* (scripts/fleet-state-push.sh writes them), fetched into a private namespace (refs/fleet-seen/*; no
# local branch, file or index changes). The member list is the ROSTER: the file `roster` of the commit at refs/fleet/_roster, one
# member per line, "name alias1 alias2 ...". One row per member: "name | headline | age", the age as 3h12m and flagged STALE
# over 2 hours; a member with no ref prints "never published | -". With no _roster it says so (stderr) and lists the refs that
# exist. --json prints the same rows as one array: name, aliases, headline, age_seconds, age, stale. Exit 0 even when some are
# stale; non-zero only when origin cannot be read. Ages come from the commit time and `date +%s` (no GNU-only date or stat).
set -uo pipefail
export LC_ALL=C
die() { echo "fleet-rollcall: $*" >&2; exit 1; }
JSON=0
case "${1:-}" in '') ;; --json) JSON=1 ;; *) echo "usage: fleet-rollcall.sh [--json]" >&2; exit 2 ;; esac
STALE_AFTER=7200

LS="$(git ls-remote origin 'refs/fleet/*')" || die "cannot read origin's refs/fleet/*"
if [ -n "$LS" ]; then
  # --prune: a ref origin has dropped leaves the private namespace too
  git fetch -q --no-tags --prune origin '+refs/fleet/*:refs/fleet-seen/*' || die "cannot fetch origin's refs/fleet/*"
else
  # origin has none: whatever this clone saw before is gone as well
  git for-each-ref --format='%(refname)' refs/fleet-seen/ | while IFS= read -r r; do git update-ref -d "$r"; done
fi
sha_of() { printf '%s\n' "$LS" | awk -v r="refs/fleet/$1" '$2 == r { print $1; exit }'; }
clean() { printf '%s' "$1" | tr -cd ' -~' | cut -c1-160; }
json_str() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
age_text() { # seconds -> 12m, 3h12m
  local s="$1"
  if [ "$s" -ge 3600 ]; then printf '%dh%02dm' $((s / 3600)) $(((s % 3600) / 60)); else printf '%dm' $((s / 60)); fi
}

NOW="$(date +%s)"
# one entry per row, in step: the member name, its aliases (space separated) and the sha of its ref (empty: never published)
R_NAME=() R_ALIAS=() R_SHA=()
add_row() { R_NAME+=("$1"); R_ALIAS+=("$2"); R_SHA+=("$3"); }
ROSTER_SHA="$(sha_of _roster)"
if [ -n "$ROSTER_SHA" ]; then
  roster="$(git cat-file blob "$ROSTER_SHA:roster" 2>/dev/null)" || die "refs/fleet/_roster holds no roster file"
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(clean "$line")"
    [ -n "$line" ] || continue
    name="${line%% *}"
    printf '%s' "$name" | grep -Eqx '[a-z][a-z0-9-]{0,31}' || continue
    aliases=""
    [ "$name" = "$line" ] || aliases="${line#* }"
    add_row "$name" "$aliases" "$(sha_of "$name")"
  done <<EOT
$roster
EOT
else
  echo "fleet-rollcall: refs/fleet/_roster is missing; listing the refs that exist" >&2
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    printf '%s' "$name" | grep -Eqx '[a-z][a-z0-9-]{0,31}' || continue
    add_row "$name" "" "$(sha_of "$name")"
  done <<EOT
$(printf '%s\n' "$LS" | awk '{ sub("^refs/fleet/", "", $2); print $2 }' | sort)
EOT
fi

OUT=""
SEP=""
i=0
while [ "$i" -lt "${#R_NAME[@]}" ]; do
  name="${R_NAME[$i]}" aliases="${R_ALIAS[$i]}" sha="${R_SHA[$i]}"
  i=$((i + 1))
  headline="" age_s="" stale=false
  if [ -n "$sha" ]; then
    headline="$(git cat-file blob "$sha:headline" 2>/dev/null | head -n 1)" || headline=""
    headline="$(clean "$headline")"
    ts="$(git log -1 --format=%ct "$sha" 2>/dev/null)" || ts=""
    case "$ts" in '' | *[!0-9]*) ts="" ;; esac
    if [ -n "$ts" ]; then
      age_s=$((NOW - ts))
      [ "$age_s" -ge 0 ] || age_s=0 # a clock a little behind the publisher's: never a negative age
    fi
  fi
  al=""
  set -f # an alias is data: never a glob
  for a in $aliases; do al="$al${al:+,}\"$(json_str "$a")\""; done
  set +f
  if [ -z "$sha" ] || [ -z "$age_s" ]; then
    if [ "$JSON" = 1 ]; then
      OUT="$OUT$SEP$(printf '{"name":"%s","aliases":[%s],"headline":null,"age_seconds":null,"age":null,"stale":false}' "$name" "$al")"
      SEP=","
    else
      printf '%s | never published | -\n' "$name"
    fi
    continue
  fi
  [ "$age_s" -gt "$STALE_AFTER" ] && stale=true
  age="$(age_text "$age_s")"
  if [ "$JSON" = 1 ]; then
    OUT="$OUT$SEP$(printf '{"name":"%s","aliases":[%s],"headline":"%s","age_seconds":%d,"age":"%s","stale":%s}' \
      "$name" "$al" "$(json_str "$headline")" "$age_s" "$age" "$stale")"
    SEP=","
  elif [ "$stale" = true ]; then
    printf '%s | %s | %s STALE\n' "$name" "$headline" "$age"
  else
    printf '%s | %s | %s\n' "$name" "$headline" "$age"
  fi
done
[ "$JSON" = 1 ] && printf '[%s]\n' "$OUT"
exit 0
