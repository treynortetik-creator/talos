#!/usr/bin/env bash
# ci-affected.sh: which of the six CI jobs can a change affect? scripts/ci-local.sh asks and skips the rest (docs/CI-LOCAL.md,
# "Running only what a change can affect").
#   ci-affected.sh jobs <base> <head>   the jobs the difference between the two commits can affect, on one line, in the order
#                                       check mod browser image desktop mobile. Exit 2 (nothing printed): git could not say.
#   ci-affected.sh plan <repo> <head>   the base is the last GREEN commit before <head>, read from GitHub's statuses with gh.
#                                       Line 1 is the jobs, line 2 says why. It never fails: no green base, GitHub unreadable
#                                       or anything unexpected prints all six jobs. A skip needs proof; "unsure" is "run".
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

status_rows() { # status_rows <repo> <sha>: the commit's statuses as context, state and description, newest first
  # per_page=100 (GitHub's default is 30 contexts, which could hide local-ci), and --paginate for a commit with more than 100
  gh api --paginate "repos/$1/commits/$2/status?per_page=100" --jq '.statuses[] | [.context, .state, .description] | @tsv' 2>/dev/null
}

# green_base <repo> <head>: prints the last green commit before <head> (rc 0), or why there is none (rc 1).
# Walks back from the parent of a commit that is on origin/main, or from the merge-base of one that is not (a PR), over the
# first-parent line, skipping commits that were never tested (the inner commits of a push get no status). The NEAREST tested
# commit decides: green is the base; red, pending, partly reported, errored or skipped any other way is no base, so a skip
# can never hide an earlier red. Bounded: 30 commits, then no base. A <head> that already has a local-ci status is a rerun
# and has no base: a skip is proved against an earlier commit, and a rerun must not turn the failure it repeats green.
green_base() {
  local head mb start c rows line cls
  [ -n "$1" ] || { echo "no repository to read statuses from"; return 1; }
  command -v gh >/dev/null 2>&1 || { echo "gh is not installed"; return 1; }
  [ -f "$HERE/ci-runner.sh" ] || { echo "ci-runner.sh (the status reader) is missing"; return 1; }
  # shellcheck source=ci-runner.sh
  . "$HERE/ci-runner.sh" # only its functions: ci_classify, the one reading of what a green commit is
  head="$(git rev-parse --verify -q "$2^{commit}")" || { echo "unknown commit $2"; return 1; }
  rows="$(status_rows "$1" "$head")" || { echo "could not read the statuses of ${head:0:7}"; return 1; }
  line="$(printf '%s\n' "$rows" | ci_classify)"
  [ "${line%%$'\t'*}" = none ] || { echo "${head:0:7} already has local-ci statuses, so this is a rerun"; return 1; }
  mb="$(git merge-base origin/main "$head" 2>/dev/null)" || { echo "no merge-base with origin/main"; return 1; }
  if [ "$mb" = "$head" ]; then
    start="$(git rev-parse --verify -q "$head^")" || { echo "${head:0:7} has no parent to compare with"; return 1; }
  else
    start="$mb"
  fi
  for c in $(git rev-list --first-parent -n 30 "$start" 2>/dev/null); do
    if ! rows="$(status_rows "$1" "$c")"; then
      echo "could not read the statuses of ${c:0:7}"
      return 1
    fi
    line="$(printf '%s\n' "$rows" | ci_classify)"
    cls="${line%%$'\t'*}"
    case "$cls" in
      none) ;;
      green) echo "$c"; return 0 ;;
      *) echo "the nearest tested commit ${c:0:7} is not green ($cls: ${line#*$'\t'})"; return 1 ;;
    esac
  done
  echo "no tested commit within 30 before ${start:0:7}"
  return 1
}

plan() { # plan <repo> <head>
  local base jobs
  if base="$(green_base "$1" "$2")"; then
    if jobs="$(affected_jobs "$base" "$2")" && [ -n "$jobs" ]; then
      printf '%s\nthe change is compared with %s, the last green commit\n' "$jobs" "${base:0:7}"
      return 0
    fi
    base="could not diff against the green commit ${base:0:7}"
  fi
  printf '%s\n%s; running every job\n' "$ALL" "$base"
}

case "${1:-}" in
  jobs) affected_jobs "${2:-}" "${3:-HEAD}" ;;
  plan) plan "${2:-}" "${3:-HEAD}" ;;
  *) sed -n '2,8p' "$0"; exit 64 ;;
esac
