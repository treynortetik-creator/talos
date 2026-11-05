#!/usr/bin/env python3
"""channel-debt.py: one script, four hook roles. Makes "answer on the channel the message came from" a mechanism.

Only matters if a chat channel (the Talos app or the iMessage plugin) is set up. Inert otherwise.

WHY. A person messaging the agent from their phone cannot see the terminal. The agent does the work, writes a
careful terminal answer, and never calls the reply tool: to the person, the turn produced silence. "Reply on the
channel first" as a prose rule fails exactly when the session is busy. This turns it into a debt that is recorded
when the message arrives and checked when the turn tries to end.

ROLES (argv[1]):
  reset  SessionStart.      Drop any debt left by a crashed or interrupted session.
  arm    UserPromptSubmit.  A prompt carrying a <channel source="imessage" ...> (or "talos-app") tag records a debt.
  clear  PostToolUse.       A channel reply tool (or notify/talos.sh through Bash) succeeded: debt paid. Bound to
                            success only: a send that ERRORED did not reach the person, and discharging on a failure
                            would silence the guard in exactly the case it exists for.
  check  Stop.              A debt is outstanding: block the turn and say so, at most MAX_BLOCKS times in a row, then
                            give up and let the turn end (a guard that can trap a session is worse than the failure).

Replies are plain text: chat clients show markdown syntax as raw characters.

FAILS OPEN, ALWAYS. Kill switch: channel-debt.off
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "channel-debt.off"
MAX_BLOCKS = 2
MAX_AGE = 3 * 3600          # a debt older than this is a leftover, not an obligation
REPLY_TOOLS = ("plugin_imessage_imessage__reply", "mcp__talos-app__reply")
ROBOT_PREFIXES = ("<scheduled-task", "<cross-session-message", "<scheduled-cron", "<task-notification", "<system-reminder")


HEADLESS = os.environ.get("CHRONOS_RUN") == "1"


def debt_path(session_id=""):
    """One debt file PER SESSION. The state folder is per agent folder, and an always-on chat session and a scheduled
    job can share one folder: with a single shared file a job's Stop check would be blocked by (and its SessionStart
    reset would wipe) the live chat session's debt. A payload with no session id falls back to the shared name."""
    sid = re.sub(r"[^A-Za-z0-9_-]", "", str(session_id or ""))[:64]
    return os.path.join(C.state_dir(), "channel-debt-%s.json" % sid if sid else "channel-debt.json")


def sid_of(data):
    return str(data.get("session_id") or "") if isinstance(data, dict) else ""


def prompt_text(data):
    for k in ("user_input", "prompt", "user_prompt", "message", "content"):
        v = data.get(k)
        if isinstance(v, str):
            return v
    return json.dumps(data)


# What the owner themselves sent through the app. A missing kind is an older app and counts as text; an unknown
# kind (a newer app) counts as machinery, so a session is never blocked on a reply nobody asked for.
OWNER_KINDS = ("text", "voice_note", "file", "voice_delegation")
_TAG = re.compile(r"<channel\s((?:[^>\"]|\"[^\"]*\")*)>")
_ATTR = re.compile(r"([A-Za-z_][\w-]*)=\"([^\"]*)\"")


def opening_tag(text):
    """Attributes of the first <channel ...> tag as a dict (first occurrence of a key wins), or None."""
    m = _TAG.search(text)
    if not m:
        return None
    attrs = {}
    for k, v in _ATTR.findall(m.group(1)):
        attrs.setdefault(k, v)
    return attrs


def arm(data):
    if HEADLESS:
        return              # a scheduled job has no chat reply tool and nobody to answer: it never owes a reply
    text = prompt_text(data)
    tag = opening_tag(text)
    if tag is not None:
        # Source and kind come from the OPENING channel tag only. A message body can quote any tag it likes.
        src = tag.get("source")
        if src not in ("imessage", "talos-app"):
            return                     # a channel we have no reply tool for
        if src == "talos-app" and tag.get("kind", "text") not in OWNER_KINDS:
            return                     # cards, hook events, schedules...: the app never expects a chat reply to these
        C.save_json(debt_path(sid_of(data)), {"source": src, "chat_id": tag.get("chat_id", ""), "ts": time.time(), "blocks": 0})
        return
    head = text.lstrip()
    if head.startswith(ROBOT_PREFIXES) or head.startswith("/"):
        return


# `talos.sh` must be the PROGRAM being run (optionally via bash/sh and a path), not just a word in a command:
# `grep -n post notify/talos.sh` sends nothing and must not pay a debt.
RUNS_TALOS_SH = re.compile(r"(?:^|[;&|(]\s*)(?:(?:ba|z)?sh\s+)?(?:\S*/)?talos\.sh(?:\s|$)")


def clear(data):
    name = str(data.get("tool_name") or "")
    if any(t in name for t in REPLY_TOOLS):
        C.drop(debt_path(sid_of(data)))
        return
    if name == "Bash" and RUNS_TALOS_SH.search(str((data.get("tool_input") or {}).get("command") or "")):
        C.drop(debt_path(sid_of(data)))


def check(data):
    if HEADLESS:
        return
    path = debt_path(sid_of(data))
    d = C.load_json(path)
    if not d:
        return
    if time.time() - float(d.get("ts", 0)) > MAX_AGE:
        C.drop(path)
        return
    # `stop_hook_active` means SOME stop hook blocked this turn, not necessarily this one: stand down only when
    # our own block is the one being retried.
    if data.get("stop_hook_active") and int(d.get("blocks", 0)) > 0:
        C.drop(path)
        return
    n = int(d.get("blocks", 0)) + 1
    if n > MAX_BLOCKS:
        C.drop(path)
        return
    d["blocks"] = n
    C.save_json(path, d)
    src = d.get("source", "the channel")
    chat = d.get("chat_id", "")
    print(json.dumps({"decision": "block", "reason": (
        "You have not replied on %s yet. The message came from %s%s and the person CANNOT SEE this terminal: to "
        "them, this turn produced silence.\n\nDeciding to reply is not replying, and drafting the answer in your "
        "response text is not replying. Call the reply tool now with the substance, then finish.\n\nIf no reply is "
        "owed (a scheduled job, an internal note), or you already replied some other way, say so in one line and "
        "stop. This blocks at most once more, then gives up." % (src, src, " (chat_id %s)" % chat if chat else ""))}))


def reset(data):
    """SessionStart: drop this session's own leftover debt and any debt older than MAX_AGE. Never another live
    session's fresh debt, and never from a headless job."""
    if HEADLESS:
        return
    C.drop(debt_path(sid_of(data)))
    try:
        d = C.state_dir()
        for fn in os.listdir(d):
            if fn.startswith("channel-debt") and fn.endswith(".json"):
                p = os.path.join(d, fn)
                if time.time() - float(C.load_json(p).get("ts", 0)) > MAX_AGE:
                    C.drop(p)
    except OSError:
        pass


def main():
    if C.killed(KILL_NAME):
        return
    role = sys.argv[1] if len(sys.argv) > 1 else ""
    data = C.read_stdin()
    {"arm": arm, "clear": clear, "check": check, "reset": reset}.get(role, lambda _: None)(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass            # fail open, always
