#!/usr/bin/env bash
# Runs the personal-data check (scripts/check-no-personal.sh) on everything a ref brings in: every commit in base..ref (all parents,
# so a value added and removed again inside one push, or inside a merged branch, is still found), each commit's own changed files
# as committed, its message, and the list of its changed paths as text.
#
#   scripts/check-ref-personal.sh <ref> [<base>]
#   scripts/check-ref-personal.sh --tree <ref>      every file of <ref>'s tree, and every path in it, once
#
# <base> defaults to the merge-base of <ref> with the main branch (origin/main, or main in a repository without a remote), or to
# <ref>'s first parent when <ref> is already on main (so a merge commit brings in the commits it merged). A root commit is compared
# with the empty tree. CHECK_MAX_COMMITS (default 500) caps the commits one run reads: more is an error, never a partial pass.
#
# Nothing is skipped: binaries (read with grep -a), node_modules, lockfiles, PDFs. A file named like the private list is a hit by
# its name. UTF-16 text (with a byte-order mark) is converted before the scan. A link is checked as its link text, never followed,
# and a target that is absolute or leaves the repository is a hit. A name that is not valid UTF-8 is checked under a %XX-escaped
# name; ":", "%" and control characters in a name are written as %XX too, so a printed path:line is never cut wrong. A path that
# is absolute or has an empty, "." or ".." part is refused: a note, and exit 2. Who made a commit or tag (author, committer,
# tagger) is not checked: the owner ruled it is not personal data in this sense. A submodule entry, and UTF-16 text that does not
# decode, are printed as notes.
# The files are copied out of git into a temp folder: no worktree, index or ref is read or moved. The folder is removed on exit.
#
# Rules: the generic list next to this script, plus scripts/personal-denylist.txt found the way scripts/gate.sh finds it (here, or
# in the main checkout of the repository this script lives in), plus any file in CHECK_EXTRA_RULES (colon-separated).
# CHECK_REPO: the repository to read (default: the current directory; it may be a bare clone).
# CHECK_REF_NAME: a ref name to check as text (path ".ref-name"). CHECK_TAG_OBJECT: an annotated tag whose message is checked too
# (path ".tag-message.<sha12>"). Both are reported against the tag object, or the ref's commit.
#
# Output, one line per hit:   <sha12> <path>:<line> [<rule file> rule line N]
#   <sha12> is the commit (or tag) the hit is in. A path that itself hits is never printed: it shows as
#   "<path hidden #N>@<sha12>", and the hit on the name itself as "<path hidden #N>@<sha12>:name".
#   A note:  note: <sha12> <path> submodule entry, its contents are not checked
# The matched text is never printed. Exit: 0 clean (notes allowed), 1 hits, 2 an error (nothing is known clean).
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_PREFIX

die() { echo "check-ref-personal: $*" >&2; exit 2; }
TREE=0
if [ "${1:-}" = --tree ]; then TREE=1; shift; fi
{ [ $# -ge 1 ] && [ $# -le 2 ] && [ -n "$1" ] && { [ "$TREE" = 0 ] || [ $# -eq 1 ]; }; } ||
  die "usage: check-ref-personal.sh <ref> [<base>] | --tree <ref>"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/check-no-personal.sh"
[ -f "$CHECK" ] || die "check-no-personal.sh is missing next to this script"
command -v perl >/dev/null || die "perl is needed to copy files out of git"
REPO="${CHECK_REPO:-$PWD}"
g() { git -C "$REPO" "$@"; }

sha="$(g rev-parse --verify -q "$1^{commit}")" || die "not a commit: the ref given could not be resolved"
base=""
if [ "$TREE" = 0 ]; then
  if [ $# -eq 2 ]; then
    base="$(g rev-parse --verify -q "$2^{commit}")" || die "not a commit: the base given could not be resolved"
  else
    main=""
    for m in refs/remotes/origin/main refs/heads/main; do
      if main="$(g rev-parse --verify -q "$m^{commit}")"; then break; fi
      main=""
    done
    [ -n "$main" ] || die "no main branch (origin/main or main) to find a base from; give one"
    base="$(g merge-base "$sha" "$main")" || base=""
    if [ -z "$base" ] || [ "$base" = "$sha" ]; then
      base="$(g rev-parse --verify -q "$sha^1^{commit}")" || base=""
    fi
  fi
fi

# Rule files: the private list the way the gate finds it, then CHECK_EXTRA_RULES (check-no-personal reads that itself).
EXTRA="${CHECK_EXTRA_RULES:-}"
if [ ! -f "$HERE/personal-denylist.txt" ]; then
  common="$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" && mainco="$(dirname "$common")" || mainco=""
  if [ -n "$mainco" ] && [ -f "$mainco/scripts/personal-denylist.txt" ]; then
    EXTRA="${EXTRA:+$EXTRA:}$mainco/scripts/personal-denylist.txt"
  fi
fi

D="$(mktemp -d "${TMPDIR:-/tmp}/talos-ref-personal.XXXXXX")" || die "could not make a temp folder"
trap 'rm -rf "$D"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# The exporter: lists one commit's changed entries (or a whole tree) and writes each into numbered folders under <root>, byte for
# byte. A path goes into the first folder where nothing of the same name (case or normalisation ignored by the disk) is in its way.
# Beside the folders: map (N <TAB> name as written <TAB> name as shown), notes (submodules), symhits (links that point out of the repository).
# shellcheck disable=SC2016
EXPORT='
use strict; use warnings;
use IPC::Open2; use File::Path qw(make_path); use Encode (); use Digest::SHA qw(sha1_hex);
my ($repo, $mode, $sha, $root) = @ARGV;
my $s12 = substr($sha, 0, 12);
my @entries;
{
  local $/ = "\0";
  my @cmd = $mode eq "tree"
    ? ("git", "-C", $repo, "ls-tree", "-r", "-z", "--full-tree", "--full-name", $sha)
    : ("git", "-C", $repo, "diff-tree", "-r", "-z", "--no-renames", "--diff-filter=d", "-c", "--root", "--no-commit-id", "--full-index", $sha);
  open(my $fh, "-|", @cmd) or die "git listing: $!\n";
  if ($mode eq "tree") {
    while (my $rec = <$fh>) { chomp $rec; my ($meta, $path) = split /\t/, $rec, 2; my ($m, undef, $b) = split / /, $meta; push @entries, [$m, $b, $path]; }
  } else {
    while (my $meta = <$fh>) {
      chomp $meta; my $path = <$fh>; die "git listing: short record\n" unless defined $path; chomp $path;
      $meta =~ s/^(:+)//; my $p = length($1); my @f = split / /, $meta;
      push @entries, [$f[$p], $f[2 * $p + 1], $path];
    }
  }
  close($fh) or die "git listing failed\n";
}
# A path that could leave the export folder (absolute, or a "", "." or ".." part) is refused: git itself never writes one, so a
# tree that holds one was made by hand. The commit fails the check (exit 2); nothing in it is called clean.
for my $e (@entries) {
  my $p = $e->[2];
  if ($p =~ m{^/} || grep { $_ eq "" || $_ eq "." || $_ eq ".." } split(m{/}, $p, -1)) {
    open(my $r, ">", "$root/refused") or die; close $r; die "a path that leaves the export folder\n";
  }
}
# The name a path is written under: ":", "%" and control characters (tab, newline) as %XX always, and bytes that are not UTF-8 as
# %XX too, so each "path:line" line the scanner prints can be split at its last colon and a path is matched back byte for byte.
sub safe {
  my ($p) = @_; my $c = $p; my $utf8 = utf8::decode($c);
  $p =~ s/([\x00-\x1f:%\x7f])/sprintf("%%%02X", ord $1)/ge;
  $p =~ s/([\x80-\xff])/sprintf("%%%02X", ord $1)/ge unless $utf8;
  return $p;
}
# Where a path is written: its escaped name, but a part longer than 200 bytes (escaping can push a legal name past the 255 a disk
# allows) as "~<hash>" plus its extension, so path rules on folders and extensions still apply. Output shows the escaped name.
sub fit {
  my ($sp) = @_;
  return join "/", map { length($_) > 200 ? "~" . substr(sha1_hex($_), 0, 16) . (/(\.[A-Za-z0-9]{1,10})$/ ? $1 : "") : $_ } split m{/}, $sp, -1;
}
sub place {
  my ($rel) = @_;
  for my $k (1 .. 50) {
    my $t = "$root/$k/$rel"; next if -e $t || -l $t;
    (my $dir = $t) =~ s{/[^/]*$}{};
    if (!-d $dir) { make_path($dir, { error => \my $err }); next unless -d $dir; }
    return $t;
  }
  die "too many colliding paths\n";
}
sub put { my ($rel, $data) = @_; my $t = place($rel); open(my $fh, ">:raw", $t) or die "write: $!\n"; print $fh $data or die "write: $!\n"; close($fh) or die "write: $!\n"; }
sub leaves {
  my ($p, $t) = @_; my @d = split m{/}, $p; pop @d; my $depth = @d;
  for my $s (split m{/}, $t) { next if $s eq "" || $s eq "."; if ($s eq "..") { return 1 if --$depth < 0 } else { $depth++ } }
  return 0;
}
my $pid = open2(my $out, my $in, "git", "-C", $repo, "cat-file", "--batch");
binmode $out; binmode $in; { my $o = select $in; $| = 1; select $o; }
sub blob {
  my ($b) = @_; local $/ = "\n";
  print $in "$b\n"; my $h = <$out>; die "cat-file: no answer\n" unless defined $h; chomp $h;
  my (undef, $type, $size) = split / /, $h; die "cat-file: an object is missing\n" unless defined $size && $type eq "blob";
  my $d = ""; while (length($d) < $size) { my $r = read($out, $d, $size - length($d), length($d)); die "cat-file: short read\n" unless $r; }
  read($out, my $nl, 1); return $d;
}
open(my $map, ">", "$root/map") or die; open(my $notes, ">", "$root/notes") or die; open(my $sym, ">", "$root/symhits") or die;
my ($n, @paths) = (0);
for my $e (@entries) {
  my ($m, $b, $path) = @$e; $n++;
  (my $line = $path) =~ s/[\r\n]/ /g; push @paths, $line;
  my $sp = safe($path); my $xp = fit($sp);
  print $map "$n\t$xp\t$sp\n";
  if ($m eq "160000") { print $notes "$n\tsubmodule entry, its contents are not checked\n"; next; }
  my $data = blob($b);
  if ($m eq "120000") {
    print $sym "[symlink: its target leaves the repository] $xp:1\n" if $data =~ m{^/} || leaves($sp, $data);
  } elsif ($data =~ /^(?:\xFF\xFE|\xFE\xFF)/) {
    my $u = eval { Encode::encode("UTF-8", Encode::decode("UTF-16", $data, Encode::FB_CROAK)) };
    if (defined $u) { $data = $u } else { print $notes "$n\tUTF-16 text that does not decode, checked as raw bytes only\n" }
  }
  put($xp, $data);
}
close $in; waitpid($pid, 0); die "cat-file failed\n" if $?;
put(($mode eq "tree" ? ".tree-paths." : ".changed-paths.") . $s12, join("", map { "$_\n" } @paths)) if @paths;
if ($mode ne "tree") {
  open(my $lg, "-|", "git", "-C", $repo, "log", "-1", "--format=%B", $sha) or die "git log: $!\n";
  local $/; my $msg = <$lg>; close($lg) or die "git log failed\n"; put(".commit-message.$s12", defined $msg ? $msg : "");
}
close $map or die; close $notes or die; close $sym or die;
'

# Rewrites the scanner's "[<rule>] <path>:<line>" lines as "<sha12> <path>:<line> [<rule>]", hiding every path whose name hits.
# shellcheck disable=SC2016
REWRITE='
BEGIN { FS = "\t" }
FILENAME == ARGV[1] { split($0, a, "\t"); name[a[1]] = a[2]; disp[a[2]] = a[3]; next }
FILENAME == ARGV[2] { note[++nn] = $1; nmsg[nn] = substr($0, length($1) + 2); next }
{
  i = index($0, "] "); if (substr($0, 1, 1) != "[" || i == 0) next
  tag = substr($0, 1, i); rest = substr($0, i + 2)
  j = match(rest, /:[^:]*$/); if (j == 0) next
  path = substr(rest, 1, j - 1); line = substr(rest, j + 1)
  h[++nh] = path; hl[nh] = line; ht[nh] = tag
  if (path == paths && (line in name)) hidden[name[line]] = line
}
END {
  for (k = 1; k <= nh; k++) {
    if (h[k] == paths && (hl[k] in name)) print s12 " <path hidden #" hl[k] ">@" s12 ":name " ht[k]
    else if (h[k] in hidden) print s12 " <path hidden #" hidden[h[k]] ">@" s12 ":" hl[k] " " ht[k]
    else print s12 " " ((h[k] in disp) ? disp[h[k]] : h[k]) ":" hl[k] " " ht[k]
  }
  for (k = 1; k <= nn; k++) {
    p = name[note[k]]; if (p in hidden) p = "<path hidden #" note[k] ">@" s12; else p = disp[p]
    print "note: " s12 " " p " " nmsg[k]
  }
}
'

# scan <root> <sha12> <paths pseudo-file name>: the scanner over every numbered folder, rewritten lines appended to $D/out
scan() {
  local root="$1" s12="$2" pseudo="$3" dir r
  : > "$root/hits"
  for dir in "$root"/[0-9]*; do
    [ -d "$dir" ] || continue
    r=0
    CHECK_ALL_FILES=1 CHECK_NO_GIT=1 CHECK_EXTRA_RULES="$EXTRA" bash "$CHECK" "$dir" > "$root/out" 2> "$root/err" || r=$?
    case "$r" in
      0) ;;
      1) while IFS= read -r l; do case "$l" in '['*) printf '%s\n' "$l" ;; esac; done < "$root/err" >> "$root/hits" ;;
      *)
        cat "$root/err" >&2 # the scanner's own messages never carry matched text
        die "the personal-data check could not run on $s12 (exit $r); nothing is known clean"
        ;;
    esac
  done
  [ -f "$root/symhits" ] && cat "$root/symhits" >> "$root/hits"
  [ -f "$root/map" ] || : > "$root/map"
  [ -f "$root/notes" ] || : > "$root/notes"
  LC_ALL=C awk -v s12="$s12" -v paths="$pseudo" "$REWRITE" "$root/map" "$root/notes" "$root/hits" >> "$D/out" || die "could not read the scanner's output"
}

: > "$D/out"
# refused <root> <sha12>: the note for a tree with a path that leaves the export folder (its name is not printed)
refused() {
  [ -f "$1/refused" ] || return 0
  printf 'note: %s a path that is absolute or has an empty, "." or ".." part: the commit is refused, nothing in it is known clean\n' "$2"
}
if [ "$TREE" = 1 ]; then
  mkdir "$D/t"
  perl -e "$EXPORT" "$REPO" tree "$sha" "$D/t" || { refused "$D/t" "${sha:0:12}"; die "could not copy the tree out of git"; }
  scan "$D/t" "${sha:0:12}" ".tree-paths.${sha:0:12}"
else
  # The listing goes to a file first: a git that fails half way is an error, never a shorter list that passes.
  range=("$sha")
  [ -n "$base" ] && range+=("^$base")
  g rev-list "${range[@]}" > "$D/commits" || die "could not list the commits"
  max="${CHECK_MAX_COMMITS:-500}"
  [ "$(wc -l < "$D/commits")" -le "$max" ] || die "more than $max commits in the range; give a base"
  while IFS= read -r c; do
    mkdir "$D/c"
    perl -e "$EXPORT" "$REPO" commit "$c" "$D/c" || { refused "$D/c" "${c:0:12}"; die "could not copy commit ${c:0:12} out of git"; }
    scan "$D/c" "${c:0:12}" ".changed-paths.${c:0:12}"
    rm -rf "$D/c"
  done < "$D/commits"
fi

# The ref's own name, and an annotated tag's message
if [ -n "${CHECK_REF_NAME:-}" ] || [ -n "${CHECK_TAG_OBJECT:-}" ]; then
  label="$sha"
  mkdir -p "$D/r/1"
  if [ -n "${CHECK_TAG_OBJECT:-}" ]; then
    tag="$(g rev-parse --verify -q "${CHECK_TAG_OBJECT}^{tag}")" || die "not an annotated tag: CHECK_TAG_OBJECT"
    label="$tag"
    # the message: everything after the header's blank line
    g cat-file tag "$tag" > "$D/r/tag" || die "could not read the tag"
    awk 'body { print } /^$/ && !body { body = 1 }' "$D/r/tag" > "$D/r/1/.tag-message.${tag:0:12}" || die "could not read the tag"
    rm -f "$D/r/tag"
  fi
  if [ -n "${CHECK_REF_NAME:-}" ]; then printf '%s\n' "$CHECK_REF_NAME" > "$D/r/1/.ref-name"; fi
  scan "$D/r" "${label:0:12}" ""
fi

cat "$D/out"
while IFS= read -r l; do
  case "$l" in 'note: '*) ;; *) exit 1 ;; esac
done < "$D/out"
exit 0
