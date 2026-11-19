#!/usr/bin/env python3
# Sign in to Claude for Talos, from the tray (docs/WINDOWS-PLAN.md section 8, "The no-terminal install"). Root-owned at
# /opt/talos-wsl/signin.py; `talos-wsl.sh signin` runs it (as root, only while the distro is cut off from Windows).
#
# It runs `claude setup-token` as talos in a pty of its own and tells Windows only what it needs, one JSON line each:
#   {"event":"url","url":"https://..."}    open this, sign in, and copy the code it shows
#   {"event":"code"}                        ready: write the code as one line on stdin
#   {"event":"signed_in"}                   done: the token is in place, and the supervisor picks it up by itself
#   {"event":"error","why":"<id>","message":"..."}   a fixed plain sentence (none of Claude Code's own text is passed on),
#                                           and its fixed id from WHY, which the tray logs (Pantheon, 2026-11-18)
# Exit 0 only after signed_in.
#
# The token never leaves the distro (Pantheon's rules, 2026-11-12): it is read from the pty here, checked, and written by a
# process running as talos to $TALOS_APP_HOME/claude-oauth-token (one line, 0600, through a temp file and a rename in that
# folder; agreed with Hestia, who owns the supervisor's side). Nothing here logs the pty's text, and nothing it prints
# carries a token.
import json
import os
import pty
import pwd
import re
import select
import signal
import struct
import sys
import termios
import fcntl
import time
import traceback

# talos, and its own Claude Code. The two TALOS_SIGNIN_* names are for a test as an ordinary user with a stand-in claude;
# the tray sets neither (it runs this through `wsl -u root --exec`, with root's own environment), and whatever they name
# still runs as that user, never as root.
# ignored as root (Fable R5-5 on 5fc143ef): nothing in any environment can point root's sign-in elsewhere
TESTING = os.getuid() != 0
USER = (os.environ.get("TALOS_SIGNIN_USER") if TESTING else None) or "talos"
URL_WAIT_S = 60
CODE_WAIT_S = 600
RESULT_WAIT_S = 90
_wait = (os.environ.get("TALOS_SIGNIN_RESULT_WAIT") if TESTING else None) or ""
if _wait.isdigit():
    RESULT_WAIT_S = int(_wait)
# The names Claude Code looks up once the code is pasted. While she signs in in the browser they are looked up here every
# 20 s, best effort: on the Windows test PC (2026-11-16) the distro's first lookup of a name failed after 10 s and the next
# ones answered at once, and Claude Code's one lookup, made only after the paste, failed (EAI_AGAIN). When testing: only the
# names TALOS_SIGNIN_WARM_HOSTS gives (comma-separated), none by default.
WARM_HOSTS = (tuple(h for h in ((os.environ.get("TALOS_SIGNIN_WARM_HOSTS") if TESTING else None) or "").split(",") if h)
              if TESTING else ("platform.claude.com", "api.anthropic.com", "claude.ai"))
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r")
# A link or a token counts only once something ends it (Fable R1-2 on f3575ba1): whitespace after it, or Claude Code's
# output ending. A pty read can stop anywhere, and half a token taken as the whole would be "signed in" and broken.
# the token alone on its line, and that line ended (a token in the middle of other words is not the sign-in's)
TOKEN_DONE = re.compile(r"(?m)^[ \t]*(sk-ant-[a-z]{2,5}\d{2}-[A-Za-z0-9_-]+)[ \t]*$(?=\n)")
# what is written: a long-lived OAuth token's whole shape, and no shorter
TOKEN_SHAPE = re.compile(r"^sk-ant-oat\d{2}-[A-Za-z0-9_-]{80,400}$")
# OAuth codes are short, printable and space-free (code#state); anything else is never written to the pty
CODE = re.compile(r"^[A-Za-z0-9#_.~+/=-]{8,512}$")
# printable ASCII only (Fable R4-1 on f1699c11): the link is Claude Code's, which talos owns, and the tray opens it; no bidi or
# other look-alike character, no quote, no angle bracket
URL_DONE = re.compile(r"(https://(claude\.ai|claude\.com|[a-z0-9.-]*\.anthropic\.com)/[!#-&(-;=?-~]+)(?=\s)")
# Claude Code's failures, in fixed plain words (Fable R1-8): none of its own text is passed on. First match wins, so the
# rejection comes before "expired": Claude Code's rejection sentence lists "expired" as one guess of several.
KNOWN_FAILURES = [
    (re.compile(r"getaddrinfo|EAI_AGAIN|EAI_FAIL|ENOTFOUND|ECONNREFUSED|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENETUNREACH"
                r"|EHOSTUNREACH|socket hang up|fetch failed|network|timeout|timed out", re.I),
     "offline", "Talos could not reach Claude, so the code was not checked. Make sure this PC is online."),
    (re.compile(r"invalid.*code|code.*invalid|n.?t accepted|not accepted", re.I),
     "not_accepted", "Claude did not accept that code. Next time, paste the whole code the page shows."),
    (re.compile(r"expired", re.I),
     "expired", "That code had expired. Next time, paste the code within a few minutes."),
]
OTHER_FAILURE = ("other", "Claude Code could not sign you in. Try again in a minute.")
# every failure's id, the only part of it the tray writes to its log: fixed words, never a code, a link or Claude Code's text
WHY = {"no_user", "no_claude", "no_link", "code_wait", "not_a_code", "no_answer", "unreadable", "not_saved", "offline",
       "not_accepted", "expired", "other"}
# Claude Code ends an error with this and then waits for Enter, with no newline after it: the line is whole once it is there
ERROR_END = re.compile(r"press enter to retry", re.I)


SIGNED = False


def say(event, **kw):
    global SIGNED
    line = json.dumps(dict(event=event, **kw), separators=(",", ":"))
    data = (line + "\n").encode()
    written = os.write(1, data)
    # only a whole signed_in line counts as said: a short or failed write leaves the normal failure path (Opus review, 2026-11-18)
    if event == "signed_in" and written == len(data):
        SIGNED = True


def fail(why, message):
    # an id off the list is "other": the person still gets the sentence (the test holds every call to the list)
    say("error", why=why if why in WHY else "other", message=message)
    sys.exit(1)


def warm(hosts, keep):
    """Look the names up every 20 s, best effort, in a child process (never a thread: write_token forks later, and a fork
    while a thread is inside a glibc lookup can hang the child's initgroups, Opus review on ac66fb7f). The child holds none of
    this process's files open but `keep`'s copies are closed too, so the tray still sees this process's output end; it ends
    when this process does. Returns its pid, or None."""
    if not hosts:
        return None
    import socket
    parent = os.getpid()
    pid = os.fork()
    if pid:
        return pid
    try:
        null = os.open(os.devnull, os.O_RDWR)
        for f in (0, 1, 2):
            os.dup2(null, f)
        os.close(null)
        os.close(keep)
        while os.getppid() == parent:
            for h in hosts:
                try:
                    socket.getaddrinfo(h, 443, proto=socket.IPPROTO_TCP)
                except OSError:
                    pass
            time.sleep(20)
    finally:
        os._exit(0)


def end_child(pid):
    """SIGKILL and reap, with a bounded wait (the same 3 s as stop())."""
    if not pid:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    end = time.time() + 3.0
    while time.time() < end:
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                return
        except ChildProcessError:
            return
        time.sleep(0.05)


def plain(raw):
    return ANSI.sub(b"", raw).decode("utf8", "replace")


def as_talos(u):
    if os.getuid() == u.pw_uid:
        return
    os.initgroups(u.pw_name, u.pw_gid)
    os.setgid(u.pw_gid)
    os.setuid(u.pw_uid)


def home_of(u):
    # TALOS_SIGNIN_HOME: a test's scratch home, so a test never writes into a real ~/.config (never set by the tray)
    return (os.environ.get("TALOS_SIGNIN_HOME") if TESTING else None) or u.pw_dir


def app_home(u):
    # the supervisor's own default (apps/bridge/src/config.ts): $HOME/.config/talos/app
    return os.path.join(home_of(u), ".config", "talos", "app")


def write_token(u, token):
    """As talos, in a child: the folder made if missing (0700), a temp file with O_EXCL|O_NOFOLLOW, then a rename."""
    pid = os.fork()
    if pid == 0:
        try:
            as_talos(u)
            os.umask(0o077)
            home = app_home(u)
            os.makedirs(home, mode=0o700, exist_ok=True)
            d = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            tmp = ".claude-oauth-token.%d" % os.getpid()
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=d)
            os.write(fd, (token + "\n").encode())
            os.fsync(fd)
            os.close(fd)
            os.rename(tmp, "claude-oauth-token", src_dir_fd=d, dst_dir_fd=d)
            os.fsync(d)
            os._exit(0)
        except Exception:
            os._exit(1)
    # bounded (Opus review on ac66fb7f): a child that hangs is killed, and the sign-in says it could not save, never "Signing
    # in..." for good
    end = time.time() + 15.0
    while time.time() < end:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
        time.sleep(0.05)
    end_child(pid)
    return False


def main():
    try:
        u = pwd.getpwnam(USER)
    except KeyError:
        fail("no_user", "there is no talos user in this distro")
    claude = (os.environ.get("TALOS_SIGNIN_CLAUDE") if TESTING else None) or os.path.join(u.pw_dir, ".local", "bin", "claude")
    if not os.path.exists(claude):
        fail("no_claude", "Claude Code is not installed in this distro yet")
    env = {
        "HOME": home_of(u),
        "USER": USER,
        "LOGNAME": USER,
        "PATH": os.path.join(u.pw_dir, ".local", "bin") + ":/usr/local/bin:/usr/bin:/bin",
        "TERM": "xterm-256color",
        "DISABLE_AUTOUPDATER": "1",
        # nothing to open a browser with here (interop is off); the URL goes to the tray instead
        "BROWSER": "/bin/true",
    }
    pid, fd = pty.fork()
    if pid == 0:
        try:
            as_talos(u)
            os.chdir(home_of(u))
            os.execve(claude, [claude, "setup-token"], env)
        finally:
            os._exit(127)
    # wide, so the URL (and the token) come on one line each, not wrapped at 80 columns
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 4000, 0, 0))

    def stop(*_):
        # Claude Code's whole session (pty.fork made it a session and group leader), never its pid alone (Fable R5-3), and
        # reaped with a bounded wait
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        end = time.time() + 3.0
        while time.time() < end:
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    return
            except ChildProcessError:
                return
            time.sleep(0.05)

    signal.signal(signal.SIGTERM, lambda *a: (stop(), sys.exit(1)))
    out = bytearray()

    def read_until(secs, want):
        """want(text) on everything read so far: first on what is already read, then after each read. When Claude Code's
        output ends, once more with a newline added: its end ends the last word too."""
        if out:
            hit = want(plain(bytes(out)))
            if hit:
                return hit
        end = time.time() + secs
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    return want(plain(bytes(out)) + "\n") or None
                out.extend(chunk)
                hit = want(plain(bytes(out)))
                if hit:
                    return hit
        return False

    warmer = None
    try:
        url = read_until(URL_WAIT_S, lambda t: URL_DONE.search(t))
        if not url:
            fail("no_link", "Claude Code did not give a sign-in link. Try again in a minute.")
        say("url", url=url.group(1))
        read_until(10, lambda t: "code" in t.lower() and ">" in t)
        warmer = warm(WARM_HOSTS, fd)
        say("code")
        # at most CODE_WAIT_S for her to sign in and paste; the tray closing ends stdin, which ends this too
        signal.signal(signal.SIGALRM, lambda *a: fail("code_wait", "The sign-in waited too long for the code. Try again."))
        signal.alarm(CODE_WAIT_S)
        line = sys.stdin.readline().strip()
        signal.alarm(0)
        end_child(warmer)
        warmer = None
        if not CODE.fullmatch(line):
            fail("not_a_code", "That is not a sign-in code. Copy the whole code the sign-in page shows, then try again.")
        del out[:]
        os.write(fd, line.encode() + b"\r")
        line = None

        def result(t):
            m = TOKEN_DONE.search(t)
            if m:
                return ("token", m.group(1))
            # whole lines only (the last one, still arriving, can wait, unless Claude Code's "Press Enter to retry" has
            # ended it); only which failure it is counts, never its text
            lines = t.split("\n")
            whole = lines[:-1] + ([lines[-1]] if ERROR_END.search(lines[-1]) else [])
            for ln in whole:
                if re.search(r"error|invalid|expired|failed|accepted", ln, re.I):
                    return ("error", ln)
            return None

        got = read_until(RESULT_WAIT_S, result)
        if not got:
            fail("no_answer", "The code was sent, but there was no answer from Claude in %d seconds. Make sure this PC is online."
                 % RESULT_WAIT_S)
        kind, value = got
        if kind == "error":
            fail(*next(((why, words) for pat, why, words in KNOWN_FAILURES if pat.search(value)), OTHER_FAILURE))
        if not TOKEN_SHAPE.fullmatch(value):
            value = None
            fail("unreadable", "Claude Code gave a sign-in Talos could not read whole. Try again.")
        if not write_token(u, value):
            fail("not_saved", "The sign-in worked, but Talos could not save it. Try again.")
        value = None
        say("signed_in")
    finally:
        # each step runs even when the one before it raises, and the token buffer is always zeroed (Opus review, 2026-11-18)
        try:
            end_child(warmer)
        finally:
            try:
                stop()
            finally:
                out[:] = b"\0" * len(out)


def run():
    try:
        main()
    except Exception:
        if SIGNED:
            # signed_in is already said and the token is saved: the tray must not hear a second event, so the failure of a
            # best-effort cleanup goes to stderr only, and the exit is 0 (Opus review, 2026-11-18)
            traceback.print_exc()
            return
        # an unexpected crash: say one fixed sentence on stdout; the traceback (stderr) is never sent on
        fail(OTHER_FAILURE[0], OTHER_FAILURE[1])


if __name__ == "__main__":
    run()
