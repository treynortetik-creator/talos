# ci-runner.sh's green step (sourced by it for `green`). docs/CI-MACHINES.md, "The green branch".
# shellcheck shell=bash
# ---------- green: fast-forward refs/heads/green to a six-green commit of main ----------
# The beta relays deploy from `green` (a fast-forward is a push, and the host deploys on a push to its trigger branch), and the
# Mac updater releases only from green's sha. After a PUSH run of main (never a PR, a dispatch or the nightly), from the
# workflow's `green` job, the only job whose token can write contents: when the commit's statuses read green (ci_classify, as
# `verdict` and `alert` read it, but over the trusted statuses only), green moves to it, fast-forward only:
#   no green yet               created at the commit
#   green is an ancestor       pushed forward to the commit
#   green is the commit, or the commit is older than green (an earlier commit turning green late)   nothing, and it says so
#   green is anything else     refused: ::error::, exit 1, an alert for the lead; green is left where it is
# The push is a plain `git push origin <sha>:refs/heads/green`, never forced: GitHub itself refuses a push that is not a fast-
# forward, so a green moved by hand between the read and the push is never overwritten. Every decision is one line of
# ~/.cache/talos-ci/logs/green.tsv (UTC time, commit, previous green or -, result) and one line in the job log. An error (GitHub
# or origin unreadable, a refused push) is loud too, never "not green". Only TRUSTED statuses count (ci_green_trusted, below), and
# a green that this machine's green.tsv did not leave where origin has it is a foreign move: a warning and an alert, then the
# usual rules (ci_green_foreign).
ci_green() {
  local repo="${GITHUB_REPOSITORY:-}" sha="${CI_PLAN_SHA:-${GITHUB_SHA:-}}" cache="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
  local prev="" short rows line cls out tries=0 now_green known trusted runs_ok=" " runs_no=" " hand="" by_hand=""
  # the creator of every status a workflow posts with GITHUB_TOKEN, and the workflow whose push runs post the six
  local bot='github-actions[bot]' workflow='.github/workflows/ci-runner.yml'
  if [ "${GITHUB_EVENT_NAME:-}" != push ] || [ "${GITHUB_REF:-}" != refs/heads/main ]; then
    echo "ci-runner: green: not a push run of main (${GITHUB_EVENT_NAME:-no event} to ${GITHUB_REF:-no ref}); green is not moved"
    return 0
  fi
  short="${sha:0:7}"
  # The lead's emergency move (docs/CI-MACHINES.md, "The green branch"), by hand only, never inside a workflow: CI_GREEN_TRUST_RUN
  # names one run of this workflow (a dispatch of the fix, say) whose statuses count as well; it is named in every tsv row.
  if [ -n "${CI_GREEN_TRUST_RUN:-}" ]; then
    case "$CI_GREEN_TRUST_RUN" in *[!0123456789]*) echo "::error::ci-runner: green: CI_GREEN_TRUST_RUN '$CI_GREEN_TRUST_RUN' is not a run id"; return 1 ;; esac
    [ "${GITHUB_ACTIONS:-}" != true ] || { echo "::error::ci-runner: green: CI_GREEN_TRUST_RUN is for a move by hand, never inside a workflow"; return 1; }
    hand="$CI_GREEN_TRUST_RUN" by_hand=" (by hand, trusting run $CI_GREEN_TRUST_RUN)"
  fi
  # ci_green_log <result>: the tsv line, and the job log's. A line that cannot be written is said as an error: the foreign-move
  # check reads this file.
  ci_green_log() {
    { mkdir -p "$cache/logs" && printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" "${prev:--}" "$1$by_hand" >> "$cache/logs/green.tsv"; } ||
      echo "::error::ci-runner: green: $cache/logs/green.tsv could not be written"
    echo "ci-runner: green: $1$by_hand"
  }
  # ci_green_fail <result>: logged, said as an error, and left for the lead (scripts/ci-alerts.sh watch passes it on)
  ci_green_fail() {
    local now
    now=$(date +%s)
    ci_green_log "$1"
    echo "::error::ci-runner: green: $1"
    mkdir -p "$cache/alerts" &&
      printf 'green NOT moved to %s: %s\nrun: %s\n' "$short" "$1" "${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-}" > "$cache/alerts/.$now-green.part" &&
      mv -f "$cache/alerts/.$now-green.part" "$cache/alerts/$now-$short-green.txt"
    return 1
  }
  # ci_green_foreign: green was moved (or deleted) by someone other than this job on this machine: a warning, a tsv line (whose
  # column 3 is then where green is) and an alert for the lead, written as ci_green_fail writes its own. Not a failure.
  ci_green_foreign() {
    local now old="${known:0:7}" new="${prev:0:7}"
    now=$(date +%s)
    ci_green_log "foreign move: ${old:-deleted} -> ${new:-deleted}"
    echo "::warning::ci-runner: green: green was moved by hand from ${old:-(deleted)} to ${new:-(deleted)}; the usual rules go on"
    { mkdir -p "$cache/alerts" &&
      printf 'green was moved by hand from %s to %s (not by the green job on this machine)\nseen by the run for %s: %s\n' \
        "${old:-(deleted)}" "${new:-(deleted)}" "$short" "${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/${GITHUB_RUN_ID:-}" \
        > "$cache/alerts/.$now-green-foreign.part" &&
      mv -f "$cache/alerts/.$now-green-foreign.part" "$cache/alerts/$now-$short-green-foreign.txt"; } ||
      echo "::error::ci-runner: green: the foreign-move alert could not be written to $cache/alerts"
  }
  # ci_green_run_id <target_url>: the run id when the link is exactly "<server>/<repo>/actions/runs/<digits>", then optionally
  # "/attempts/<digits>", then optionally "#<letters, digits, . _ ->", and nothing else; else it fails. A prefix strip and a
  # strict pattern on the rest, never a regex built from the repository's name.
  ci_green_run_id() {
    local base="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/" rest id tail a
    case "$1" in "$base"*) rest="${1#"$base"}" ;; *) return 1 ;; esac
    id="${rest%%[!0123456789]*}"
    tail="${rest#"$id"}"
    [ -n "$id" ] || return 1
    case "$tail" in /attempts/[0123456789]*) a="${tail#/attempts/}" && tail="${a#"${a%%[!0123456789]*}"}" ;; esac
    case "$tail" in
      "") ;;
      "#"?*) case "${tail#"#"}" in *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-]*) return 1 ;; esac ;;
      *) return 1 ;;
    esac
    printf '%s\n' "$id"
  }
  # ci_green_trusted: $rows (context, state, description, creator, link; newest first) to $trusted, the first three fields of
  # each TRUSTED local-ci/* row in the same order. Trusted: posted by GitHub's own token (the creator is the bot, the same for
  # every workflow's GITHUB_TOKEN), and linked to a run of this workflow, on a push, of this very commit (each run read once).
  # The creator alone closes nothing (a PR's or a dispatch's code under test holds statuses: write and posts as the same bot);
  # the run check stops a status such a run posts under its own run's link, since only a push run tests code already on
  # main. It does not stop a deliberate forger copying the push run's link, and on Lemnos PR code runs as the owner's user:
  # the real boundary is who can push to the repository. A run that cannot be read is an error, never "untrusted".
  ci_green_trusted() {
    local r ctx state desc creator url rest id info why
    trusted=""
    while IFS= read -r r; do
      [ -n "$r" ] || continue
      ctx="${r%%$'\t'*}" rest="${r#*$'\t'}"
      state="${rest%%$'\t'*}" rest="${rest#*$'\t'}"
      desc="${rest%%$'\t'*}" rest="${rest#*$'\t'}"
      creator="${rest%%$'\t'*}" url="${rest#*$'\t'}"
      case "$ctx" in local-ci/*) ;; *) continue ;; esac
      why=""
      if [ "$creator" != "$bot" ]; then
        why="not posted by $bot"
      elif ! id="$(ci_green_run_id "$url")"; then
        why="not a link to a run of $repo"
      else
        case "$runs_ok$runs_no" in
          *" $id "*) ;;
          *)
            if info="$(gh api "repos/$repo/actions/runs/$id" --jq '[.path, .event, .head_sha, .head_branch] | @tsv' </dev/null 2>"$cache/.green-gh.err")" && [ -n "$info" ]; then
              if [ "$info" = "$workflow"$'\t'push$'\t'"$sha"$'\t'main ]; then runs_ok="$runs_ok$id "
              # the lead's named run (by hand only): this workflow, a push or a dispatch, run from main (a dispatch from a branch
              # would run that branch's own workflow and scripts); its head is main's tip then, not always the commit
              elif [ "$id" = "$hand" ] && case "$info" in "$workflow"$'\t'push$'\t'*$'\t'main | "$workflow"$'\t'workflow_dispatch$'\t'*$'\t'main) true ;; *) false ;; esac; then
                runs_ok="$runs_ok$id "
              else runs_no="$runs_no$id "; fi
            # no such run (404) is a definite answer, so untrusted; any other failure (403, 5xx, a rate limit) is an error
            elif grep -q 'HTTP 404' "$cache/.green-gh.err" 2>/dev/null; then runs_no="$runs_no$id "
            else
              ci_green_fail "error: run $id, behind $ctx of $short, could not be read ($(tail -1 "$cache/.green-gh.err" 2>/dev/null))"; return 1
            fi ;;
        esac
        case "$runs_no" in *" $id "*) why="run $id is not $workflow's push run of $short" ;; esac
      fi
      if [ -n "$why" ]; then
        echo "ci-runner: green: ignored an untrusted status: $ctx by ${creator:-nobody} at ${url:-no link} ($why)"
      else
        trusted="$trusted$ctx"$'\t'"$state"$'\t'"$desc"$'\n'
      fi
    done <<< "$rows"
  }
  [ -n "$repo" ] && [ -n "$sha" ] || { ci_green_fail "error: needs GITHUB_REPOSITORY and the commit"; return 1; }
  # green as origin has it now (ls-remote: "no line" is "no green yet", a failed call is an error), then main and green fetched
  out="$(ci_git_net "$ROOT" ls-remote origin refs/heads/green)" || { ci_green_fail "error: origin's green could not be read"; return 1; }
  prev="$(printf '%s\n' "$out" | awk '$2 == "refs/heads/green" { print $1; exit }')"
  ci_git_net "$ROOT" fetch -q --no-tags origin +refs/heads/main:refs/remotes/origin/main ${prev:+"+refs/heads/green:refs/remotes/origin/green"} ||
    { ci_green_fail "error: origin could not be fetched"; return 1; }
  [ -z "$prev" ] || prev="$(git -C "$ROOT" rev-parse -q --verify refs/remotes/origin/green)" ||
    { ci_green_fail "error: origin's green was fetched but cannot be read here"; return 1; }
  # A foreign move: where green.tsv last left green ("created"/"moved": column 2; "foreign move": column 3, "-" is deleted)
  # is not where origin has it. Said on every push run, whatever the verdict, and logged, so it is said once per move.
  if [ -f "$cache/logs/green.tsv" ]; then
    known="$(awk -F'\t' '$4 ~ /^created/ || $4 ~ /^moved/ { k = $2; s = 1 } $4 ~ /^foreign move/ { k = $3; s = 1 } END { if (s) print "=" k }' "$cache/logs/green.tsv")" ||
      { ci_green_fail "error: $cache/logs/green.tsv cannot be read"; return 1; }
    if [ -n "$known" ]; then # no such row yet: nothing to compare
      known="${known#=}"
      [ "$known" != - ] || known=""
      [ "$known" = "$prev" ] || ci_green_foreign
    fi
  fi
  git -C "$ROOT" merge-base --is-ancestor "$sha" refs/remotes/origin/main 2>/dev/null ||
    { ci_green_log "unchanged: not on main"; return 0; }
  # The statuses can lag one just posted by a few seconds (ci_sweep says so too): a read that is not final yet (pending,
  # partial, none) is read again, CI_GREEN_READS times in all (3), CI_GREEN_WAIT_S apart (20). Red is final at once.
  mkdir -p "$cache" || { ci_green_fail "error: $cache cannot be made"; return 1; }
  # A 404 on a run counts as untrusted (below), and GitHub can answer 404 for a token without actions: read: so this job's own
  # run is read first, and a failure there is an error, never a quiet "partial" (skipped by hand, with no run of its own).
  if [ -n "${GITHUB_RUN_ID:-}" ]; then
    out="$(gh api "repos/$repo/actions/runs/$GITHUB_RUN_ID" --jq .id </dev/null 2>"$cache/.green-gh.err")" && [ "$out" = "$GITHUB_RUN_ID" ] || {
      ci_green_fail "error: this job's own run $GITHUB_RUN_ID could not be read, so no run can be checked (actions: read?) ($(tail -1 "$cache/.green-gh.err" 2>/dev/null))"
      return 1
    }
  fi
  while :; do
    tries=$((tries + 1))
    # The list endpoint, newest first (the combined /status has no creator); only the trusted rows reach ci_classify, in that
    # order, so the newest trusted status of each context wins.
    if ! rows="$(gh api --paginate "repos/$repo/commits/$sha/statuses?per_page=100" --jq '.[] | [.context, .state, .description, .creator.login, .target_url] | @tsv' </dev/null 2>"$cache/.green-gh.err")"; then
      ci_green_fail "error: the statuses of $short could not be read ($(tail -1 "$cache/.green-gh.err" 2>/dev/null))"
      return 1
    fi
    ci_green_trusted || return 1
    line="$(printf '%s' "$trusted" | ci_classify)"
    cls="${line%%$'\t'*}"
    case "$cls" in pending | partial | none) [ "$tries" -lt "${CI_GREEN_READS:-3}" ] || break ;; *) break ;; esac
    sleep "${CI_GREEN_WAIT_S:-20}"
  done
  rm -f "$cache/.green-gh.err"
  [ "$cls" = green ] || { echo "ci-runner: green: $short's verdict is $cls (${line#*$'\t'})"; ci_green_log "unchanged: verdict $cls"; return 0; }
  if [ -z "$prev" ]; then
    :
  elif [ "$prev" = "$sha" ]; then
    ci_green_log "unchanged: already green"; return 0
  elif git -C "$ROOT" merge-base --is-ancestor "$sha" "$prev" 2>/dev/null; then
    echo "ci-runner: green: $short is older than green ${prev:0:7}, which is ahead of it; nothing to do"
    ci_green_log "unchanged: older than green"; return 0
  elif ! git -C "$ROOT" merge-base --is-ancestor "$prev" "$sha" 2>/dev/null; then
    ci_green_fail "refused: green ${prev:0:7} is not an ancestor of $short (moved off main?); fast-forward only, nothing forced"
    return 1
  fi
  # No hook here (GIT_CONFIG_*: core.hooksPath=/dev/null): the commit is already on main and six-green, and the runner's checkout
  # may have the gate's pre-push hook on. ci_git_net: no prompt, a time limit, and git's own last line when it fails.
  if ! out="$(GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null \
    ci_git_net "$ROOT" push origin "$sha:refs/heads/green" 2>&1)"; then
    # lost a race: green moved past this commit meanwhile (a newer run, or the lead by hand), which is no failure
    if ci_git_net "$ROOT" fetch -q --no-tags origin +refs/heads/green:refs/remotes/origin/green &&
      now_green="$(git -C "$ROOT" rev-parse -q --verify refs/remotes/origin/green)" && [ "$now_green" != "$prev" ] &&
      git -C "$ROOT" merge-base --is-ancestor "$sha" "$now_green" 2>/dev/null; then
      # green at this very commit: the push landed though git reported a failure (say, a time limit after the update)
      [ "$now_green" != "$sha" ] || { ci_green_log "moved (the push reported a failure, but green is at the commit)"; return 0; }
      prev="$now_green"
      ci_green_log "unchanged: older than green"
      return 0
    fi
    ci_green_fail "failed: the push was refused or did not finish: $(printf '%s\n' "$out" | tail -1)"
    return 1
  fi
  if [ -z "$prev" ]; then ci_green_log "created" && echo "ci-runner: green: created at $short"
  else ci_green_log "moved" && echo "ci-runner: green: moved ${prev:0:7} -> $short"; fi
  return 0
}
