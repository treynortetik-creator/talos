# ci-runner.sh's relays step (sourced by it for `relays`, after green.sh). docs/CI-MACHINES.md, "The green branch"; docs/deploy-railway.md.
# shellcheck shell=bash
# ---------- relays: a relay that must run only six-green commits is running one that is not ----------
# The relay list names each relay's GitHub deployment environment and what it tracks, `green` or `main`: lines of
# "<environment><TAB><green|main>". It is NOT in the repository (the environment names are the owner's): the workflow passes the repository
# variable CI_RELAY_DEPLOYS as the environment variable of that name, and a person's machine (the lead's watcher) reads
# ~/.config/talos-ci/relay-deploys.txt (CI_RELAY_DEPLOYS_FILE moves it). A literal \t or \n in the variable is read as a tab or a newline, since
# a one-line variable cannot hold them; scripts/relay-deploys.example.txt shows the format. The hand-deploy list (CI_RELAY_HAND_DEPLOYS, or
# ~/.config/talos-ci/relay-hand-deploys.txt, which may be absent) is "<full sha><TAB><environment><TAB><YYYY-MM-DD><TAB><reason>" lines.
# A missing or empty relay list is an error and an alert, never "nothing to check".
# What is RUNNING: the newest deployment of the environment (gh api repos/<repo>/deployments?environment=<env>, newest first, at most
# CI_RELAYS_SCAN = 20) whose newest status is `success`; one in progress, queued, failed, errored or inactive is not running. Its commit is OK for a
# `green` relay only when
#   - its own six local-ci/* statuses read green: ci_classify over the TRUSTED statuses, ci_green_trusted, the very functions the green
#     step uses (pending, partial, red, none or untrusted statuses are never ok); or
#   - the pair (commit, environment) is in the hand-deploy list: an approved emergency deploy, said as allowlisted.
# Anything else is an ALERT. A `main` relay is only reported (one info line, with what its statuses read). Every listed environment that has no
# deployment at all is an error; every environment in the repository's newest 100 deployments that is not listed is an error. Every error, warning
# and alert also writes one alert file in ~/.cache/talos-ci/alerts/, once per environment and kind until the next ok (relays-said/), so a lost
# deployments: read or a signed-out gh is never silent. One line per environment in ~/.cache/talos-ci/logs/relays.tsv (UTC time, environment,
# commit or -, the statuses' verdict or -, result). Exit 1 on any error or alert. Run by the workflow's `relays` job after the green job and every
# 10 minutes by scripts/ci-alerts.sh watch. It decides nothing about main and moves nothing.
CI_RELAYS_LIST_LABEL="the relay list"
CI_RELAYS_HAND_LABEL="the hand-deploy list"

ci_relays_slug() { printf '%s' "$1" | tr -c 'A-Za-z0-9' '_'; }
ci_relays_trust_fail() { why="$1"; }

# ci_relays_row <env> <sha|-> <verdict|-> <result>: the tsv line. A line that cannot be written is an error.
ci_relays_row() {
  { mkdir -p "$cache/logs" && printf '%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >> "$cache/logs/relays.tsv"; } ||
    { echo "::error::ci-runner: relays: $cache/logs/relays.tsv could not be written"; rc=1; }
}

# ci_relays_clear <key>: the next ok for it: every alert kept quiet for it is forgotten, so a later failure is said again
ci_relays_clear() { rm -f "$cache/relays-said/$(ci_relays_slug "$1")".*; }

# ci_relays_notice <key> <kind> <token> <file stem> <body>: one alert file for the lead (the body's first line is what the watcher passes on),
# written as alert.sh writes its own (atomic), once per key and kind until ci_relays_clear; a different token (a new commit) is said again.
ci_relays_notice() {
  local key="$1" kind="$2" token="$3" stem="$4" body="$5" slug now file
  slug="$(ci_relays_slug "$key")" now=$(date +%s)
  if [ "$(cat "$cache/relays-said/$slug.$kind" 2>/dev/null)" = "$token" ]; then
    echo "ci-runner: relays: $key: the $kind alert is already written"
    return 0
  fi
  file="$cache/alerts/$now-$stem.txt"
  [ ! -e "$file" ] || file="$cache/alerts/$now-$stem-$$.txt"
  { mkdir -p "$cache/alerts" "$cache/relays-said" &&
      printf '%s\n' "$body" > "$cache/alerts/.$now-$slug-$kind.part" &&
      mv -f "$cache/alerts/.$now-$slug-$kind.part" "$file" &&
      printf '%s\n' "$token" > "$cache/relays-said/$slug.$kind"; } ||
    { echo "::error::ci-runner: relays: the alert for $key could not be written to $cache/alerts"; rc=1; return 0; }
  echo "ci-runner: relays: alert written for the lead: $(head -1 "$file")"
}

# ci_relays_bad <env> <sha|-> <verdict|-> <level: error|warning> <kind> <token> <stem> <result> <message> [more lines for the alert]
# one problem, said everywhere: the job log, the tsv, an alert file; an error also fails the run
ci_relays_bad() {
  local env="$1" sha="$2" cls="$3" level="$4" kind="$5" token="$6" stem="$7" result="$8" msg="$9" more="${10:-}"
  echo "::$level::ci-runner: relays: $msg"
  ci_relays_row "$env" "$sha" "$cls" "$result"
  ci_relays_notice "$env" "$kind" "$token" "$stem" "RELAYS CHECK, $kind: $msg${more:+$'\n'$more}"
  [ "$level" != error ] || rc=1
}

# ci_relays_perr <message>: a problem with the lists themselves (before any environment is known)
ci_relays_perr() { echo "::error::ci-runner: relays: $1"; perrs="$perrs$1"$'\n'; }

# ci_relays_norm <text>: a literal \t and \n (a one-line variable) are a tab and a newline; a CR is dropped
ci_relays_norm() {
  local v="$1"
  v="${v//$'\r'/}"
  v="${v//\\t/$'\t'}"
  v="${v//\\n/$'\n'}"
  printf '%s' "$v"
}

# ci_relays_load: the two lists' text into $listtext and $handtext. The relay list is required (variable, else the file under ~/.config);
# the hand-deploy list may be absent.
ci_relays_load() {
  local f
  listtext="" handtext=""
  if [ -n "${CI_RELAY_DEPLOYS:-}" ]; then
    listtext="$CI_RELAY_DEPLOYS"
  else
    f="${CI_RELAY_DEPLOYS_FILE:-$HOME/.config/talos-ci/relay-deploys.txt}"
    [ -f "$f" ] || { ci_relays_perr "no relay list: CI_RELAY_DEPLOYS is empty and $f does not exist, so no relay would be checked"; return 1; }
    listtext="$(cat "$f")" || { ci_relays_perr "$f cannot be read"; return 1; }
  fi
  if [ -n "${CI_RELAY_HAND_DEPLOYS:-}" ]; then
    handtext="$CI_RELAY_HAND_DEPLOYS"
  else
    f="${CI_RELAY_HAND_DEPLOYS_FILE:-$HOME/.config/talos-ci/relay-hand-deploys.txt}"
    if [ -f "$f" ]; then handtext="$(cat "$f")" || { ci_relays_perr "$f cannot be read"; return 1; }; fi
  fi
  listtext="$(ci_relays_norm "$listtext")" handtext="$(ci_relays_norm "$handtext")"
}

# ci_relays_parse: $listtext into $envs ("env<TAB>mode" lines) and $handtext into $allowed ("sha<TAB>env<TAB>date<TAB>reason" lines).
# Every bad line is named (which list, line number, why); returns 1 if any, or if no relay is listed.
ci_relays_parse() {
  local line n=0 bad=0 name mode sha env date reason rest rest2 f="$CI_RELAYS_LIST_LABEL"
  envs="" allowed=""
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [ -n "${line//[[:space:]]/}" ] || continue
    case "$line" in '#'*) continue ;; esac
    case "$line" in
      *$'\t'*$'\t'*) ci_relays_perr "$f line $n: more than two tab-separated fields"; bad=1; continue ;;
      *$'\t'*) ;;
      *) ci_relays_perr "$f line $n: not '<environment><TAB><green|main>'"; bad=1; continue ;;
    esac
    name="${line%%$'\t'*}" mode="${line#*$'\t'}"
    [ -n "${name//[[:space:]]/}" ] || { ci_relays_perr "$f line $n: no environment"; bad=1; continue; }
    case "$mode" in green | main) ;; *) ci_relays_perr "$f line $n: the mode is '$mode', not green or main"; bad=1; continue ;; esac
    if printf '%s' "$envs" | CI_E="$name" awk -F'\t' '$1 == ENVIRON["CI_E"] { f = 1 } END { exit !f }'; then
      ci_relays_perr "$f line $n: '$name' is listed twice"; bad=1; continue
    fi
    envs="$envs$name"$'\t'"$mode"$'\n'
  done <<< "$listtext"
  [ -n "$envs" ] || [ "$bad" = 1 ] || { ci_relays_perr "$f lists no relay, so no relay would be checked"; bad=1; }
  n=0 f="$CI_RELAYS_HAND_LABEL"
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    [ -n "${line//[[:space:]]/}" ] || continue
    case "$line" in '#'*) continue ;; esac
    sha="${line%%$'\t'*}" rest="${line#*$'\t'}"
    [ "$rest" != "$line" ] || { ci_relays_perr "$f line $n: not '<sha><TAB><environment><TAB><date><TAB><reason>'"; bad=1; continue; }
    env="${rest%%$'\t'*}" rest2="${rest#*$'\t'}"
    [ "$rest2" != "$rest" ] || { ci_relays_perr "$f line $n: not '<sha><TAB><environment><TAB><date><TAB><reason>'"; bad=1; continue; }
    date="${rest2%%$'\t'*}" reason="${rest2#*$'\t'}"
    [ "$reason" != "$rest2" ] || { ci_relays_perr "$f line $n: no reason (four tab-separated fields)"; bad=1; continue; }
    case "$sha" in *[!0-9a-f]*) ci_relays_perr "$f line $n: '$sha' is not a full lower-case 40-hex commit"; bad=1; continue ;; esac
    [ "${#sha}" = 40 ] || { ci_relays_perr "$f line $n: '$sha' is not a full lower-case 40-hex commit"; bad=1; continue; }
    [ -n "${env//[[:space:]]/}" ] || { ci_relays_perr "$f line $n: no environment"; bad=1; continue; }
    case "$date" in [0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]) ;; *) ci_relays_perr "$f line $n: '$date' is not a YYYY-MM-DD date"; bad=1; continue ;; esac
    case "${date:5:2}${date:8:2}" in 00?? | 13?? | 14?? | 15?? | 16?? | 17?? | 18?? | 19?? | ??00 | ??3[2-9]) ci_relays_perr "$f line $n: '$date' is not a date"; bad=1; continue ;; esac
    [ -n "${reason//[[:space:]]/}" ] || { ci_relays_perr "$f line $n: the reason is empty"; bad=1; continue; }
    allowed="$allowed$sha"$'\t'"$env"$'\t'"$date"$'\t'"$reason"$'\n'
  done <<< "$handtext"
  return "$bad"
}

# ci_relays_running <env>: the commit the environment runs, into $run_id and $run_sha. 0 found, 1 deployments but no successful one in the
# window, 2 unreadable (the reason in $why), 3 no deployment at all.
ci_relays_running() {
  local env="$1" rows id sha st
  run_id="" run_sha="" why=""
  if ! rows="$(gh api -X GET "repos/$repo/deployments" -f "environment=$env" -f "per_page=$scan" --jq '.[] | [.id, .sha] | @tsv' </dev/null 2>"$cache/.relays-gh.err")"; then
    why="the deployments could not be read ($(tail -1 "$cache/.relays-gh.err" 2>/dev/null))"; return 2
  fi
  [ -n "$rows" ] || return 3
  while IFS=$'\t' read -r id sha; do
    [ -n "$id" ] || continue
    case "$id" in *[!0-9]*) why="a deployment id '$id' is not a number"; return 2 ;; esac
    # the newest status of the deployment (the list is newest first); none yet is "", which is not a success
    if ! st="$(gh api -X GET "repos/$repo/deployments/$id/statuses" -f per_page=1 --jq '.[0].state // ""' </dev/null 2>"$cache/.relays-gh.err")"; then
      why="the status of deployment $id could not be read ($(tail -1 "$cache/.relays-gh.err" 2>/dev/null))"; return 2
    fi
    [ "$st" = success ] || continue
    case "$sha" in *[!0-9a-f]* | '') why="deployment $id has the commit '$sha', not a full 40-hex sha"; return 2 ;; esac
    [ "${#sha}" = 40 ] || { why="deployment $id has the commit '$sha', not a full 40-hex sha"; return 2; }
    run_id="$id" run_sha="$sha"
    return 0
  done <<< "$rows"
  return 1
}

# ci_relays_verdict <sha>: the commit's own six read as green.sh reads them: the list endpoint, only the TRUSTED local-ci/* statuses
# (ci_green_trusted, green.sh), then ci_classify. Into $cls and $cdet; 2 (reason in $why) when they cannot be read.
ci_relays_verdict() {
  local sha="$1" short="${1:0:7}" rows="" trusted="" line runs_ok=" " runs_no=" " hand="" trust_fail=ci_relays_trust_fail trust_tag=relays
  local bot='github-actions[bot]' workflow='.github/workflows/ci-runner.yml'
  cls="" cdet="" why=""
  if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[] | [.context, .state, .description, .creator.login, .target_url] | @tsv' </dev/null 2>"$cache/.green-gh.err")"; then
    why="the statuses of $short could not be read ($(tail -1 "$cache/.green-gh.err" 2>/dev/null))"; return 2
  fi
  ci_green_trusted || { [ -n "$why" ] || why="the runs behind the statuses of $short could not be read"; return 2; }
  [ -z "$why" ] || return 2
  line="$(printf '%s' "$trusted" | ci_classify)"
  cls="${line%%$'\t'*}" cdet="${line#*$'\t'}"
  return 0
}

ci_relays() {
  local repo="${GITHUB_REPOSITORY:-${CI_REPO:-}}" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
  local scan="${CI_RELAYS_SCAN:-20}" rc=0 envs="" allowed="" listtext handtext perrs="" why run_id run_sha out cls cdet env mode s7 allow slug e
  local line seen="" unl="" f
  case "$scan" in '' | *[!0-9]* | 0) scan=20 ;; esac
  mkdir -p "$cache" || { echo "::error::ci-runner: relays: $cache cannot be made"; return 1; }
  # the lists: a problem with them is an error and an alert, and nothing else can be checked
  if ! { ci_relays_load && ci_relays_parse; }; then
    ci_relays_notice "relay lists" error x relay-lists-relay-error "RELAYS CHECK, error: $perrs"
    return 1
  fi
  ci_relays_clear "relay lists"
  # the repository: from this checkout's origin first (no GitHub call, so no account is needed yet), else `gh repo view`
  [ -n "$repo" ] || repo="$(ci_gh_origin_repo "$HERE")"
  if [ -z "$repo" ]; then
    repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner </dev/null 2>"$cache/.relays-gh.err")" && [ -n "$repo" ] || {
      ci_relays_bad "(relays check)" - - error error x relays-check-relay-error "error: no repository" "no GITHUB_REPOSITORY or CI_REPO, no github.com origin, and gh repo view failed: set CI_REPO=<owner>/<name> ($(tail -1 "$cache/.relays-gh.err" 2>/dev/null))"
      return 1
    }
  fi
  # the token: the repository owner's account by name, never gh's active one (scripts/ci-runner/gh-account.sh)
  local tok
  if ! tok="$(ci_gh_token "$repo" 2>"$cache/.relays-gh.err")"; then
    ci_relays_bad "(relays check)" - - error account x relays-check-relay-error "error: account" "$(tail -1 "$cache/.relays-gh.err" 2>/dev/null)"
    return 1
  fi
  local -x GH_TOKEN="$tok" # this function's gh calls only, and the verdict's (green.sh) under it
  # this job's own run first: a token without actions: read would make every run behind a status read as "untrusted" (green.sh does the same)
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    out="$(gh api "repos/$repo/actions/runs/$GITHUB_RUN_ID" --jq .id </dev/null 2>"$cache/.relays-gh.err")" && [ "$out" = "$GITHUB_RUN_ID" ] || {
      ci_relays_bad "(relays check)" - - error error x relays-check-relay-error "error: own run unreadable" "this job's own run $GITHUB_RUN_ID could not be read, so no status can be trusted (actions: read?) ($(tail -1 "$cache/.relays-gh.err" 2>/dev/null))"
      return 1
    }
  fi
  ci_relays_clear "(relays check)"
  # an environment that is deploying but not listed (a typo, a rename, a new relay) would never be checked: it is an error
  if ! out="$(gh api -X GET "repos/$repo/deployments" -f per_page=100 --jq '.[].environment' </dev/null 2>"$cache/.relays-gh.err")"; then
    ci_relays_bad "(all environments)" - - error error x all-environments-relay-error "error: environments unreadable" "the repository's deployment environments could not be read ($(tail -1 "$cache/.relays-gh.err" 2>/dev/null))"
  else
    while IFS= read -r e; do
      [ -n "$e" ] || continue
      case "$seen" in *$'\n'"$e"$'\n'*) continue ;; esac
      seen="$seen"$'\n'"$e"$'\n'
      if ! printf '%s' "$envs" | CI_E="$e" awk -F'\t' '$1 == ENVIRON["CI_E"] { f = 1 } END { exit !f }'; then
        unl="$unl$(ci_relays_slug "$e")."
        ci_relays_bad "$e" - - error unlisted x "$(ci_relays_slug "$e")-relay-unlisted" "error: unlisted relay environment" "unlisted relay environment: $e has deployments but is not in the relay list (a typo, a rename or a new relay), so it is not being checked" "add it to the relay list (CI_RELAY_DEPLOYS and ~/.config/talos-ci/relay-deploys.txt) as green or main"
      fi
    done <<< "$out"
  fi
  # an unlisted environment that is listed now (or has gone) stops being said
  for f in "$cache/relays-said"/*.unlisted; do
    [ -e "$f" ] || continue
    slug="${f##*/}" slug="${slug%.unlisted}"
    case "$unl" in *"$slug."*) ;; *) rm -f "$f" ;; esac
  done
  while IFS=$'\t' read -r env mode; do
    [ -n "$env" ] || continue
    slug="$(ci_relays_slug "$env")"
    ci_relays_running "$env"
    case $? in
      2) ci_relays_bad "$env" - - error error x "$slug-relay-error" "error: $why" "$env: $why"; continue ;;
      3) ci_relays_bad "$env" - - error nodeploy x "$slug-relay-nodeploy" "error: no deployment" "$env has no deployment at all: a typo in the list, or the relay was never deployed" "check the environment name against gh api repos/<repo>/deployments"; continue ;;
      1) ci_relays_bad "$env" - - warning warning x "$slug-relay-warning" "warning: no successful deployment" "$env has no successful deployment among its newest $scan; nothing to judge"; continue ;;
    esac
    s7="${run_sha:0:7}"
    # an approved emergency deploy by hand is on the hand-deploy list: no need to read its statuses
    allow="$(printf '%s' "$allowed" | CI_E="$env" CI_S="$run_sha" awk -F'\t' '$1 == ENVIRON["CI_S"] && $2 == ENVIRON["CI_E"] { print $3 ": " $4; exit }')"
    if [ "$mode" = green ] && [ -n "$allow" ]; then
      echo "ci-runner: relays: $env runs $s7, which is not (or not yet) six-green, but ${CI_RELAYS_HAND_LABEL} allows it ($allow): ok (allowlisted)"
      ci_relays_row "$env" "$run_sha" - "ok: allowlisted ($allow)"
      ci_relays_clear "$env"
      continue
    fi
    ci_relays_verdict "$run_sha"
    if [ $? = 2 ]; then
      ci_relays_bad "$env" "$run_sha" - error error x "$slug-relay-error" "error: statuses unreadable" "$env runs $s7 and its statuses cannot be judged: $why"
      continue
    fi
    if [ "$mode" = main ]; then
      echo "ci-runner: relays: info: $env (tracks main) runs $s7; its six statuses read $cls"
      ci_relays_row "$env" "$run_sha" "$cls" "info: tracks main, statuses $cls"
      ci_relays_clear "$env"
      continue
    fi
    if [ "$cls" = green ]; then
      echo "ci-runner: relays: $env runs $s7 (deployment $run_id); its own six statuses read green: ok"
      ci_relays_row "$env" "$run_sha" green ok
      ci_relays_clear "$env"
      continue
    fi
    ci_relays_bad "$env" "$run_sha" "$cls" error alert "$run_sha" "$s7-relay-not-green" "ALERT: not six-green ($cls)" \
      "$env runs $s7, which is not six-green: its own local-ci/* statuses read $cls ($cdet). A green-only relay deployed a commit CI has not passed" \
"environment: $env
deployed commit: $run_sha (deployment $run_id)
statuses: $cls ($cdet)
what to do:
  - roll back: redeploy a six-green commit in Railway (a beta relay's trigger branch must be green); or
  - if the commit is really six-green and only its trusted statuses are missing (a dispatch-tested fix), have CI test it by a push run; or
  - if it was an approved emergency deploy by hand, add a line to the hand-deploy list (CI_RELAY_HAND_DEPLOYS and ~/.config/talos-ci/relay-hand-deploys.txt): $run_sha<TAB>$env<TAB><YYYY-MM-DD><TAB><reason>
$([ -z "${GITHUB_RUN_ID:-}" ] || printf 'run: %s/%s/actions/runs/%s' "${GITHUB_SERVER_URL:-https://github.com}" "$repo" "$GITHUB_RUN_ID")"
  done <<< "$envs"
  rm -f "$cache/.relays-gh.err" "$cache/.green-gh.err"
  return "$rc"
}
