#!/usr/bin/env bash
# Fails when the repo contains personal data. It can run as a hard stop (docs/CI-LOCAL.md, "The personal-data scan").
# By default the pre-push hook (scripts/pre-push.sh) and the check job of every local-ci run call it too, and both
# only warn on a failure. The generic list is in the repo. A maintainer may keep a private list, scripts/personal-denylist.txt,
# which is gitignored: a hook in a worktree finds it in the main checkout and passes it in CHECK_EXTRA_RULES. A machine without
# it checks the generic list only.
#
#   scripts/check-no-personal.sh [root]        root defaults to $CHECK_ROOT, then the git top level
#
# Rule files are tab-separated, one rule per line:
#   PATH_RE <TAB> FLAGS <TAB> PATTERN [<TAB> ALLOW_RE]
#   PATH_RE   ERE matched against the repo-relative path; a leading "!" means "files that do NOT match".
#   FLAGS     "-" (case sensitive) or "i" (case insensitive)
#   PATTERN   ERE searched in each matching file
#   ALLOW_RE  optional ERE; a hit whose "file:line:match" text matches it is ignored (anchor it on the match end)
# Lines starting with # and blank lines are ignored.
# A failure prints "[rule file, rule line N] path:line" and never the matched text, so a hit on a private rule can't leak it.
#
# Private documents: every line of the "## Appendix P" section of a design doc kept OUTSIDE the repo is a fixed-string
# pattern too (docs/SCHEDULES.md is copied from such a doc). Name the docs in CHECK_PRIVATE_DOCS (colon-separated) or,
# one path per line, in the gitignored scripts/private-docs.txt. Hits print as file:line only, never the private text.
# A named doc without an "## Appendix P" heading is an error (exit 2), so a renamed heading can't silently pass.
#
# CHECK_ALL_FILES=1: check every file under the root, as text, with nothing skipped (for a folder of exactly the files a push
# carries, scripts/check-ref-personal.sh): no node_modules / lockfile / binary-extension exclusion, binaries read with grep -a, and
# a file named like the private list (personal-denylist.txt, private-docs.txt) is a hit by its name. The generic list alone keeps
# the default exclusions (its shapes match byte noise in images and lockfiles, and it would match itself); every other list (the
# private one) reads every file. Without it, the defaults above are unchanged.
set -euo pipefail

ROOT="${1:-${CHECK_ROOT:-}}"
if [ -z "$ROOT" ]; then ROOT="$(git rev-parse --show-toplevel)"; fi
# Inside a git hook GIT_DIR (and friends) point at the repository being pushed from. They must not steer this script's own git calls.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_PREFIX
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # before the cd: the script may have been called by a relative path
cd "$ROOT"
RULE_FILES=()
[ -f "$HERE/denylist.generic.txt" ] && RULE_FILES+=("$HERE/denylist.generic.txt")
[ -f "$HERE/personal-denylist.txt" ] && RULE_FILES+=("$HERE/personal-denylist.txt")
# CHECK_EXTRA_RULES: more rule files, colon-separated. A named file that is not there is an error, not a quiet pass.
if [ -n "${CHECK_EXTRA_RULES:-}" ]; then
  IFS=':' read -r -a _extra <<<"$CHECK_EXTRA_RULES"
  for f in ${_extra[@]+"${_extra[@]}"}; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || { echo "check-no-personal: a rule file named in CHECK_EXTRA_RULES does not exist" >&2; exit 2; }
    RULE_FILES+=("$f")
  done
fi
if [ "${#RULE_FILES[@]}" -eq 0 ]; then echo "check-no-personal: no rule files found" >&2; exit 2; fi

# Files to scan: tracked + untracked-not-ignored in a git checkout, otherwise everything under ROOT. The list is NUL-separated end to
# end ($LIST), so a name with a quote, a tab, a space or non-ASCII letters is scanned like any other: git would otherwise print
# such a name quoted, and a "does the file exist" filter would drop it, leaving the check to print ok over a file it never read.
LIST="$(mktemp)"
trap 'rm -f "$LIST" "$LIST.all" "$LIST.hits" "$LIST.sel" "$LIST.sel2" "$LIST.pats" "$LIST.err"' EXIT
ALL="${CHECK_ALL_FILES:-}"
BINARY=-I # skip binary files
[ -n "$ALL" ] && BINARY=-a
# The scan matches bytes, in the C locale, for every caller and in every locale: under a UTF-8 locale grep passes over a line with
# a byte that is not UTF-8, so a Latin-1 line holding a value would read as clean. What a UTF-8 locale gave a rule is rebuilt in
# bytes instead (BYTE_RE), so nothing depends on which locales are installed. (Set before any grep, find or regex.)
export LC_ALL=C
# BYTE_RE: a rule's pattern, rewritten for byte matching. Each rewrite only ever matches more, never less:
#   - a non-ASCII letter becomes a group; in an "i" rule, a group of its lower and upper UTF-8 forms, as bytes
#   - "." becomes one byte, or one whole UTF-8 character (under C alone it matched one byte of it)
#   - a negated set, or one with a POSIX class, also takes one whole UTF-8 character
#   - a set that holds a non-ASCII byte is refused (exit 3): write those letters as an alternation, e.g. (x|y)
#   - a back reference in a rule that needed any of the above is refused (exit 4): the new groups would renumber it
#   - a rule that is not valid UTF-8 is refused (exit 7), and so is one mixing non-ASCII bytes with \b, \B, \w, \W, \< or \>
#     (exit 6): those look at one byte at a time, so they are not reliable on multi-byte letters
# It reads and writes raw bytes (binmode), and runs with PERL_UNICODE, PERL5OPT and PERL5LIB unset, so nothing in the caller's
# environment can re-encode a rule or change what the program does.
# shellcheck disable=SC2016
BYTE_RE='
use strict; use warnings; use Encode ();
binmode STDIN, ":raw"; binmode STDOUT, ":raw";
my $icase = $ARGV[0] eq "i";
local $/; my $p = <STDIN>; $p = "" unless defined $p;
{ my $c = $p; exit 7 unless utf8::decode($c); }
exit 6 if $p =~ /[\x80-\xFF]/ && $p =~ /\\[bBwW<>]/;
my $MB = "[\xC2-\xF4][\x80-\xBF]{1,3}";
my $ANY = "([\x01-\x7F]|$MB|[\x80-\xFF])";
my ($out, $changed, $backref, $i, $n) = ("", 0, 0, 0, length $p);
sub char_at { my ($s, $k) = @_; my $b = ord substr($s, $k, 1);
  my $len = $b >= 0xF0 ? 4 : $b >= 0xE0 ? 3 : $b >= 0xC0 ? 2 : 1; return substr($s, $k, $len); }
sub letter { my ($c) = @_; my $u = eval { Encode::decode("UTF-8", $c, Encode::FB_CROAK | Encode::LEAVE_SRC) };
  return "($c)" unless defined $u && $icase;
  my %f = map { (Encode::encode("UTF-8", $_) => 1) } ($u, lc $u, uc $u);
  return "(" . join("|", sort keys %f) . ")"; }
while ($i < $n) {
  my $ch = substr($p, $i, 1);
  if ($ch eq "\\") {
    my $nx = $i + 1 < $n ? char_at($p, $i + 1) : "";
    $backref = 1 if $nx =~ /^[1-9]$/;
    if (length($nx) && ord($nx) >= 0x80) { $out .= letter($nx); $changed = 1 } else { $out .= "\\" . $nx }
    $i += 1 + length($nx); next;
  }
  if ($ch eq ".") { $out .= $ANY; $changed = 1; $i++; next }
  if ($ch eq "[") {
    my $j = $i + 1; my $neg = 0;
    if ($j < $n && substr($p, $j, 1) eq "^") { $neg = 1; $j++ }
    $j++ if $j < $n && substr($p, $j, 1) eq "]";
    while ($j < $n && substr($p, $j, 1) ne "]") {
      if (substr($p, $j, 2) =~ /^\[[:=.]$/) { my $t = substr($p, $j + 1, 1); my $e = index($p, "$t]", $j + 2); exit 5 if $e < 0; $j = $e + 2; next }
      $j++;
    }
    exit 5 if $j >= $n;
    my $set = substr($p, $i, $j - $i + 1);
    exit 3 if $set =~ /[\x80-\xFF]/;
    if ($neg || $set =~ /\[:(alpha|alnum|lower|upper|print|graph|punct):\]/) { $out .= "($set|$MB)"; $changed = 1 } else { $out .= $set }
    $i = $j + 1; next;
  }
  if (ord($ch) >= 0x80) { my $c = char_at($p, $i); $out .= letter($c); $changed = 1; $i += length $c; next }
  $out .= $ch; $i++;
}
exit 4 if $backref && $changed;
print $out;
'
EXCLUDE='(^|/)node_modules/|^pnpm-lock\.yaml$|\.(png|jpg|jpeg|gif|webp|ico|woff2?|mp3|mp4|m4a|pdf|zip)$|^scripts/(denylist\.generic|personal-denylist|private-docs)\.txt$'
# The listing goes to a file first, so a failed git or find is an error (exit 2), never a shorter list that passes.
# CHECK_NO_GIT=1: always find (the pre-push hook hands over a folder of exactly the pushed files).
if [ -z "${CHECK_NO_GIT:-}" ] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -c core.quotePath=off -C "$ROOT" ls-files -coz --exclude-standard > "$LIST.all" || { echo "check-no-personal: git ls-files failed; nothing was checked" >&2; exit 2; }
else
  if [ -n "$ALL" ]; then nm=(); else nm=(-not -path '*/node_modules/*'); fi
  find . \( -type f -o -type l \) -not -path './.git/*' ${nm[@]+"${nm[@]}"} -print0 > "$LIST.all" || { echo "check-no-personal: find failed; nothing was checked" >&2; exit 2; }
fi
# A write that fails (a full disk) must stop the check: an empty list would read as a clean repository.
while IFS= read -r -d '' f; do
  f="${f#./}"
  [ -z "$ALL" ] && [[ "$f" =~ $EXCLUDE ]] && continue
  if [ -f "$f" ]; then printf '%s\0' "$f" || exit 2; fi
done < "$LIST.all" > "$LIST" || { echo "check-no-personal: could not write the file list (disk full?); nothing was checked" >&2; exit 2; }

: > "$LIST.hits"
# A file named like the private list is personal data by its name, whatever it holds (CHECK_ALL_FILES only: in a checkout the
# list sits there on purpose, gitignored).
if [ -n "$ALL" ]; then
  while IFS= read -r -d '' f; do
    case "$f" in personal-denylist.txt | */personal-denylist.txt | private-docs.txt | */private-docs.txt)
      printf '[private list file] %s:1\n' "$f" ;;
    esac
  done < "$LIST" >> "$LIST.hits" || { echo "check-no-personal: the file-name check failed; nothing was checked" >&2; exit 2; }
fi

# ---- symlinks ------------------------------------------------------------------------------------------------------
# A link's target is not file content, so the scan below never reads it (and a link to a folder is not even listed). A link
# whose target is an absolute path, or a relative one that leads out of the repository, names a place on one machine (a home
# folder, a dependency folder): a hit. The target is never printed, as no matched text is.
leaves_repo() { # $1: the link's path from the root, $2: its relative target. True when the target climbs above the root.
  local depth=0 seg
  local -a parts
  IFS=/ read -r -a parts <<<"$(dirname -- "$1")/$2"
  for seg in ${parts[@]+"${parts[@]}"}; do
    case "$seg" in
      '' | .) ;;
      ..)
        depth=$((depth - 1))
        [ "$depth" -lt 0 ] && return 0
        ;;
      *) depth=$((depth + 1)) ;;
    esac
  done
  return 1
}
while IFS= read -r -d '' f; do
  f="${f#./}"
  [ -L "$f" ] || continue
  t="$(readlink -- "$f")" || { echo "check-no-personal: a link could not be read; nothing is known clean" >&2; exit 2; }
  case "$t" in
    /*) printf '[symlink] %s: its target is an absolute path\n' "$f" ;;
    *) if leaves_repo "$f" "$t"; then printf '[symlink] %s: its target leads out of the repository\n' "$f"; fi ;;
  esac
done < "$LIST.all" >> "$LIST.hits" || { echo "check-no-personal: the link check failed; nothing was checked" >&2; exit 2; }

TAB=$'\t'
# A regular expression grep -E refuses (exit 2) would match nothing, and the scan would say ok: a rule that is not a valid
# regex is an error, like every other way this check can fail (closed, never open).
valid_re() { local rc=0; printf 'x\n' | grep -E -- "$1" >/dev/null 2>&1 || rc=$?; [ "$rc" -lt 2 ]; }
for rules in "${RULE_FILES[@]}"; do
  rule_line=0
  while IFS= read -r line || [ -n "$line" ]; do
    rule_line=$((rule_line + 1))
    case "$line" in ''|'#'*) continue ;; esac
    IFS="$TAB" read -r path_re flags pattern allow <<<"$line"
    # The rule text is never printed (a private rule is the value itself): only which file and which line.
    [ -z "${pattern:-}" ] && { echo "check-no-personal: bad rule at $(basename "$rules") line $rule_line (not printed)" >&2; exit 2; }
    for _re in "${path_re#!}" "$pattern" ${allow:+"$allow"}; do
      valid_re "$_re" || { echo "check-no-personal: bad rule at $(basename "$rules") line $rule_line: not a valid regular expression (not printed)" >&2; exit 2; }
    done
    if [ "${path_re#!}" != "$path_re" ]; then
      grep -zEv -- "${path_re#!}" "$LIST" > "$LIST.sel" || true
    else
      grep -zE -- "$path_re" "$LIST" > "$LIST.sel" || true
    fi
    # The generic shapes (an email, a phone number) match byte noise in images and lockfiles, and the generic list would match
    # itself: in CHECK_ALL_FILES it keeps the default exclusions. Every other list (the private one) reads everything.
    if [ -n "$ALL" ] && [ "$rules" = "$HERE/denylist.generic.txt" ]; then
      grep -zEv -- "$EXCLUDE" "$LIST.sel" > "$LIST.sel2" || true
      mv "$LIST.sel2" "$LIST.sel"
    fi
    [ -s "$LIST.sel" ] || continue
    iflag=""; [ "$flags" = "i" ] && iflag="-i"
    # the pattern in bytes (see BYTE_RE); a rule that holds nothing it touches is used as it is
    case "$pattern" in
      *[.[\\]* | *[![:print:]]*) need_rw=1 ;;
      *) need_rw=0 ;;
    esac
    if [ "$need_rw" = 1 ]; then
      _rw=0
      bpat="$(printf '%s' "$pattern" | env -u PERL_UNICODE -u PERL5OPT -u PERL5LIB perl -e "$BYTE_RE" "$flags")" || _rw=$?
      case "$_rw" in
        0) ;;
        3) echo "check-no-personal: $(basename "$rules") line $rule_line has a bracket set with non-ASCII letters, which a byte match can't hold; write them as an alternation, e.g. (x|y) (rule not printed)" >&2; exit 2 ;;
        6) echo "check-no-personal: $(basename "$rules") line $rule_line mixes non-ASCII letters with \\b, \\B, \\w, \\W, \\< or \\>, which are not reliable byte-wise (rule not printed)" >&2; exit 2 ;;
        7) echo "check-no-personal: $(basename "$rules") line $rule_line is not valid UTF-8 (rule not printed)" >&2; exit 2 ;;
        4) echo "check-no-personal: $(basename "$rules") line $rule_line has a back reference and non-ASCII or \".\" parts, which the byte rewrite would renumber (rule not printed)" >&2; exit 2 ;;
        *) echo "check-no-personal: $(basename "$rules") line $rule_line could not be rewritten for byte matching (exit $_rw; rule not printed); nothing is known clean" >&2; exit 2 ;;
      esac
      [ -n "$bpat" ] || { echo "check-no-personal: $(basename "$rules") line $rule_line: its byte form came out empty; nothing is known clean (rule not printed)" >&2; exit 2; }
      valid_re "$bpat" || { echo "check-no-personal: $(basename "$rules") line $rule_line: its byte form is not a valid regular expression (not printed)" >&2; exit 2; }
    else
      bpat="$pattern"
    fi
    # shellcheck disable=SC2086
    # No match is grep's exit 1, which xargs passes on as 123 (GNU) or 1 (BSD: any 1-125 is 1). So the exit alone cannot tell
    # "no match" from a grep error on a Mac; grep always says why on stderr, and that is what fails the scan closed (a file it
    # could not read, a grep killed part way), as does an exit xargs only gives for its own trouble (124-127, a signal).
    # The messages are not printed (they can name private paths).
    _rc=0
    hits="$(xargs -0 grep -nHoE $BINARY $iflag -- "$bpat" < "$LIST.sel" 2>"$LIST.err")" || _rc=$?
    if { [ "$_rc" != 0 ] && [ "$_rc" != 1 ] && [ "$_rc" != 123 ]; } || [ -s "$LIST.err" ]; then
      echo "check-no-personal: the scan for $(basename "$rules") line $rule_line failed (grep exit $_rc); nothing is known clean" >&2; exit 2
    fi
    [ -z "$hits" ] && continue
    if [ -n "${allow:-}" ]; then hits="$(printf '%s\n' "$hits" | grep -Ev -- "$allow" || true)"; fi
    [ -z "$hits" ] && continue
    # Name the rule (rule file + its line number) and the offending file:line. The matched text is deliberately NOT printed:
    # with the private denylist it would be the personal value itself. Open the rule line to see what it looks for.
    printf '%s\n' "$hits" | cut -d: -f1,2 | sed "s#^#[$(basename "$rules") rule line $rule_line] #" >> "$LIST.hits"
  done < "$rules"
done

# ---- private documents ------------------------------------------------------------------------------------------
PRIVATE_DOCS=()
if [ -n "${CHECK_PRIVATE_DOCS:-}" ]; then
  IFS=':' read -r -a _docs <<<"$CHECK_PRIVATE_DOCS"
  for d in ${_docs[@]+"${_docs[@]}"}; do [ -n "$d" ] && PRIVATE_DOCS+=("$d"); done
fi
if [ -f "$HERE/private-docs.txt" ]; then
  while IFS= read -r d || [ -n "$d" ]; do
    case "$d" in ''|'#'*) continue ;; esac
    PRIVATE_DOCS+=("$d")
  done < "$HERE/private-docs.txt"
fi
PATS="$LIST.pats"
: > "$PATS"
for doc in ${PRIVATE_DOCS[@]+"${PRIVATE_DOCS[@]}"}; do
  if [ ! -f "$doc" ]; then echo "check-no-personal: a named private doc does not exist" >&2; rm -f "$PATS"; exit 2; fi
  if ! grep -q '^## Appendix P' "$doc"; then
    echo "check-no-personal: a named private doc has no '## Appendix P' section" >&2; rm -f "$PATS"; exit 2
  fi
  # the section's lines, markdown markers trimmed, 24+ characters (shorter lines are too generic to be a signal)
  awk '/^## Appendix P/{on=1; next} on && /^## /{on=0} on{print}' "$doc" \
    | sed -E 's/^[[:space:]]*([-*>|#]+[[:space:]]*|[0-9]+\.[[:space:]]+)*//; s/[[:space:]|]+$//' \
    | awk 'length($0) >= 24' >> "$PATS"
done
if [ -s "$PATS" ]; then
  hits="$(xargs -0 grep -nHF $BINARY -f "$PATS" < "$LIST" 2>/dev/null | cut -d: -f1,2 || true)"
  if [ -n "$hits" ]; then printf '%s\n' "$hits" | sed 's#^#[private-doc] #' >> "$LIST.hits"; fi
fi
rm -f "$PATS"

if [ -s "$LIST.hits" ]; then
  echo "check-no-personal: FAILED" >&2
  sort -u "$LIST.hits" >&2
  echo "check-no-personal: $(sort -u "$LIST.hits" | wc -l | tr -d ' ') hit(s). Use owner / Alex Example / alex@example.com / example.com / UTC." >&2
  exit 1
fi
echo "check-no-personal: ok ($(tr -cd '\0' < "$LIST" | wc -c | tr -d ' ') files, ${#RULE_FILES[@]} rule file(s))"
