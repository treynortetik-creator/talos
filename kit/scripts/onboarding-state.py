#!/usr/bin/env python3
"""onboarding-state.py -- the latched setup-interview offer, kept in <agent>/.agent-state/onboarding.json.

    python3 scripts/onboarding-state.py status
    python3 scripts/onboarding-state.py start                     # owner said yes (or tapped "Set up my agent"): resume or begin
    python3 scripts/onboarding-state.py set later|declined|done   # keeps the saved wave
    python3 scripts/onboarding-state.py record --wave N < answers # write wave N's confirmed answers, then move on to wave N+1

States: not_offered, later, declined, in_progress, done. `wave` is the wave to ask next (1 to 8). Every write goes to a
temp file in the same folder, is flushed to disk, then renamed over the real one, so a kill leaves either the old file or
the new one. `record` writes the answers into wiki/_onboarding-progress.md first and moves the wave second; it does nothing
to answers already recorded for that wave, so running it again changes nothing."""
import datetime
import json
import os
import re
import stat
import sys

STATES = ("not_offered", "later", "declined", "in_progress", "done")
LAST_WAVE = 8
MAX_BYTES = 65536
AGENT = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
STATE_DIR = os.path.join(AGENT, ".agent-state")
STATE_FILE = os.path.join(STATE_DIR, "onboarding.json")
PROGRESS = os.path.join(AGENT, "wiki", "_onboarding-progress.md")


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def read_bytes(path, limit):
    """Open without following a link or blocking on a pipe; a regular file under the cap, else None."""
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        data = os.read(fd, limit + 1)
        return data if len(data) <= limit else None
    except OSError:
        return None
    finally:
        if fd is not None:
            os.close(fd)


def load():
    """The saved state, a fresh not_offered when there is no file, and None when the file is unreadable or corrupt."""
    if not os.path.lexists(STATE_FILE):
        return {"state": "not_offered", "wave": 1}
    raw = read_bytes(STATE_FILE, MAX_BYTES)
    try:
        d = json.loads(raw.decode("utf-8")) if raw is not None else None
    except ValueError:
        d = None
    if not isinstance(d, dict) or d.get("state") not in STATES:
        return None
    w = d.get("wave")
    d["wave"] = w if isinstance(w, int) and not isinstance(w, bool) and 1 <= w <= LAST_WAVE else 1
    return d


def atomic_write(path, text):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = "%s.tmp.%d" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save(state, wave, **extra):
    atomic_write(STATE_FILE, json.dumps(dict({"state": state, "wave": wave, "at": now()}, **extra), indent=1) + "\n")


def need_state():
    d = load()
    if d is None:
        sys.exit("onboarding.json is unreadable or corrupt; fix or delete %s, then run again" % STATE_FILE)
    return d


def ensure_progress():
    """Create the progress file from the template only when it is missing. An existing one holds answers; never touched."""
    if os.path.lexists(PROGRESS):
        return
    tmpl = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates", "_onboarding-progress.md.tmpl")
    raw = read_bytes(tmpl, 1 << 20)
    atomic_write(PROGRESS, raw.decode("utf-8") if raw is not None else "# Onboarding progress\n")


def mark_row(text, wave):
    """Set the wave's table row to `done` with today's date."""
    pat = re.compile(r"^(\|\s*%d\s*\|[^|]*\|)[^|]*\|[^|]*\|\s*$" % wave, re.M)
    return pat.sub(lambda m: "%s done | %s |" % (m.group(1), datetime.date.today().isoformat()), text, count=1)


def cmd_record(wave, answers):
    d = need_state()
    ensure_progress()
    raw = read_bytes(PROGRESS, 1 << 20)
    text = raw.decode("utf-8") if raw is not None else ""
    header = "### Wave %d — done" % wave
    live = re.sub(r"<!--.*?-->", "", text, flags=re.S)  # the template's example answers sit in a comment
    if re.search(r"^%s\b" % re.escape(header), live, re.M):
        print("wave %d already recorded; kept the first answers" % wave)
    else:
        if not answers.strip():
            sys.exit("no answers on stdin; nothing recorded")
        if "*(nothing captured yet)*" in text:
            text = text.replace("*(nothing captured yet)*\n", "", 1)
        text = mark_row(text, wave).rstrip("\n") + "\n\n%s %s\n%s\n" % (header, datetime.date.today().isoformat(), answers.strip())
        atomic_write(PROGRESS, text)
    if d["state"] == "in_progress" and d["wave"] > wave:
        print("state already past wave %d" % wave)
        return
    if wave >= LAST_WAVE:
        save("done", LAST_WAVE)
    else:
        save("in_progress", wave + 1)
    print("recorded wave %d; next wave %d" % (wave, min(wave + 1, LAST_WAVE)))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "status"
    if cmd == "status":
        d = load()
        print(json.dumps(d) if d is not None else "corrupt")
    elif cmd == "start":
        d = need_state()
        if d["state"] == "done":
            print("setup is already done")
            return
        ensure_progress()
        if d["state"] != "in_progress":
            save("in_progress", d["wave"])
        print("in_progress, wave %d" % d["wave"])
    elif cmd == "set" and len(argv) > 2 and argv[2] in ("later", "declined", "done"):
        d = need_state()
        save(argv[2], d["wave"])
        print(argv[2])
    elif cmd == "record" and len(argv) > 3 and argv[2] == "--wave" and argv[3].isdigit() and 1 <= int(argv[3]) <= LAST_WAVE:
        cmd_record(int(argv[3]), sys.stdin.read(1 << 16))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main(sys.argv)
