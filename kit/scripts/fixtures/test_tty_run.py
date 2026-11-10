#!/usr/bin/env python3
"""Run with: python3 kit/scripts/fixtures/test_tty_run.py"""
import errno
import io
from pathlib import Path
import runpy
import subprocess
import sys
import unittest
from unittest.mock import patch


TTY_RUN = Path(__file__).with_name("tty-run.py")
MARKER = "LAST: undoing it failed too"
BURST = "for i in range(2000): print('line', i)\n"
FINISH = "print(%r, flush=True)\nsys.exit(4)\n" % MARKER


class TtyRunTests(unittest.TestCase):
    def check_child(self, source):
        for attempt in range(200):
            with self.subTest(attempt=attempt):
                result = subprocess.run(
                    [sys.executable, str(TTY_RUN), "--", sys.executable, "-c", source],
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=130,
                )
                self.assertEqual(result.returncode, 4, result.stderr.decode())
                self.assertIn((MARKER + "\n").encode(), result.stdout)
                self.assertEqual(len(result.stdout.splitlines()), 2001)

    def test_burst_keeps_final_line(self):
        self.check_child("import sys\n" + BURST + FINISH)

    def test_final_line_after_stdin_work(self):
        self.check_child(
            "import os, subprocess, sys\n" + BURST +
            "subprocess.run([sys.executable, '-c', "
            "'import sys; assert len(sys.stdin.buffer.read()) == 2000000'], "
            "input=b'x' * 2000000, check=True)\n"
            "os.close(0)\n" + FINISH
        )

    def test_temporary_eof_and_eio_retry_then_drain(self):
        output = io.BytesIO()
        stdout = io.TextIOWrapper(output)
        reads = [
            b"short\r\n", b"", OSError(errno.EIO, "terminal closing"),
            b"before exit\r\n", b"", b"first drain\r\n", b"",
            (MARKER + "\r\n").encode(), b"",
        ]
        polls = iter([(0, 0), (0, 0), (123, 4 << 8)])

        def waitpid(pid, flags):
            return next(polls) if flags else (pid, 4 << 8)

        with (
            patch.object(sys, "argv", [str(TTY_RUN), "--", "unused"]),
            patch.object(sys, "stdout", stdout),
            patch("pty.fork", return_value=(123, 9)),
            patch("select.select", return_value=([9], [], [])),
            patch("os.read", side_effect=reads),
            patch("os.waitpid", side_effect=waitpid),
            self.assertRaises(SystemExit) as exited,
        ):
            runpy.run_path(str(TTY_RUN), run_name="__main__")
        self.assertEqual(exited.exception.code, 4)
        self.assertEqual(
            output.getvalue(),
            ("short\nbefore exit\nfirst drain\n" + MARKER + "\n").encode(),
        )


if __name__ == "__main__":
    unittest.main()
