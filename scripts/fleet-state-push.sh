#!/usr/bin/env bash
# Publishes ONE status line for this machine where the rest of the fleet can read it: the non-branch ref refs/fleet/<machine> on
# origin (read back by scripts/fleet-rollcall.sh).
#
#   TALOS_MACHINE=<name> scripts/fleet-state-push.sh [--] "<headline>"
#   scripts/fleet-state-push.sh --roster <file>          publish the roster (refs/fleet/_roster): one member per line, "name alias ..."
#
# The machine name comes only from TALOS_MACHINE (one lowercase word, digits and "-"); nothing is guessed from the host name.
# The line is checked before anything is pushed: 1 to 160 characters, one line, printable ASCII, then scripts/check-no-personal.sh
# on a temp folder holding only that line (plus the maintainer's private list when the main checkout has one). Any refusal exits
# non-zero and pushes nothing. The ref points at a commit with no parent and ONE file (headline, or roster for the roster), pushed
# with plumbing only (hash-object, mktree, commit-tree, push --force): no checkout, no index change, no branch, no working tree.
# The commit time is the line's timestamp; GIT_COMMITTER_DATE sets it (tests do, so nothing waits). Works on macOS (bash 3.2, BSD tools).
set -euo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "fleet-state-push: $*" >&2; exit "${2:-2}"; }

MODE=headline
if [ "${1:-}" = -- ]; then # "--" ends the options: the headline may start with "-"
  shift; [ "$#" -eq 1 ] || die "usage: fleet-state-push.sh [--] \"<headline>\" | --roster <file>"; SRC=""
else
  case "${1:-}" in
    --roster) MODE=roster; [ "$#" -eq 2 ] || die "usage: fleet-state-push.sh --roster <file>"; SRC="$2" ;;
    -*) die "usage: fleet-state-push.sh [--] \"<headline>\" | --roster <file>" ;;
    *) [ "$#" -eq 1 ] || die "usage: fleet-state-push.sh [--] \"<headline>\" | --roster <file>"; SRC="" ;;
  esac
fi

if [ "$MODE" = roster ]; then
  REF=refs/fleet/_roster FILE=roster
  [ -f "$SRC" ] || die "no such roster file"
  BODY="$(cat "$SRC")"
else
  MACHINE="${TALOS_MACHINE:-}"
  [ -n "$MACHINE" ] || die "set TALOS_MACHINE to this machine's fleet name (never its host name)"
  printf '%s' "$MACHINE" | grep -Eqx '[a-z][a-z0-9-]{0,31}' || die "TALOS_MACHINE must be one lowercase word (letters, digits, -)"
  REF="refs/fleet/$MACHINE" FILE=headline
  BODY="$1"
fi

# Line checks: no empty body, no control character (a newline included), printable ASCII only, at most 160 characters a line.
[ -n "$BODY" ] || die "the line is empty"
if printf '%s' "$BODY" | LC_ALL=C grep -q '[^ -~'"$(printf '\n')"']'; then die "the line holds a control or non-ASCII character"; fi
if [ "$MODE" = headline ]; then
  case "$BODY" in *$'\n'*) die "the headline must be one line" ;; esac
fi
while IFS= read -r line || [ -n "$line" ]; do
  [ "${#line}" -le 160 ] || die "a line is longer than 160 characters"
  if [ "$MODE" = roster ]; then
    case "$line" in '' ) die "the roster holds an empty line" ;; esac
    printf '%s' "$line" | grep -Eqx '[a-z][a-z0-9-]{0,31}( [A-Za-z0-9._-]{1,32})*' || die "a roster line is \"name alias ...\" (lowercase name; aliases of letters, digits . _ -)"
  fi
done <<EOT
$BODY
EOT

# The public personal-data check on a folder holding only this line, plus the private list the way the pre-push hook finds it.
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/fleet-state.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT
mkdir "$TMPD/scan"
printf '%s\n' "$BODY" > "$TMPD/scan/$FILE"
# (the same two lookups as private_lists in scripts/pre-push.sh: the private rules and the private-docs list of the main checkout)
EXTRA="${CHECK_EXTRA_RULES:-}" EXTRA_DOCS="${CHECK_PRIVATE_DOCS:-}"
if common="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  main="$(dirname "$common")"
  if [ ! -f "$HERE/personal-denylist.txt" ] && [ -f "$main/scripts/personal-denylist.txt" ]; then
    EXTRA="${EXTRA:+$EXTRA:}$main/scripts/personal-denylist.txt"
  fi
  if [ ! -f "$HERE/private-docs.txt" ] && [ -f "$main/scripts/private-docs.txt" ]; then
    while IFS= read -r d || [ -n "$d" ]; do
      case "$d" in '' | '#'*) continue ;; esac
      EXTRA_DOCS="${EXTRA_DOCS:+$EXTRA_DOCS:}$d"
    done < "$main/scripts/private-docs.txt"
  fi
fi
if ! out="$(CHECK_NO_GIT=1 CHECK_EXTRA_RULES="$EXTRA" CHECK_PRIVATE_DOCS="$EXTRA_DOCS" bash "$HERE/check-no-personal.sh" "$TMPD/scan" 2>&1)"; then
  printf '%s\n' "$out" >&2
  die "check-no-personal refused the line; nothing was pushed" 1
fi

# Plumbing only: a blob, a one-file tree, a parentless commit, a forced push of that sha to the fleet ref.
blob="$(printf '%s\n' "$BODY" | git hash-object -w --stdin)"
tree="$(printf '100644 blob %s\t%s\n' "$blob" "$FILE" | git mktree)"
commit="$(GIT_AUTHOR_NAME=fleet GIT_AUTHOR_EMAIL=fleet@example.com GIT_COMMITTER_NAME=fleet GIT_COMMITTER_EMAIL=fleet@example.com \
  git commit-tree "$tree" -m "fleet status")"
git push --force -q origin "$commit:$REF"
echo "fleet-state-push: published to $REF"
