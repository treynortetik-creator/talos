#!/usr/bin/env bash
# The fast gate's planning (scripts/gate.sh --fast; docs/CI-LOCAL.md, "The fast gate"): sourced by gate.sh, which owns every
# name used here that is not defined here (CHANGED, BASE, BUN and the other plan lists, lines_of, uniq_into,
# reaches_bridge_suite). Both counts live here: fast_plan, in bash, and FAST_CHECK_JS, the node second count's own copy of the
# same rules, which gate.sh runs ahead of PLAN_CHECK_JS. A change to the rules is made in both.
# The planned gate runs the whole bridge suite for any bridge change, because bun has no `vitest related`. The fast gate runs,
# of the bridge tests, the changed test files, the guards that read a changed file (`// gate-reads:`, planned by plan_suites) and the
# test files whose own relative strings name a changed apps/bridge/src or apps/bridge/test file ('../src/x.ts': an import, an
# export from, a dynamic import, a require, a path it spawns). Direct only, on purpose: bridge.ts reaches 317 of the 321 source
# files, so following imports further selects about 283 of the 371 bridge test files for almost any change. Everything else
# the planned gate runs (the e2e, old-client and browser specs) is CI's after the push. Names count only as written with their
# extension, as every bridge import is (allowImportingTsExtensions).
# It runs the full gate instead (FAST=0, FAST_WHY says why) for a change to: the keep-out list (scripts/gate-fast-keepout.txt,
# the push path in scripts/gate-inputs.txt, the paths in docs/protected-paths.txt); a deleted bridge file (no scan follows a
# file that is gone); a bridge file that is not a module (data and fixtures are read by path); anything else the bridge tests
# read outside the scan (reaches_bridge_suite); a module the bridge test preload loads (it is in every test); or a selection
# of more than FAST_MAX bridge test files. The node second count makes the same choice, or the gate refuses.
# One carve-out, for test files (gate_test_file: *.test.ts, *.test.tsx, *.spec.ts, a Swift file under Tests/): the gate-inputs rule and
# the keep-out list are for the code a test checks, not the test, so a change to only tests is fast, vitest related on the files.
# Test helpers that are no test file stay code; the protected paths and FAST_MAX still apply. Its personal-data step reads this
# change only (fast_personal). Every fall back to the full gate is one line in <cache>/logs/fast-fallbacks.tsv (fast_fallback_log).
FAST_MAX=60
FAST_WHY=""
BRIDGE_PRELOAD=apps/bridge/test/preload.ts # bunfig.toml's preload; bunfig.toml is a gate input, so a change to it is full
# a quoted relative path in a bridge file: '../src/x.ts', "./helpers.ts", `../src/a.ts`
REL_RE=$'[\'"`]\\.\\.?/[^\'"` \t]*[\'"`]'
norm_path() { # norm_path <dir> <relative>: _NP=the path, . and .. worked out as text (the disk is never asked)
  local IFS=/ s n=0 noglob=0 out=()
  case $- in *f*) noglob=1 ;; esac
  set -f
  # shellcheck disable=SC2086 # each split at / on purpose (a / written between them would join two parts)
  for s in $1 $2; do
    case "$s" in
      '' | .) ;;
      ..)
        if [ "$n" -gt 0 ] && [ "${out[n - 1]}" != .. ]; then
          n=$((n - 1))
          unset "out[$n]"
        else
          out[n]=..
          n=$((n + 1))
        fi
        ;;
      *)
        out[n]="$s"
        n=$((n + 1))
        ;;
    esac
  done
  [ "$noglob" = 1 ] || set +f
  _NP="${out[*]+"${out[*]}"}"
}
names_file() { # names_file <file> <path>: 0 when one of <file>'s quoted relative paths is <path>
  local t="$1" f="$2" tok _LO_LINES=()
  lines_of "$(LC_ALL=C grep -oE -e "$REL_RE" "$t" 2>/dev/null)"
  for tok in "${_LO_LINES[@]+"${_LO_LINES[@]}"}"; do
    tok="${tok#?}"
    norm_path "${t%/*}" "${tok%?}"
    [ "$_NP" = "$f" ] && return 0
  done
  return 1
}
FAST_HITS=() # the changed files the full gate was chosen for (fast_fallback_log)
fast_off() { # the first reason is the one printed
  FAST=0
  [ -n "$FAST_WHY" ] || FAST_WHY="$*"
}
# list_at_base <path>: the list's lines as the base has them (never the change's own copy, which could take itself off the
# list), CRs dropped, each line trimmed, comments and blank lines left out. Fails when the base has no such file.
list_at_base() {
  local txt
  txt="$(git show "$BASE:$1" 2>/dev/null)" || return 1
  printf '%s\n' "$txt" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^#' | grep -v '^$'
  return 0
}
# gate_test_file <path> <the input lines but ^scripts/, as one regex, or empty>: 0 for a TEST file, which the fast gate lets
# past the gate-inputs rule and the keep-out list (they are for the code a test checks, not the test): *.test.ts, *.test.tsx,
# *.spec.ts anywhere, and a Swift file under a Tests/ folder (exact case); a regular file still there (a deletion or a link is
# judged as before); and named by no input line but ^scripts/ itself, as the base has it. A helper that is not a test file
# (scripts/x-harness.ts, apps/bridge/test/helpers.ts) is not one. The protected paths still apply to it.
gate_test_file() {
  case "$1" in *.test.ts | *.test.tsx | *.spec.ts | */Tests/*.swift) ;; *) return 1 ;; esac
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  [ -z "$2" ] || ! printf '%s\n' "$1" | LC_ALL=C grep -iqE -e "$2"
}
fast_plan() {
  local f p ins ins_rest keep t tf _LO_LINES=() prot=() seeds=() bun=() cands=()
  # each list as the base has it; a list that is missing there, or holds nothing, keeps the fast gate off
  for p in scripts/gate-fast-keepout.txt scripts/gate-inputs.txt docs/protected-paths.txt; do
    [ -n "$(list_at_base "$p")" ] || { fast_off "$p is missing or empty at the base, so the keep-out list cannot be read"; return 0; }
  done
  # the two pattern lists as one extended regex each, (a)|(b)|...; the protected paths without a trailing /
  ins="$(list_at_base scripts/gate-inputs.txt | sed 's/.*/(&)/' | paste -sd'|' -)"
  # every input line but the ^scripts/ one: a test file is let past the gate-inputs rule only when no other line names it
  ins_rest="$(list_at_base scripts/gate-inputs.txt | grep -vxF '^scripts/' | sed 's/.*/(&)/' | paste -sd'|' -)"
  keep="$(list_at_base scripts/gate-fast-keepout.txt | sed 's/.*/(&)/' | paste -sd'|' -)"
  lines_of "$(list_at_base docs/protected-paths.txt | sed 's#/*$##')"
  prot=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
  for f in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    tf=1
    gate_test_file "$f" "$ins_rest" || tf=0
    # the three lists name every file that trips them (the log of fallbacks wants them all); the rest return at the first
    if [ "$tf" = 0 ] && printf '%s\n' "$f" | LC_ALL=C grep -iqE -e "$ins"; then
      fast_off "$f is a gate input (scripts/gate-inputs.txt)"
      FAST_HITS+=("$f")
      continue
    fi
    if [ "$tf" = 0 ] && printf '%s\n' "$f" | LC_ALL=C grep -iqE -e "$keep"; then
      fast_off "$f is on the keep-out list (scripts/gate-fast-keepout.txt)"
      FAST_HITS+=("$f")
      continue
    fi
    for p in "${prot[@]+"${prot[@]}"}"; do
      case "$f" in "$p" | "$p"/*)
        fast_off "$f is a protected path (docs/protected-paths.txt)"
        FAST_HITS+=("$f")
        continue 2
        ;;
      esac
    done
    case "$f" in
      apps/bridge/*) [ -e "$f" ] || { fast_off "$f is deleted, and the import scan cannot follow a file that is gone"; FAST_HITS+=("$f"); return 0; } ;;
    esac
    case "$f" in
      apps/bridge/test/*.test.ts) ;; # runs itself (planned by plan_suites)
      apps/bridge/src/* | apps/bridge/test/*)
        case "$f" in
          *.ts | *.tsx | *.mts | *.js | *.mjs) seeds+=("$f") ;;
          *)
            fast_off "$f is a bridge file no import names (data or a fixture, read by path)"
            FAST_HITS+=("$f")
            return 0
            ;;
        esac
        ;;
      apps/bridge/*)
        fast_off "$f is outside apps/bridge/src and apps/bridge/test, where the import scan looks"
        FAST_HITS+=("$f")
        return 0
        ;;
      *)
        if [ "$tf" = 0 ] && reaches_bridge_suite "$f"; then # (the bridge tests read a test file's fixtures, not the test file)
          fast_off "the bridge tests read $f, which the import scan does not follow"
          FAST_HITS+=("$f")
          return 0
        fi
        ;;
    esac
  done
  [ "$FAST" = 1 ] || return 0 # a list above chose the full gate
  bun=("${BUN[@]+"${BUN[@]}"}")
  for f in "${seeds[@]+"${seeds[@]}"}"; do
    if [ -f "$BRIDGE_PRELOAD" ] && names_file "$BRIDGE_PRELOAD" "$f"; then
      fast_off "$f is loaded by the bridge test preload ($BRIDGE_PRELOAD), so every bridge test runs it"
      FAST_HITS+=("$f")
      return 0
    fi
    # the test files that name it (by its file name first: grep, cheap), then by a quoted relative path
    lines_of "$(grep -rlF --include='*.test.ts' -e "${f##*/}" apps/bridge/test 2>/dev/null)"
    cands=("${_LO_LINES[@]+"${_LO_LINES[@]}"}")
    for t in "${cands[@]+"${cands[@]}"}"; do
      names_file "$t" "$f" && bun+=("$t")
    done
  done
  uniq_into bun "${bun[@]+"${bun[@]}"}"
  if [ "${#bun[@]}" -gt "$FAST_MAX" ]; then
    fast_off "it selects ${#bun[@]} bridge test files, more than $FAST_MAX"
    return 0
  fi
  BUN=("${bun[@]+"${bun[@]}"}")
  BUN_ALL=0 E2E=() E2E_ALL=0 OLD=0 WEB=() WEBKIT=()
}

# fast_personal <rule files>: the fast gate's personal-data scan, of this change only: its files as they are on disk (CHANGED,
# deleted ones aside) and the messages of its commits (BASE..HEAD), each under its own path in a temp folder, through
# check-no-personal.sh with the rule files the whole-tree scan has (the private list included: a hit refuses as before). The
# rest of the tree was scanned when it was pushed, and CI scans it all again. The full gate keeps scanning the tree.
fast_personal() (
  local f r rules="" rc=0 IFS=:
  set -f # a rule file's name is a name, never a pattern
  # a relative rule file is the repository's, not the temp folder's
  for r in $1; do
    case "$r" in '' | /*) ;; *) r="$PWD/$r" ;; esac
    rules="${rules:+$rules:}$r"
  done
  IFS=$' \t\n'
  set +f
  d="$(mktemp -d "${TMPDIR:-/tmp}/gate-personal.XXXXXX")" || return 1
  trap 'rm -rf "$d"' EXIT
  mkdir "$d/files" "$d/msg" || return 1
  git log --format=%B "$BASE..HEAD" >"$d/msg/.commit-message" || {
    echo "gate: the commit messages of $BASE..HEAD cannot be read; nothing is known clean" >&2
    return 1
  }
  for f in "${CHANGED[@]+"${CHANGED[@]}"}"; do
    # a deleted file is gone (and its folder may now be a file): only what is there is copied
    if [ -L "$f" ]; then # a link stays a link, with its target: the scan reads where it leads
      mkdir -p "$d/files/$(dirname -- "$f")" && ln -s -- "$(readlink -- "$f")" "$d/files/$f" || return 1
    elif [ -f "$f" ]; then
      mkdir -p "$d/files/$(dirname -- "$f")" && cat -- "$f" >"$d/files/$f" || return 1
    fi
  done
  for f in files msg; do
    CHECK_NO_GIT=1 CHECK_EXTRA_RULES="$rules" bash scripts/check-no-personal.sh "$d/$f" || rc=1
  done
  return $rc
)

# fast_fallback_log: one line for each full gate that --fast chose, appended to <cache>/logs/fast-fallbacks.tsv (TALOS_CI_CACHE, else
# ~/.cache/talos-ci): UTC time, machine, HEAD sha, the reason as printed, and the changed files that tripped it (the first 20,
# comma-separated), so the keep-out list can be cut by evidence. A log that cannot be written never stops the gate.
fast_fallback_log() {
  local log="${TALOS_CI_CACHE:-${HOME:-/nonexistent}/.cache/talos-ci}/logs/fast-fallbacks.tsv" m files="" f n=0
  m="$(talos_machine 2>/dev/null)" || m=unknown
  for f in "${FAST_HITS[@]+"${FAST_HITS[@]}"}"; do
    n=$((n + 1))
    [ "$n" -gt 20 ] || files="${files:+$files,}$f"
  done
  [ "$n" -le 20 ] || files="$files,(+$((n - 20)) more)"
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$m" "$(git rev-parse HEAD 2>/dev/null)" \
    "$(printf '%s' "$FAST_WHY" | tr '\t\n' '  ')" "$(printf '%s' "$files" | tr '\t\n' '  ')" >>"$log" 2>/dev/null || true
  return 0
}

# The second count's half (no shared code with fast_plan above): gate.sh runs it ahead of PLAN_CHECK_JS, which calls fastPlan.
IFS= read -r -d '' FAST_CHECK_JS <<'FAST_CHECK_JS_END' || true
// --fast, fast_plan's rules written again: the bridge tests (the planned ones and those whose quoted relative paths name a
// changed bridge module), or null for the full gate. c: the second count's own helpers and lists (gate.sh, PLAN_CHECK_JS).
function fastPlan(c) {
  const { base, changed, want, text, exists, glob, sorted, B, fs, spawnSync, bridgeTests, BRIDGE_TEST, BRIDGE_ALL } = c
  // a list as the base has it: CRs dropped, each line trimmed, no comments or blank lines; null when the base has none
  const atBase = (p) => {
    const r = spawnSync('git', ['show', `${base}:${p}`], { maxBuffer: 1 << 30 })
    if (r.status !== 0) return null
    return r.stdout
      .toString('latin1')
      .replace(/\r/g, '')
      .split('\n')
      .map((l) => l.replace(/^[ \t\n\v\f]+|[ \t\n\v\f]+$/g, ''))
      .filter((l) => l !== '' && !l.startsWith('#'))
  }
  const anyOf = (ls) => new RegExp(ls.map((l) => `(${l})`).join('|'), 'i')
  const rel = /['"`](\.\.?\/[^'"` \t\n]*)['"`]/g
  const norm = (dir, r) => {
    const out = []
    for (const s of `${dir}/${r}`.split('/')) {
      if (s === '' || s === '.') continue
      if (s === '..') {
        if (out.length && out[out.length - 1] !== '..') out.pop()
        else out.push('..')
      } else out.push(s)
    }
    return out.join('/')
  }
  const namesFile = (t, f) => {
    const d = t.slice(0, t.lastIndexOf('/'))
    for (const m of text(t).matchAll(rel)) if (norm(d, m[1]) === f) return true
    return false
  }
  const fastOff = () => {
    const lists = ['scripts/gate-inputs.txt', 'scripts/gate-fast-keepout.txt', 'docs/protected-paths.txt'].map(atBase)
    if (lists.some((l) => !l?.length)) return true
    const ins = anyOf(lists[0])
    // gate_test_file's twin: a test file (*.test.ts, *.test.tsx, *.spec.ts, a Swift file under Tests/), a regular file still there,
    // named by no input line but ^scripts/
    const rest = lists[0].filter((l) => l !== '^scripts/')
    const restRe = rest.length ? anyOf(rest) : null
    const gateTest = (f) =>
      /(\.test\.tsx?|\.spec\.ts|\/Tests\/.*\.swift)$/.test(f) &&
      fs.lstatSync(B(f), { throwIfNoEntry: false })?.isFile() === true &&
      !restRe?.test(f)
    const keep = anyOf(lists[1])
    const prot = lists[2].map((p) => p.replace(/\/+$/, ''))
    const seeds = []
    for (const f of changed) {
      const tf = gateTest(f)
      if (!tf && (ins.test(f) || keep.test(f))) return true
      if (prot.some((p) => f === p || f.startsWith(`${p}/`))) return true
      if (f.startsWith('apps/bridge/') && !exists(f)) return true
      if (BRIDGE_TEST(f)) continue
      if (glob('apps/bridge/src/*', 'apps/bridge/test/*')(f)) {
        if (!glob('*.ts', '*.tsx', '*.mts', '*.js', '*.mjs')(f)) return true
        seeds.push(f)
      } else if (f.startsWith('apps/bridge/') || (!tf && BRIDGE_ALL(f))) return true
    }
    const bun = [...want.BUN]
    const preload = 'apps/bridge/test/preload.ts'
    for (const f of seeds) {
      if (fs.statSync(B(preload), { throwIfNoEntry: false })?.isFile() && namesFile(preload, f)) return true
      const name = f.slice(f.lastIndexOf('/') + 1)
      bun.push(...bridgeTests.filter((t) => text(t).includes(name) && namesFile(t, f)))
    }
    if (sorted(bun).length > 60) return true
    picked = sorted(bun)
    return false
  }
  let picked = null
  return fastOff() ? null : picked
}
FAST_CHECK_JS_END
