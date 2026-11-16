# gate-excuse.pl <log> <vitest project root...>: what failed in one gate test step's log, for scripts/gate-excuse.sh (the gate's
# excuse for tests that are failing on main's tip already). One line per failing test, "test<TAB><name><TAB><file>" (the file
# empty when the log does not say it), and an "unaccounted<TAB><why>" line for anything that failed that is not one named test:
# an unhandled error, a test file that crashed or was killed, a Swift test, or a runner whose own count of failures is not the
# number of tests named. The names are the ones scripts/ci-alert-tests.pl reads (the same patterns; gate-excuse.sh checks the
# two agree on every log), with Vitest's project label in one form (canon, below): CI's coloured " scripts  a.test.ts" and the
# gate's plain "|scripts| a.test.ts" are one test.
# gate-excuse.pl --canon <vitest project root...>: names on stdin, one a line, written in that one form.
use strict;
use warnings;
my ($log, @roots) = @ARGV;
my %proj = map { my ($b) = m{([^/]+)$}; ($b => $_) } @roots;
sub canon {
  my $n = shift;
  $n =~ s/^\|([^|]+)\|\s+/|$1| /;
  $n =~ s/^(\S+)\s{2,}(?=\S)/exists $proj{$1} ? "|$1| " : $&/e;
  return $n;
}
if ($log eq '--canon') {
  while (<STDIN>) { chomp; print canon($_), "\n" if length }
  exit 0;
}
my (@why, %test, @order, %pw, @pwo, %badfile, %named_in);
my ($file, $vt, $vf, $bun, $pwf, $inbad) = ('', 0, 0, undef, 0, 0);
my $add = sub {
  my ($kind, $n, $f) = @_;
  return if exists $test{$n};
  $test{$n} = [$kind, $f];
  push @order, $n;
  $named_in{$f} = 1 if $f ne '';
};
my $fh;
unless (open $fh, '<', $log) { print "unaccounted\tthe step's log could not be read\n"; exit 0 }
while (<$fh>) {
  s/\e\[[\d;]*m//g;
  chomp;
  if ($inbad && /^- (\S+)(.*)$/) {
    my ($f, $rest) = ($1, $2);
    $badfile{"apps/bridge/$f"} = $rest;
    push @why, "a test file was killed at its time limit ($f)" if $rest =~ /killed after/;
    next;
  }
  $inbad = 0;
  # a bridge test file's own output begins: test-parallel's "<file>: exit N" (or its retry's), bun test's "<file>:"
  if (/^(test\/\S+\.test\.tsx?):(?: (?:failed again on retry: |failed, then passed on retry: )?exit -?\d+)?$/) { $file = "apps/bridge/$1" }
  elsif (/^\s*FAIL\s+(.*\S)/) {
    my $n = canon($1);
    my ($p, $rel) = $n =~ /^(?:\|([^|]+)\| )?(\S+?\.(?:test|spec)\.tsx?) > /;
    if (!defined $rel) { push @why, "a Vitest file failed with no test named ($n)"; next }
    my @c = defined $p ? (exists $proj{$p} ? ("$proj{$p}/$rel") : ()) : map { "$_/$rel" } @roots;
    @c = grep { -f } @c;
    $add->('vitest', $n, @c == 1 ? $c[0] : '');
  }
  elsif (/^\(fail\)\s+(.*?)(\s+\[[\d.]+m?s\])?\s*$/) { $add->('bun', $1, $file) }
  elsif (/(\xe2\x9c\x98|\xe2\x9c\x93)\s+\d+\s+(\[[^\]]+\]\s+\xe2\x80\xba.*|\S+:\d+:\d+\s+\xe2\x80\xba.*)$/) {
    my ($mark, $t) = ($1, $2);
    $t =~ s/\s*\([\d.]+(?:ms|s|m|h)\)\s*$//;
    my $retry = $t =~ s/\s*\(retry #\d+\)\s*$//;
    if ($mark eq "\xe2\x9c\x98") { push @pwo, $t unless exists $pw{$t}; $pw{$t} = 1 }
    elsif ($retry && exists $pw{$t}) { $pw{$t} = 0 }
  }
  elsif (/^\s*\xe2\x9c\x98 Test (.+?) failed after /) { push @why, "a Swift test failed ($1)" }
  elsif (/^\s*Test Files\s+(\d+) failed/) { $vf += $1 }
  elsif (/^\s*Tests\s+(\d+) failed/) { $vt += $1 }
  elsif (/^\s*(\d+) fail$/) { $bun = $1 } # bun's own total is its last such line (test-parallel prints each file's, then the sum)
  elsif (/^\s*(\d+) failed$/) { $pwf += $1 }
  elsif (/^test-parallel: FAILED \(/) { $inbad = 1 }
  # the runners' own words for an error outside a test (Vitest's "⎯⎯ Unhandled Errors ⎯⎯" and "Errors  N error", bun's "# Unhandled
  # error between tests" and " N error"), never a test that has the words in its name
  push @why, "an unhandled error" if /\xe2\x8e\xaf\s*Unhandled/ || /^\s*Errors\s+\d+ errors?/ || /^#?\s*Unhandled error between tests/ ||
    /^\s*\d+ errors?$/;
  push @why, "an error outside any test" if /not a part of any test/;
  push @why, "a test file was killed at its time limit" if /\(killed after \d+ s/;
  # Playwright tests that never ran (a stop, a serial group after its failure, a worker lost) or were cut off; the gate's own
  # time limit on the web specs
  push @why, "Playwright tests did not run or were interrupted" if /^\s*\d+ (?:did not run|interrupted)$/;
  push @why, "the step was stopped at its time limit" if /were stopped after \d+ s/;
}
close $fh;
for my $t (grep { $pw{$_} } @pwo) {
  my $f = $t =~ /^\[[^\]]+\]\s+\xe2\x80\xba\s+(\S+?):\d+:\d+\s/ ? "apps/web/$1" : $t =~ /^(\S+?):\d+:\d+\s/ ? "e2e/$1" : '';
  $add->('playwright', $t, -f $f ? $f : '');
}
my %n = (vitest => 0, bun => 0, playwright => 0);
my %vfiles;
for (@order) { my ($k, $f) = @{$test{$_}}; $n{$k}++; $vfiles{$f || $_} = 1 if $k eq 'vitest' }
push @why, "Vitest counts $vt failed test(s), and the log names $n{vitest}" if $vt != $n{vitest};
push @why, "Vitest counts $vf failed file(s), and the log names tests in " . keys(%vfiles) if $vf != keys %vfiles;
push @why, "bun counts " . ($bun // 'no') . " failed test(s), and the log names $n{bun}" if ($bun // -1) != $n{bun} && ($n{bun} || $bun);
push @why, "Playwright counts $pwf failed test(s), and the log names $n{playwright}" if $pwf != $n{playwright};
for (sort keys %badfile) { push @why, "$_ failed with no test of it named" unless $named_in{$_} }
push @why, "no failing test is named" unless @order;
print "unaccounted\t$_\n" for @why;
print "test\t$_\t$test{$_}[1]\n" for @order;
