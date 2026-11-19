#!/usr/bin/env bash
# The lead's inbox: CI alerts kept on GitHub, so they wait for the lead while it is offline and arrive even when no session on
# this Mac is relaying them. One issue in the repository, "Lead inbox" (label lead-inbox; the oldest one with that label, made
# when there is none). Each alert is one comment: its id on the first line, then its text. Before posting, the ids already on
# the issue are read and a present one is skipped, so running again never posts twice. It adds to the relay
# (scripts/ci-alerts.sh watch / ack), it does not replace it.
#
#   scripts/lead-inbox.sh post <id> <file>   post one alert, unless its id is on the issue already
#   scripts/lead-inbox.sh flush              post every alert in alerts/ and alerts/sent/ from the last 48 h not on the issue yet
#   scripts/lead-inbox.sh note <file>        post free text (a catch-up to queue), id note-<UTC time>-<pid>
#   scripts/lead-inbox.sh unread [--mark]    for the reader: the comments after the last one read; --mark remembers them as read
#
# Posting refuses unless `gh repo view` says the repository is PRIVATE (exit 3), and every posted text is scrubbed first: a home
# path (/Users/<name>, /home/<name>, C:\Users\<name>) becomes ~, this machine's host name and any *.local / *.lan / *.internal
# name <host>, this user's login <user>, an email address <email>, every commit author and committer name in this checkout's
# history <author> (whole words; no history to read: nothing posted), and an @name or #123 a code span (no ping, no link).
# post / flush / note exit 0 when done (posted, or already there), 1 when GitHub could not be read or written, 3 when refused.
#
# unread's output contract (a job may run it every 30 minutes):
#   - nothing new: prints nothing, exit 0.
#   - new comments: each one as its id on its own line, then its text; then one summary line `lead-inbox: N new (R red)`
#     (R: those whose id ends in -red), exit 0.
#   - cannot read (gh fails, no inbox issue): one line on stderr starting `lead-inbox: cannot read`, exit 2.
#   - --mark advances the last-read comment only after a successful print, never on exit 2.
# The last-read comment id is ~/.cache/talos-lead-inbox/last-read (TALOS_LEAD_INBOX_HOME), on the reader's machine.
#
# The repository: LEAD_INBOX_REPO, else GITHUB_REPOSITORY, else CI_REPO, else this checkout's github.com origin, else
# treynortetik-creator/talos-app. Alerts: TALOS_CI_CACHE/alerts. Every gh call runs as the repository owner's account, never gh's active
# one (scripts/ci-runner/gh-account.sh): no account is exit 1 and an alert (unread: exit 2, `lead-inbox: cannot read`).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=ci-runner/gh-account.sh
. "$HERE/ci-runner/gh-account.sh"
REPO="${LEAD_INBOX_REPO:-$(ci_gh_repo "$HERE/.." treynortetik-creator/talos-app)}"
CACHE="${TALOS_CI_CACHE:-$HOME/.cache/talos-ci}"
READER="${TALOS_LEAD_INBOX_HOME:-$HOME/.cache/talos-lead-inbox}"
LOCK="$CACHE/lead-inbox.lock"
LABEL=lead-inbox
MAX=60000 # a GitHub comment holds 65,536 characters

die() { echo "lead-inbox: $*" >&2; exit 1; }

private() { # posting only to a private repository
  local v
  v="$(gh repo view "$REPO" --json visibility --jq .visibility </dev/null 2>/dev/null)"
  [ "$v" = PRIVATE ] && return 0
  echo "lead-inbox: refused: $REPO is not private (visibility: ${v:-unknown}); nothing posted" >&2
  exit 3
}

find_issue() { # the inbox issue's number, or nothing; non-zero when GitHub could not be read
  gh api "repos/$REPO/issues?labels=$LABEL&state=all&per_page=100" \
    --jq '[.[] | select(.pull_request == null and .title == "Lead inbox")] | sort_by(.number) | .[0].number // empty' </dev/null 2>/dev/null
}

issue() { # find the inbox issue, or make it
  local n
  n="$(find_issue)" || return 1
  if [ -z "$n" ]; then
    gh api -X POST "repos/$REPO/labels" -f name="$LABEL" -f color=d93f0b -f description="CI alerts for the lead" \
      </dev/null >/dev/null 2>&1 # already there is fine
    gh api -X POST "repos/$REPO/issues" -f title="Lead inbox" -f "labels[]=$LABEL" \
      -f body="CI alerts for the lead, one comment each (scripts/lead-inbox.sh). Read with: bash scripts/lead-inbox.sh unread --mark" \
      --jq .number </dev/null >/dev/null 2>&1 || return 1
    n="$(find_issue)" || return 1 # the oldest: two makers at once both use the same one
  fi
  [ -n "$n" ] && printf '%s\n' "$n"
}

ids() { # the first line of every comment on issue $1
  gh api --paginate "repos/$REPO/issues/$1/comments?per_page=100" --jq '.[] | .body | split("\n")[0]' </dev/null 2>/dev/null
}

scrub() { # stdin to stdout: no home paths, host names, user names, email addresses or author names (see the header)
  local h names
  h="$(hostname 2>/dev/null)"
  names="$(git -C "$HERE/.." log --format='%an%n%cn' -n 2000 2>/dev/null | sort -u)"
  # fail closed: with no author list the names would go out as they are
  [ -n "$names" ] || { echo "lead-inbox: no commit authors to scrub with (not a checkout?); nothing posted" >&2; return 1; }
  H="$h" NAMES="$names" ME="$(id -un 2>/dev/null)" perl -CSD -Mutf8 -pe '
    BEGIN {
      sub dec { my $s = shift // ""; utf8::decode($s); $s } # the environment is bytes; the text is decoded
      my %tool = map { $_ => 1 } qw(GitHub Claude root runner); # committer names that are not people
      @n = sort { length($b) <=> length($a) } grep { length($_) >= 4 && !$tool{$_} && !/\[bot\]$/ } split /\n/, dec($ENV{NAMES});
      @u = grep { length($_) >= 3 && !$tool{$_} } map { dec($_) } ($ENV{ME}, $ENV{USER}, $ENV{LOGNAME});
      my $h = dec($ENV{H}); (my $hs = $h) =~ s/\..*//;
      @h = grep { length($_) >= 2 } ($h, $hs);
    }
    s{(?<![\w.-])/(?:Users|home)/[^/\s:]+}{~}g; # after a start, space, quote, = or a list colon; file:/// too
    s{\b[A-Za-z]:\\Users\\[^\\\s]+}{~}g;
    s{[A-Za-z0-9._%+-]+\@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}}{<email>}g;
    s{(?<![\w./-])[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal|home\.arpa)\b}{<host>}gi;
    for my $x (@h) { s{(?<![\w-])\Q$x\E(?![\w-])}{<host>}gi }
    for my $x (@n) { s{(?<!\w)\Q$x\E(?!\w)}{<author>}g }
    for my $x (@u) { s{(?<![\w-])\Q$x\E(?![\w-])}{<user>}gi }
    s{(?<![\w`])([\@#][A-Za-z0-9][\w./-]*)}{`$1`}g; # no @mention or #123 link: GitHub never links inside a code span
    tr/\x1e//d;
  '
}

lock() { # one poster at a time on this machine (the CI job and the watcher's flush), so a check and its post are one step
  local i=0 pid
  mkdir -p "$CACHE" || return 1
  until mkdir "$LOCK" 2>/dev/null; do
    pid="$(cat "$LOCK/pid" 2>/dev/null)"
    # a holder that is gone (ps, not kill -0: the CI job and the watcher may be different users), one that never wrote its pid,
    # or one older than any holder lives (flush stops at 305 s; a reused pid looks alive). Taken over by moving the folder
    # aside (one mv wins), and only while it still holds the pid read above.
    # "gone" only when ps works now (it sees this very process) and does not see the holder: a ps that could not run at all (no
    # process slots left under load) said "gone" for a live holder, and two posters posted the same alert twice
    if { [ -n "$pid" ] && ps -p "$$" >/dev/null 2>&1 && ! ps -p "$pid" >/dev/null 2>&1; } ||
      { [ -z "$pid" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1 2>/dev/null)" ]; } ||
      [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$pid" ] && mv "$LOCK" "$LOCK.dead.$$" 2>/dev/null &&
        rm -f "$LOCK.dead.$$/pid" && rmdir "$LOCK.dead.$$" 2>/dev/null
    fi
    i=$((i + 1))
    [ "$i" -lt 40 ] || { echo "lead-inbox: another post is running; nothing posted (flush retries)" >&2; return 1; }
    sleep 0.5
  done
  printf '%s\n' "$$" > "$LOCK/pid"
  trap '[ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && rm -f "$LOCK/pid" && rmdir "$LOCK" 2>/dev/null' EXIT
}

valid_id() { case "$1" in '' | */* | .* | *[[:space:]]*) die "not an alert id: $1" ;; esac; }

send() { # send <issue> <id> <file>: one comment, scrubbed, at most MAX characters
  local body
  body="$(printf '%s\n' "$2"; scrub < "$3")" || return 1
  [ "${#body}" -le "$MAX" ] || body="${body:0:$MAX}"$'\n'"(cut: the full text is on the CI machine)"
  if gh api -X POST "repos/$REPO/issues/$1/comments" -f body="$body" </dev/null >/dev/null 2>&1; then
    echo "lead-inbox: posted $2"
  else
    echo "lead-inbox: $2 could not be posted" >&2
    return 1
  fi
}

post() { # post <id> <file>
  local n have
  valid_id "$1"
  [ -f "$2" ] || die "no file $2"
  private
  lock || exit 1
  n="$(issue)" || die "the inbox issue could not be found or made in $REPO; $1 not posted"
  have="$(ids "$n")" || die "the comments of issue $n could not be read; $1 not posted"
  if printf '%s\n' "$have" | grep -qxF -- "$1"; then echo "lead-inbox: $1 is on the issue already"; return 0; fi
  send "$n" "$1" "$2"
}

flush() {
  local n have f id rc=0 posted=0
  private
  lock || exit 1
  n="$(issue)" || die "the inbox issue could not be found or made in $REPO; nothing flushed"
  have="$(ids "$n")" || die "the comments of issue $n could not be read; nothing flushed"
  while IFS= read -r f; do # oldest first: an id starts with its epoch second
    id="${f##*/}" && id="${id%.txt}"
    case "$id" in .* | *[[:space:]]*) continue ;; esac
    printf '%s\n' "$have" | grep -qxF -- "$id" && continue
    if send "$n" "$id" "$f"; then have="$have"$'\n'"$id" posted=$((posted + 1)); else rc=1; fi
  done < <(find "$CACHE/alerts" "$CACHE/alerts/sent" -maxdepth 1 -name '*.txt' -mmin -2880 2>/dev/null | awk -F/ '{ print $NF "\t" $0 }' | sort | cut -f2-)
  echo "lead-inbox: flush: $posted posted"
  return "$rc"
}

unread() {
  local mark="" last n out new red maxid rs
  [ "${1:-}" = --mark ] && mark=1
  last="$(cat "$READER/last-read" 2>/dev/null)"
  case "$last" in '' | *[!0-9]*) last=0 ;; esac
  n="$(find_issue)" || { echo "lead-inbox: cannot read $REPO's issues" >&2; exit 2; }
  [ -n "$n" ] || { echo "lead-inbox: cannot read: no inbox issue (label $LABEL) in $REPO" >&2; exit 2; }
  # each comment after the last read: a record separator, its id, then its body (scrub keeps that byte out of a body)
  out="$(gh api --paginate "repos/$REPO/issues/$n/comments?per_page=100" \
    --jq ".[] | select(.id > $last) | \"\u001e\(.id)\n\(.body)\"" </dev/null 2>/dev/null)" ||
    { echo "lead-inbox: cannot read the comments of issue $n in $REPO" >&2; exit 2; }
  [ -n "$out" ] || return 0
  rs=$'\x1e'
  read -r new red < <(printf '%s\n' "$out" | awk -v rs="$rs" 'index($0, rs) == 1 { n++; getline; if ($0 ~ /-red$/) r++ } END { print n + 0, r + 0 }')
  maxid="$(printf '%s\n' "$out" | grep -a "^$rs" | cut -c2- | sort -n | tail -1)" # as text: comment ids pass 2^31 (old mawk)
  { printf '%s\n' "$out" | grep -v "^$rs" && echo "lead-inbox: $new new ($red red)"; } || exit 2
  if [ -n "$mark" ] && [ "$maxid" -gt "$last" ]; then
    mkdir -p "$READER" && printf '%s\n' "$maxid" > "$READER/last-read.part" && mv -f "$READER/last-read.part" "$READER/last-read" ||
      { echo "lead-inbox: could not save the last-read mark in $READER" >&2; exit 1; }
  fi
}

# the account, before any gh call of a command that has one
case "${1:-}" in
  post | flush | note | unread)
    mkdir -p "$CACHE" 2>/dev/null # the error file's folder
    if ! tok="$(ci_gh_token "$REPO" 2>"$CACHE/.lead-inbox-gh.err")"; then
      why="$(tail -1 "$CACHE/.lead-inbox-gh.err" 2>/dev/null)"
      [ "$1" != unread ] || { echo "lead-inbox: cannot read: $why" >&2; exit 2; }
      ci_gh_problem "$CACHE" inbox-account "lead-inbox: nothing posted: $why"
      exit 1
    fi
    ci_gh_problem_clear "$CACHE" inbox-account
    export GH_TOKEN="$tok"
    ;;
esac

case "${1:-}" in
  post) [ "$#" -eq 3 ] || die "usage: post <id> <file>"; post "$2" "$3" ;;
  flush) flush ;;
  note)
    [ "$#" -eq 2 ] && [ -f "$2" ] || die "usage: note <file>"
    post "note-$(date -u +%Y%m%dT%H%M%SZ)-$$" "$2"
    ;;
  unread) unread "${2:-}" ;;
  *) sed -n '8,11p' "$0" | sed 's/^# *//' >&2; exit 64 ;;
esac
