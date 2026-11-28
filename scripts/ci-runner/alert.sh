# ci-runner.sh's alert step (sourced by it for `alert` and `untested`; moved out so ci-runner.sh stays under 1,000 lines).
# shellcheck shell=bash
# ---------- alert: main went red, or is green again ----------
# After Lemnos's run of a main commit (a push, or a dispatch of a commit that is on main), once its own and its fallback's
# statuses are in: when main turns red, ONE message for the lead (the red jobs, the failing tests from this runner's own logs,
# the first red commit and how long main has been red, the commits since the last green); when it turns green again, one line;
# within a red streak, one "still RED" line when a commit's failing tests differ from the set last said (new, now passing, how
# many still fail; none when a red job's log names none); nothing for a commit with no verdict yet, nothing for a result older than one
# already seen (a run that finished after a newer commit's). The streak, with the set last said (failing=, one a line;
# failing_n= marks a file that keeps one), is ~/.cache/talos-ci/main-streak. The message is a file in
# ~/.cache/talos-ci/alerts/: the runner can't send it, and must never open the live Talos home to post it. A session on this
# Mac passes it on (scripts/ci-alerts.sh watch, as a Monitor). It decides nothing about the commit. GitHub unreadable is an alert
# of its own once it lasts (ci_gh_problem, scripts/ci-runner/gh-account.sh) and exit 1; any other trouble is a line in the log.
ci_alert_age() { # ci_alert_age <seconds>: "2h 5m" or "5m"
  local m=$(($1 / 60))
  [ "$m" -ge 0 ] || m=0
  if [ "$m" -ge 60 ]; then printf '%dh %dm' $((m / 60)) $((m % 60)); else printf '%dm' "$m"; fi
}
ci_alert_tests() { # ci_alert_tests <logs dir> <sha7> <job...>: the failing tests in those jobs' logs (scripts/ci-alert-tests.pl), deduped
  local d="$1" short="$2" j
  shift 2
  for j in "$@"; do
    [ -f "$d/$short-$j.log" ] && perl "$HERE/ci-alert-tests.pl" "$d/$short-$j.log"
  done | awk '!seen[$0]++'
}
ci_alert_notrun() { # ci_alert_notrun <logs dir> <sha7> <job...>: the NOT RUN lines the jobs wrote to <short>-<job>.notrun (ci-local's
  # not_run), as "<job>: NOT RUN: <suite> (<why>)". Only that file: a line a test printed into a job log is no suite left out. At most
  # 50 a job (then "... and N more not listed"), a line at most 300 characters, control characters out.
  local d="$1" short="$2" j
  shift 2
  for j in "$@"; do
    [ -f "$d/$short-$j.notrun" ] && awk -v j="$j" '/^NOT RUN: / { t++; if (t <= 50) { gsub(/[[:cntrl:]]/, ""); print j ": " substr($0, 1, 300) } }
      END { if (t > 50) print j ": ... and " t - 50 " more not listed" }' "$d/$short-$j.notrun"
  done
}
ci_alert_notrun_n() { # ci_alert_notrun_n <logs dir> <sha7> <job...>: how many NOT RUN lines they wrote in all (the list above is capped)
  local d="$1" short="$2" j n=0 c
  shift 2
  for j in "$@"; do
    [ -f "$d/$short-$j.notrun" ] || continue
    c="$(grep -c '^NOT RUN: ' "$d/$short-$j.notrun")"
    n=$((n + c))
  done
  echo "$n"
}
ci_alert_list() { # ci_alert_list < names: "a, b, c", at most 15 then "and N more"; "none" for none
  awk 'NF { n++; if (n <= 15) s = s (n > 1 ? ", " : "") $0 } END { if (n > 15) s = s ", and " n - 15 " more"; print (n ? s : "none") }'
}
ci_alert() {
  local repo="${GITHUB_REPOSITORY:-}" sha="${CI_PLAN_SHA:-}" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}" short
  local file rows line cls prev="" last="" first="" first_at="" green="" now jobs tests n msg out url failing="" known="" new gone whole
  [ -n "$repo" ] && [ -n "$sha" ] || { echo "ci-runner: alert: needs GITHUB_REPOSITORY and CI_PLAN_SHA; nothing said"; return 0; }
  short="${sha:0:7}" file="$cache/main-streak" now=$(date +%s)
  git fetch -q origin main </dev/null >/dev/null 2>&1
  git merge-base --is-ancestor "$sha" origin/main 2>/dev/null || { echo "ci-runner: alert: $short is not on main; nothing to say"; return 0; }
  # the hostile nightly (CI_HOSTILE): its own hostile-ci/* and report only, never main's verdict or streak (ci_alert_hostile)
  [ "${CI_HOSTILE:-}" != 1 ] || { ci_alert_hostile "$repo" "$sha" "$cache"; return; }
  if [ -f "$file" ]; then
    prev="$(sed -n 's/^state=//p' "$file")" last="$(sed -n 's/^sha=//p' "$file")" first="$(sed -n 's/^first=//p' "$file")"
    first_at="$(sed -n 's/^first_at=//p' "$file")" green="$(sed -n 's/^green=//p' "$file")"
    failing="$(sed -n 's/^failing=//p' "$file")" known="$(sed -n 's/^failing_n=//p' "$file")" # none in a file from before sets
  fi
  if [ "${CI_NIGHTLY:-}" != 1 ] && [ -n "$last" ] && [ "$last" != "$sha" ] && git merge-base --is-ancestor "$sha" "$last" 2>/dev/null; then
    echo "ci-runner: alert: $short is older than ${last:0:7}, which already counted; nothing to say"
    return 0
  fi
  mkdir -p "$cache" 2>/dev/null # the error file's folder: a missing one would fail the read itself
  if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' </dev/null 2>"$cache/.alert-gh.err")"; then
    # never a quiet "nothing said": a red main whose statuses cannot be read would go unannounced. At once, with no wait: this
    # runs once a push, not every 10 minutes like the watcher
    ci_gh_problem "$cache" alert-read "ci-runner: alert: the statuses of $short could not be read from $repo, so whether main went red is unknown ($(tail -1 "$cache/.alert-gh.err" 2>/dev/null))"
    return 1
  fi
  ci_gh_problem_clear "$cache" alert-read
  # the nightly (CI_NIGHTLY): its own nightly-ci/* only, never main's verdict or the streak (ci_alert_nightly)
  [ "${CI_NIGHTLY:-}" != 1 ] || { ci_alert_nightly "$repo" "$sha" "$rows" "$cache"; return 0; }
  line="$(printf '%s\n' "$rows" | ci_classify)"
  cls="${line%%$'\t'*}"
  case "$cls" in red | green) ;; *) echo "ci-runner: alert: $short has no verdict ($cls); nothing to say"; return 0 ;; esac
  out=""
  url="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-}"
  jobs="$(printf '%s\n' "$rows" | awk -F'\t' '$1 ~ /^local-ci\// && $2 == "failure" { sub(/^local-ci\//, "", $1); if (!s[$1]++) printf "%s ", $1 }')"
  [ "$cls" = green ] || tests="$(ci_alert_tests "$cache/logs" "$short" $jobs)" whole="$tests"
  for n in $jobs; do [ -n "$(ci_alert_tests "$cache/logs" "$short" "$n")" ] || whole=""; done # a red job naming none: can't tell
  if [ "$cls" = red ] && [ "$prev" != red ]; then
    first="$sha" first_at="$(git show -s --format=%ct "$sha" 2>/dev/null)"
    [ -n "$first_at" ] || first_at="$now"
    n="$(printf '%s' "$tests" | grep -c .)"
    msg="main is RED at $short: ${jobs% } (first red $short, red for $(ci_alert_age $((now - first_at))))"$'\n'
    if [ "$n" -gt 0 ]; then
      msg="${msg}failing tests:"$'\n'"$(printf '%s\n' "$tests" | head -10 | sed 's/^/  /')"$'\n'
      [ "$n" -le 10 ] || msg="${msg}  ... and $((n - 10)) more"$'\n'
    else
      msg="${msg}failing tests: none named in this runner's logs ($cache/logs/$short-<job>.log)"$'\n'
    fi
    if [ -n "$green" ]; then
      msg="${msg}commits since the last green ${green:0:7}:"$'\n'"$(git log --first-parent --format='%H %an %s' -n 20 "$green..$sha" | awk '{ $1 = substr($1, 1, 7); print "  " $0 }')"$'\n'
      n="$(git rev-list --first-parent --count "$green..$sha" 2>/dev/null)"
      [ "${n:-0}" -le 20 ] || msg="${msg}  ... and $((n - 20)) more commits"$'\n'
    else
      msg="${msg}commits (no green on record here; the newest 20):"$'\n'"$(git log --first-parent --format='%H %an %s' -n 20 "$sha" | awk '{ $1 = substr($1, 1, 7); print "  " $0 }')"$'\n'
    fi
    out="${msg}run: $url"
    prev=red failing="$tests" known=1
  elif [ "$cls" = red ] && [ -n "$whole" ] && [ -z "$known" ]; then
    failing="$tests" known=1 # a streak file from before sets: nothing to compare with yet
  elif [ "$cls" = red ] && [ -n "$whole" ] && [ "$(printf '%s\n' "$tests" | sort)" != "$(printf '%s\n' "$failing" | sort)" ]; then
    new="$(awk 'NR == FNR { o[$0]; next } !($0 in o)' <(printf '%s\n' "$failing") <(printf '%s\n' "$tests"))"
    gone="$(awk 'NR == FNR { o[$0]; next } !($0 in o)' <(printf '%s\n' "$tests") <(printf '%s\n' "$failing"))"
    n=$(($(printf '%s' "$tests" | grep -c .) - $(printf '%s' "$new" | grep -c .)))
    out="main is still RED at $short: new failures: $(printf '%s\n' "$new" | ci_alert_list); now passing: $(printf '%s\n' "$gone" | ci_alert_list); still failing: $n"$'\n'"run: $url"
    failing="$tests"
  elif [ "$cls" = green ] && [ "$prev" = red ]; then
    out="main is green again at $short (red since ${first:0:7}, for $(ci_alert_age $((now - ${first_at:-$now})))); run: $url"
    prev=green first="" first_at="" green="$sha" failing="" known=1
  elif [ "$cls" = green ]; then
    prev=green green="$sha" failing="" known=1
  fi
  mkdir -p "$cache/alerts" || return 0
  { printf 'state=%s\nsha=%s\nfirst=%s\nfirst_at=%s\ngreen=%s\n' "$prev" "$sha" "$first" "$first_at" "$green"
    [ -z "$known" ] || printf 'failing_n=%s\n' "$(printf '%s' "$failing" | grep -c .)"
    printf '%s\n' "$failing" | sed '/^$/d; s/^/failing=/'; } > "$file.part" && mv -f "$file.part" "$file"
  if [ -n "$out" ]; then
    printf '%s\n' "$out" > "$cache/alerts/.$now-$short.part" && mv -f "$cache/alerts/.$now-$short.part" "$cache/alerts/$now-$short-$cls.txt"
    echo "ci-runner: alert: written for the lead: $(head -1 "$cache/alerts/$now-$short-$cls.txt")"
  else
    echo "ci-runner: alert: $short is $cls, as main already was; nothing to say"
  fi
  return 0
}
# ci_alert_nightly <repo> <sha> <status rows> <cache>: the nightly's nightly-ci/<job> read as the six (ci_classify), its
# part and report-only contexts left out. Red: one message for the lead, "nightly" in it; green: nothing. It never reads or
# writes main-streak: the nightly is not main's verdict (a push run's local-ci/* is).
ci_alert_nightly() {
  local short="${2:0:7}" line cls jobs tests n out now notrun nr nrs="" ld
  line="$(printf '%s\n' "$3" | awk -F'\t' 'BEGIN { OFS = "\t" } $1 ~ /^nightly-ci\// && $1 !~ /^nightly-ci\/(part|report)-/ { sub(/^nightly-ci\//, "local-ci/", $1); print }' | ci_classify)"
  cls="${line%%$'\t'*}"
  [ "$cls" = red ] || { echo "ci-runner: alert: the nightly of $short is $cls (nightly-ci/*); nothing to say"; return 0; }
  jobs="$(printf '%s\n' "$3" | awk -F'\t' '$1 ~ /^nightly-ci\// && $1 !~ /^nightly-ci\/(part|report)-/ && ($2 == "failure" || $2 == "error") { sub(/^nightly-ci\//, "", $1); if (!s[$1]++) printf "%s ", $1 }')"
  ld="$(ci_logs_dir "$4")"
  tests="$(ci_alert_tests "$ld" "$short" $jobs)" n="$(printf '%s' "$tests" | grep -c .)" now=$(date +%s)
  notrun="$(ci_alert_notrun "$ld" "$short" $jobs)" nr="$(ci_alert_notrun_n "$ld" "$short" $jobs)"
  [ "$nr" -eq 0 ] || nrs=", $nr suite(s) NOT RUN"
  out="main's NIGHTLY is RED at $short: ${jobs% } (nightly-ci/*; main's push verdict, local-ci/*, is unchanged)$nrs"$'\n'
  if [ "$n" -gt 0 ]; then
    out="${out}failing tests:"$'\n'"$(printf '%s\n' "$tests" | head -10 | sed 's/^/  /')"$'\n'
    [ "$n" -le 10 ] || out="${out}  ... and $((n - 10)) more"$'\n'
  else out="${out}failing tests: none named in this runner's logs ($ld/$short-<job>.log)"$'\n'; fi
  [ "$nr" -eq 0 ] || out="${out}NOT RUN, left out ($nr):"$'\n'"$(printf '%s\n' "$notrun" | sed 's/^/  /')"$'\n'
  out="${out}run: ${GITHUB_SERVER_URL:-https://github.com}/$1/actions/runs/${GITHUB_RUN_ID:-}"
  mkdir -p "$4/alerts" || return 0
  printf '%s\n' "$out" > "$4/alerts/.$now-$short-nightly.part" && mv -f "$4/alerts/.$now-$short-nightly.part" "$4/alerts/$now-$short-nightly-red.txt"
  echo "ci-runner: alert: written for the lead: $(head -1 "$4/alerts/$now-$short-nightly-red.txt")"
}

# ci_alert_hostile <repo> <sha> <cache>: the hostile nightly (docs/CI-MACHINES.md, "The hostile nightly"). Its hostile-ci/<job>
# read as the six; every run appends a section to <cache>/hostile/<UTC date>.md: the conditions the run said it made
# (<cache>/hostile/<sha7>.conditions), its load record, each test that failed in the run (a finding: nothing is retried, so each
# failed once, in the run the section names) and each suite its red jobs left out (NOT RUN). A red run also writes ONE alert of its
# own kind ("hostile"): a finding for a test fix, never "main is RED". It never reads or writes main-streak.
ci_alert_hostile() {
  local repo="$1" sha="$2" cache="$3" short="${2:0:7}" rows line cls jobs tests nt rep now url sum reps notrun nr nrs="" ld
  now=$(date +%s) rep="$cache/hostile/$(date -u +%F).md" url="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-}"
  mkdir -p "$cache" 2>/dev/null # the error file's folder: a missing one would fail the read itself
  if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' </dev/null 2>"$cache/.alert-gh.err")"; then
    ci_gh_problem "$cache" hostile-read "ci-runner: alert: the statuses of $short could not be read from $repo, so the hostile nightly has no report ($(tail -1 "$cache/.alert-gh.err" 2>/dev/null))"
    return 1
  fi
  ci_gh_problem_clear "$cache" hostile-read
  line="$(printf '%s\n' "$rows" | awk -F'\t' 'BEGIN { OFS = "\t" } $1 ~ /^hostile-ci\// && $1 !~ /^hostile-ci\/(part|report)-/ { sub(/^hostile-ci\//, "local-ci/", $1); print }' | ci_classify)"
  cls="${line%%$'\t'*}"
  jobs="$(printf '%s\n' "$rows" | awk -F'\t' '$1 ~ /^hostile-ci\// && $1 !~ /^hostile-ci\/(part|report)-/ && ($2 == "failure" || $2 == "error") { sub(/^hostile-ci\//, "", $1); if (!s[$1]++) printf "%s ", $1 }')"
  ld="$(ci_logs_dir "$cache")"
  tests="$(ci_alert_tests "$ld" "$short" $jobs)"
  nt="$(printf '%s' "$tests" | grep -c .)"
  notrun="$(ci_alert_notrun "$ld" "$short" $jobs)" nr="$(ci_alert_notrun_n "$ld" "$short" $jobs)"
  [ "$nr" -eq 0 ] || nrs=", $nr suite(s) NOT RUN"
  sum="$nt finding(s) (each failed once; nothing is retried)$nrs${jobs:+; red: ${jobs% }}"
  # one line each: "<context>: <state> (<description>)", the description cut to one line of printable text
  reps="$(printf '%s\n' "$rows" | awk -F'\t' '$1 ~ /^hostile-ci\/report-/ { d = $3; gsub(/[^[:print:]]/, " ", d); if (length(d) > 160) d = substr(d, 1, 160) "..."; if (!s[$1]++) print $1 ": " $2 (d != "" ? " (" d ")" : "") }')"
  mkdir -p "$cache/hostile" || return 0
  {
    printf '\n## %s, %s UTC: %s\n\nrun: %s\n\n' "$short" "$(date -u +%H:%M)" "$cls" "$url"
    echo "Conditions:"
    if [ -s "$cache/hostile/$short.conditions" ]; then sed 's/^/- /' "$cache/hostile/$short.conditions"; else echo "- none recorded (the run did not get as far as its slot)"; fi
    if [ -f "$cache/hostile/$short.load" ]; then
      printf -- '- load per hold of the heavy lock: %s with a burner (its first 600 s), %s not applied, %s with burners left over (killed)\n' \
        "$(grep -c 'none left' "$cache/hostile/$short.load")" "$(grep -c 'not applied' "$cache/hostile/$short.load")" "$(grep -c 'still there' "$cache/hostile/$short.load")"
    fi
    printf '\nFindings, each failed once in %s (%s; nothing is retried):\n' "$url" "$nt"
    if [ "$nt" -gt 0 ]; then printf '%s\n' "$tests" | sed 's/^/- /'; else echo "- none${jobs:+ named in the logs of the red job(s): ${jobs% } ($ld/$short-<job>.log)}"; fi
    printf '\nNOT RUN, left out (%s):\n' "$nr"
    if [ "$nr" -gt 0 ]; then printf '%s\n' "$notrun" | sed 's/^/- /'; else echo "- none recorded${jobs:+ in the logs of the red job(s): ${jobs% }}"; fi
    # report-only contexts (Titan's check and e2e packages with CI_TITAN_HOSTILE=shadow): as they stand when this step runs, never
    # in the result above. Their findings are in that machine's own logs and its job's per-test artifact, not counted here.
    if [ -n "$reps" ]; then
      printf '\nReport-only, not in the result above (Titan: CI_TITAN_HOSTILE=shadow; its tests are in its job'"'"'s logs):\n'
      printf '%s\n' "$reps" | sed 's/^/- /'
    fi
  } >> "$rep"
  echo "ci-runner: alert: hostile run of $short is $cls: $sum; report: $rep"
  [ "$cls" = red ] || return 0
  mkdir -p "$cache/alerts" || return 0
  printf 'HOSTILE nightly at %s: %s. Test fixes, not a red main (local-ci/* unchanged).\nreport: %s\nrun: %s\n' "$short" "$sum" "$rep" "$url" \
    > "$cache/alerts/.$now-$short-hostile.part" && mv -f "$cache/alerts/.$now-$short-hostile.part" "$cache/alerts/$now-$short-hostile.txt"
  echo "ci-runner: alert: written for the lead: $(head -1 "$cache/alerts/$now-$short-hostile.txt")"
}

# ---------- report: main's Linux report went red, or is green again ----------
# Titan's Linux e2e (report-ci/browser-e2e, while CI_TITAN_BROWSER is e2e-shadow) is one of them too.
# Titan's gating parts (image on, browser-e2e, check on) report a red of their own to report-ci/<part> too, and the Mac's run decides the
# verdict: that red is Linux-only, and this is its one alert line. report-ci/image is read like the rest.
# Linux-only reds that main's verdict (local-ci/*) does not see: Hestia's report-ci/linux, and check-titan's report-ci/check
# while CI_TITAN_CHECK is shadow (on: its ci-part/check is folded into the verdict, so a red there is main's red; a commit with
# one ends the look back). For each, the newest result in main's newest 20 commits (a failure is red, "passed on ..." green;
# pending, error, "not tested" and skips are no result), never older than the one last seen: ONE message when it turns red, one
# when it is green again, once per commit, context and state (alerts/said/). The nightly posts nightly-ci/report-* instead (its
# own alert). State: ~/.cache/talos-ci/main-report-<job> ("<state> <sha> <first red sha>").
# Run by the alert step and, for a report that ends after Lemnos's run, every 10 minutes by scripts/ci-alerts.sh watch.
ci_report_alert() {
  local repo="${GITHUB_REPOSITORY:-${CI_REPO:-treynortetik-creator/talos-app}}" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}" ctx f list
  local sha rows st desc prev last first out now todo="report-ci/linux report-ci/check report-ci/browser-e2e report-ci/image" left err
  err="$cache/.report-gh.err"
  mkdir -p "$cache" || return 1
  # GitHub unreadable is an error and an alert (ci_gh_problem, scripts/ci-runner/gh-account.sh), never a quiet "nothing to say"
  list="$(gh api "repos/$repo/commits?sha=main&per_page=20" --jq '.[] | [.sha, .commit.committer.date] | @tsv' </dev/null 2>"$err")" || { ci_gh_problem "$cache" report-read "ci-runner: report: main's commits could not be read from $repo, so a red Linux report would go unseen ($(tail -1 "$err" 2>/dev/null))" "$(ci_gh_read_after)"; return 1; }
  now=$(date +%s)
  for sha in $(printf '%s\n' "$list" | cut -f1); do
    [ -n "$todo" ] || break
    rows="$(gh api --paginate "repos/$repo/commits/$sha/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' </dev/null 2>"$err")" || { ci_gh_problem "$cache" report-read "ci-runner: report: the statuses of ${sha:0:7} could not be read from $repo, so a red Linux report would go unseen ($(tail -1 "$err" 2>/dev/null))" "$(ci_gh_read_after)"; return 1; }
    left=""
    for ctx in $todo; do
      f="$cache/main-report-${ctx#report-ci/}" prev="" last="" first="" out=""
      [ ! -f "$f" ] || read -r prev last first < "$f"
      IFS=$'\t' read -r st desc <<< "$(printf '%s\n' "$rows" | awk -F'\t' -v c="$ctx" '$1 == c { print $2 "\t" $3; exit }')"
      case "$st:$desc" in failure:*) st=red ;; "success:passed on "*) st=green ;; *) st="" ;; esac
      # check-titan on (the plan's CI_TITAN_CHECK is not seen here): it posts ci-part/check, part of the verdict; older is stale.
      # Its own report-ci/check beside it (a gating part says its red, or its green, there too) is the result and stands.
      if [ -z "$st" ] && [ "$ctx" = report-ci/check ] && printf '%s\n' "$rows" | grep -q '^ci-part/check'$'\t'; then st=on
      elif [ -z "$st" ]; then [ "$sha" = "$last" ] || left="$left $ctx"; continue; fi # no result: the commit before, not past the last seen
      if [ "$st" = red ] && [ "$prev" != red ]; then
        first="$sha" out="main's LINUX REPORT is RED at ${sha:0:7}: $ctx (${desc:-no description}); report-only, not in main's verdict (local-ci/*)"
      elif [ "$st" = green ] && [ "$prev" = red ]; then
        out="main's LINUX REPORT is green again at ${sha:0:7}: $ctx (red since ${first:0:7})"
      fi
      mkdir -p "$cache/alerts/said" && printf '%s %s %s\n' "$st" "$sha" "$first" > "$f.$$" && mv -f "$f.$$" "$f" || return 0
      # once per commit, context and state, even for two runs that read the state before either wrote it (O_EXCL)
      [ -n "$out" ] && (set -C && : > "$cache/alerts/said/${sha:0:7}-${ctx#report-ci/}-$st") 2>/dev/null || continue
      printf '%s\n' "$out" > "$cache/alerts/.$now-$$-report.part" &&
        mv -f "$cache/alerts/.$now-$$-report.part" "$cache/alerts/$now-${sha:0:7}-report-${ctx#report-ci/}-$st.txt"
      echo "ci-runner: report: written for the lead: $out"
    done
    todo="${left# }"
  done
  ci_gh_problem_clear "$cache" report-read
  return 0
}
