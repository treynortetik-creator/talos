#!/usr/bin/env bash
# ci-swift-retry.sh <swift test command...>: in CI, a failed `swift test` run is followed by one run of only the tests that failed
# (each as a --filter added to the same command). A pass then counts green, and those tests are appended to CI_FLAKE_FILE as
# "<test>\t<package folder>", so scripts/ci-local.sh says "passed on retry" and logs/flakes.tsv keeps them. A second failure stays
# red. Without CI_FLAKE_FILE (a run by hand) it runs the command once, as it is.
# A rerun is only tried when the failed tests account for the whole failure. Not rerun, so red: a crash (the tests after it never
# ran), a run with no end-of-run summary (it stopped early), an issue no failed test accounts for (a suite-level one), a test known
# only by its display name (--filter matches the identifier, which the output does not show), a build error. The rerun is a pass
# only if each failed test printed a pass line in it: swift test exits 0 when a --filter matches nothing.
# It reads the lines swift prints: swift-testing "✘ Test name(args:) [with N test cases ]failed after ... with N issues" and
# "Test run with ... failed after ... with N issues (including K known issues)" (one per test product: they are summed, less the
# known ones); XCTest "Test Case '-[Module.Class test]' failed"
# and "Test Suite 'All tests' failed".
set -uo pipefail
[ -n "${CI_FLAKE_FILE:-}" ] || exec "$@"
out="$(mktemp)" || exec "$@"
trap 'rm -f "$out"' EXIT
"$@" 2>&1 | tee "$out"
rc=${PIPESTATUS[0]}
[ "$rc" != 0 ] || exit 0

no() { echo "ci-swift-retry: not rerun: $1"; exit "$rc"; }
esc() { printf '%s' "$1" | sed 's/[][\.*^$(){}+?|]/\\&/g'; }
issues() { local i; i="$(printf '%s' "$1" | sed -nE 's/.* with ([0-9]+) issues?.*/\1/p')"; echo "${i:-0}"; }
known() { local k; k="$(printf '%s' "$1" | sed -nE 's/.*\(including ([0-9]+) known issues?\).*/\1/p')"; echo "${k:-0}"; }
names=() filters=() pass=() unnamed=0 st=0 xc=0 st_end=0 xc_end=0 counted=0 total=""
while IFS= read -r line; do
  case "$line" in
    *"Exited with signal"* | *"Exited with unexpected signal"* | *"Fatal error"*) no "the run crashed" ;;
    # each framework's own end of the whole run: a swift-testing package prints XCTest's empty "Executed 0 tests" too, and
    # XCTest prints an "Executed" line per class
    # one per test product (a package can have several), so their issues add up; known issues belong to no failed test
    "✘ Test run with "*" failed after "*) st_end=1; total=$((${total:-0} + $(issues "$line") - $(known "$line"))) ;;
    "Test Suite 'All tests' failed"*) xc_end=1 ;;
    "✘ Test \""*" failed after "*) unnamed=1 ;;
    "✘ Test "*" failed after "*)
      n="${line#✘ Test }"; n="${n%% failed after *}"; n="${n% with * test case*}"
      counted=$((counted + $(issues "$line")))
      names+=("$n"); filters+=("$(esc "$n")"); pass+=("st:$n"); st=1 ;;
    "Test Case '-["*"]' failed"*)
      n="${line#Test Case \'-[}"; n="${n%%]\' failed*}" # Module.Class test
      names+=("${n% *}/${n##* }"); filters+=("$(esc "${n% *}")/$(esc "${n##* }")"); pass+=("xc:$n"); xc=1 ;;
  esac
done < "$out"
[ "${#names[@]}" -gt 0 ] || no "no failed test named in the output"
[ "$unnamed" = 0 ] || no "a failed test has only a display name"
[ "$st" = 0 ] || [ "$st_end" = 1 ] || no "no swift-testing end-of-run summary, so it stopped before every test ran"
[ "$xc" = 0 ] || [ "$xc_end" = 1 ] || no "no XCTest \"All tests\" summary, so it stopped before every test ran"
[ -z "$total" ] || [ "$total" = "$counted" ] || no "$total issue(s) in the run, $counted in the failed tests: one belongs to no test"

args=()
for f in "${filters[@]}"; do args+=(--filter "$f"); done
echo "ci-swift-retry: ${#names[@]} test(s) failed; running only them once more"
"$@" "${args[@]}" 2>&1 | tee "$out"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "ci-swift-retry: failed again on retry"; exit 1; }
missing=""
for p in "${pass[@]}"; do
  n="${p#*:}"
  case "$p" in
    st:*) grep -qF -e "✔ Test $n passed after" -e "✔ Test $n with " "$out" ;;
    xc:*) grep -qF "Test Case '-[$n]' passed" "$out" ;;
  esac || missing="$missing ${n/ //}"
done
[ -z "$missing" ] || { echo "ci-swift-retry: did not pass on the rerun:$missing"; exit 1; }
top="$(git rev-parse --show-toplevel 2>/dev/null)" here="$(pwd -P)"
where="${here#"${top:+$(cd "$top" && pwd -P)}/"}"
for n in "${names[@]}"; do printf '%s\t%s\n' "$(printf '%s' "$n" | tr '\t\r\n' '   ')" "$where" >> "$CI_FLAKE_FILE"; done
echo "ci-swift-retry: passed on retry: ${names[*]}"
