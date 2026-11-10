#!/usr/bin/env python3
"""tty-run.py: run a command with a real terminal (a pty) as its stdin, stdout and stderr, the way the owner's Terminal does.
`talos update`, `rollback` and `restore` refuse to run without one, so a test has to give them one.

    tty-run.py [--pidfile FILE] [--timeout SECONDS] [--send TEXT] -- COMMAND [ARGS...]

Prints what the command wrote, exits with the command's own exit status (128+N when a signal ended it). With --pidfile the
command's pid is written there before anything runs, so a test can signal it. --timeout (default 120) kills the command's whole
session and exits 124 (--send types TEXT and Enter after a second, to answer a prompt), so a test whose code under test hangs fails instead of hanging. Python 3.9, standard library only."""
import os
import pty
import select
import signal
import sys
import time

args = sys.argv[1:]
pidfile = None
timeout = 120.0
send = None
while args[:1] in (["--pidfile"], ["--timeout"], ["--send"]):
    if args[0] == "--pidfile":
        pidfile = args[1]
    elif args[0] == "--send":
        send = args[1]
    else:
        timeout = float(args[1])
    args = args[2:]
if args[:1] != ["--"] or len(args) < 2:
    sys.exit("usage: tty-run.py [--pidfile FILE] -- COMMAND [ARGS...]")
cmd = args[1:]
pid, fd = pty.fork()
if pid == 0:
    try:
        os.execvp(cmd[0], cmd)
    except OSError as e:
        sys.stderr.write("tty-run: cannot run %s: %s\n" % (cmd[0], e))
        os._exit(127)
if pidfile:
    with open(pidfile + ".tmp", "w") as fh:
        fh.write(str(pid))
    os.replace(pidfile + ".tmp", pidfile)


def drain():
    # Output can still arrive as the child finishes closing its terminal.
    idle = time.monotonic() + 1.0
    while time.monotonic() < idle:
        if not select.select([fd], [], [], 0.05)[0]:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        sys.stdout.buffer.write(data.replace(b"\r\n", b"\n"))
        sys.stdout.buffer.flush()
        idle = time.monotonic() + 1.0


deadline = time.monotonic() + timeout
sent = send is None
t0 = time.monotonic()
status = None
while True:
    if not sent and time.monotonic() - t0 > 1.0:
        os.write(fd, send.encode() + b"\n")
        sent = True
    left = deadline - time.monotonic()
    if left <= 0:
        sys.stdout.write("tty-run: timed out after %d s; the command was killed\n" % timeout)
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pid, sig)
            except OSError:
                pass
            time.sleep(0.3)
        # A session leader cannot finish exiting while the terminal's output is unread (macOS), so keep draining it, then give up
        # waiting: a command that will not die must not hang the test that timed it out.
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if select.select([fd], [], [], 0.2)[0]:
                try:
                    if not os.read(fd, 65536):
                        break
                except OSError:
                    break
            if os.waitpid(pid, os.WNOHANG)[0]:
                break
        sys.exit(124)
    ready, _, _ = select.select([fd], [], [], min(left, 1.0))
    if not ready:
        continue
    try:
        data = os.read(fd, 65536)
    except OSError:
        data = b""
    if not data:
        exited, child_status = os.waitpid(pid, os.WNOHANG)
        if exited:
            status = child_status
            break
        continue
    sys.stdout.buffer.write(data.replace(b"\r\n", b"\n"))
    sys.stdout.buffer.flush()
drain()
if status is None:
    _, status = os.waitpid(pid, 0)
drain()
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
