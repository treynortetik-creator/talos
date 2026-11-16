#!/usr/bin/env bash
# ci-affected.sh: which of the six CI jobs can a change affect? scripts/ci-local.sh asks and skips the rest (docs/CI-LOCAL.md,
# "Running only what a change can affect").
#   ci-affected.sh jobs <base> <head>   the jobs the difference between the two commits can affect, on one line, in the order
#                                       check mod browser image desktop mobile. Exit 2 (nothing printed): git could not say.
#   ci-affected.sh plan <repo> <head>   each job is compared with the last commit before <head> where THAT job passed, read
#                                       from GitHub's statuses with gh. Line 1 is the jobs to run, line 2 says why, line 3 is
#                                       "kit-tests: skip" when check has a base and `kit` says skip, else "kit-tests: run", then
#                                       "skip <job> <sha>" per skipped job. It never fails: GitHub unreadable or anything
#                                       unexpected prints all six jobs. A skip needs proof; "unsure" is "run".
#                                       CI_ATTEMPT_URL: this workflow attempt's link; its own statuses are not a rerun.
#   ci-affected.sh kit <base> <head>    do the install and kit tests (root-install*.test.ts, kit-tests.test.ts) need to run?
#                                       Exit 0 run, 1 skip (nothing they run changed), 2 git could not say.
# The rules: apps/web, apps/bridge, apps/relay, docs and CHANGELOG.md touch the browser job; apps/mobile touches the mobile job;
# desktop is whatever scripts/ci-desktop-gate.sh says (its path list is the one list of desktop paths); anything else (the
# protocol, testkit, scripts, the lockfile, root config, a path nobody listed) is all six. check, mod and image always run:
# they are short and nothing here is sure enough to drop them. --no-renames, so a rename counts both the old path and the new.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALL="check mod browser image desktop mobile"

affected_jobs() { # affected_jobs <base> <head>
  local list f web=0 mobile=0 other=0 rc j out="" want=" check mod image "
  case "$1" in '' | -*) return 2 ;; esac
  # A file, not a pipe: NUL-separated names are read whole (spaces, newlines, quotes) and a failing git is seen.
  list="$(mktemp)" || return 2
  if ! git diff --name-only -z --no-renames "$1" "$2" -- > "$list" 2>/dev/null; then rm -f "$list"; return 2; fi
  while IFS= read -r -d '' f; do
    case "$f" in
      apps/web/* | apps/bridge/* | apps/relay/* | docs/* | CHANGELOG.md) web=1 ;;
      apps/desktop/*) ;; # asked of the desktop gate below
      apps/mobile/*) mobile=1 ;;
      *) other=1 ;;
    esac
  done < "$list"
  rm -f "$list"
  [ "$other" = 0 ] || { echo "$ALL"; return 0; }
  bash "$HERE/ci-desktop-gate.sh" "$1" "$2"
  rc=$?
  [ "$web" = 0 ] || want="${want}browser "
  [ "$rc" = 1 ] || want="${want}desktop " # 1 is the gate's one "skip"; 0 (differs) and 2 (error) both run it
  [ "$mobile" = 0 ] || want="${want}mobile "
  for j in $ALL; do case "$want" in *" $j "*) out="${out:+$out }$j" ;; esac; done
  echo "$out"
}

# The install and kit tests are about three quarters of the vitest step. They run install.sh, kit/, the plugin, the bridge CLI and
# the packages it imports, with the lockfile and root config, so those are their inputs. The paths below cannot reach them;
# anything else (an input, a path nobody listed) runs them.
kit_affected() { # kit_affected <base> <head>
  local list f rc=1
  case "$1" in '' | -*) return 2 ;; esac
  list="$(mktemp)" || return 2
  if ! git diff --name-only -z --no-renames "$1" "$2" -- > "$list" 2>/dev/null; then rm -f "$list"; return 2; fi
  while IFS= read -r -d '' f; do
    case "$f" in
      scripts/root-install*.ts | scripts/v1-agent-fixture.sh | scripts/kit-tests.test.ts | scripts/kit-run.ts | scripts/size-report.ts) rc=0 ;;
      apps/web/* | apps/relay/* | apps/mobile/* | apps/desktop/* | docs/* | CHANGELOG.md | scripts/*) ;;
      *) rc=0 ;;
    esac
  done < "$list"
  rm -f "$list"
  return $rc
}

status_rows() { # status_rows <repo> <sha>: the commit's statuses as context, state and description, newest first
  # per_page=100 (GitHub's default is 30 contexts, which could hide local-ci), and --paginate for a commit with more than 100
  gh api --paginate "repos/$1/commits/$2/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' 2>/dev/null
}

# earlier_rows <repo> <sha>: the commit's local-ci/, ci-part/ and report-ci/ statuses that an earlier run posted, as context,
# state and link, one per line (nothing: none). This workflow attempt's own are left out: CI_ATTEMPT_URL ("<run>/attempts/<n>#")
# starts the link of every status this attempt posts, and another machine of the attempt may post before this plan is made
# (docs/CI-MACHINES.md, "The rerun rule and this attempt"). The "#" is part of the match, so attempts/2# never takes attempts/20#;
# a run link with no attempt (every switch off) is never this attempt's. The full list, not the combined status: the combined
# one keeps only the newest per context, so a status of this attempt could hide an earlier run's of the same context.
earlier_rows() {
  local all a="${CI_ATTEMPT_URL:-}"
  case "$a" in *'#') ;; *) a="" ;; esac # without its "#", attempts/2 would also take attempts/20: then every status counts
  all="$(gh api --paginate "repos/$1/commits/$2/statuses?per_page=100" \
    --jq '.[] | [.context, .state, (.target_url // "")] | @tsv' 2>/dev/null)" || return 1
  printf '%s\n' "$all" | awk -F'\t' -v a="$a" '
    $1 ~ /^(local-ci|ci-part|report-ci)\// && (a == "" || index($NF, a) != 1) { print $1 "\t" $2 "\t" $NF }'
}

# job_bases <repo> <head>: for each job, the nearest commit before <head> where THAT job passed: prints "base <job> <sha>" for each
# job that has one and "nobase <job> <state> at <sha7>" for one decided otherwise (rc 0), or why no job can have one (rc 1).
# Walks back from the parent of a commit that is on origin/main, or from the merge-base of one that is not (a PR), over the
# first-parent line, at most 30 commits. Per job, the nearest commit with a result for it decides: a final pass ("passed on ...",
# "passed on retry" included: the verdict counts it green) is that job's base; pending, failure, error or any other state means
# no base, so the job runs (a skip never hides that job's own red or a result not in yet). A commit where the job has no status,
# or was skipped, is walked past, and what it changed counts, because the diff is taken to the base. Main's overall colour does
# not matter: another job's red says nothing about this job's inputs. A <head> that already has a status of an earlier run
# (earlier_rows: local-ci/, ci-part/ or report-ci/, not this attempt's own) is a rerun: no base for any job, because a rerun must
# not turn the failure it repeats green. A status read that fails: no base at all.
job_bases() {
  local head mb start c rows j line st desc left rc out="" t=$'\t'
  [ -n "$1" ] || { echo "no repository to read statuses from"; return 1; }
  command -v gh >/dev/null 2>&1 || { echo "gh is not installed"; return 1; }
  head="$(git rev-parse --verify -q "$2^{commit}")" || { echo "unknown commit $2"; return 1; }
  rows="$(earlier_rows "$1" "$head")" || { echo "could not read the statuses of ${head:0:7}"; return 1; }
  [ -z "$rows" ] || { echo "${head:0:7} already has statuses of an earlier run, so this is a rerun"; return 1; }
  mb="$(git merge-base origin/main "$head" 2>/dev/null)" || { echo "no merge-base with origin/main"; return 1; }
  if [ "$mb" = "$head" ]; then
    start="$(git rev-parse --verify -q "$head^")" || { echo "${head:0:7} has no parent to compare with"; return 1; }
  else
    start="$mb"
  fi
  left=" $ALL "
  for c in $(git rev-list --first-parent -n 30 "$start" 2>/dev/null); do
    rows="$(status_rows "$1" "$c")" || { echo "could not read the statuses of ${c:0:7}"; return 1; }
    for j in $left; do
      # A here-string, not a pipe: under pipefail an early-exiting grep -m1 on a long list fails the writer with SIGPIPE, and
      # a found failure row would read as "no status".
      line="$(grep -m1 "^local-ci/$j$t" <<< "$rows")"
      rc=$?
      [ "$rc" != 1 ] || continue # no status for this job here: walk on
      st="${line#*$t}" desc="${st#*$t}" st="${st%%$t*}"
      if [ "$rc" != 0 ]; then st="unreadable" desc=""; fi
      case "$st:$desc" in
        "success:passed on "*) out="${out}base $j $c"$'\n' ;;
        success:*) continue ;; # skipped there, so not tested there: walk on
        *) out="${out}nobase $j $st at ${c:0:7}"$'\n' ;; # pending, failure, error: decided, no base
      esac
      left="${left/ $j / }"
    done
    [ -n "${left// /}" ] || break
  done
  printf '%s' "$out"
}

# plan <repo> <head>: line 1 the jobs to run, line 2 why, line 3 "kit-tests: skip|run", then "skip <job> <sha>" for each job
# that skips, with the commit where it last passed, then "base <job> <sha>" for every job that has a base. A job runs unless it has a base and affected_jobs (the one list of which paths
# reach which job) says the diff from that base cannot reach it. check, mod and image are reached by every diff, so they always
# run. The install and kit tests (inside check) are compared with check's own base.
plan() {
  local bases j b jobs run="" skips="" kit=run why="" lastb="" lastjobs="" bases_out=""
  if ! bases="$(job_bases "$1" "$2")"; then
    printf '%s\n%s; running every job\nkit-tests: run\n' "$ALL" "$bases"
    return 0
  fi
  for j in $ALL; do
    b="$(printf '%s\n' "$bases" | awk -v j="$j" '$1 == "base" && $2 == j { print $3 }')"
    if [ -z "$b" ]; then
      run="$run $j"
      why="$why $j: $(printf '%s\n' "$bases" | awk -v j="$j" '$1 == "nobase" && $2 == j { $1 = ""; $2 = ""; sub(/^  /, ""); print }'),"
      case "$why" in *" $j: ,") why="${why%: ,}: no pass found (30 commits at most)," ;; esac
      continue
    fi
    if [ "$b" != "$lastb" ]; then
      lastb="$b"
      lastjobs="$(affected_jobs "$b" "$2")" || lastjobs=""
    fi
    why="$why $j: ${b:0:7},"
    bases_out="${bases_out}base $j $b"$'\n'
    case " ${lastjobs:-$ALL} " in
      *" $j "*) run="$run $j" ;;
      *) skips="${skips}skip $j $b"$'\n' ;;
    esac
  done
  b="$(printf '%s\n' "$bases" | awk '$1 == "base" && $2 == "check" { print $3 }')"
  if [ -n "$b" ]; then
    kit_affected "$b" "$2"
    [ $? != 1 ] || kit=skip
  fi
  why="${why%,}"
  printf '%s\neach job is compared with the last commit where it passed:%s\nkit-tests: %s\n%s%s' "${run# }" "$why" "$kit" "$skips" "$bases_out"
}

case "${1:-}" in
  jobs) affected_jobs "${2:-}" "${3:-HEAD}" ;;
  plan) plan "${2:-}" "${3:-HEAD}" ;;
  kit) kit_affected "${2:-}" "${3:-HEAD}" ;;
  *) sed -n '2,13p' "$0"; exit 64 ;;
esac
