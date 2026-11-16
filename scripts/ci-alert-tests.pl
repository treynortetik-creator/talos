# ci-alert-tests.pl <log>: the failing tests one CI job's log names, one a line (ci-runner.sh alert, ci_alert_tests).
# Colours off first; then vitest's FAIL lines (FAIL first on the line, so a passing test that has the word in its name is not
# one), bun's "(fail)", and Playwright's "✘ <n> <test>" lines, with a [project] (apps/web) or without (the e2e package): a test
# whose retry passed ("✓ ... (retry #N)") was a flake and is left out, one that failed every try is named once, and they come
# after the others, once the retries are known. Swift Testing's "✘ Test <name> failed after" (not its issue, suite or
# whole-run lines) are held until scripts/ci-swift-retry.sh says what became of them: "running only them once more" drops them
# (the rerun's own ✘ lines are the last attempt; a test that passed there was a flake; a red rerun that named none, a build
# error say, keeps the first names), any other word of it, or the end of the log, keeps them. The time at the end goes.
use strict;
use warnings;
my (@st, @pre, @pw, %pw);
while (<<>>) {
  s/\e\[[\d;]*m//g;
  chomp;
  if (/^\s*FAIL\s+(.*\S)/) { print "$1\n" }
  elsif (/^\(fail\)\s+(.*?)(\s+\[[\d.]+m?s\])?\s*$/) { print "$1\n" }
  elsif (/(\xe2\x9c\x98|\xe2\x9c\x93)\s+\d+\s+(\[[^\]]+\]\s+\xe2\x80\xba.*|\S+:\d+:\d+\s+\xe2\x80\xba.*)$/) {
    my ($mark, $t) = ($1, $2);
    $t =~ s/\s*\([\d.]+(?:ms|s|m|h)\)\s*$//;
    my $retry = $t =~ s/\s*\(retry #\d+\)\s*$//;
    if ($mark eq "\xe2\x9c\x98") { push @pw, $t unless exists $pw{$t}; $pw{$t} = 1 }
    elsif ($retry && exists $pw{$t}) { $pw{$t} = 0 }
  }
  elsif (/^\s*\xe2\x9c\x98 Test (.+?)(?: with \d+ test cases?)? failed after / && $1 !~ /^(run with \d+ tests? in |case passing )/) { push @st, "$1\n" }
  elsif (/^ci-swift-retry: \d+ test\(s\) failed; running only them once more/) { @pre = @st; @st = () }
  elsif (/^ci-swift-retry: /) { @st = @pre if !@st && /failed again on retry|did not pass on the rerun/; print @st; @st = @pre = () }
}
print @st ? @st : @pre;
print map { "$_\n" } grep { $pw{$_} } @pw;
