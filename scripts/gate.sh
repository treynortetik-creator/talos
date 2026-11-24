#!/usr/bin/env bash
# The one gate every push goes through (the pre-push hook runs it; builders run it by hand before they push). It REFUSES on
# any failure, and when it cannot run at all: there is no "warning only" here. In this order, stopping at the first that fails:
#   1. typecheck  the whole workspace (pnpm typecheck)
#   2. lint       biome check . (the whole tree)
#   3. personal   check-no-personal on the working tree, with the maintainer's private list when this checkout or the main
#                 checkout of the repository has one (it says so when there is none)
#   4. size       the production file size budget (scripts/size-budget.test.ts)
#   4a. timing    the timing lint over this change's added and changed test lines (scripts/timing-lint.ts --changed <base>): a literal
#                 wait or timeout not scaled by the time factor, or a test whose waits outrun its timeout, refuses
#   4b. swift     "swift build (<package>)": swift build --build-tests in each SwiftPM package a changed *.swift file or Package.swift /
#                 Package.resolved belongs to, in the fast gate too. Not a Mac, or no swift: REFUSED (land it from a Mac)
#   5. suites     the tests the change touches, from the changed paths against the base (see `plan_suites`), the e2e specs
#                 among them (Playwright, one worker); --full runs every Vitest project, the whole bridge suite and every e2e
#                 spec instead
# Usage: scripts/gate.sh [--full | --fast] [--base <ref>] [--plan] [--checks-only]
#        scripts/gate.sh --push [--full] [<remote> [<branch>]]   the one way to push: rebase, gate, push, retry a race
#                 (gate-push.sh); it gates with --fast, or with the full gate when given --full
#   --base <ref>  what the change is measured against (default: the merge base with origin/main)
#   --plan        print what it would run and exit 0, running nothing (tests and a look before a long run)
#   --checks-only typecheck, lint, personal, size and timing, no suites (gate-push.sh after a race whose new commits touch none of
#                 this change's tests; CI runs everything after the merge)
#   --fast        the checks, vitest related, and of the bridge tests only the changed ones, the ones that import a changed
#                 file directly and the guards that read it (scripts/gate-fast.sh); no e2e or old-client step. Of the browser
#                 specs only the changed spec files themselves, each on every Playwright project that takes it (desktop, iphone,
#                 pixel), under the heavy lock; with no changed spec there is no browser step and no
#                 heavy lock. CI runs everything else after the push. A change on the keep-out list (scripts/gate-fast-keepout.txt) or
#                 one the import scan cannot follow runs the full gate instead, and says why. A change to only test files
#                 (*.test.ts, *.test.tsx, *.spec.ts, Swift Tests/) is fast too, wherever they are. Its personal step scans this change only (its files and commit messages, base..HEAD); the full gate, the whole tree
# It checks the files on disk. Run from the pre-push hook, the hook first makes sure those are the ones being pushed.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
# Run from a hook, git hands over where this repository is (GIT_DIR and the like; in a linked worktree, always). The tests make
# git repos of their own, and with these set their git would read this one instead. The gate's own git finds the repository
# from the folder it is in.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES

[ "${1:-}" = --push ] && { shift; exec bash scripts/gate-push.sh "$@"; }
FULL=0 PLAN=0 CHECKS_ONLY=0 BASE="" IN_LOCK=0 OLD=0 COREPACK=0 FAST=0 READERS=0 READ_FILES=()
ARGS=("$@") # as given: the suites run again under the heavy lock with the same options (see the suites, below)
while [ $# -gt 0 ]; do
  case "$1" in
    --in-heavy-lock) IN_LOCK=1 ;; # internal: this run is the suites only, inside scripts/heavy-lock.sh
    --full) FULL=1 ;;
    --fast) FAST=1 ;;
    --plan) PLAN=1 ;;
    --readers) # the rest are files: print the tests that read them (gate-push.sh's rebase-clean pass), run nothing
      shift
      READERS=1 READ_FILES=("$@")
      set --
      continue
      ;;
    --checks-only) CHECKS_ONLY=1 ;;
    --base)
      shift
      BASE="${1:-}"
      ;;
    -h | --help)
      sed -n '2,28p' "$0"
      exit 0
      ;;
    *)
      echo "gate: unknown option $1" >&2
      exit 64
      ;;
  esac
  shift
done

say() { printf 'gate: %s\n' "$*" >&2; }
# (after the cd to the top: every script here is named from the top, so a gate run from a sub-folder finds it too)
[ -f scripts/talos-machine.sh ] || {
  say "REFUSED: scripts/talos-machine.sh is missing: this checkout is incomplete"
  exit 1
}
# shellcheck source=scripts/talos-machine.sh
. scripts/talos-machine.sh
# --fast's planning, both counts (fast_plan and FAST_CHECK_JS). A copy of the gate without it (its own tests) is never fast.
FAST_CHECK_JS=""
if [ -f scripts/gate-fast.sh ]; then
  # shellcheck source=scripts/gate-fast.sh
  . scripts/gate-fast.sh
else
  fast_plan() {
    FAST=0
    FAST_WHY="scripts/gate-fast.sh is missing"
  }
fi
# A test step that fails only on tests failing on main's tip already, which this change does not touch: excused, when
# gate.sh --push asks (tstep, scripts/gate-excuse.sh). Without the file a test step is a plain step.
if [ -f scripts/gate-excuse.sh ]; then
  # shellcheck source=scripts/gate-excuse.sh
  . scripts/gate-excuse.sh
else
  tstep() { step "$@"; }
  rstep() { step "$@"; }
fi
trap 'say "stopped"; exit 130' INT TERM

# ---- how long a test may take here ------------------------------------------------------------------------------------------
# On a machine with 4 cores or fewer the same tests need longer: every test budget is multiplied by TALOS_TEST_TIME_FACTOR
# (vitest.config.ts, apps/bridge/scripts/test-parallel.ts, the testkit's t(ms)). The cores this process may use: nproc honours a
# CPU affinity limit (taskset), getconf does not and is the fallback where there is no nproc (macOS). One set already wins.
# The core count, read once for every rule that needs it (GATE_CORES: a test's own count, never set otherwise). CORES_RAW is
# what was read (the small-machine notice below takes only a real count, 1 to 4); CORES is that as a number for the factor.
# Apple silicon counts its efficiency cores too, and tests on them run several times slower: an M1 Air reports 8 and has 4
# performance cores, so its gate ran at factor 1 and timing tests failed under load. There the performance cores are the count
# (hw.perflevel0.physicalcpu; a Mac without performance levels, or another system, has no such key and keeps nproc).
# Only on a small one, though (8 cores or fewer in all): a base M5's 4 performance cores sit beside 6 efficiency cores, and that
# machine is fast.
all_cores() { nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0; }
cores_here() {
  local all p
  all="$(all_cores)"
  p="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null)"
  case "$p" in '' | *[!0-9]*) p="" ;; esac
  case "$all" in '' | *[!0-9]*) all=0 ;; esac
  if [ -n "$p" ] && [ "$all" -le 8 ]; then echo "$p"; else echo "$all"; fi
}
CORES_RAW="${GATE_CORES:-$(cores_here)}"
CORES="$CORES_RAW"
case "$CORES" in '' | *[!0-9]* | 0) CORES=1 ;; esac
if [ -z "${TALOS_TEST_TIME_FACTOR:-}" ]; then
  if [ "$CORES" -le 4 ]; then TALOS_TEST_TIME_FACTOR=3; else TALOS_TEST_TIME_FACTOR=1; fi
fi
export TALOS_TEST_TIME_FACTOR
refuse() {
  say "REFUSED: $*"
  exit 1
}

# ---- what changed --------------------------------------------------------------------------------------------------------
if [ -z "$BASE" ]; then
  BASE="$(git merge-base HEAD origin/main 2>/dev/null)" || BASE=""
fi
CHANGED=()
if [ "$FULL" = 0 ] && [ "$READERS" = 0 ]; then
  [ -n "$BASE" ] || refuse "no base to measure the change against (no origin/main?): pass --base <ref>, or --full"
  # committed since the base, plus anything changed in the working tree (the gate checks the files on disk). NUL-separated (-z):
  # without it git prints a name with a non-ASCII letter, a tab, a quote or a backslash as a quoted C string (and whether it does
  # for non-ASCII is the user's core.quotePath), which no rule below matches, so the file would be planned for nothing.
  # A name with a newline in it is refused: the plan and its second count read names a line at a time, so it would be planned
  # as two names that are neither of them (and a suite it needs left out), with both counts agreeing.
  while IFS= read -r -d '' f; do
    case "$f" in *$'\n'*) refuse "a changed file name holds a newline ($(printf '%s' "$f" | tr '\n' '?')): the gate cannot plan it; rename it" ;; esac
    [ -n "$f" ] && CHANGED+=("$f")
  done < <(
    {
      git diff -z --name-only --no-renames "$BASE" HEAD
      git diff -z --name-only --no-renames HEAD
      git ls-files -z --others --exclude-standard
    } | LC_ALL=C sort -zu
  )
fi

# The suites a change touches: VIT, the files for `vitest related` (the tests that import a changed file, and changed test
# files themselves, in every Vitest project), and BUN, the bridge test files (a changed bridge test runs itself). Anything else
# the bridge tests reach (any file under apps/bridge/, a deletion there, the protocol and the testkit, and the files outside it
# they read: see plan_suites) runs the whole bridge suite (BUN_ALL). Paths are kept in arrays, so a name with a space in it
# stays one path.
# The Vitest projects' folders (vitest.config.ts `projects`).
VITEST_ROOTS="packages/protocol packages/testkit packages/integrations apps/relay apps/web apps/mobile scripts"
VIT=() BUN=() E2E=() VPROJ=() WEB=() WEBKIT=() SWIFT=() SWIFT_PARSE=() VIT_ALL=0 BUN_ALL=0 E2E_ALL=0 WEB_ALL=0
FOLDER_HITS=() # for --plan: which folder-listing test was picked for which folder
# shellcheck source=scripts/gate/plan.sh
. scripts/gate/plan.sh
# The tests that list a folder's files (readdirSync, a glob, git ls-files / ls-tree / write-tree) and name that folder as a path
# of its own ('kit', 'kit/scripts'). Found by grep, so a new folder-scanning test is picked up with no list to keep. Which
# folders count, for a changed file: any folder of its, its own included, two or more levels deep (apps/windows/distro,
# apps/windows), and of the top-level ones only those in WHOLE_FOLDERS, whose tests read them whole (kit-source hashes kit/).
# A top-level folder like apps or scripts never counts, its own file's folder included: tests name those to build paths, which
# says nothing about this file.
WHOLE_FOLDERS="kit"
LISTS_FILES='readdirSync|globSync|readdir\(|ls-files|ls-tree|write-tree'
LISTERS=""
# The tests that read a words or asset file (a doc, a markdown page, an image, a config the gate has no suite for): the ones
# that name it, by its path or by its file name in quotes, in the Vitest projects and the bridge. The gate plans them, so a
# docs-only change that breaks a test pinning that doc is caught at the push. A file no test names plans nothing. A changed test
# file, and install.sh, are read by name too (a doc test cites the titles of the tests it opens; bc69061a), though they are code.
READERS_POOL=""
# The guards over test files (the ci-requires guard walks apps/bridge/test; the spec lint reads every *.spec.ts): they import
# none of the files they read, so no list of importers finds them. Each says what it reads on a line of its own,
# `// gate-reads: <pattern>...` (case patterns: * and ? match / too, no [ ]), and a changed or deleted file that matches one
# runs that guard. Found by grep, like the folder readers: a new guard needs only its own line (a bridge test began to run
# tmux without its header, and main went red, 2026-11-14). The same line is how a test that reads a source, a doc or a whole
# folder gets planned for it: a test is not planned for a source file because it names it (memory/cli.ts is named by 66 tests),
# so any test that opens a file it does not import says so (real-file.test.ts walks apps/bridge/src, 90eda966). The core
# installer tests read install.sh, kit/ and scripts/ this way: any change there runs them (root-install, install-bughunt,
# uninstall-bughunt, kit-update; the other root-install* files are macOS-only or heavy, and CI's).
GUARDS=""
# The web app's browser specs (apps/web/test/**/*.spec.ts, Playwright; CI's browser job runs all of them on three browsers):
# a change under apps/web/src/features/<x>/ runs apps/web/test/<x>/*.spec.ts, a changed spec runs itself, and a change to
# what every screen is built from (ui, lib, theme, the shell, the entry, the service worker, the build) runs this smoke
# set, a few specs over the main paths. On Chromium (the desktop project); the change's own
# specs also on WebKit and Pixel (web_own_specs_for; the fast gate runs only the changed spec files, on every project: gate-fast.sh).
WEB_SMOKE="threads/threads.spec.ts threads/message-row.spec.ts composer/send-leaves-no-text.spec.ts home/home.spec.ts \
settings/settings-home.spec.ts session/session.spec.ts fake-mode.spec.ts"

# --readers <file>...: "<test> <- <file>" for each test the plan runs because it names that file or reads it by a gate-reads
# pattern, and "the whole bridge suite <- <file>" for a file the bridge suite reads (plan_suites' own rules, not a copy). Nothing
# printed: no test reads them. gate-push.sh's rebase-clean pass asks it about the words files both sides changed.
if [ "$READERS" = 1 ]; then
  reader_pools
  # no test file found at all is a search that failed, never "nobody reads it"
  [ -n "$READERS_POOL" ] || { say "--readers: no test files found: who reads these cannot be told"; exit 2; }
  for f in "${READ_FILES[@]+"${READ_FILES[@]}"}"; do
    lines_of "$(file_readers "$f"; guards_reading "$f")"
    for t in "${_LO_LINES[@]+"${_LO_LINES[@]}"}"; do printf '%s <- %s\n' "$t" "$f"; done
    ! reaches_bridge_suite "$f" || printf 'the whole bridge suite <- %s\n' "$f"
  done
  exit 0
fi

# The plan fails closed: after plan_suites, a second count of the same rules (node, its own code, from git and the files, not
# these loops) must come out the same, every list and flag, or the gate refuses. A plan the shell got wrong for any reason (bash
# 3.2 losing lists on a big change, 2026-11-13) refuses instead of running fewer tests. A change to plan_suites' rules is made
# in both; the gate's own tests run every --plan case through both. No node, an empty answer, anything but "ok": refused.
IFS= read -r -d '' PLAN_CHECK_JS < scripts/gate/plan-check.cjs || true

# --fast asks; with --full or --checks-only it is not a fast gate (each says what it runs)
{ [ "$FULL" = 1 ] || [ "$CHECKS_ONLY" = 1 ]; } && FAST=0 # (inside the lock, a fast gate stays fast: the suites it chose run there)
ASK_FAST="$FAST"
if [ "$FULL" = 1 ]; then
  VIT_ALL=1 BUN_ALL=1 E2E_ALL=1 OLD=1 WEB_ALL=1
  plan_swift_all # no changed list in --full: every Swift package is built
else
  plan_suites || refuse "planning the suites failed (exit $?): nothing runs on a plan that did not finish"
  [ "$FAST" = 0 ] || fast_plan
  plan_corepack
  plan_check
  plan_swift # outside the second count: it reads the same CHANGED list and nothing else
fi
if [ "$ASK_FAST" = 1 ] && [ "$IN_LOCK" = 0 ]; then
  if [ "$FAST" = 1 ]; then
    if [ "${#WEB[@]}${#WEBKIT[@]}" = 00 ]; then FAST_LOCK_SAYS="no heavy lock"; else FAST_LOCK_SAYS="the heavy lock for its browser specs"; fi
    say "fast gate: of the bridge tests only the changed ones, their direct importers and their guards; of the browser specs only the changed spec files, on every project that takes them; no e2e or old-client step; $FAST_LOCK_SAYS (CI runs everything after the push)"
  else
    say "full gate, not the fast one: $FAST_WHY"
    [ "$PLAN" = 0 ] && declare -F fast_fallback_log >/dev/null && fast_fallback_log # one line for the evidence (gate-fast.sh)
  fi
fi
if [ "$CHECKS_ONLY" = 1 ]; then VIT=() BUN=() E2E=() VPROJ=() WEB=() WEBKIT=() SWIFT=() SWIFT_PARSE=() VIT_ALL=0 BUN_ALL=0 E2E_ALL=0 OLD=0 WEB_ALL=0 COREPACK=0; fi
[ -d e2e ] || E2E_ALL=0 # a checkout with no e2e package has no e2e to run (the hook's tests run in such a clone)
[ -d e2e ] && [ -f scripts/old-client.sh ] || OLD=0 # nor the old-client step, nor one without its script
[ -f apps/web/playwright.config.ts ] || { WEB_ALL=0; WEB=(); WEBKIT=(); } # nor web browser specs without the web app's Playwright config
NEED_BUN=0
{ [ "$BUN_ALL" = 1 ] || [ "${#BUN[@]}" -gt 0 ]; } && NEED_BUN=1

# The whole bridge suite on a small machine: about 5 minutes on the fast Macs, 30 or more on 2 cores. Say so, and the way out.
SMALL=0
[ "$CORES_RAW" -ge 1 ] 2>/dev/null && [ "$CORES_RAW" -le 4 ] && SMALL=1
# (not while landing someone's handoff: gate-push.sh sets GATE_LANDING_HANDOFF, and that work has nowhere else to go)
if [ "$BUN_ALL" = 1 ] && [ "$SMALL" = 1 ] && [ "$CHECKS_ONLY" = 0 ] && [ "$IN_LOCK" = 0 ] && [ -z "${GATE_LANDING_HANDOFF:-}" ]; then
  # the handoff branch is named after the machine's fleet name (TALOS_MACHINE), never its host name: a branch on origin must not
  # carry a person's name. Unset or unknown: the hint says so instead of naming the branch.
  if me="$(talos_machine 2>/dev/null)"; then
    say "the whole bridge suite runs for this change: about $((CORES <= 2 ? 30 : 15)) minutes or more on $CORES cores. To land it from a faster machine instead: git push origin HEAD:refs/heads/handoff/$me/<name>, then a machine with the private list runs scripts/gate.sh --push --from origin/handoff/$me/<name> (a change to the push path itself cannot be handed off)"
  else
    say "the whole bridge suite runs for this change: about $((CORES <= 2 ? 30 : 15)) minutes or more on $CORES cores. To land it from a faster machine, set TALOS_MACHINE to this machine's fleet name ($TALOS_FLEET) first: the handoff branch is named after it, never after the host"
  fi
fi

if [ "$PLAN" = 1 ]; then
  # one step per line; a suite's files follow it, one per line, indented by a tab
  if [ "$ASK_FAST" = 1 ]; then if [ "$FAST" = 1 ]; then echo fast; else echo "full-gate: $FAST_WHY"; fi; fi
  printf '%s\n' typecheck lint personal size timing
  if [ "$VIT_ALL" = 1 ]; then echo vitest-all; elif [ "${#VIT[@]}" -gt 0 ]; then echo vitest; printf '\t%s\n' "${VIT[@]}"; fi
  if [ "$VIT_ALL" = 0 ] && [ "${#VPROJ[@]}" -gt 0 ]; then echo vitest-project; printf '\t%s\n' "${VPROJ[@]}"; fi
  [ "$COREPACK" = 0 ] || echo corepack-install
  # one step per package, its command indented below it (tests are built too: a Swift test file must compile)
  [ "${#SWIFT_PARSE[@]}" = 0 ] || { echo "swift parse (apps/mobile/ios/App)"; printf '\t%s\n' "${SWIFT_PARSE[@]}"; }
  for p in "${SWIFT[@]+"${SWIFT[@]}"}"; do printf 'swift build (%s)\n\tswift build --build-tests\n' "$p"; done
  if [ "$BUN_ALL" = 1 ]; then echo bun-all; elif [ "${#BUN[@]}" -gt 0 ]; then echo bun; printf '\t%s\n' "${BUN[@]}"; fi
  if [ "$E2E_ALL" = 1 ]; then echo e2e-all; elif [ "${#E2E[@]}" -gt 0 ]; then echo e2e; printf '\t%s\n' "${E2E[@]}"; fi
  [ "$OLD" = 0 ] || echo old-client
  if [ "$WEB_ALL" = 1 ]; then echo web-specs-all; elif [ "${#WEB[@]}" -gt 0 ]; then echo web-specs; printf '\t%s\n' "${WEB[@]}"; fi
  if [ "$WEB_ALL" = 0 ] && [ "${#WEBKIT[@]}" -gt 0 ]; then echo web-specs-webkit; printf '\t%s\n' "${WEBKIT[@]}"; fi
  # the Playwright projects each planned browser spec runs on
  web_projects_report >&2
  # why each folder-listing test is there (on stderr: stdout stays the plan)
  [ "${#FOLDER_HITS[@]}" = 0 ] || { echo "folder readers:"; printf '  %s\n' "${FOLDER_HITS[@]}" | LC_ALL=C sort -u; } >&2
  echo "time factor: $TALOS_TEST_TIME_FACTOR (test budgets x$TALOS_TEST_TIME_FACTOR)" >&2
  exit 0
fi
# ---- can it run at all ---------------------------------------------------------------------------------------------------
# A change that touches Swift is built here (the "swift build" step below). A machine that cannot build it refuses, never skips.
if [ "$IN_LOCK" = 0 ] && [ "$((${#SWIFT[@]} + ${#SWIFT_PARSE[@]}))" -gt 0 ]; then
  SWIFT_WHAT="${SWIFT[*]-}"
  [ "${#SWIFT_PARSE[@]}" = 0 ] || SWIFT_WHAT="${SWIFT_WHAT:+$SWIFT_WHAT, }the Xcode app, apps/mobile/ios/App"
  [ "$(uname -s)" = Darwin ] || refuse "this change touches Swift ($SWIFT_WHAT) and this machine is not a Mac, so it cannot be built here: land it from a Mac"
  { command -v swift >/dev/null 2>&1 && command -v swiftc >/dev/null 2>&1; } || refuse "this change touches Swift ($SWIFT_WHAT) and swift is not installed on this machine: install the Xcode Command Line Tools (xcode-select --install), or land it from a Mac that has Swift"
fi
say "time factor $TALOS_TEST_TIME_FACTOR: every test budget x$TALOS_TEST_TIME_FACTOR on this machine"
[ "$IN_LOCK" = 0 ] && [ -f scripts/tmp-sweep.sh ] && bash scripts/tmp-sweep.sh # day-old test folders in $TMPDIR, once per gate
command -v node >/dev/null 2>&1 || refuse "no node on PATH: the gate cannot run, so the push cannot go"
# The repo's Node major (.nvmrc). Another major on PATH fails tests that look wrong (Node 26 refuses
# --experimental-transform-types: the sandbox tests exit 9). Where the right one is installed in a usual place (Homebrew's
# node@N, nvm) it goes first on PATH for this run; where it is not, one line says what to install.
if [ -f .nvmrc ]; then
  want="$(head -1 .nvmrc | sed 's/^v//; s/\..*//' | tr -dc '0-9')"
  have="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
  if [ -n "$want" ] && [ "$have" != "$want" ]; then
    found=""
    for d in "/opt/homebrew/opt/node@$want/bin" "/usr/local/opt/node@$want/bin" "${NVM_DIR:-$HOME/.nvm}"/versions/node/v"$want".*/bin; do
      [ -x "$d/node" ] || continue
      [ "$("$d/node" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "$want" ] || continue
      found="$d"
      break
    done
    [ -n "$found" ] || refuse "this repo runs on Node $want (.nvmrc) and node on PATH is ${have:-unreadable}: install Node $want (brew install node@$want, or nvm install $want) or put it first on PATH"
    PATH="$found:$PATH"
    export PATH
    say "node $have on PATH: using Node $want from $found for this run (.nvmrc)"
  fi
fi
command -v pnpm >/dev/null 2>&1 || refuse "no pnpm on PATH: the gate cannot run"
[ -x node_modules/.bin/biome ] || refuse "no node_modules here: run pnpm install"
if [ -f node_modules/.modules.yaml ] && [ pnpm-lock.yaml -nt node_modules/.modules.yaml ] && ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml; then # newer, same content: only a rebase
  refuse "pnpm-lock.yaml is newer than node_modules: run pnpm install"
fi
[ "$NEED_BUN" = 0 ] || command -v bun >/dev/null 2>&1 || refuse "no bun on PATH: the bridge tests cannot run"
# Bun and the SQLite under bun:sqlite, named at the top of every run: a test can pass on one and fail on another (on macOS
# bun:sqlite is the system SQLite, older than the one other machines have). The repo's floor is Bun 1.4.4 (README, CI):
# an older one refuses whenever the bridge tests run.
BUN_FLOOR=1.4.4
# 0 when version $1 is at least $2 (numbers only: 1.4.4-canary.2 counts as 1.4.4)
version_at_least() {
  local a b i
  IFS=. read -r -a a <<<"${1%%[-+]*}"
  IFS=. read -r -a b <<<"$2"
  for i in 0 1 2; do
    [[ "${a[i]:-0}" =~ ^[0-9]+$ ]] || return 1
    [ "$((10#${a[i]:-0}))" -gt "$((10#${b[i]:-0}))" ] && return 0
    [ "$((10#${a[i]:-0}))" -lt "$((10#${b[i]:-0}))" ] && return 1
  done
  return 0
}
if command -v bun >/dev/null 2>&1; then
  bun_v="$(bun --version 2>/dev/null | head -1)"
  sqlite_v="$(bun -e 'import { Database } from "bun:sqlite"; const d = new Database(":memory:"); console.log(d.query("select sqlite_version() as v").get().v); d.close()' 2>/dev/null | head -1)"
  say "bun ${bun_v:-unreadable}, SQLite ${sqlite_v:-unreadable} (bun:sqlite)"
  if [ "$NEED_BUN" = 1 ] && ! version_at_least "$bun_v" "$BUN_FLOOR"; then
    refuse "bun ${bun_v:-unreadable} is older than $BUN_FLOOR, the repo's floor: upgrade it (bun upgrade) or put a newer one first on PATH"
  fi
else
  say "no bun on PATH"
fi
# the web app's Playwright and its Chromium, for its browser specs (Pixel, in the WebKit step below, is Chromium too)
if [ "$WEB_ALL" = 1 ] || [ "${#WEB[@]}" -gt 0 ] || [ "${#WEBKIT[@]}" -gt 0 ]; then
  (cd apps/web 2>/dev/null && node -e "const {chromium}=require('@playwright/test');process.exit(require('fs').existsSync(chromium.executablePath())?0:1)") >/dev/null 2>&1 ||
    refuse "the web app's Playwright or its Chromium is not installed, so its browser specs cannot run: pnpm install, then (in apps/web) pnpm exec playwright install chromium"
fi
# and its WebKit, for the change's own specs on the iphone project (the iphone-se project is WebKit as well)
if [ "$WEB_ALL" = 0 ] && [ "${#WEBKIT[@]}" -gt 0 ]; then
  (cd apps/web 2>/dev/null && node -e "const {webkit}=require('@playwright/test');process.exit(require('fs').existsSync(webkit.executablePath())?0:1)") >/dev/null 2>&1 ||
    refuse "the web app's WebKit is not installed, so this change's browser specs cannot run on it: (in apps/web) pnpm exec playwright install webkit"
fi
# Playwright and its Chromium, asked of the e2e package itself: an e2e spec that cannot run is not a pass
if [ "$E2E_ALL" = 1 ] || [ "${#E2E[@]}" -gt 0 ] || [ "$OLD" = 1 ]; then
  (cd e2e 2>/dev/null && node -e "const {chromium}=require('@playwright/test');process.exit(require('fs').existsSync(chromium.executablePath())?0:1)") >/dev/null 2>&1 ||
    refuse "Playwright or its Chromium is not installed, so the e2e specs cannot run: pnpm install, then pnpm exec playwright install chromium"
fi

# web_specs_run <limit s> <project...> -- <spec...>: playwright test in apps/web for those projects and specs, in a process group
# of its own: at the limit INT, TERM, KILL to the whole group (the limit named in the message), and a stop stops it all
web_specs_run() {
  local lim="$1" proj=()
  shift
  while [ "$#" -gt 0 ] && [ "$1" != -- ]; do
    proj+=("--project=$1")
    shift
  done
  [ "${1:-}" = -- ] && shift
  # Inside a heavy slot (scripts/heavy-lock.sh) the preview port is the slot's own (PW_PORT): taken, it is said here, naming who has
  # it, not as a web spec that cannot reach its server
  if [ -n "${TALOS_HEAVY_SLOT:-}" ] && command -v lsof >/dev/null 2>&1; then
    local pp="${PW_PORT:-4173}" holder
    holder="$(lsof -nP -iTCP:"$pp" -sTCP:LISTEN -Fpc 2>/dev/null | tr '\n' ' ')"
    [ -z "$holder" ] || refuse "the web specs' preview port $pp (heavy slot $TALOS_HEAVY_SLOT's) is in use ($holder: pid, command): a server left by a stopped run, or a run by hand; stop it, or the specs cannot start"
  fi
  # scripts/gate/group-run.pl: the specs in a group of their own, stopped with INT, then TERM, then KILL (Playwright's web server goes
  # down on INT only), at the limit or when the gate is stopped
  bash -c 'cd apps/web && exec perl "$0" "$@"' "$PWD/scripts/gate/group-run.pl" "$lim" pnpm exec playwright test "${proj[@]}" --forbid-only --workers=2 "$@"
}
step() { # step <name> <command...>: runs it, refuses on failure
  local name="$1" t
  shift
  t=$SECONDS
  say "$name ..."
  "$@" || refuse "$name failed (above)"
  say "$name ok ($((SECONDS - t)) s)"
}

# swift_build <package folder>: swift build --build-tests there, in a process group of its own with a time limit (GATE_SWIFT_LIMIT
# seconds, 900 x the time factor), under the machine's desktop mutex like the Mac app's Swift test script. Without
# Xcode the Command Line Tools keep Testing.framework outside the default search path: the same flags as test.sh.
swift_build() {
  local p="$1" lim="${GATE_SWIFT_LIMIT:-}" top="$PWD" F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks rc
  local flags=() lock=()
  case "$lim" in '' | *[!0-9]* | 0) lim=$((900 * TALOS_TEST_TIME_FACTOR)) ;; esac
  if ! xcodebuild -version >/dev/null 2>&1 && [ -d "$F" ]; then
    flags=(-Xswiftc -F -Xswiftc "$F" -Xlinker -F -Xlinker "$F" -Xlinker -rpath -Xlinker "$F")
  fi
  if [ -f scripts/heavy-lock.sh ] && ! bash scripts/heavy-lock.sh held desktop; then
    lock=(bash "$top/scripts/heavy-lock.sh" desktop "gate swift build ($p)" --)
  fi
  (cd "$p" && "${lock[@]+"${lock[@]}"}" perl -e '$t=shift; $p=fork; if(!$p){setpgrp(0,0); exec @ARGV} $SIG{ALRM}=sub{kill "TERM",-$p; sleep 5; kill "KILL",-$p; exit 142}; alarm $t; waitpid($p,0); exit($? & 127 ? 128+($? & 127) : $? >> 8)' \
    "$lim" swift build --build-tests "${flags[@]+"${flags[@]}"}")
  rc=$?
  [ "$rc" != 142 ] || say "the swift build of $p was stopped after $lim s (GATE_SWIFT_LIMIT)"
  return $rc
}

# swift_parse: swiftc -parse on each file of SWIFT_PARSE (the Xcode app's changed files); every one is tried, any failure fails
swift_parse() {
  local f rc=0
  for f in "${SWIFT_PARSE[@]}"; do swiftc -parse "$f" || rc=1; done
  return $rc
}

if [ "$IN_LOCK" = 0 ]; then
  step typecheck pnpm -s typecheck
  step lint node_modules/.bin/biome check .

  # The private list lives in the main checkout (gitignored), so a worktree uses that one.
  EXTRA="${CHECK_EXTRA_RULES:-}"
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && main="$(dirname "$common")" || main=""
  if [ ! -f scripts/personal-denylist.txt ] && [ -n "$main" ] && [ -f "$main/scripts/personal-denylist.txt" ]; then
    EXTRA="${EXTRA:+$EXTRA:}$main/scripts/personal-denylist.txt"
  fi
  if [ ! -f scripts/personal-denylist.txt ] && [ "${EXTRA#*personal-denylist.txt}" = "$EXTRA" ]; then
    say "no private list (scripts/personal-denylist.txt) here or in the main checkout: only the generic personal-data rules run"
  fi
  # the fast gate scans this change (its files and commit messages, base..HEAD: gate-fast.sh), the full gate the whole tree
  if [ "$FAST" = 1 ]; then step "personal (this change only: its files and commit messages)" fast_personal "$EXTRA"
  else step personal env CHECK_EXTRA_RULES="$EXTRA" bash scripts/check-no-personal.sh; fi
  step size pnpm exec vitest run --project scripts scripts/size-budget.test.ts
  # a literal wait, or waits that outrun the test's timeout, on the lines this change adds or changes (old code blocks nobody)
  if [ -n "$BASE" ]; then step timing pnpm -s timing-lint --changed "$BASE"; else say "timing: no base to diff against, skipped"; fi
  # a file that loses its executable bit without a commit saying so (edits over \\wsl$ did, twice: scripts/gate/exec-bits.sh)
  if [ -n "$BASE" ]; then step "exec bits" bash scripts/gate/exec-bits.sh "$BASE"; fi
  # every Swift package the change touches must build, its tests too (the fast gate as well: nothing else here compiles Swift)
  # the Xcode app is not a package: its changed files get a syntax check, no build (cheap, and a parse error is what a build would say first)
  [ "${#SWIFT_PARSE[@]}" = 0 ] || step "swift parse (apps/mobile/ios/App)" swift_parse
  for p in "${SWIFT[@]+"${SWIFT[@]}"}"; do step "swift build ($p)" swift_build "$p"; done
fi

# ---- the suites: under the machine's heavy lock ---------------------------------------------------------------------------
# The tests are the heavy part. They run under the lock CI's suites take (scripts/heavy-lock.sh, one per machine), so a gate never
# runs its tests beside CI's, and the light steps above stay outside it, as CI's do. One hold for all of them: this script runs
# again, suites only, inside the lock. Inside a holder already (a CI job), heavy-lock.sh passes straight through.
# The fast gate takes no lock when it has no browser specs: it runs a handful of test files beside whatever else runs, a few at a
# time (GATE_FAST_JOBS). Its own browser specs (a changed spec file) run under the lock like the planned gate's: a web server
# and up to two browsers beside CI's suites flake each other's timing, and take the preview port.
if [ "$FAST" = 1 ] && [ "${#WEB[@]}${#WEBKIT[@]}" = 00 ]; then
  : # the suites run straight, below
elif [ "$IN_LOCK" = 0 ] && [ "$VIT_ALL$BUN_ALL$E2E_ALL$OLD$WEB_ALL${#VIT[@]}${#BUN[@]}${#E2E[@]}${#VPROJ[@]}${#WEB[@]}${#WEBKIT[@]}" != 00000000000 ] && [ ! -f scripts/heavy-lock.sh ]; then
  say "no heavy-lock.sh here, suites run unlocked" # a copy of the gate alone (its own tests); the checkout always has it
elif [ "$IN_LOCK" = 0 ] && [ "$VIT_ALL$BUN_ALL$E2E_ALL$OLD$WEB_ALL${#VIT[@]}${#BUN[@]}${#E2E[@]}${#VPROJ[@]}${#WEB[@]}${#WEBKIT[@]}" != 00000000000 ]; then
  bash scripts/heavy-lock.sh run "gate ($(basename "$PWD"))" -- bash scripts/gate.sh --in-heavy-lock "${ARGS[@]+"${ARGS[@]}"}"
  rc=$?
  [ "$rc" = 75 ] && refuse "the tests could not get the heavy lock (scripts/heavy-lock.sh status shows who has it)"
  [ "$rc" = 0 ] || exit "$rc" # the run inside said why
  say "passed"
  exit 0
fi

if [ "$VIT_ALL" = 1 ]; then
  tstep "tests (every Vitest project)" pnpm exec vitest run
elif [ "${#VIT[@]}" -gt 0 ]; then
  # never excused: vitest related picks a test because it imports a changed file (through any module), so it is this change's
  # (a known flaky test that fails here is rerun alone, as in any test step)
  rstep "tests (vitest related)" pnpm exec vitest related --run "${VIT[@]}"
fi
if [ "$VIT_ALL" = 0 ] && [ "${#VPROJ[@]}" -gt 0 ]; then
  # shellcheck disable=SC2046
  tstep "tests (whole Vitest project, for a deleted file: ${VPROJ[*]})" pnpm exec vitest run $(printf -- '--project %s ' "${VPROJ[@]}")
fi
# the installer's core tests once more with a corepack pnpm first on PATH (scripts/corepack-install-tests.sh), as a Mac set up
# by SETUP.md has it: a harness fault that only a corepack pnpm shows reached main (KIT-8, 05676ca3)
# (a Mac's step, as in CI: elsewhere it is said to be skipped, so a Linux gate does not need corepack)
if [ "$COREPACK" = 1 ]; then
  if [ "$(uname -s)" = Darwin ]; then tstep "tests (the installer tests, a corepack pnpm first on PATH)" bash scripts/corepack-install-tests.sh
  else say "the installer tests with a corepack pnpm first on PATH: skipped, they run on a Mac only"; fi
fi
if [ "$BUN_ALL" = 1 ]; then
  tstep "tests (the whole bridge suite)" bash -c 'cd apps/bridge && exec bun run scripts/test-parallel.ts'
elif [ "$FAST" = 1 ] && [ "${#BUN[@]}" -gt 0 ]; then
  # one process per file, as CI runs them, and fewer at a time than the whole suite takes: no lock keeps CI's runs apart
  FAST_JOBS="${GATE_FAST_JOBS:-2}"
  case "$FAST_JOBS" in '' | *[!0-9]* | 0) FAST_JOBS=2 ;; esac
  FAST_LIST="$(mktemp "${TMPDIR:-/tmp}/gate-fast-XXXXXX")" || refuse "no temp file for the list of bridge test files"
  trap 'rm -f "$FAST_LIST"' EXIT
  printf '%s\n' "${BUN[@]#apps/bridge/}" >"$FAST_LIST"
  tstep "tests (${#BUN[@]} bridge files, $FAST_JOBS at a time, $([ "$IN_LOCK" = 1 ] && echo 'under the heavy lock for the browser specs' || echo 'no heavy lock'))" \
    bash -c 'cd apps/bridge && exec bun run scripts/test-parallel.ts --jobs "$0" --files "$1"' "$FAST_JOBS" "$FAST_LIST"
elif [ "${#BUN[@]}" -gt 0 ]; then
  # the paths are relative to the repository; bun runs in apps/bridge
  tstep "tests (bridge files)" bash -c 'cd apps/bridge && exec bun test --timeout=$((5000 * TALOS_TEST_TIME_FACTOR)) "${@#apps/bridge/}"' bun-tests "${BUN[@]}"
fi
# e2e: one worker (its relay runs inside the worker), Chromium (the config's one project)
if [ "$E2E_ALL" = 1 ]; then
  tstep "tests (every e2e spec)" bash -c 'cd e2e && E2E_WORKERS=1 exec pnpm exec playwright test --workers=1'
elif [ "${#E2E[@]}" -gt 0 ]; then
  tstep "tests (e2e specs)" bash -c 'cd e2e && E2E_WORKERS=1 exec pnpm exec playwright test --workers=1 "$@"' e2e "${E2E[@]}"
fi
# the saved web bundle that is live now, against this tree (a failing spec refuses: GATING=1 in scripts/old-client.sh)
[ "$OLD" = 0 ] || step "tests (old client: the saved web bundle)" bash scripts/old-client.sh
# the web app's browser specs, on Chromium, in a process group of their own with a time limit (WEB_SPECS_LIMIT, 900 s)
# every spec (--full: 882 tests, 7.5 min on Cyclops) gets an hour, its own limit; a planned set gets 15 minutes
if [ "$WEB_ALL" = 1 ]; then WEB_LIMIT_NAME=WEB_SPECS_FULL_LIMIT WEB_LIMIT="${WEB_SPECS_FULL_LIMIT:-3600}" WEB_DEFAULT=3600
else WEB_LIMIT_NAME=WEB_SPECS_LIMIT WEB_LIMIT="${WEB_SPECS_LIMIT:-900}" WEB_DEFAULT=900; fi
case "$WEB_LIMIT" in '' | *[!0-9]* | 0) WEB_LIMIT=$WEB_DEFAULT ;; esac
export WEB_LIMIT_NAME
if [ "$WEB_ALL" = 1 ] || [ "${#WEB[@]}" -gt 0 ]; then
  [ "$WEB_ALL" = 1 ] && WEB=() # every spec: no file arguments
  tstep "tests (web browser specs, Chromium)" web_specs_run "$WEB_LIMIT" desktop -- "${WEB[@]+"${WEB[@]}"}"
fi
# the change's own specs on WebKit (the iphone project, and iphone-se for its one spec) and on Pixel too: a spec that only fails
# there (Tab skips buttons) reached main
if [ "$WEB_ALL" = 0 ] && [ "${#WEBKIT[@]}" -gt 0 ]; then
  read -r -a WK_PROJECTS <<<"$(web_webkit_projects)"
  tstep "tests (web browser specs, own specs on WebKit and Pixel)" web_specs_run "$WEB_LIMIT" "${WK_PROJECTS[@]}" -- "${WEBKIT[@]}"
fi
[ "$IN_LOCK" = 1 ] && exit 0 # the run outside says passed
[ "$VIT_ALL$BUN_ALL$E2E_ALL$OLD$WEB_ALL${#VIT[@]}${#BUN[@]}${#E2E[@]}${#VPROJ[@]}${#WEB[@]}${#WEBKIT[@]}" != 00000000000 ] || say "no test suite is touched by this change"
say "passed"
