# ci-runner.sh's check-shadow step (sourced by it for `check-shadow`, after e2e-shadow.sh for its date helpers; kept apart so
# ci-runner.sh stays under 1,000 lines).
# shellcheck shell=bash
# ---------- check-shadow: Titan's check beside Lemnos's own, test by test, on the same commit ----------
# CI_TITAN_CHECK=shadow (docs/CI-MACHINES.md, "check on Titan"), after Lemnos's own run: Titan's check-titan part
# (report-ci/check of this attempt) beside Lemnos's local-ci/check, compared test by test from each side's per-test results
# file (<short>-check-tests.tsv, "# talos-check-tests v1": suite, file, name, state; Lemnos's in its log folder, Titan's from its
# job's per-test artifact ci-tests-check-titan-<attempt>, uploaded on every run; none: "no per-test file"). One row of ~/.cache/talos-ci/logs/check-shadow.tsv and a detail file,
# logs/check-shadow/<short>-<attempt>.txt, with every test named:
#   disagreements  in both files with different states (flaky counts as pass); disagree_outside_macos leaves out the files
#                  Lemnos runs itself in `on` (scripts/ci-local/macos-only.sh: bridge, Vitest and contract)
#   skipped        skip or todo, per side
#   ran on neither in both files with no pass, fail or flaky on either side, and every file that crashed (`*` fail) on a side
#   only one side  a test the other side's file does not have
#   runs nowhere in on  skip or todo on Titan, run on Lemnos, in a file outside the macOS-only list: in `on` Lemnos runs
#                  only that list, so nothing runs it (a tool skip, like Python deps missing on Titan). The ::warning::
#                  names it, and plan warns in `on` while the newest row has any (the column is last; an older file's
#                  header gains it)
# With "# no bun results" on either side only vitest is compared (the row says so); a side with no test lines never reached
# the suites (typecheck or lint failed): recorded, no per-test comparison. Also Titan's part time, its lock wait (its log's
# "lock wait <n>s" lines), its start delay (its run step's start to its pending) and end, and Lemnos's desktop end. It waits
# for Titan's answer while its job works (CI_CHECK_SHADOW_WAIT, 1800 s) or is queued (CI_CHECK_SHADOW_QUEUED, 300 s). It decides
# nothing about the commit: any trouble is a line in the log and exit 0.
ci_check_shadow() {
  local repo="${GITHUB_REPOSITORY:-}" sha="${CI_PLAN_SHA:-}" run="${GITHUB_RUN_ID:-}" n="${GITHUB_RUN_ATTEMPT:-1}"
  local m="${CI_PART_JOB:-check-titan}" poll="${CI_CHECK_SHADOW_POLL:-30}" cache short tsv detail attempt runurl start now
  local st="" run_at="" jobs rows mine final="" titan=none lemnos=none t_at t_desc t_secs=- t_delay=- t_end=- d_end=- lock=-
  local pend a b tmp="" tf lf compared="" cmp out macos up
  local c_t=- c_l=- dis=- dis_out=- sk_t=- sk_l=- nei=- on_t=- on_l=- pe_t="" pe_l="" pe=- rn=-
  [ -n "$repo" ] && [ -n "$sha" ] && [ -n "$run" ] || { echo "ci-runner: check-shadow: needs GITHUB_REPOSITORY, CI_PLAN_SHA and GITHUB_RUN_ID; nothing recorded"; return 0; }
  cache="$(ci_cache_dir)" || { echo "ci-runner: check-shadow: no cache dir; nothing recorded"; return 0; }
  short="${sha:0:7}" tsv="$cache/logs/check-shadow.tsv" detail="$cache/logs/check-shadow/$short-$n.txt"
  runurl="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/$run" attempt="$runurl/attempts/$n#"
  # Titan's answer of this attempt (the job is read before the statuses: a job seen done means its status, if any, is in them)
  start=$(date +%s)
  while :; do
    if jobs="$(gh api --paginate "repos/$repo/actions/runs/$run/jobs?per_page=100" \
      --jq '.jobs[] | [.name, .status, ([(.steps // [])[] | select(.name == (env.CI_PART_RUN_STEP // "")) | .started_at // ""] | first // "")] | @tsv' </dev/null 2>/dev/null)"; then
      st="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')"
      run_at="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $3; exit }')"
    else st=unread; fi
    rows="$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" \
      --jq '.[] | [.context, .state, (.target_url // ""), (.created_at // ""), (.description // "")] | @tsv' </dev/null 2>/dev/null)"
    mine="$(printf '%s\n' "$rows" | awk -F'\t' -v a="$attempt" -v c="$(ci_ns report-ci/check)" '$1 == c && index($3, a) == 1')"
    final="$(printf '%s\n' "$mine" | awk -F'\t' '$2 != "" && $2 != "pending" { print; exit }')" # newest first
    [ -z "$final" ] || break
    now=$(date +%s)
    case "$st" in
      in_progress | unread) [ $((now - start)) -lt "${CI_CHECK_SHADOW_WAIT:-1800}" ] || break ;;
      queued | waiting | pending | requested) [ $((now - start)) -lt "${CI_CHECK_SHADOW_QUEUED:-300}" ] || break ;;
      *) break ;; # done, or not in the run, with no answer: none will come
    esac
    sleep "$poll"
  done
  if [ -n "$final" ]; then
    t_at="$(printf '%s\n' "$final" | awk -F'\t' '{ print $4 }')" t_desc="$(printf '%s\n' "$final" | awk -F'\t' '{ print $5 }')"
    case "$(printf '%s\n' "$final" | awk -F'\t' '{ print $2 }'):$t_desc" in
      success:skipped*) titan=skipped ;; success:*) titan=pass ;; failure:*) titan=fail ;;
      error:"not tested:"*) titan=not-tested ;; *) titan="$(printf '%s\n' "$final" | awk -F'\t' '{ print $2 }')" ;;
    esac
    t_end="$t_at"
    pend="$(printf '%s\n' "$mine" | awk -F'\t' '$2 == "pending" { p = $4 } END { print p }')" # the oldest: the part's start
    if [ -n "$pend" ] && a="$(ci_e2e_epoch "$pend")" && b="$(ci_e2e_epoch "$t_at")"; then t_secs=$((b - a)); fi
    if [ -n "$pend" ] && [ -n "$run_at" ] && a="$(ci_e2e_epoch "$run_at")" && b="$(ci_e2e_epoch "$pend")"; then t_delay=$((b - a)); [ "$t_delay" -ge 0 ] || t_delay=-; fi
  fi
  # Lemnos's own (this run's links: in shadow its statuses link to the run, not the attempt): check's answer, desktop's end
  out="$(printf '%s\n' "$rows" | awk -F'\t' -v r="$runurl" -v c="$(ci_ns local-ci/check)" '$1 == c && $2 != "pending" && ($3 == r || index($3, r "/") == 1) { print $2 "\t" $5; exit }')"
  case "$out" in success$'\t'skipped*) lemnos=skipped ;; success*) lemnos=pass ;; failure*) lemnos=fail ;; '') ;; *) lemnos="${out%%$'\t'*}" ;; esac
  d_end="$(printf '%s\n' "$rows" | awk -F'\t' -v r="$runurl" -v c="$(ci_ns local-ci/desktop)" '$1 == c && $2 != "pending" && ($3 == r || index($3, r "/") == 1) { print $4; exit }')"
  [ -n "$d_end" ] || d_end=-
  # the two results files: Lemnos's here, Titan's (and its log, for the lock wait) from its job's artifact
  lf="$(ci_logs_dir "$cache")/$short-check-tests.tsv" # Lemnos's own per-test file, of this kind of run
  if tmp="$(mktemp -d)"; then
    # the artifact is uploaded after Titan's status is posted: tried until its job is completed (then twice more), 10 tries at most
    local tries=0 after=0
    while [ "$tries" -lt 10 ] && [ "$after" -lt 3 ]; do
      gh run download "$run" -R "$repo" -n "ci-tests-check-titan-$n" -D "$tmp" </dev/null >/dev/null 2>&1 && break
      tries=$((tries + 1))
      gh api --paginate "repos/$repo/actions/runs/$run/jobs?per_page=100" --jq '.jobs[] | [.name, .status] | @tsv' </dev/null 2>/dev/null |
        awk -F'\t' -v m="$m" '$1 == m && $2 == "completed" { f = 1 } END { exit !f }' && after=$((after + 1))
      sleep "$poll"
    done
    tf="$tmp/$short-check-tests.tsv"
    [ ! -f "$tmp/$short-check-lock-wait.txt" ] || lock="$(sed -nE 's/.*lock wait ([0-9]+)s.*/\1/p' "$tmp/$short-check-lock-wait.txt" | awk '{ s += $1; n++ } END { if (n) print s; else print "-" }')"
  fi
  mkdir -p "$cache/logs/check-shadow" || { [ -z "$tmp" ] || rm -rf "$tmp"; return 0; }
  printf 'check-shadow %s attempt %s: titan %s, lemnos %s\n' "$sha" "$n" "$titan" "$lemnos" > "$detail"
  if [ ! -s "${tf:-/nonexistent}" ]; then compared="not compared: no per-test file from titan"
  elif [ ! -s "$lf" ]; then compared="not compared: no per-test file from lemnos"
  else ci_cs_compare "$tf" "$lf" titan lemnos >> "$detail"; fi
  [ -z "$tmp" ] || rm -rf "$tmp"
  [ -s "$tsv" ] || printf 'date\tsha\tattempt\ttitan\tlemnos\tcompared\ttests_titan\ttests_lemnos\tdisagree\tdisagree_outside_macos\tskip_titan\tskip_lemnos\tneither\tonly_titan\tonly_lemnos\tparts_elsewhere\ttitan_part_s\ttitan_lock_wait_s\ttitan_start_delay_s\ttitan_part_end\tlemnos_desktop_end\tdetail\truns_nowhere_in_on\n' > "$tsv"
  # a file from before runs_nowhere_in_on: its header gains the column (its rows, one field short, read it as empty)
  case $'\t'"$(head -1 "$tsv")"$'\t' in *$'\t'runs_nowhere_in_on$'\t'*) ;; *)
    if up="$(mktemp "$tsv.XXXXXX")"; then
      { printf '%s\truns_nowhere_in_on\n' "$(head -1 "$tsv")"; tail -n +2 "$tsv"; } > "$up" && cat "$up" > "$tsv"; rm -f "$up"
    else echo "ci-runner: check-shadow: could not add runs_nowhere_in_on to $tsv's header"; fi ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$sha" "$n" "$titan" \
    "$lemnos" "$compared" "$c_t" "$c_l" "$dis" "$dis_out" "$sk_t" "$sk_l" "$nei" "$on_t" "$on_l" "$pe" "$t_secs" "$lock" "$t_delay" \
    "$t_end" "$d_end" "$detail" "$rn" >> "$tsv"
  echo "ci-runner: check-shadow: $short: titan $titan, lemnos $lemnos, $compared; $dis disagree ($dis_out outside the macOS-only files), $nei ran on neither side; part ${t_secs}s after a ${t_delay}s wait, lock wait ${lock}s (row in $tsv, names in $detail)"
  # a disagreement, a test that ran nowhere, and a Titan that gave no pass or fail: the lead's to see
  case "$dis:$nei:$rn" in 0:0:0 | -:-:-) ;; *) echo "::warning::check-shadow $short: $dis disagree, $nei ran on neither side, $rn run nowhere in \`on\` (see $detail)" ;; esac
  case "$titan" in pass | fail) ;; *) echo "::warning::check-shadow $short: titan $titan, lemnos $lemnos" ;; esac
  return 0
}

# ci_cs_compare <file A> <file B> <name A> <name B>: the join of two per-test files (LC_ALL=C), its sections on stdout; sets
# compared, c_t, c_l (A's and B's test lines), dis, dis_out, sk_t, sk_l, nei, on_t, on_l (A's counts first), pe and rn in the
# caller. A is the Linux side (Titan): rn counts the tests skip or todo on A, run on B, outside the macOS-only list.
ci_cs_compare() {
  local a="$1" b="$2" na="$3" nb="$4" macos pe_t pe_l cmp
  ci_cs_tests() { grep -vc '^#' "$1" 2>/dev/null || true; } # its test lines (0 when none)
  c_t="$(ci_cs_tests "$a")" c_l="$(ci_cs_tests "$b")"
  # no test lines: typecheck or lint failed, so no suite ran there; nothing to compare test by test
  if [ "$c_t" = 0 ]; then compared="not compared: $na never reached the suites"; echo "$compared"; return 0; fi
  if [ "$c_l" = 0 ]; then compared="not compared: $nb never reached the suites"; echo "$compared"; return 0; fi
  compared=vitest+bun
  grep -qx '# no bun results' "$a" "$b" 2>/dev/null && compared="vitest only (no bun results)"
  macos="$(bash "$HERE/ci-local/macos-only.sh" "$ROOT" | awk '{ print $2 }' | tr '\n' ' ')"
  # "# parts elsewhere: <part>:<machine> ..." (that side's check had CI_REMOTE_PARTS): those parts' tests are missing from its
  # file on purpose. Their suites (vitest: vitest; a bridge shard: bun) are left out of "only on the other side".
  ci_cs_pe() { sed -n 's/^# parts elsewhere: //p' "$1" | head -1; }
  ci_cs_suites() { for p in $1; do case "${p%%:*}" in vitest) echo vitest ;; bridge-shard-*) echo bun ;; esac; done | sort -u | tr '\n' ' '; }
  pe_t="$(ci_cs_pe "$a")" pe_l="$(ci_cs_pe "$b")"
  pe=-
  [ -z "$pe_t$pe_l" ] || pe="${pe_t:+$na: $pe_t}${pe_t:+${pe_l:+; }}${pe_l:+$nb: $pe_l}"
  # tagged lines: D disagreement (DM: in a macOS-only file), N ran on neither, ST/SL skipped on A/B, OT/OL only on A/B,
  # XT/XL in a part run elsewhere, RN runs nowhere in `on` (a D that is skip or todo on A and ran on B)
  cmp="$(LC_ALL=C awk -F'\t' -v only="${compared%% *}" -v macos=" $macos" -v xt=" $(ci_cs_suites "$pe_t")" -v xl=" $(ci_cs_suites "$pe_l")" \
    -v na="$na" -v nb="$nb" '
    function norm(s) { return s == "flaky" ? "pass" : s }
    function ran(s) { return s == "pass" || s == "fail" || s == "flaky" }
    FNR == 1 { side++ }
    /^#/ || NF < 4 { next }
    only == "vitest" && $1 != "vitest" { next }
    {
      k = $1 "\t" $2 "\t" $3
      if ($3 == "*") { if ($4 == "fail") print "N\t" k "\tcrashed on " (side == 1 ? na : nb); next }
      if ($4 == "skip" || $4 == "todo") print (side == 1 ? "ST" : "SL") "\t" k "\t" $4
      if (side == 1) t[k] = $4; else l[k] = $4
    }
    END {
      for (k in t) {
        if (!(k in l)) { split(k, f, "\t"); print (index(xl, " " f[1] " ") ? "XL" : "OT") "\t" k "\t" t[k]; continue }
        if (norm(t[k]) != norm(l[k])) {
          split(k, f, "\t"); m = index(macos, " " f[2] " ") ? "DM" : "D"
          print m "\t" k "\t" na "=" t[k] "\t" nb "=" l[k]
          if (m == "D" && !ran(t[k]) && ran(l[k])) print "RN\t" k "\t" na "=" t[k] "\t" nb "=" l[k]
        }
        if (!ran(t[k]) && !ran(l[k])) print "N\t" k "\t" na "=" t[k] "\t" nb "=" l[k]
      }
      for (k in l) if (!(k in t)) { split(k, f, "\t"); print (index(xt, " " f[1] " ") ? "XT" : "OL") "\t" k "\t" l[k] }
    }' "$a" "$b" | LC_ALL=C sort)"
  ci_cs_part() { printf '%s\n' "$cmp" | awk -F'\t' -v t="$1" '$1 ~ ("^(" t ")$")' | cut -f2-; }
  ci_cs_n() { ci_cs_part "$1" | sed '/^$/d' | wc -l | tr -d ' '; }
  dis="$(ci_cs_n 'D|DM')" dis_out="$(ci_cs_n D)" nei="$(ci_cs_n N)" sk_t="$(ci_cs_n ST)" sk_l="$(ci_cs_n SL)"
  on_t="$(ci_cs_n OT)" on_l="$(ci_cs_n OL)" rn="$(ci_cs_n RN)"
  printf '%s\n' "$compared"
  printf '\ndisagreements:\n%s\n' "$(ci_cs_part 'D|DM')"
  printf '\nran on neither side:\n%s\n' "$(ci_cs_part N)"
  printf '\nruns nowhere in on (skipped on %s, run on %s, not in the macOS-only list):\n%s\n' "$na" "$nb" "$(ci_cs_part RN)"
  printf '\nskipped on %s:\n%s\n' "$na" "$(ci_cs_part ST)"
  printf '\nskipped on %s:\n%s\n' "$nb" "$(ci_cs_part SL)"
  printf '\nonly on %s:\n%s\n' "$na" "$(ci_cs_part OT)"
  printf '\nonly on %s:\n%s\n' "$nb" "$(ci_cs_part OL)"
  printf '\nin a part run elsewhere (%s), so not compared:\n%s\n' "$pe" "$(ci_cs_part 'XT|XL')"
}

# By hand (the proof that a take-back is today's run: its <short>-check-tests.tsv against a normal check of the same commit):
#   bash scripts/ci-runner/check-shadow.sh compare <file A> <file B>
# (A the Linux side, Titan's, when one is.) The join's sections, then one line of counts. Exit 0: the same tests in the same
# states (flaky counts as pass), every one run on a side; 1: any difference (a state, or a test only one side has), a test
# that ran on neither side (skip or todo on both, or a file that crashed), or one that runs nowhere in `on`;
# 2: not comparable or partial (a side never reached the suites, has no bun results, or names
# parts run elsewhere); 64:
# usage. (The shadow step records the same counts and decides nothing.)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  [ "${1:-}" = compare ] && [ -f "${2:-}" ] && [ -f "${3:-}" ] || { echo "usage: check-shadow.sh compare <file A> <file B>" >&2; exit 64; }
  HERE="$(cd "$(dirname "$0")/.." && pwd)" ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  compared="" c_t=- c_l=- dis=- dis_out=- sk_t=- sk_l=- nei=- on_t=- on_l=- pe=- rn=-
  ci_cs_compare "$2" "$3" a b
  echo "compare: a=$2 ($c_t tests) b=$3 ($c_l tests): $compared; $dis differ, only on a $on_t, only on b $on_l, ran on neither $nei, runs nowhere in on $rn"
  case "$compared" in "not compared"*) exit 2 ;; esac
  # a proof needs every test: a side without bun results, or with parts run elsewhere, is a partial compare, never a pass
  part=""
  if [ "${compared%% *}" = vitest ]; then
    for f in "$2" "$3"; do grep -qx '# no bun results' "$f" && echo "partial compare: bun results missing on $([ "$f" = "$2" ] && echo a || echo b) ($f)"; done
    part=1
  fi
  [ "$pe" = - ] || { echo "partial compare: parts run elsewhere ($pe), their tests not compared"; part=1; }
  [ -z "$part" ] || exit 2
  [ "$nei" = 0 ] || echo "ran on neither side: $nei (listed above)"
  [ "$rn" = 0 ] || echo "runs nowhere in on: $rn (listed above)"
  [ "$dis:$on_t:$on_l:$nei:$rn" = 0:0:0:0:0 ] && exit 0
  exit 1
fi
