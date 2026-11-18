# shellcheck shell=bash
# The gate's planning helpers (what a change runs), sourced by scripts/gate.sh, which owns CHANGED, VITEST_ROOTS, the plan's lists
# and the other globals these read at call time. Definitions only: nothing here runs when it is sourced.
uniq_into() { # uniq_into <array name> <path...>: the paths, sorted, without repeats
  local name="$1"
  shift
  local -a out=()
  [ $# -gt 0 ] && while IFS= read -r -d '' x; do out+=("$x"); done < <(printf '%s\0' "$@" | LC_ALL=C sort -zu)
  eval "$name=(\"\${out[@]+\"\${out[@]}\"}\")"
}
# lines_of <text>: _LO_LINES=(the text's non-empty lines). The per-file loop in plan_suites reads a command's output this way,
# never `done < <(cmd)`: bash 3.2 (the macOS /bin/bash) keeps each of those descriptors open until the whole planning step
# ends, and at descriptor 256 writes one byte past its own table (subst.c add_fifo_list, fixed in bash 5), so a change of
# about 80 files or more could abort the gate, or empty the lists it planned from (2026-11-13; gate-large-change.test.ts).
# No pipe, no temp file: nothing to leak or fail.
lines_of() {
  local IFS=$'\n' noglob=0
  case $- in *f*) noglob=1 ;; esac
  set -f
  # shellcheck disable=SC2206 # split on newlines only, with globbing off (not LINES: bash 5 resets that one to the terminal height)
  _LO_LINES=($1)
  [ "$noglob" = 1 ] || set +f
}
file_readers() { # prints each test that names `f`
  local f="$1" base path
  [ -n "$READERS_POOL" ] || return 0
  # the path as a whole token (not inside a longer name), or the file name in quotes; / is not special in an ERE
  base="$(printf '%s' "${f##*/}" | sed 's/[][\.*^$+?(){}|]/\\&/g')" # not basename: a name may start with -
  path="$(printf '%s' "$f" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
  printf '%s\n' "$READERS_POOL" | tr '\n' '\0' | xargs -0 grep -lE -e "(^|[^A-Za-z0-9_.-])${path}(\$|[^A-Za-z0-9_-])" \
    -e "['\"\`/]${base}['\"\`]" 2>/dev/null
}
folder_readers() { # prints "<test><US><folder>" for each test that lists a folder of `f`'s (US, \037: a name may hold a tab)
  local d="$1" t re
  [ -n "$LISTERS" ] || return 0
  # each folder up from the file, by cutting at the last / (not dirname: a name may start with -)
  while case "$d" in */*) true ;; *) false ;; esac; do
    d="${d%/*}"
    [ -n "$d" ] || break
    # a top-level folder (the file's own one too) counts only when its tests read it whole; any deeper one counts
    if [ "${d#*/}" = "$d" ]; then
      case " $WHOLE_FOLDERS " in *" $d "*) ;; *) continue ;; esac
    fi
    # the folder as literal text in the pattern, and the tests NUL-separated to xargs: a folder or test path with a space in it
    # is one path, not two
    re="$(printf '%s' "$d" | sed 's/[][\.*^$+?(){}|]/\\&/g')"
    while IFS= read -r t; do [ -n "$t" ] && printf '%s\037%s\n' "$t" "$d"; done < <(
      printf '%s\n' "$LISTERS" | tr '\n' '\0' | xargs -0 grep -lE -e "['\"]$re/?['\"]" 2>/dev/null
    )
  done
}
guards_reading() { # prints each guard with a gate-reads pattern that matches `f`
  local f="$1" t p
  [ -n "$GUARDS" ] || return 0
  set -f # a pattern is matched, never expanded against the files (this runs in a $( ) subshell, so it stays there)
  printf '%s\n' "$GUARDS" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    # shellcheck disable=SC2254 # $p unquoted on purpose: it is the pattern
    for p in $(sed -n 's#^// gate-reads:##p' "$t"); do case "$f" in $p) printf '%s\n' "$t" && break ;; esac; done
  done
}
web_smoke() { local t; for t in $WEB_SMOKE; do [ -e "apps/web/test/$t" ] && echo "test/$t"; done; }
web_specs_in() { local d t; for d in "$@"; do for t in apps/web/test/"$d"/*.spec.ts; do [ -e "$t" ] && echo "${t#apps/web/}"; done; done; return 0; }
# The change's own browser specs, which also run on WebKit (the iphone project): a changed spec, and the specs of a changed
# feature or spec folder. Never the smoke set (shared code is not WebKit-specific; CI's browser job runs WebKit for all of
# it), and never voice (the iphone project leaves voice out). A WebKit-only failure (Tab skips buttons there) reached main
# when the gate ran Chromium alone.
web_own_specs_for() {
  local f="$1" x
  case "$f" in
    apps/web/test/voice*/*) ;;
    apps/web/test/*.spec.ts) [ -e "$f" ] && echo "${f#apps/web/}" ;;
    apps/web/test/helpers/* | apps/web/test/*.test.ts | apps/web/test/*.test.tsx) ;;
    apps/web/test/*/*)
      x="${f#apps/web/test/}"
      web_specs_in "${x%%/*}"
      ;;
    apps/web/src/*.test.ts | apps/web/src/*.test.tsx | apps/web/src/features/voice/*) ;;
    apps/web/src/features/*/*)
      x="${f#apps/web/src/features/}"
      web_specs_in "${x%%/*}"
      ;;
  esac
}
web_specs_for() { # prints the specs, relative to apps/web, a changed (or deleted) web file runs
  local f="$1" x out
  case "$f" in
    apps/web/src/*.test.ts | apps/web/src/*.test.tsx) ;; # unit tests (Vitest), not browser specs
    apps/web/test/helpers/*) web_smoke ;; # what every spec runs on
    apps/web/test/*.spec.ts) [ -e "$f" ] && echo "${f#apps/web/}" ;;
    apps/web/test/*.test.ts | apps/web/test/*.test.tsx) ;; # unit tests (Vitest), not browser specs
    apps/web/test/*/*)
      # a spec folder's own support file (cards/e2e.ts, voice/fakes.ts): that folder's specs, and the smoke set
      x="${f#apps/web/test/}"
      web_specs_in "${x%%/*}"
      web_smoke
      ;;
    apps/web/src/features/*/*)
      x="${f#apps/web/src/features/}"
      x="${x%%/*}"
      # a feature's own specs (voice has a setup folder of its own); a feature with none gets the smoke set
      if [ "$x" = voice ]; then out="$(web_specs_in voice voice-setup)"; else out="$(web_specs_in "$x")"; fi
      if [ -n "$out" ]; then echo "$out"; else web_smoke; fi
      ;;
    apps/web/src/Shell.tsx) web_specs_in shell; web_smoke ;;
    apps/web/src/theme/*) web_specs_in themes; web_smoke ;;
    apps/web/src/features/* | apps/web/src/ui/* | apps/web/src/lib/* | apps/web/src/App.tsx | apps/web/src/main.tsx | \
      apps/web/src/sw.ts | apps/web/public/* | apps/web/index.html | apps/web/vite.config.ts | apps/web/vite.brand.ts | \
      apps/web/playwright.config.ts | apps/web/package.json | apps/web/tsconfig.json)
      web_smoke
      ;;
    apps/web/src/*) web_smoke ;; # anything else every screen may be built from (a new top-level file or folder)
  esac
}
reaches_bridge_suite() { # 0 when a change to `f` runs the whole bridge suite (the rule in plan_suites, below)
  case "$1" in
    apps/bridge/test/*.test.ts) [ -e "$1" ] && return 1 ;;
    apps/bridge/* | packages/protocol/src/* | packages/testkit/src/* | packages/protocol/fixtures/* | \
      packages/protocol/test/support/* | packages/testkit/fixtures/* | apps/desktop/Tests/* | apps/desktop/Resources/* | \
      apps/desktop/Sources/* | plugins/talos-app-mod/* | third_party/chronos/* | kit/* | examples/* | docs/SETUP.md) ;;
    *) return 1 ;;
  esac
  return 0
}
reader_pools() { # GUARDS, the guards over test files, and READERS_POOL, every test file (for file_readers)
  # shellcheck disable=SC2086
  GUARDS="$(grep -rlE --include='*.test.ts' '^// gate-reads:' $VITEST_ROOTS apps/bridge/test 2>/dev/null)"
  # shellcheck disable=SC2086
  READERS_POOL="$(find $VITEST_ROOTS apps/bridge/test \( -name node_modules -prune \) -o \( -name '*.test.ts' -o -name '*.test.tsx' \) -type f -print 2>/dev/null)"
}
plan_suites() {
  local f t d x base named US=$'\037' _LO_LINES=() vit=() bun=() e2e=() vproj=() web=() webkit=() folder_tests=()
  # the tests that list files at all, once (folder_readers runs in a subshell, so it cannot keep a cache of its own)
  # shellcheck disable=SC2086
  LISTERS="$(grep -rlE --include='*.test.ts' "$LISTS_FILES" $VITEST_ROOTS apps/bridge/test 2>/dev/null)"
  reader_pools
  for f in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    # The bridge: its tests reach a file through other modules (which no list of importers by name finds), read
    # fixtures and JSON by path, and break on a deleted file. So anything under apps/bridge/ but a changed test file, a
    # deletion included, and the fixtures its tests read, run the whole bridge suite (a bridge change that ran a fraction
    # of the tests that exercise it, and CI was the first full run, 2026-11-12).
    reaches_bridge_suite "$f" && BUN_ALL=1
    # the pairing path (the enroll CLI and the bridge's half, the web pages, the relay's auth): only the e2e specs drive it
    # end to end, so they run too, for a deletion as well (a CLI change once declined every pairing and no gate saw it,
    # 2026-11-12)
    case "$f" in
      apps/bridge/src/enroll*.ts | apps/bridge/src/enrollment.ts | apps/bridge/src/devices.ts | apps/bridge/src/cli-main.ts | \
        apps/bridge/src/cli.ts | apps/bridge/src/relay-http.ts | apps/web/src/features/auth/* | apps/web/src/lib/deviceKey.ts | \
        apps/relay/src/auth/* | packages/protocol/src/enroll.ts | packages/protocol/src/device-proof.ts)
        [ ! -d e2e ] || e2e+=(tests/01-enroll.spec.ts tests/08-devices.spec.ts tests/12-device-proof.spec.ts)
        ;;
    esac
    # A deleted file in a Vitest app: `vitest related` cannot follow a file that is gone, and a test may read it by path,
    # so that app's whole project runs (the type check catches a broken import, not a test that reads the file).
    if [ ! -e "$f" ]; then
      case "$f" in apps/web/*) vproj+=(web) ;; apps/relay/*) vproj+=(relay) ;; apps/mobile/*) vproj+=(mobile) ;; esac
    fi
    # words and assets (anything the suites below do not plan), and the two code files a test opens by name: the tests that name
    # it, a deleted or renamed one too. A changed test file is named by a doc test that cites its titles (bc69061a renamed relay
    # tests and no gate ran the doc test); install.sh by the tests that run it (a deleted one is no .sh the loop below finds).
    # Not any other source file: a source is read by a guard that says so (`// gate-reads:`, below), and a file like
    # memory/cli.ts is named by 66 tests.
    case "$f" in
      *.test.ts | *.test.tsx | *.spec.ts | install.sh) named=1 ;;
      *.ts | *.tsx | *.mts | *.js | *.mjs | *.json | *.sh | *.py | e2e/*) named=0 ;;
      *) named=1 ;;
    esac
    if [ "$named" = 1 ]; then
      lines_of "$(file_readers "$f")"
      for t in "${_LO_LINES[@]+"${_LO_LINES[@]}"}"; do
        folder_tests+=("$t")
        FOLDER_HITS+=("$t <- $f (names it)")
      done
    fi
    # the guards that read this file by its folder or name, not by import; for a deletion too (a guard may name a file that
    # must exist)
    lines_of "$(guards_reading "$f")"
    for t in "${_LO_LINES[@]+"${_LO_LINES[@]}"}"; do
      folder_tests+=("$t")
      FOLDER_HITS+=("$t <- $f (reads it)")
    done
    lines_of "$(web_specs_for "$f")"
    web+=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
    lines_of "$(web_own_specs_for "$f")"
    webkit+=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
    [ -e "$f" ] || continue # deleted: its importers are found through what else changed, or by the type check
    # tests that read a folder by listing it (kit-tests, kit-pipefail, kit-source...), not by naming the file: any kind of
    # file under kit/ counts, and every .sh or .py
    case "$f" in kit/* | *.sh | *.py)
      lines_of "$(folder_readers "$f")"
      for x in "${_LO_LINES[@]+"${_LO_LINES[@]}"}"; do
        t="${x%%"$US"*}" d="${x#*"$US"}"
        [ -n "$t" ] || continue
        folder_tests+=("$t")
        FOLDER_HITS+=("$t <- $d (lists it)")
      done
      ;;
    esac
    # what an older page meets (room decision 4, scripts/old-client.sh): the protocol, the relay, the bridge's hello and
    # features, and the old-client specs and their tools
    case "$f" in
      packages/protocol/src/* | apps/relay/src/* | apps/relay/migrations/* | apps/relay/package.json | \
        apps/bridge/src/handshake.ts | apps/bridge/src/relay-client.ts | apps/bridge/src/bridge.ts | apps/bridge/src/frames-out.ts | \
        e2e/tests/old-client/* | e2e/harness/* | scripts/old-client.sh | scripts/web-bundle-manifest.mjs)
        OLD=1
        ;;
    esac
    # the end-to-end specs (e2e/, Playwright): a changed spec runs itself; a change to what every spec runs on (the harness,
    # the config, the package) runs them all
    case "$f" in
      e2e/tests/*.spec.ts | e2e/tests/*/*.spec.ts)
        e2e+=("${f#e2e/}")
        continue
        ;;
      e2e/*)
        case "$f" in *.ts | *.json | *.mjs | *.js) E2E_ALL=1 ;; esac
        continue
        ;;
    esac
    case "$f" in
      *.ts | *.tsx | *.mts | *.js | *.mjs | *.json | *.sh | *.py) ;;
      *) continue ;; # words and assets: their readers are planned above
    esac
    case "$f" in
      apps/bridge/test/*.test.ts) bun+=("$f") ;; # any depth: a case * takes / too
    esac
    case "$f" in
      *.sh | *.py)
        # a shell or Python script is not imported: its tests are the ones that name it (and, above, the ones that list its
        # folder), in the Vitest projects or the bridge
        base="${f##*/}" # not basename, and grep -e: a name may start with -
        # shellcheck disable=SC2086
        lines_of "$(grep -rlF --include='*.test.ts' -e "$base" $VITEST_ROOTS 2>/dev/null)"
        vit+=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
        lines_of "$(grep -rlF --include='*.test.ts' -e "$base" apps/bridge/test 2>/dev/null)"
        bun+=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
        ;;
      apps/bridge/*) ;; # bun's, above
      *.json) case "$f" in */package.json | */tsconfig*.json) ;; *) [ "${f%%/*}" = scripts ] && vit+=("$f") ;; esac ;;
      *)
        # a module in a Vitest project: vitest related finds the tests that import it (and runs it if it is a test)
        for r in $VITEST_ROOTS; do case "$f" in "$r"/*) vit+=("$f") ;; esac; done
        ;;
    esac
  done
  for t in "${folder_tests[@]+"${folder_tests[@]}"}"; do case "$t" in apps/bridge/*) bun+=("$t") ;; *) vit+=("$t") ;; esac; done
  uniq_into VIT "${vit[@]+"${vit[@]}"}"
  uniq_into BUN "${bun[@]+"${bun[@]}"}"
  uniq_into E2E "${e2e[@]+"${e2e[@]}"}"
  uniq_into VPROJ "${vproj[@]+"${vproj[@]}"}"
  uniq_into WEB "${web[@]+"${web[@]}"}"
  uniq_into WEBKIT "${webkit[@]+"${webkit[@]}"}"
  # a change across many screens: the smoke set here, and CI's browser job runs them all (the whole set takes 7.5 min on
  # Cyclops on Chromium; this keeps a wide refactor's push near the smoke set's half minute)
  local max="${WEB_SPECS_MAX:-40}"
  case "$max" in '' | *[!0-9]*) max=40 ;; esac # a cap that is not a number is the default, never off
  if [ "${#WEB[@]}" -gt "$max" ]; then
    say "this change touches ${#WEB[@]} web browser specs: the gate runs the smoke set, and CI's browser job runs them all"
    uniq_into WEB $(web_smoke)
    WEBKIT=() # a change that wide is CI's to run on every browser
  fi
  return 0
}
# The installer's core tests also run with a corepack pnpm first on PATH (scripts/corepack-install-tests.sh, one more step of the
# plan) whenever the plan runs the root installer's test: that is what an install.sh, kit/ or scripts/ change plans through the
# guard lines on those tests, and a change to the test itself; not --full, whose every-project run has the tests once already and
# which plans from no change. The second count (plan-check.cjs) says the same from its own list.
# The Swift packages a change must build (the gate's "swift build" step). A changed *.swift file, or a Package.resolved, belongs to
# the nearest folder above it that holds a Package.swift (a changed Package.swift is a *.swift file). apps/mobile/ios/App is the Xcode
# app (its CapApp-SPM package is generated and pulls Capacitor): too slow for a gate, CI's mobile job builds it. A deleted file counts
# by its folder, so a deleted source still builds what is left.
swift_package_of() { # prints the package folder of changed file `f`, or nothing
  local f="$1" d
  case "$f" in *.swift | */Package.resolved) ;; *) return 0 ;; esac
  d="${f%/*}"
  [ "$d" != "$f" ] || return 0
  while [ -n "$d" ]; do
    case "$d" in apps/mobile/ios/App | apps/mobile/ios/App/*) return 0 ;; esac
    if [ -f "$d/Package.swift" ]; then
      printf '%s\n' "$d"
      return 0
    fi
    case "$d" in */*) d="${d%/*}" ;; *) return 0 ;; esac
  done
}
plan_swift() { # SWIFT = the package folders to build for CHANGED, sorted, once each; SWIFT_PARSE = the Xcode app's changed *.swift files
  local f p all=() parse=()
  for f in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    p="$(swift_package_of "$f")"
    [ -z "$p" ] || all+=("$p")
    case "$f" in apps/mobile/ios/App/*.swift) [ ! -f "$f" ] || parse+=("$f") ;; esac # a deleted file has nothing to parse
  done
  uniq_into SWIFT "${all[@]+"${all[@]}"}"
  uniq_into SWIFT_PARSE "${parse[@]+"${parse[@]}"}"
}
plan_swift_all() { # --full: SWIFT = every SwiftPM package (every Package.swift but the Xcode app's), SWIFT_PARSE = the Xcode app's *.swift files
  local f d all=() parse=()
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue # tracked, deleted in the tree
    case "$f" in apps/mobile/ios/App/*.swift) parse+=("$f") ;; esac
    case "$f" in */Package.swift) ;; *) continue ;; esac
    d="${f%/*}"
    case "$d" in apps/mobile/ios/App | apps/mobile/ios/App/*) continue ;; esac
    all+=("$d")
  done < <(git ls-files -z --cached --others --exclude-standard -- ':(glob)**/*.swift')
  uniq_into SWIFT "${all[@]+"${all[@]}"}"
  uniq_into SWIFT_PARSE "${parse[@]+"${parse[@]}"}"
}
plan_corepack() {
  local t
  COREPACK=0
  for t in "${VIT[@]+"${VIT[@]}"}"; do [ "$t" != scripts/root-install.test.ts ] || COREPACK=1; done
}
plan_records() { # the plan as NUL-separated NAME<US>value records, for the second count
  local v
  for v in "${VIT[@]+"${VIT[@]}"}"; do printf 'VIT\037%s\0' "$v"; done
  for v in "${BUN[@]+"${BUN[@]}"}"; do printf 'BUN\037%s\0' "$v"; done
  for v in "${E2E[@]+"${E2E[@]}"}"; do printf 'E2E\037%s\0' "$v"; done
  for v in "${VPROJ[@]+"${VPROJ[@]}"}"; do printf 'VPROJ\037%s\0' "$v"; done
  for v in "${WEB[@]+"${WEB[@]}"}"; do printf 'WEB\037%s\0' "$v"; done
  for v in "${WEBKIT[@]+"${WEBKIT[@]}"}"; do printf 'WEBKIT\037%s\0' "$v"; done
  printf 'BUN_ALL\037%s\0E2E_ALL\037%s\0OLD\037%s\0FAST\037%s\0COREPACK\037%s\0' "$BUN_ALL" "$E2E_ALL" "$OLD" "$FAST" "$COREPACK"
}
plan_check() {
  local out
  command -v node >/dev/null 2>&1 || refuse "no node on PATH: the plan cannot be checked, so nothing runs"
  out="$(plan_records | node -e "$FAST_CHECK_JS$PLAN_CHECK_JS" -- "$BASE" "$ASK_FAST")"
  [ "$out" = "plan-check: ok" ] ||
    refuse "the planned suites differ from a second count of this change (above): the gate does not trust its own plan"
}
