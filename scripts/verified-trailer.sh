#!/usr/bin/env bash
# The "Verified:" trailer check (the verify skill, .claude/skills/verify/SKILL.md). Every commit message ends with a trailer that
# says what was driven and where the evidence is, or why nothing was:
#   Verified: web fake mode, graph click x5, themes all; evidence /home/alex/evidence/96f2389/
#   Verified: none - <reason>        (a dash or an em dash; the reason is required, so unverified commits can be queried)
#
# pre-push.sh runs this for the commits being pushed: stdin is its list of "<tip sha> <base sha|none>" lines.
#   TALOS_VERIFIED_TRAILER=off|observe|enforce    (or `git config talos.verifiedTrailer`; default observe)
#     off      does nothing
#     observe  for each commit without a valid trailer: one line to stderr and one to the log file; ALWAYS exits 0, whatever git
#              says (a git error is itself one line, never a refusal)
#     enforce  the same lines, then exits 1 when any commit lacks the trailer or the commits could not be listed. Not switched on:
#              the owner decides when.
#   TALOS_VERIFIED_LOG=<file>      where the lines go (default <git common dir>/talos-verified-trailer.log)
#   TALOS_VERIFIED_NOT=<ref>       commits already on this ref are not this push's (pre-push passes the remote's main)
#   TALOS_VERIFIED_MAX=<n>         look at the newest n commits of each pushed ref only (default 20): a new branch with no remote
#                                  main, a force push or a rebase can have thousands, and a push must not wait for them. Said once
#                                  per ref when it applies. At most 3 commits are named, then one count; the log keeps its last
#                                  ~500 lines once it passes 256 KiB. (enforce too checks only the newest n.)
# A merge commit is skipped (it carries no change of its own).
set -uo pipefail
MODE="${TALOS_VERIFIED_TRAILER:-}"
[ -n "$MODE" ] || MODE="$(git config --get talos.verifiedTrailer 2>/dev/null)" || MODE=""
[ -n "$MODE" ] || MODE=observe
case "$MODE" in
  off) exit 0 ;;
  observe | enforce) ;;
  *)
    echo "verified-trailer: unknown mode \"$MODE\" (off, observe or enforce); treated as observe" >&2
    MODE=observe
    ;;
esac

LOG="${TALOS_VERIFIED_LOG:-}"
if [ -z "$LOG" ]; then
  common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  [ -n "$common" ] && LOG="$common/talos-verified-trailer.log"
fi

MAX="${TALOS_VERIFIED_MAX:-20}"
case "$MAX" in '' | *[!0-9]* | 0) MAX=20 ;; esac
SHOW=3
LOGCHECKED=""
BAD=0 ERR=0 SHOWN=0
note() { # note <line>: stderr and the log; a log that cannot be written is said once, never fatal
  echo "verified-trailer: $1" >&2
  if [ -n "$LOG" ]; then
    if [ -z "$LOGCHECKED" ]; then # once per run: a log past 256 KiB keeps only its last 500 lines
      LOGCHECKED=1
      if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
        tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG" 2>/dev/null
      fi
    fi
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG" 2>/dev/null || {
      [ -n "${LOGWARNED:-}" ] || echo "verified-trailer: cannot write the log $LOG" >&2
      LOGWARNED=1
    }
  fi
}

# the trailer's value of one commit: empty when there is none
trailer_of() {
  git log -1 --format=%B "$1" 2>/dev/null | git interpret-trailers --parse 2>/dev/null | sed -n 's/^[Vv]erified:[[:space:]]*//p' | tail -n 1
}

valid() { # valid <value>: evidence text, or "none" + a dash + a reason
  local v="$1"
  [ -n "$v" ] || return 1
  case "$v" in
    none | None | NONE) return 1 ;;
    none[[:space:]]* | None[[:space:]]* | NONE[[:space:]]*)
      local rest="${v#[Nn][Oo][Nn][Ee]}"
      rest="${rest#"${rest%%[![:space:]]*}"}"
      case "$rest" in
        "—"* | "–"* | -* | :*) rest="${rest#"—"}"; rest="${rest#"–"}"; rest="${rest#[-:]}" ;;
        *) return 1 ;;
      esac
      rest="${rest#"${rest%%[![:space:]]*}"}"
      [ -n "$rest" ] || return 1
      return 0
      ;;
  esac
  return 0
}

while read -r sha base; do
  [ -n "${sha:-}" ] || continue
  args=("$sha")
  if [ "${base:-none}" != none ]; then args=("$base..$sha"); fi
  [ -z "${TALOS_VERIFIED_NOT:-}" ] || args+=(--not "$TALOS_VERIFIED_NOT")
  # one more than the cap, so "there were more" is known without walking the rest of the history
  commits="$(git rev-list --no-merges -n $((MAX + 1)) "${args[@]}" 2>&1)" || {
    note "could not list the commits of ${sha:0:12} (${commits%%$'\n'*})"
    ERR=1
    continue
  }
  if [ "$(printf '%s\n' "$commits" | grep -c .)" -gt "$MAX" ]; then
    commits="$(printf '%s\n' "$commits" | head -n "$MAX")"
    note "${sha:0:12} has more than $MAX commits to check: only the newest $MAX were checked"
  fi
  for c in $commits; do
    v="$(trailer_of "$c")"
    if ! valid "$v"; then
      BAD=$((BAD + 1))
      [ "$SHOWN" -lt "$SHOW" ] || continue # a count at the end, not a line each
      SHOWN=$((SHOWN + 1))
      subject="$(git log -1 --format=%s "$c" 2>/dev/null)"
      if [ -z "$v" ]; then note "commit ${c:0:9} has no Verified: trailer (${subject:0:70})"
      else note "commit ${c:0:9} has an unusable Verified: trailer \"${v:0:60}\" (\"none\" needs a dash and a reason)"; fi
    fi
  done
done
if [ "$BAD" -gt 0 ]; then
  if [ "$BAD" -eq 1 ]; then note "1 commit lacks a valid Verified: trailer"
  else note "$BAD commits lack a valid Verified: trailer (the first $SHOW are named above)"; fi
fi

if [ "$MODE" = enforce ] && { [ "$BAD" -gt 0 ] || [ "$ERR" -gt 0 ]; }; then
  echo "verified-trailer: REFUSED (enforce): end each commit message with 'Verified: <what was driven; evidence path>' or 'Verified: none - <reason>'" >&2
  exit 1
fi
exit 0
