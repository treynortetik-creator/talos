# ci-runner.sh's online check (sourced by `plan`; its own file so ci-runner.sh stays under 1,000 lines).
# shellcheck shell=bash
# A part is never handed to a machine that is not online right now. GitHub never moves a queued job: one handed to an offline
# runner sits "working" until Lemnos's wait (CI_CHECK_WAIT, CI_BROWSER_E2E_WAIT) runs out and takes it back, about an hour with every
# gate queued behind it, and a report-only job for an absent runner holds the run open until `close` cancels it. So plan asks the
# repository's runners (GET repos/<repo>/actions/runners: each runner's status and labels) and turns a switch OFF, with a line saying
# why, when no runner with the label the job asks for is online. Offline, unknown (no such runner), or an answer that could not be had
# (no token, a 403, a timeout, a reply that is not understood) all read as "not online": the part then runs here, as with the switch off.
# The runners API needs repository administration: the workflow's own GITHUB_TOKEN cannot read it, so the token is CI_RUNNERS_TOKEN
# (the plan job passes the secret of that name, a fine-grained token with Administration: read on this repository, if the owner sets one),
# else GH_TOKEN as given, else this Mac's login of the repository owner (CI_GH_USER names another), by name, never gh's active account.
# Nothing is asked while every switch is off.
CI_ONLINE_LIST="" CI_ONLINE_LOADED="" CI_ONLINE_WHY=""
ci_online_token() { # ci_online_token <repo>: the token for the runners read, or nothing (the reason in CI_ONLINE_WHY)
  local repo="$1" acct tok
  if [ -n "${CI_RUNNERS_TOKEN:-}" ]; then printf '%s' "$CI_RUNNERS_TOKEN"; return 0; fi
  if [ -n "${GH_TOKEN:-}" ]; then printf '%s' "$GH_TOKEN"; return 0; fi
  acct="${CI_GH_USER:-${repo%%/*}}"
  tok="$(gh auth token --hostname github.com --user "$acct" </dev/null 2>/dev/null)" || tok=""
  [ -n "$tok" ] || return 1
  printf '%s' "$tok"
}
ci_online_load() { # the runners once per plan: CI_ONLINE_LIST is "status<TAB>labels" lines; CI_ONLINE_WHY says why it could not be had
  local repo tok out rc
  [ -z "$CI_ONLINE_LOADED" ] || return 0
  CI_ONLINE_LOADED=1 CI_ONLINE_LIST="" CI_ONLINE_WHY=""
  repo="$(ci_gh_repo "${ROOT:-.}" "")"
  if [ -z "$repo" ]; then CI_ONLINE_WHY="the runners list could not be read: no repository known"; return 0; fi
  if ! tok="$(ci_online_token "$repo")"; then
    CI_ONLINE_WHY="the runners list could not be read: no token (CI_RUNNERS_TOKEN, GH_TOKEN, or a gh login of ${CI_GH_USER:-${repo%%/*}})"
    return 0
  fi
  # bounded: 20 s, in a group of its own (TERM, then KILL after 5 s); a limit that is not whole seconds is the 20 (alarm 0 is no limit)
  local lim="${CI_ONLINE_TIMEOUT_S:-20}"
  case "$lim" in '' | *[!0-9]* | 0) lim=20 ;; esac
  out="$(GH_TOKEN="$tok" perl -e '$t = shift; $p = fork; if (!$p) { setpgrp(0, 0); exec @ARGV } $SIG{ALRM} = sub { kill "TERM", -$p; sleep 5; kill "KILL", -$p; exit 142 }; alarm $t; waitpid($p, 0); exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' \
    "$lim" gh api --paginate "repos/$repo/actions/runners" \
    --jq '.runners[] | [.status, ([.labels[].name] | join(","))] | @tsv' </dev/null 2>/dev/null)"
  rc=$?
  if [ "$rc" != 0 ]; then CI_ONLINE_WHY="the runners list could not be read (gh api exit $rc)"; return 0; fi
  CI_ONLINE_LIST="$out"
  [ -n "$out" ] || CI_ONLINE_WHY="the repository has no runners"
}
ci_online() { # ci_online <label>: 0 when a runner with that label is online now; else 1, CI_ONLINE_WHY says why
  local label st labels any=""
  label="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" # GitHub matches labels without regard to case
  ci_online_load
  [ -z "$CI_ONLINE_LIST" ] && [ -n "$CI_ONLINE_WHY" ] && return 1
  while IFS=$'\t' read -r st labels; do
    labels="$(printf '%s' "$labels" | tr '[:upper:]' '[:lower:]')"
    case ",$labels," in *",$label,"*) ;; *) continue ;; esac
    any=1
    [ "$st" != online ] || return 0
  done <<EOF2
$CI_ONLINE_LIST
EOF2
  if [ -n "$any" ]; then CI_ONLINE_WHY="its runner is offline"; else CI_ONLINE_WHY="no runner of this repository has that label"; fi
  return 1
}
ci_plan_online() { # each switch that hands a part to another machine: off, with a line, when no runner of that machine is online
  local lbl=talos-ci-linux spec var label val pre
  # the hostile nightly's report-only copies run on Titan's second runner (plan's linux_label)
  # (the hostile run hands nothing else anywhere, and with CI_TITAN_HOSTILE off not even those: nothing to ask then)
  local specs="CI_DELPHI:talos-ci-delphi CI_CYCLOPS:talos-ci-cyclops CI_HESTIA:talos-ci-report CI_TITAN_IMAGE:talos-ci-linux CI_TITAN_BROWSER:$lbl CI_TITAN_CHECK:$lbl"
  if [ "${CI_HOSTILE:-}" = 1 ]; then
    [ "${CI_TITAN_HOSTILE:-}" = shadow ] || return 0
    lbl=talos-ci-linux-b
    specs="CI_TITAN_BROWSER:$lbl CI_TITAN_CHECK:$lbl"
  fi
  for spec in $specs; do
    var="${spec%%:*}" label="${spec#*:}" val="${!var:-}"
    case "$val" in on | shadow | e2e | e2e-shadow) ;; *) continue ;; esac # off, unset, or a value plan itself refuses
    if ci_online "$label"; then continue; fi
    # an answer that could not be had is an annotation on the run (every part then runs here); an offline machine is a plain line
    case "$CI_ONLINE_WHY" in "the runners list could not be read"*) pre="::warning::plan: " ;; *) pre="plan: " ;; esac
    echo "$pre$var=$val, but no runner labelled $label is online ($CI_ONLINE_WHY): that part is not handed over and runs here, as with the switch off" >&2
    printf -v "$var" '%s' off
    export "$var"
  done
  return 0
}
