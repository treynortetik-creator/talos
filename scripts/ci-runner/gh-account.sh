# The GitHub account a CI script reads and writes the repository as, for every script that can run on a person's Mac: the relays
# check, untested and the Linux report (scripts/ci-alerts.sh watch), the lead inbox, gate-push's red check and the nightly dispatch
# (scripts/ci-nightly.sh). On such a Mac gh's ACTIVE account can be another login (the owner switches it to a work account), and a
# call made as that account fails ("HTTP 404: workflow ci-runner.yml not found", 2026-11-19) or reads nothing. So the account is
# chosen by name for each command, never by what is active:
#   - GH_TOKEN as given (the workflow's own token) is used as it is;
#   - in Actions (GITHUB_ACTIONS=true) an empty GH_TOKEN is an error: the job's token went missing, and the runner Mac's own login
#     must not stand in for it;
#   - else the token of the repository owner's account (CI_GH_USER names another), from `gh auth token --hostname github.com --user`;
#     no login for it is an error that names the account and the fix.
# The repository is GITHUB_REPOSITORY, else CI_REPO, else this checkout's github.com origin (no GitHub call), else the caller's default.
# Sourced; no state of its own. docs/CI-MACHINES.md, "The GitHub account".
# shellcheck shell=bash

# ci_gh_origin_repo <dir>: owner/name of <dir>'s origin when it is on github.com, else nothing. https, ssh://, scp-style user@host:owner/name,
# and an ssh host alias (host github-personal, a Mac with two logins) whose `ssh -G` hostname is github.com. No GitHub call.
ci_gh_origin_repo() {
  local u host
  u="$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$1" remote get-url origin 2>/dev/null)" || return 0
  case "$u" in
    https://github.com/*) u="${u#https://github.com/}" ;;
    ssh://git@github[.]com/*) u="${u#ssh://git@github[.]com/}" ;; # [.]: a literal dot, written so it does not read as an address
    *://*) return 0 ;;
    *@*:*)
      host="${u#*@}" host="${host%%:*}"
      [ "$host" = github.com ] || [ "$(ssh -G -- "$host" 2>/dev/null </dev/null | awk '$1 == "hostname" { print $2; exit }')" = github.com ] || return 0
      u="${u#*:}" ;;
    *) return 0 ;;
  esac
  u="${u%/}" u="${u%.git}"
  case "$u" in */*/* | /* | */ | '' | *[!A-Za-z0-9._/_-]*) return 0 ;; */*) printf '%s' "$u" ;; esac
}

# ci_gh_repo <dir> [default]: GITHUB_REPOSITORY, else CI_REPO, else <dir>'s github.com origin, else <default> (may be empty)
ci_gh_repo() {
  local r="${GITHUB_REPOSITORY:-${CI_REPO:-}}"
  [ -n "$r" ] || r="$(ci_gh_origin_repo "$1")"
  printf '%s' "${r:-${2:-}}"
}

# ci_gh_token <repo>: prints the token every gh call for <repo> runs with (see the top). On failure: one line on stderr saying why and
# what to do, exit 1, nothing on stdout. The token itself is never printed anywhere else.
ci_gh_token() {
  local repo="$1" acct help tok err="" errf
  if [ -n "${GH_TOKEN:-}" ]; then
    printf '%s' "$GH_TOKEN"
    return 0
  fi
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "GH_TOKEN is empty in this Actions job: the job's read-only token is missing (the workflow's env line), and the runner's own gh login is not used in its place" >&2
    return 1
  fi
  acct="${CI_GH_USER:-${repo%%/*}}"
  [ -n "$acct" ] || { echo "no repository is known, so no account to read it as: set CI_REPO=<owner>/<name> (or CI_GH_USER)" >&2; return 1; }
  # the whole help read first: a grep -q that stops at the match closes the pipe on gh, and under pipefail its SIGPIPE read as "too old"
  help="$(gh auth token --help </dev/null 2>/dev/null)" || help=""
  case "$help" in
    *--user*) ;;
    *) echo "this gh has no \`gh auth token --user\` (gh 2.40 or newer has it), so the account cannot be chosen by name: update gh, or set GH_TOKEN" >&2; return 1 ;;
  esac
  errf="$(mktemp "${TMPDIR:-/tmp}/ci-gh-account.XXXXXX")" || errf=/dev/null
  tok="$(gh auth token --hostname github.com --user "$acct" </dev/null 2>"$errf")" || tok=""
  [ "$errf" = /dev/null ] || { err="$(tail -1 "$errf" 2>/dev/null)"; rm -f "$errf"; }
  if [ -z "$tok" ]; then
    echo "gh on this machine has no login for $acct, the account this check reads $repo as (gh's active account is never used): set CI_GH_USER to an account that can read $repo, or run gh auth login and sign in as $acct, or set GH_TOKEN${err:+ ($err)}" >&2
    return 1
  fi
  printf '%s' "$tok"
}

# ci_gh_problem <cache> <key> <message> [after_s]: one alert file for the lead (alerts/, which ci-alerts.sh watch passes on) per key until
# ci_gh_problem_clear <cache> <key>: the first message of a problem is said, a later different one for the same key is not (an outage
# that alternates 502 and 503, or a new commit's sha in the text, is one problem). after_s (default 0): said only once the key has
# been failing that long, so one blip (a Mac waking before its Wi-Fi) is not an alert; a read failure passes
# CI_GH_READ_ALERT_AFTER_S (1200 s: two of the watcher's 10-minute checks). Always on stderr, as an ::error:: line.
ci_gh_problem() {
  local cache="$1" key="$2" msg="$3" after="${4:-0}" now said since
  now=$(date +%s) said="$cache/alerts/said/gh-$key"
  echo "::error::$msg" >&2
  [ ! -e "$said" ] || return 0
  mkdir -p "$cache/alerts/said" 2>/dev/null
  since="$(cat "$said.since" 2>/dev/null)"
  # a first failure older than three waits is from before a gap (a Mac asleep since): this failure starts the wait again
  case "$since" in '' | *[!0-9]*) since="" ;; esac
  if [ -z "$since" ] || { [ "$after" -gt 0 ] && [ $((now - since)) -gt $((3 * after)) ]; }; then
    since=$now
    printf '%s\n' "$now" > "$said.since" 2>/dev/null
  fi
  [ $((now - since)) -ge "$after" ] || return 0
  { printf '%s\n' "$msg" > "$cache/alerts/.$now-$$-gh-$key.part" &&
      mv -f "$cache/alerts/.$now-$$-gh-$key.part" "$cache/alerts/$now-$$-gh-$key.txt" &&
      printf '%s\n' "$msg" > "$said"; } 2>/dev/null ||
    echo "::error::the alert for $key could not be written to $cache/alerts" >&2
}
ci_gh_problem_clear() { rm -f "$1/alerts/said/gh-$2" "$1/alerts/said/gh-$2.since"; }
# the wait before a failed read is an alert (ci_gh_problem's after_s)
ci_gh_read_after() { printf '%s' "${CI_GH_READ_ALERT_AFTER_S:-1200}"; }
