# scripts/gate/group-run.pl <limit s> <cmd...>: how the gate runs the web browser specs (gate.sh, web_specs_run).
# The command runs in a process group of its own. At the limit, or when this process is stopped (TERM, INT, HUP), the group is asked
# to stop with INT, then (after GATE_STOP_WAIT seconds, 5 by default) TERM, then (after as long again) KILL. INT first because
# Playwright tears its web server down on INT only, and that server is in a group of its own that no group signal reaches: with TERM
# first it was left behind, holding the preview port of its heavy slot (scripts/heavy-lock.sh), and the next run's specs failed on it.
# Exit: the command's own code (128 + the signal that killed it), 142 at the limit (said on stderr, naming WEB_LIMIT_NAME), 143 stopped.
use strict;
use POSIX qw(WNOHANG EINTR);

my $lim = shift;
my $wait = $ENV{GATE_STOP_WAIT} // 5;
my $pid = fork() // die "fork: $!\n";
if (!$pid) { setpgrp(0, 0); exec @ARGV or die "exec: $!\n" }
setpgrp($pid, $pid);
my ($timed, $reaped, $st) = (0, 0, 0);
my $stop = sub {
  $SIG{$_} = "IGNORE" for qw(ALRM TERM INT HUP); # one stop: a second signal (the holder's TERM after its INT) must not start it over,
  # or Playwright would get a second INT before its web server is down
  for my $sig (qw(INT TERM)) {
    kill $sig, -$pid;
    for (1 .. int($wait * 10)) {
      if (!$reaped && waitpid($pid, WNOHANG) == $pid) { $reaped = 1; $st = $? }
      last unless kill 0, -$pid;
      select(undef, undef, undef, 0.1);
    }
    last unless kill 0, -$pid;
  }
  kill "KILL", -$pid;
};
$SIG{ALRM} = sub { $timed = 1; $stop->() };
$SIG{$_} = sub { $stop->(); exit 143 } for qw(TERM INT HUP);
alarm $lim;
until ($reaped) {
  my $r = waitpid($pid, 0);
  if ($r == $pid) { $reaped = 1; $st = $? } elsif ($r == -1 && $! != EINTR) { last }
}
alarm 0;
kill "KILL", -$pid if kill 0, -$pid;
if ($timed) { print STDERR "gate: the web browser specs were stopped after $lim s ($ENV{WEB_LIMIT_NAME})\n"; exit 142 }
exit($st & 127 ? 128 + ($st & 127) : $st >> 8);
