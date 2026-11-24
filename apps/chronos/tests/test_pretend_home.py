"""A pretend HOME (a test's, a sandbox's) never puts a job into the real user's launchd: the probe submits nothing."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CODE = """
import json, sys
sys.path.insert(0, %r)
import chronoslib as C, chronos_runlog as R
cfg = {"home_dir": sys.argv[1] + "/.chronos", "blocked_file": sys.argv[1] + "/.chronos/headless.blocked", "disable_plugins": [], "probe_timeout_s": 1,
       "workspace": sys.argv[1], "claude_bin": "claude", "claude_args": [], "path": []}
R.run_path = lambda c: "/usr/bin:/bin"
R.read_block = lambda c: None
R.write_block = lambda *a, **k: open(sys.argv[1] + "/block-written", "w").close()
print(json.dumps(R.probe(cfg)["text"]), C.pretend_home())
""" % os.path.join(ROOT, "lib")


class PretendHome(unittest.TestCase):
    def setUp(self):
        self.d = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.d, ignore_errors=True)
        self.calls = os.path.join(self.d, "calls")
        os.mkdir(os.path.join(self.d, "bin"))
        p = os.path.join(self.d, "bin", "launchctl")
        with open(p, "w") as f:
            f.write('#!/bin/sh\necho "$*" >> "%s"\nexit 1\n' % self.calls)
        os.chmod(p, 0o755)

    def probe(self, home):
        # the stub's folder ALONE: were the stub ever not runnable, the real launchctl must not be the next one found
        env = {"PATH": os.path.join(self.d, "bin"), "HOME": home, "PYTHONDONTWRITEBYTECODE": "1"}
        r = subprocess.run([sys.executable, "-c", CODE, self.d], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def test_a_pretend_home_submits_nothing(self):
        out = self.probe(self.d)
        self.assertIn("not your own home folder", out)
        self.assertFalse(os.path.exists(self.calls))
        self.assertFalse(os.path.exists(os.path.join(self.d, "block-written")))

    def test_the_users_own_home_is_asked(self):
        import pwd
        real = pwd.getpwuid(os.getuid()).pw_dir
        if not os.path.isdir(real):
            self.skipTest("this user has no home folder")
        for home in (real, real + "/"):
            self.assertIn("could not submit", self.probe(home))
        with open(self.calls) as f:
            self.assertIn("submit", f.read())

    def test_a_link_to_the_home_is_the_home(self):
        import pwd
        real = pwd.getpwuid(os.getuid()).pw_dir
        if not os.path.isdir(real):
            self.skipTest("this user has no home folder")
        link = os.path.join(self.d, "link")
        os.symlink(real, link)
        self.assertIn("could not submit", self.probe(link))

    def test_what_cannot_be_read_is_not_refused(self):
        self.assertIn("could not submit", self.probe(os.path.join(self.d, "gone")))


if __name__ == "__main__":
    unittest.main()
