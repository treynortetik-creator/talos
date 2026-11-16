# ci-runner.sh's e2e-shadow step (sourced by it for `e2e-shadow`; kept apart so ci-runner.sh stays under 1,000 lines).
# shellcheck shell=bash
# ---------- e2e-shadow: Titan's e2e packages beside Lemnos's own, on the same commit ----------
# CI_TITAN_BROWSER=e2e-shadow (docs/CI-MACHINES.md, "The e2e packages on Titan"), after Lemnos's own run: Titan's browser-e2e
# part (report-ci/browser-e2e of this attempt) beside Lemnos's result for the same packages (the "e2e-shadow:" lines job_browser
# writes in shadow), one row of ~/.cache/talos-ci/logs/e2e-shadow.tsv: the commit, both results, whether they agree, the tests
# that differ (scripts/ci-alert-tests.pl; flakes left out; Titan's from its job's log artifact), the part's time, how long its
# run step waited before the part began (a slot, or Titan's load above CI_MAX_LOAD: from that step's start to its pending), its end,
# Lemnos's web end, and the gap between the two (what CI_BROWSER_E2E_WAIT must cover). A "skipped" success ran nothing: it is
# never a pass. It waits for Titan's answer while its job works (CI_E2E_SHADOW_WAIT, 1800 s), or is queued (CI_E2E_SHADOW_QUEUED,
# 300 s). It decides nothing about the commit: any trouble is a line in the log and exit 0.
ci_e2e_epoch() { date -u -d "$1" +%s 2>/dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null; }
ci_e2e_iso() { date -u -r "$1" +%FT%TZ 2>/dev/null || date -u -d "@$1" +%FT%TZ 2>/dev/null; }
ci_e2e_list() { LC_ALL=C sort -u | sed '/^$/d' | tr '\t' ' ' | awk '{ s = s (NR > 1 ? " | " : "") $0 } END { print s }'; }
ci_e2e_shadow() {
  local repo="${GITHUB_REPOSITORY:-}" sha="${CI_PLAN_SHA:-}" run="${GITHUB_RUN_ID:-}" n="${GITHUB_RUN_ATTEMPT:-1}"
  local m="${CI_PART_JOB:-browser-e2e}" poll="${CI_E2E_SHADOW_POLL:-30}" cache short log tsv attempt start now st rows mine
  local final="" titan=none t_state t_at t_desc t_secs=- t_end=- t_delay=- run_at="" jobs pend a b lemnos=none rc web="" web_end=- after=-
  local l_tests="" t_tests="" tmp f agree=- diff="" only_t only_l
  [ -n "$repo" ] && [ -n "$sha" ] && [ -n "$run" ] || { echo "ci-runner: e2e-shadow: needs GITHUB_REPOSITORY, CI_PLAN_SHA and GITHUB_RUN_ID; nothing recorded"; return 0; }
  cache="$(ci_cache_dir)" || { echo "ci-runner: e2e-shadow: no cache dir; nothing recorded"; return 0; }
  short="${sha:0:7}" log="$cache/logs/$short-browser.log" tsv="$cache/logs/e2e-shadow.tsv"
  attempt="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/$run/attempts/$n#"
  # Titan's answer of this attempt. The job is read before the statuses: a job seen done means its status, if any, is in them.
  start=$(date +%s)
  while :; do
    # the part's job: its status, and when its run step (CI_PART_RUN_STEP) started
    if jobs="$(gh api --paginate "repos/$repo/actions/runs/$run/jobs?per_page=100" \
      --jq '.jobs[] | [.name, .status, ([(.steps // [])[] | select(.name == (env.CI_PART_RUN_STEP // "")) | .started_at // ""] | first // "")] | @tsv' </dev/null 2>/dev/null)"; then
      st="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $2; exit }')"
      run_at="$(printf '%s\n' "$jobs" | awk -F'\t' -v m="$m" '$1 == m { print $3; exit }')"
    else st=unread; fi
    rows="$(CI_E2E_CTX="$(ci_ns report-ci/browser-e2e)" gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" \
      --jq '.[] | select(.context == env.CI_E2E_CTX) | [.state, (.target_url // ""), (.created_at // ""), (.description // "")] | @tsv' </dev/null 2>/dev/null)"
    mine="$(printf '%s\n' "$rows" | awk -F'\t' -v a="$attempt" 'index($2, a) == 1')"
    final="$(printf '%s\n' "$mine" | awk -F'\t' '$1 != "" && $1 != "pending" { print; exit }')" # newest first
    [ -z "$final" ] || break
    now=$(date +%s)
    case "$st" in
      in_progress | unread) [ $((now - start)) -lt "${CI_E2E_SHADOW_WAIT:-1800}" ] || break ;;
      queued | waiting | pending | requested) [ $((now - start)) -lt "${CI_E2E_SHADOW_QUEUED:-300}" ] || break ;;
      *) break ;; # done, or not in the run, with no answer: none will come
    esac
    sleep "$poll"
  done
  if [ -n "$final" ]; then
    # by awk, not read: a tab is whitespace to read, so an empty field would shift the rest
    t_state="$(printf '%s\n' "$final" | awk -F'\t' '{ print $1 }')" t_at="$(printf '%s\n' "$final" | awk -F'\t' '{ print $3 }')"
    t_desc="$(printf '%s\n' "$final" | awk -F'\t' '{ print $4 }')"
    case "$t_state:$t_desc" in
      success:skipped*) titan=skipped ;; success:*) titan=pass ;; failure:*) titan=fail ;;
      error:"not tested:"*) titan=not-tested ;; *) titan="$t_state" ;;
    esac
    t_end="$t_at"
    pend="$(printf '%s\n' "$mine" | awk -F'\t' '$1 == "pending" { p = $3 } END { print p }')" # the oldest: the part's start
    if [ -n "$pend" ] && a="$(ci_e2e_epoch "$pend")" && b="$(ci_e2e_epoch "$t_at")"; then t_secs=$((b - a)); fi
    # ci-local.sh posts the pending once it has a slot (after any wait for load): the run step's start to it is that wait
    if [ -n "$pend" ] && [ -n "$run_at" ] && a="$(ci_e2e_epoch "$run_at")" && b="$(ci_e2e_epoch "$pend")"; then t_delay=$((b - a)); [ "$t_delay" -ge 0 ] || t_delay=-; fi # clocks apart: no number
  fi
  # Lemnos's own: the last shadow lines of its browser log
  if [ -f "$log" ]; then
    rc="$(sed -n 's/^e2e-shadow: the other e2e packages ended with exit \([0-9]*\)$/\1/p' "$log" | tail -1)"
    case "$rc" in '') ;; 0) lemnos=pass ;; *) lemnos=fail ;; esac
    web="$(sed -n 's/^e2e-shadow: web ended at \([0-9]*\)$/\1/p' "$log" | tail -1)"
    [ -z "$web" ] || web_end="$(ci_e2e_iso "$web")"
    # the failing tests of the other packages' call only: between the last web-ended line and its exit line
    [ "$lemnos" != fail ] || l_tests="$(awk '/^e2e-shadow: web ended at / { s = ""; on = 1; next } /^e2e-shadow: the other e2e packages ended/ { on = 0 } on { s = s $0 "\n" } END { printf "%s", s }' "$log" |
      perl "$HERE/ci-alert-tests.pl" | LC_ALL=C sort -u)"
  fi
  [ -z "$web" ] || [ "$t_end" = - ] || { b="$(ci_e2e_epoch "$t_end")" && after=$((b - web)); }
  # Titan's failing tests: its log, from the job's artifact (uploaded right after its run step)
  if [ "$titan" = fail ] && tmp="$(mktemp -d)"; then
    for _ in 1 2 3 4; do
      gh run download "$run" -R "$repo" -n "ci-logs-browser-e2e-$n" -D "$tmp" </dev/null >/dev/null 2>&1 && break
      sleep "$poll"
    done
    f="$tmp/$short-browser-e2e.log"
    [ ! -f "$f" ] || t_tests="$(perl "$HERE/ci-alert-tests.pl" "$f" | LC_ALL=C sort -u)"
    rm -rf "$tmp"
  fi
  case "$titan:$lemnos" in
    pass:pass) agree=yes ;;
    pass:fail | fail:pass | fail:fail)
      only_t="$(LC_ALL=C comm -23 <(printf '%s\n' "$t_tests" | sed '/^$/d') <(printf '%s\n' "$l_tests" | sed '/^$/d') | ci_e2e_list)"
      only_l="$(LC_ALL=C comm -13 <(printf '%s\n' "$t_tests" | sed '/^$/d') <(printf '%s\n' "$l_tests" | sed '/^$/d') | ci_e2e_list)"
      diff="${only_t:+titan only: $only_t}${only_t:+${only_l:+; }}${only_l:+lemnos only: $only_l}"
      local unnamed=""
      if [ "$titan" = fail ] && [ -z "$t_tests" ]; then unnamed="titan red, no test named"; fi
      if [ "$lemnos" = fail ] && [ -z "$l_tests" ]; then unnamed="${unnamed:+$unnamed; }lemnos red, no test named"; fi
      diff="$diff${diff:+${unnamed:+; }}$unnamed"
      if [ "$titan" != "$lemnos" ]; then agree=no
      elif [ -n "$unnamed" ]; then agree=unknown # both red, and a side named none: can't tell they are the same tests
      elif [ -n "$only_t$only_l" ]; then agree=no
      else agree=yes; fi ;;
    *) diff="not compared:$([ "$titan" = pass ] || [ "$titan" = fail ] || echo " titan $titan")$([ "$lemnos" = pass ] || [ "$lemnos" = fail ] || echo " lemnos $lemnos")" ;;
  esac
  mkdir -p "$cache/logs" || return 0
  [ -s "$tsv" ] || printf 'date\tsha\tattempt\ttitan\tlemnos\tagree\tdisagreeing_tests\ttitan_part_s\ttitan_start_delay_s\ttitan_part_end\tlemnos_web_end\tpart_end_minus_web_end_s\n' > "$tsv"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$sha" "$n" "$titan" "$lemnos" "$agree" \
    "$(printf '%s' "$diff" | tr '\t\n' '  ')" "$t_secs" "$t_delay" "$t_end" "$web_end" "$after" >> "$tsv"
  echo "ci-runner: e2e-shadow: $short: titan $titan, lemnos $lemnos, agree $agree${diff:+ ($diff)}; part ${t_secs}s after a ${t_delay}s wait, ended ${after}s after Lemnos's web (row in $tsv)"
  # a disagreement, and a Titan that gave no pass or fail (no answer, a refusal, a skip): both are the lead's to see
  case "$agree:$titan" in no:* | unknown:* | -:none | -:not-tested | -:skipped | -:error) echo "::warning::e2e-shadow $short: titan $titan, lemnos $lemnos: $diff" ;; esac
  return 0
}
