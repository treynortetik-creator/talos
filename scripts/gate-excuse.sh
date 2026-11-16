# shellcheck shell=bash
# The gate's excuse for tests that are failing on main's tip already (docs/CI-MACHINES.md, "Failures already red on main"):
# sourced by gate.sh, which owns CHANGED, VITEST_ROOTS, the plan's lists (VIT, BUN, E2E, WEB, WEBKIT), say and refuse, and by
# way of gate-fast.sh names_file. Only gate.sh --push asks for it (gate-push.sh sets both, for its full gate only):
#   GATE_EXCUSE_MAIN  a file: "sha=<main's red sha>", then the tests failing there, "<test><TAB><file>" a line (CI's own logs
#                     read by scripts/ci-alert-tests.pl, the alert's parser, in gate-excuse.pl's one form, with the file that
#                     log says each is in)
#   GATE_EXCUSE_OUT   where the excused go, "<test><TAB><file>" a line
# A test step that fails is excused, and the gate goes on to its next step, only when every test it failed is one of main's,
# this change touches none of their files nor what they read, and nothing else failed in it (gate-excuse.pl). Any doubt, and
# the step refuses as it always did. Without both variables a test step is a plain step.

# excuse_touches <test file>: prints how this change reaches it (and returns 0), or nothing (1): the change edits it, the plan
# picked it for this change (a gate-reads guard, a test that names a changed doc, a spec of a changed feature), it names a
# changed file by a relative path (as the fast gate's scan reads one: an import, a require, a path it spawns), or it names
# the package (@scope/name) a changed packages/ file is in. Direct only, as the fast gate is: a test is not followed through
# the modules it imports (bridge.ts alone reaches nearly every bridge file).
excuse_touches() {
  local t="$1" c p pkg
  for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do [ "$c" != "$t" ] || { echo "changes $t"; return 0; }; done
  for p in "${VIT[@]+"${VIT[@]}"}" "${BUN[@]+"${BUN[@]}"}"; do [ "$p" != "$t" ] || { echo "plans $t (it reads a changed file)"; return 0; }; done
  for p in "${E2E[@]+"${E2E[@]}"}"; do [ "e2e/$p" != "$t" ] || { echo "plans $t"; return 0; }; done
  for p in "${WEB[@]+"${WEB[@]}"}" "${WEBKIT[@]+"${WEBKIT[@]}"}"; do [ "apps/web/$p" != "$t" ] || { echo "plans $t"; return 0; }; done
  declare -F names_file >/dev/null || { echo "cannot read what $t names (scripts/gate-fast.sh is missing)"; return 0; }
  for c in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    if names_file "$t" "$c"; then echo "changes $c, which $t names"; return 0; fi
    case "$c" in packages/*/*)
      p="${c#packages/}"
      pkg="$(sed -n 's/^  "name": "\(.*\)",*$/\1/p' "packages/${p%%/*}/package.json" 2>/dev/null | head -1)"
      [ -n "$pkg" ] || { echo "changes $c, in a package whose name cannot be read"; return 0; }
      if grep -qF -e "'$pkg" -e "\"$pkg" -e "\`$pkg" "$t" 2>/dev/null; then echo "changes $c, in $pkg, which $t imports"; return 0; fi
      ;;
    esac
  done
  return 1
}

# excuse_check <log of the failed step>: 0 when every failure in it is excused (each appended to GATE_EXCUSE_OUT); else prints
# why not, one line, and returns 1
excuse_check() {
  local log="$1" out why names alert main n f how sha t ok=""
  [ -f scripts/gate-excuse.pl ] && [ -f scripts/ci-alert-tests.pl ] || { echo "the log readers (scripts/gate-excuse.pl, ci-alert-tests.pl) are missing"; return 1; }
  sha="$(sed -n '1s/^sha=//p' "$GATE_EXCUSE_MAIN" 2>/dev/null)"
  main="$(tail -n +2 "$GATE_EXCUSE_MAIN" 2>/dev/null)"
  [ -n "$sha" ] && [ -n "$main" ] || { echo "main's failing tests could not be read ($GATE_EXCUSE_MAIN)"; return 1; }
  # shellcheck disable=SC2086 # the roots, one argument each
  out="$(perl scripts/gate-excuse.pl "$log" $VITEST_ROOTS)" || { echo "the step's log could not be read"; return 1; }
  why="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "unaccounted" { print $2; exit }')"
  [ -z "$why" ] || { echo "not only named tests failed: $why"; return 1; }
  names="$(printf '%s\n' "$out" | awk -F'\t' '$1 == "test" { print $2 }' | LC_ALL=C sort -u)"
  # shellcheck disable=SC2086
  alert="$(perl scripts/ci-alert-tests.pl "$log" | perl scripts/gate-excuse.pl --canon $VITEST_ROOTS | LC_ALL=C sort -u)"
  [ -n "$names" ] && [ "$names" = "$alert" ] || { echo "the step's failing tests read differently by the alert's parser: no excuse"; return 1; }
  while IFS=$'\t' read -r _ n f; do
    [ -n "$n" ] || continue
    [ -n "$f" ] || { echo "$n: its test file cannot be told from the log"; return 1; }
    # the same test in the same file: one name in two files is two tests
    grep -Fxq -- "$n"$'\t'"$f" <<<"$main" || { echo "$n ($f) failed here and is not failing on main at ${sha:0:7}"; return 1; }
    if how="$(excuse_touches "$f")"; then echo "$n is failing on main at ${sha:0:7}, but this change $how"; return 1; fi
    ok="$ok$n"$'\t'"$f"$'\n'
  done < <(printf '%s\n' "$out" | awk -F'\t' '$1 == "test"')
  printf '%s' "$ok" >>"$GATE_EXCUSE_OUT" || { echo "the excused could not be written down ($GATE_EXCUSE_OUT)"; return 1; }
  n="$(printf '%s' "$ok" | grep -c .)"
  echo "$n test(s), all failing on main at ${sha:0:7} (its newest finished CI verdict), none reached directly by this change: $(printf '%s' "$ok" | cut -f1 | paste -sd';' - | sed 's/;/; /g')"
}

# tstep <name> <command...>: a test step. As step, unless gate.sh --push asked for excuses: then its output is kept (and shown as
# it runs), and a failure that excuse_check excuses lets the gate go on, saying which tests and why.
tstep() {
  local name="$1" t log rc why
  if [ -z "${GATE_EXCUSE_MAIN:-}" ] || [ -z "${GATE_EXCUSE_OUT:-}" ]; then
    step "$@"
    return
  fi
  shift
  t=$SECONDS
  say "$name ..."
  log="$(mktemp "${TMPDIR:-/tmp}/gate-step-XXXXXX")" || refuse "no temp file for the step's log"
  "$@" 2>&1 | tee "$log"
  rc="${PIPESTATUS[0]}"
  if [ "$rc" = 0 ]; then
    rm -f "$log"
    say "$name ok ($((SECONDS - t)) s)"
    return 0
  fi
  if why="$(excuse_check "$log")"; then
    rm -f "$log"
    say "$name failed, EXCUSED: $why"
    return 0
  fi
  rm -f "$log"
  refuse "$name failed (above); not excused: $why"
}
