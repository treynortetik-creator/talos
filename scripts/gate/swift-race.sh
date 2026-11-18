# shellcheck shell=bash
# Sourced by scripts/gate-push.sh. Definitions only.
# swift_touched <plan> <theirs>: prints the first new main file under a Swift package this change builds (the plan's "swift build
# (<package>)" lines) and returns 0; returns 1 when there is none. The cheap checks (--checks-only) and the rebase-clean pass build
# no Swift, so a new main commit in a package this change builds must run the full gate again: the build of the combined tree is the
# one that counts. A commit in another package changes nothing this change built, so it does not force it.
swift_touched() {
  local pkg f
  # no plan (plan_of failed: a plan always has steps) is doubt, and doubt runs the full gate (Opus review)
  [ -n "$1" ] || { printf '%s\n' '(no plan for this change)'; return 0; }
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    f="$(awk -v p="$pkg/" 'index($0, p) == 1 { print; exit }' <<<"$2")"
    [ -z "$f" ] || { printf '%s\n' "$f"; return 0; }
  done < <(sed -n 's/^swift build (\(.*\))$/\1/p' <<<"$1")
  return 1
}
