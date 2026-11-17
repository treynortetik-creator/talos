# scripts/ci-runner/schedule.sh: a scheduled run's own skips. Part of scripts/ci-runner.sh, which sources it for a schedule event only. Not run on its own.
# The nightly must never get in the way of the pushes that matter, nor test a commit that is no longer main's: it skips itself, with
# a "skipped:" line and no status (neither red nor green), when it is daytime (TALOS_CI_SCHEDULE_QUIET_HOURS, "HH:MM-HH:MM" in the
# machine's local time, default 07:00-22:00, across midnight allowed; off, or anything that is not a window, turns the rule off), when
# its sha is not main's head (not for the hostile nightly, CI_HOSTILE=1: it runs on whatever main is), or when a push run of this workflow is
# queued or in progress. GitHub unreadable is no reason to skip. Two nights skipped in a row are said (ci_schedule_note).
# The nightly and the hostile nightly run at night (docs/CI-MACHINES.md), so neither is touched in practice.
ci_hhmm_minutes() { # ci_hhmm_minutes HH:MM: minutes since midnight, nothing for anything else
  case "$1" in [0-2][0-9]:[0-5][0-9]) ;; *) return 1 ;; esac
  printf '%s\n' $((10#${1%:*} * 60 + 10#${1#*:}))
}
ci_quiet_hours_now() { # 0 when the local time is inside the window
  local w="${TALOS_CI_SCHEDULE_QUIET_HOURS-07:00-22:00}" a b n
  case "$w" in [0-2][0-9]:[0-5][0-9]-[0-2][0-9]:[0-5][0-9]) ;; *) return 1 ;; esac
  a="$(ci_hhmm_minutes "${w%-*}")" && b="$(ci_hhmm_minutes "${w#*-}")" && n="$(ci_hhmm_minutes "$(date +%H:%M)")" || return 1
  if [ "$a" -lt "$b" ]; then [ "$n" -ge "$a" ] && [ "$n" -lt "$b" ]
  elif [ "$a" -gt "$b" ]; then [ "$n" -ge "$a" ] || [ "$n" -lt "$b" ]
  else return 1; fi
}
ci_schedule_why() { # the reason this scheduled run is to do nothing, or nothing
  local head runs
  if ci_quiet_hours_now; then
    echo "it is daytime (${TALOS_CI_SCHEDULE_QUIET_HOURS-07:00-22:00}, local time), and a scheduled run waits for the night."
    return 0
  fi
  # The hostile nightly runs on whatever main is by then: it hunts what time and load do, not main's verdict, so a sha that is no
  # longer main's head is no reason for it to skip. The nightly's is the verdict of main's head.
  if [ "${CI_HOSTILE:-}" != 1 ] && head="$(ci_git_net "$ROOT" ls-remote origin refs/heads/main 2>/dev/null | cut -f1)" &&
    [ -n "$head" ] && [ "$head" != "${GITHUB_SHA:-}" ]; then
    echo "this scheduled run's commit ${GITHUB_SHA:0:7} is not main's head (${head:0:7}), so it would test a commit that is no longer main's."
    return 0
  fi
  runs="$(gh api "repos/${GITHUB_REPOSITORY:-}/actions/runs?event=push&per_page=50" --jq \
    '[.workflow_runs[] | select(.path == ".github/workflows/ci-runner.yml" and (.status == "queued" or .status == "in_progress" or .status == "waiting" or .status == "pending" or .status == "requested"))] | length' 2>/dev/null)"
  case "$runs" in '' | *[!0-9]* | 0) return 0 ;; esac
  echo "a push run is queued or in progress ($runs), and a scheduled run does not get in its way."
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
ci_schedule_skip() { # 0 (and says why) when this scheduled run is to do nothing
  local why kind=nightly
  [ "${GITHUB_EVENT_NAME:-}" = schedule ] || return 1
  [ "${CI_HOSTILE:-}" != 1 ] || kind=hostile
  why="$(ci_schedule_why)"
  if [ -z "$why" ]; then ci_schedule_note "$kind" ran ""; return 1; fi
  echo "ci-runner: skipped: $why Nothing tested, nothing posted."
  ci_schedule_note "$kind" skipped "$why"
  return 0
}
