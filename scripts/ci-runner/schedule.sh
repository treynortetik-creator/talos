# scripts/ci-runner/schedule.sh: a scheduled run's own skips. Part of scripts/ci-runner.sh, which sources it for a schedule event only. Not run on its own.
# The nightly must never get in the way of the pushes that matter: it skips itself, with
# a "skipped:" line and no status (neither red nor green), when it was dispatched in the daytime (TALOS_CI_SCHEDULE_QUIET_HOURS,
# "HH:MM-HH:MM" in the machine's local time, default 07:00-22:00, across midnight allowed; off, or anything that is not a window,
# turns the rule off). Main having moved on since the dispatch is no reason to skip: the run tests the sha main had then (said in the log).
# The daytime is judged at the DISPATCH (the run's created_at, or CI_SCHEDULE_DISPATCHED_AT, epoch seconds): a run dispatched at night
# that only gets a runner after 07:00 still runs. A push run never makes it skip: it yields (ci_schedule_yield) to the push run(s)
# already going when it was dispatched, for at most CI_SCHEDULE_YIELD_MAX_S (5400 s), then goes. GitHub unreadable is no reason to
# skip. Two nights skipped in a row are said (ci_schedule_note). A dispatched night run that starts inside the owner's weekday
# 08:00-14:00 window runs with CI_WORKERS capped (ci_day_workers). The nightly and the hostile nightly run at night
# (docs/CI-MACHINES.md). ci_nightly_unreported, last, is the 07:00 check that a dispatched nightly reported a result at all.
ci_hhmm_minutes() { # ci_hhmm_minutes HH:MM: minutes since midnight, nothing for anything else
  case "$1" in [0-2][0-9]:[0-5][0-9]) ;; *) return 1 ;; esac
  printf '%s\n' $((10#${1%:*} * 60 + 10#${1#*:}))
}
ci_in_window() { # ci_in_window <HH:MM-HH:MM> <HH:MM>: 0 when the time is inside the window (across midnight is fine); 1 for anything else
  local a b n
  case "$1" in [0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]) ;; *) return 1 ;; esac
  a="$(ci_hhmm_minutes "${1%-*}")" && b="$(ci_hhmm_minutes "${1#*-}")" && n="$(ci_hhmm_minutes "$2")" || return 1
  if [ "$a" -lt "$b" ]; then [ "$n" -ge "$a" ] && [ "$n" -lt "$b" ]
  elif [ "$a" -gt "$b" ]; then [ "$n" -ge "$a" ] || [ "$n" -lt "$b" ]
  else return 1; fi
}
ci_hhmm_at() { date -d "@$1" +%H:%M 2>/dev/null || date -r "$1" +%H:%M 2>/dev/null; } # ci_hhmm_at <epoch>: its local HH:MM (GNU date, then BSD)
ci_iso_epoch() { # ci_iso_epoch <YYYY-MM-DDTHH:MM:SSZ>: epoch seconds, nothing for anything else
  case "$1" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;; *) return 1 ;; esac
  date -u -d "$1" +%s 2>/dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%SZ' "$1" +%s 2>/dev/null
}
ci_epoch_iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null; } # ci_epoch_iso <epoch>
ci_quiet_hours_at() { # ci_quiet_hours_at [epoch]: 0 when that moment (default: now), in local time, is inside the quiet window
  local hm
  if [ -n "${1:-}" ]; then hm="$(ci_hhmm_at "$1")"; else hm="$(date +%H:%M)"; fi
  ci_in_window "${TALOS_CI_SCHEDULE_QUIET_HOURS-07:00-22:00}" "$hm"
}
ci_quiet_hours_now() { ci_quiet_hours_at; } # 0 when the local time is inside the window
# When this scheduled run was dispatched (epoch): CI_SCHEDULE_DISPATCHED_AT when set, else the run's created_at; nothing (exit 1) when
# neither can be had, and the caller then takes now.
ci_dispatched_at() {
  local v
  case "${CI_SCHEDULE_DISPATCHED_AT:-}" in '' | *[!0-9]*) ;; *) printf '%s\n' "$CI_SCHEDULE_DISPATCHED_AT"; return 0 ;; esac
  [ -n "${GITHUB_RUN_ID:-}" ] && [ -n "${GITHUB_REPOSITORY:-}" ] || return 1
  v="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" --jq .created_at 2>/dev/null)" || return 1
  ci_iso_epoch "$v"
}
ci_schedule_why() { # ci_schedule_why [dispatched-at epoch]: the reason this scheduled run is to do nothing, or nothing
  local at="${1:-}"
  if ci_quiet_hours_at "$at"; then
    echo "it is daytime (${TALOS_CI_SCHEDULE_QUIET_HOURS-07:00-22:00}, local time${at:+; dispatched at $(ci_hhmm_at "$at")}), and a scheduled run waits for the night."
    return 0
  fi
}
# Main's head is judged as of the dispatch: a GitHub dispatch of main runs at the sha main had then, and pushes land every ~20 min overnight,
# so skipping because main moved on meanwhile meant the nightly almost never ran (2026-11-20). The nightly tests that commit, and says so.
ci_schedule_moved_note() { # not the hostile nightly: it runs on whatever main is and never looked
  local head
  [ "${CI_HOSTILE:-}" != 1 ] && head="$(ci_git_net "$ROOT" ls-remote origin refs/heads/main 2>/dev/null | cut -f1)" &&
    [ -n "$head" ] && [ "$head" != "${GITHUB_SHA:-}" ] || return 0
  echo "ci-runner: main has moved on (${GITHUB_SHA:0:7} was main's head when this run was created, ${head:0:7} is now); this run tests ${GITHUB_SHA:0:7}"
}
# A scheduled run never skips for a push run: it yields to the push run(s) that were already GOING when it was dispatched (a run with a job
# that had started by then: not one still queued or pending in main's concurrency group, and not one that came later), then takes the next
# turn. It waits for that run's Lemnos job ("local-ci on ci-runner", as ci_dispatch_wait does), not for the other machines' parts. Those
# queued and later push runs wait for the push run's end in main's concurrency group, which this job (already past plan, polling every
# CI_SCHEDULE_YIELD_POLL_S, 15 s) beats to ci-local's slot. At most CI_SCHEDULE_YIELD_MAX_S (5400 s) of waiting, then it goes anyway; a
# push run GitHub cannot list is not waited for, one it cannot answer a poll about is waited for until the cap. Output is for the log.
ci_schedule_yield() { # ci_schedule_yield [dispatched-at epoch]
  local repo="${GITHUB_REPOSITORY:-}" at="${1:-}" iso ids id n st waiting="" still max poll start
  [ -n "$repo" ] || return 0
  [ -n "$at" ] || at="$(date +%s)"
  iso="$(ci_epoch_iso "$at")" || return 0
  ids="$(gh api "repos/$repo/actions/runs?event=push&status=in_progress&per_page=50" --jq \
    '.workflow_runs[] | select(.path == ".github/workflows/ci-runner.yml") | .id' 2>/dev/null)" || return 0
  for id in $ids; do
    case "$id" in '' | *[!0-9]*) continue ;; esac
    n="$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq \
      "[.jobs[] | select(.started_at != null and .started_at <= \"$iso\")] | length" 2>/dev/null)" || continue
    case "$n" in '' | *[!0-9]* | 0) continue ;; esac
    waiting="$waiting $id"
  done
  waiting="${waiting# }"
  [ -n "$waiting" ] || return 0
  max="${CI_SCHEDULE_YIELD_MAX_S:-5400}" poll="${CI_SCHEDULE_YIELD_POLL_S:-15}" start="$(date +%s)"
  echo "ci-runner: yielding to the push run(s) going when this run was dispatched ($waiting), for at most $max s; then this run goes"
  while :; do
    still=""
    for id in $waiting; do
      st="$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq \
        '[.jobs[] | select(.name == "local-ci on ci-runner") | .status][0] // "gone"' 2>/dev/null)" || st=in_progress # a failed poll: still waiting
      case "$st" in completed | gone) ;; *) still="$still $id" ;; esac # queued, in progress, anything else: not done
    done
    waiting="${still# }"
    if [ -z "$waiting" ]; then echo "ci-runner: the push run(s) it yielded to are done ($(($(date +%s) - start)) s); this run goes next"; return 0; fi
    if [ $(($(date +%s) - start)) -ge "$max" ]; then
      echo "ci-runner: yielded for $max s (CI_SCHEDULE_YIELD_MAX_S) and the push run(s) $waiting still go; this run goes now"
      return 0
    fi
    sleep "$poll"
  done
}
# The owner's CPU rule (docs/CI-MACHINES.md): Monday-Friday 08:00-14:00 local time (TALOS_CI_DAY_WINDOW, off for none) CI runs with
# CI_WORKERS=5 (TALOS_CI_DAY_WORKERS). com.talos.cpu-window writes that into each runner's .env, which a runner reads only when it
# starts, so a night run that gets going after 08:00 inside a runner that was busy at 08:00 would still have the default. This caps it:
# a scheduled run that goes ahead inside the window never runs with more than the cap. Exported, so ci-local.sh gets it.
ci_day_workers() {
  local cap="${TALOS_CI_DAY_WORKERS:-5}" dow
  case "$cap" in '' | *[!0-9]*) return 0 ;; esac
  dow="$(date +%u)"
  case "$dow" in [1-5]) ;; *) return 0 ;; esac
  ci_in_window "${TALOS_CI_DAY_WINDOW-08:00-14:00}" "$(date +%H:%M)" || return 0
  case "${CI_WORKERS:-}" in '' | *[!0-9]*) ;; *) [ "$CI_WORKERS" -gt "$cap" ] || return 0 ;; esac
  export CI_WORKERS="$cap"
  echo "ci-runner: it is inside the owner's weekday window (${TALOS_CI_DAY_WINDOW-08:00-14:00}), so this scheduled run uses CI_WORKERS=$cap"
}
# What each scheduled run did, one row in <cache>/logs/schedule-skips.tsv: epoch, nightly or hostile, ran or skipped, why. A run that
# skips when the same kind's last row is a skip from the last 36 hours has skipped two nights in a row: said in the log, and a message
# for the lead (alerts/, which scripts/ci-alerts.sh watch passes on), since a nightly that never runs is a verification that never happens.
ci_schedule_note() { # ci_schedule_note <kind> <ran|skipped> <why>
  local cache f now prev
  cache="$(ci_cache_dir 2>/dev/null)" || return 0
  f="$cache/logs/schedule-skips.tsv"
  now="$(date +%s)"
  mkdir -p "$cache/logs" 2>/dev/null || return 0
  prev="$(awk -F'\t' -v k="$1" '$2 == k { l = $0 } END { print l }' "$f" 2>/dev/null)"
  printf '%s\t%s\t%s\t%s\n' "$now" "$1" "$2" "$3" >> "$f" 2>/dev/null || return 0
  [ "$2" = skipped ] || return 0
  case "$prev" in *"$(printf '\tskipped\t')"*) ;; *) return 0 ;; esac
  [ $((now - ${prev%%$(printf '\t')*})) -le 129600 ] 2>/dev/null || return 0
  echo "ci-runner: warning: the $1 run has skipped two nights in a row (this time: $3)"
  mkdir -p "$cache/alerts" 2>/dev/null &&
    printf '%s\n' "the $1 run has skipped two nights in a row ($3): main has gone without it; check TALOS_CI_SCHEDULE_QUIET_HOURS, push runs that never end, and the runner" \
      > "$cache/alerts/.$now-sched.part" && mv -f "$cache/alerts/.$now-sched.part" "$cache/alerts/$now-${GITHUB_SHA:0:7}-schedule-skipped.txt"
  return 0
}
# A nightly dispatched by hand (CI_DISPATCH_NIGHTLY=<kind>) leaves <cache>/nightly-dispatch/<kind>-<local date> when it starts; the
# schedule of that kind does nothing on that local day, so a day never has two. Another kind, or another day, does not match.
ci_dispatch_marker() { # ci_dispatch_marker <kind>: the marker's path
  local cache
  cache="$(ci_cache_dir 2>/dev/null)" || return 1
  printf '%s\n' "$cache/nightly-dispatch/$1-$(date +%F)"
}
# One decision per workflow run, kept in <cache>/schedule-decisions/<run id>-<attempt>: the run step and the fallback step both ask, and
# a run that yielded for an hour must not be judged again by a main that moved on (its sha, the daytime) after it said "ran".
ci_schedule_decision_file() { # the file's path, nothing without a run id or a cache
  local cache
  [ -n "${GITHUB_RUN_ID:-}" ] && cache="$(ci_cache_dir 2>/dev/null)" || return 1
  printf '%s\n' "$cache/schedule-decisions/$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}"
}
ci_schedule_skip() { # 0 (and says why) when this scheduled run is to do nothing
  local why kind=nightly marker at df="" said
  [ "${GITHUB_EVENT_NAME:-}" = schedule ] || return 1
  [ "${CI_HOSTILE:-}" != 1 ] || kind=hostile
  if df="$(ci_schedule_decision_file)" && said="$(cat "$df" 2>/dev/null)" && [ -n "$said" ]; then
    case "$said" in
      ran) ci_day_workers; return 1 ;;
      skipped:*) echo "ci-runner: skipped: ${said#skipped:} Nothing tested, nothing posted."; return 0 ;;
    esac
  fi
  if [ -z "${CI_DISPATCH_NIGHTLY:-}" ] && marker="$(ci_dispatch_marker "$kind")" && [ -e "$marker" ]; then
    why="a dispatched $kind run already started today ($(date +%F), local date), so this scheduled one is not needed."
    echo "ci-runner: skipped: $why Nothing tested, nothing posted."
    # no note: that night did get its dispatched run, so this is no skipped night for "two nights in a row"
    [ -z "$df" ] || { mkdir -p "${df%/*}" 2>/dev/null && printf 'skipped:%s\n' "$why" > "$df"; } 2>/dev/null
    return 0
  fi
  at="$(ci_dispatched_at)" || at=""
  why="$(ci_schedule_why "$at")"
  if [ -z "$why" ]; then
    ci_schedule_moved_note
    if [ -n "${CI_DISPATCH_NIGHTLY:-}" ] && marker="$(ci_dispatch_marker "$kind")"; then mkdir -p "${marker%/*}" 2>/dev/null && : > "$marker"; fi
    [ "${CI_SCHEDULE_NO_YIELD:-}" = 1 ] || ci_schedule_yield "$at" # only the workflow's yield step waits: a run or fallback step that finds no decision goes on
    ci_schedule_note "$kind" ran ""
    [ -z "$df" ] || { mkdir -p "${df%/*}" 2>/dev/null && printf 'ran\n' > "$df" && find "${df%/*}" -type f -mtime +14 -exec rm -f {} + ; } 2>/dev/null
    ci_day_workers
    return 1
  fi
  echo "ci-runner: skipped: $why Nothing tested, nothing posted."
  ci_schedule_note "$kind" skipped "$why"
  [ -z "$df" ] || { mkdir -p "${df%/*}" 2>/dev/null && printf 'skipped:%s\n' "$why" > "$df"; } 2>/dev/null
  return 0
}

# ---------- the 07:00 check: did tonight's dispatch report anything? ----------
# scripts/ci-nightly.sh logs one line a dispatch that went out (<cache>/logs/ci-nightly.log: "<local date time> <kind>: exit 0: <run url>").
# A run that was dispatched but never reported (it sat queued, died, or skipped itself) leaves nothing else behind until the "skipped two
# nights" message, a night later. From 07:00 (CI_NIGHTLY_DEADLINE) on, for each kind whose dispatch of the night (the 13 hours
# before the deadline) exit-0'd, with no run among them that posted a result, ONE message for the lead: <cache>/alerts/<time>-<kind>-
# unreported.txt (ci-alerts.sh watch passes it on, and runs this every 10 min). A result is a nightly-ci/ (hostile-ci/) status
# in a final state, linked to that run, on its commit. One check per kind and morning: <cache>/nightly-check/<kind>-<date>. A dispatch
# line with no run url cannot be looked up and is left alone. CI_NIGHTLY_CHECK_NOW (epoch) is a test's clock. GitHub unreadable: exit 1.
ci_nightly_unreported() {
  local cache repo now dl from kind day lines at url id ok last="" lastat="" lasturl="" run rows prefix state ctx n err why short
  cache="$(ci_cache_dir 2>/dev/null)" || return 1
  repo="${GITHUB_REPOSITORY:-${CI_REPO:-treynortetik-creator/talos-app}}"
  now="${CI_NIGHTLY_CHECK_NOW:-$(date +%s)}"
  dl="$(perl -MPOSIX -e '($h, $m) = split /:/, shift; @t = localtime shift; print mktime(0, $m, $h, $t[3], $t[4], $t[5])' "${CI_NIGHTLY_DEADLINE:-07:00}" "$now")" || return 0
  [ "$now" -ge "$dl" ] || { echo "ci-runner: nightly-check: before ${CI_NIGHTLY_DEADLINE:-07:00}; nothing to check yet"; return 0; }
  from=$((dl - 13 * 3600)) day="$(date -d "@$dl" +%F 2>/dev/null || date -r "$dl" +%F)"
  err="$cache/.nightly-check-gh.err"
  for kind in nightly hostile; do
    [ ! -e "$cache/nightly-check/$kind-$day" ] || continue
    lines="$(kind="$kind" from="$from" to="$dl" perl -MPOSIX -ne 'if (/^(\d+)-(\d+)-(\d+) (\d+):(\d+):(\d+) (nightly|hostile): exit 0: (\S*)/ && $7 eq $ENV{kind}) {
        $e = mktime($6, $5, $4, $3, $2 - 1, $1 - 1900); print "$e\t$8\n" if $e >= $ENV{from} && $e < $ENV{to} }' < "$cache/logs/ci-nightly.log" 2>/dev/null)"
    [ -n "$lines" ] || continue
    ok="" last=""
    while IFS=$'\t' read -r at url; do
      id="${url##*/actions/runs/}" id="${id%%[!0-9]*}"
      case "$id" in '' | *[!0-9]*) continue ;; esac
      last="$id" lastat="$at" lasturl="$url"
      if run="$(gh api "repos/$repo/actions/runs/$id" --jq '[.head_sha, .status, (.conclusion // "none")] | @tsv' </dev/null 2>"$err")"; then
        rows="$(gh api --paginate "repos/$repo/commits/${run%%$'\t'*}/statuses?per_page=100" --jq '.[] | [.context, .state, (.target_url // "")] | @tsv' </dev/null 2>"$err")" || {
          ci_gh_problem "$cache" nightly-check-read "ci-runner: nightly-check: the statuses of run $id could not be read from $repo ($(tail -1 "$err" 2>/dev/null))" "$(ci_gh_read_after)"
          return 1
        }
      elif grep -q 'HTTP 404' "$err" 2>/dev/null; then run=$'-\tgone\tnone' rows="" # a run that is no longer there reported nothing; the other kind is still checked
      else
        ci_gh_problem "$cache" nightly-check-read "ci-runner: nightly-check: run $id could not be read from $repo ($(tail -1 "$err" 2>/dev/null))" "$(ci_gh_read_after)"
        return 1
      fi
      if [ "$kind" = hostile ]; then prefix=hostile-ci/; else prefix=nightly-ci/; fi
      # Lemnos's own final statuses of this run only: its link ends .../actions/runs/<id>[/attempts/N][#lemnos]. Another machine's part
      # (#titan, #check-titan, #browser-e2e, #hestia) posts under the same prefix even when Lemnos skipped the run.
      n="$(printf '%s\n' "$rows" | awk -F'\t' -v p="$prefix" -v r="/actions/runs/$id" '
        index($1, p) == 1 && $2 != "pending" { i = index($3, r); if (!i) next; c = substr($3, i + length(r), 1)
          if (c != "" && c != "/" && c != "#") next
          h = index($3, "#"); f = h ? substr($3, h + 1) : ""
          if (f == "" || f == "lemnos") n++ }
        END { print n + 0 }')"
      [ "$n" -eq 0 ] || ok=1
    done <<LINES
$lines
LINES
    ci_gh_problem_clear "$cache" nightly-check-read
    mkdir -p "$cache/nightly-check" "$cache/alerts" 2>/dev/null || continue
    if [ -n "$ok" ]; then : > "$cache/nightly-check/$kind-$day"; echo "ci-runner: nightly-check: the $kind run reported"; continue; fi
    [ -n "$last" ] || { echo "ci-runner: nightly-check: the $kind dispatch of the night has no run url in the log; not checked"; continue; }
    IFS=$'\t' read -r _ state ctx <<< "$run" # the last run's own: head, status, conclusion
    # a run still going (a long hostile run, or one that yielded) is looked at again, up to CI_NIGHTLY_GRACE_S (3 h) past the deadline
    if [ "$state" = in_progress ] && [ "$now" -lt $((dl + ${CI_NIGHTLY_GRACE_S:-10800})) ]; then
      echo "ci-runner: nightly-check: the $kind run $last is still going and has posted no final status; looked at again later"
      continue
    fi
    why="$(awk -F'\t' -v k="$kind" -v t="$lastat" '$2 == k && $1 >= t && $3 == "skipped" { w = $4 } END { print w }' "$cache/logs/schedule-skips.tsv" 2>/dev/null)"
    short="$(date -d "@$lastat" '+%F %H:%M' 2>/dev/null || date -r "$lastat" '+%F %H:%M')"
    printf '%s\n' "the $kind run dispatched at $short (run $last, $lasturl) reported no result by ${CI_NIGHTLY_DEADLINE:-07:00}: it is ${state:-unknown}/${ctx:-unknown}, with no final ${prefix}* status${why:+; it skipped itself: $why}" \
      > "$cache/alerts/.$now-$kind-unreported.part" && mv -f "$cache/alerts/.$now-$kind-unreported.part" "$cache/alerts/$now-$kind-unreported.txt"
    : > "$cache/nightly-check/$kind-$day"
    find "$cache/nightly-check" -type f -mtime +14 -exec rm -f {} + 2>/dev/null
    echo "ci-runner: nightly-check: written for the lead: the $kind run $last reported nothing"
  done
  return 0
}
