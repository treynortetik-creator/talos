#!/usr/bin/env python3
"""hands-free.py: while the user is driving, walking or working out, a long reply must be listenable.

WHY. "Send me audio for the next hour" is a preference an agent honours while it is thinking about it and drops when a
turn runs long, and the person finds out mid-run. The trigger is decidable (a mode file with an expiry), the
discharge is observable (did the reply carry an audio file, yes or no) and the correct action is constant (attach
audio), which is exactly when a hook fits better than a rule.

ROLES (argv[1]):
  on [minutes]   start or extend the window (default 60, at most 480). The agent runs this when the user asks.
  off            end it now
  status         print the minutes left (exit 0 while active, 1 when not)
  note           PostToolUse (the channel reply tools): record whether that reply carried an audio file
  check          Stop: while the window is open, block a turn whose chat replies were substantive text with no audio

Only replies of MIN_CHARS or more are required to be audio: a four-second clip saying "on it" is worse than reading
it. Needs the Telegram channel (setup/telegram.md) and scripts/tts.sh to make the audio. Blocks at most twice, then
gives up. FAILS OPEN, ALWAYS. Kill switch: hands-free.off
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "hands-free.off"
DEFAULT_MIN = 60
MIN_CHARS = 320
MAX_BLOCKS = 2
AUDIO_EXT = (".mp3", ".m4a", ".wav", ".ogg", ".opus", ".aiff")
REPLY_TOOLS = ("plugin_telegram_telegram__reply", "plugin_imessage_imessage__reply")


def mode_path():
    return os.path.join(C.state_dir(), "hands-free.json")


def debt_path():
    return os.path.join(C.state_dir(), "hands-free-debt.json")


def active():
    d = C.load_json(mode_path())
    if not d:
        return None
    if time.time() > float(d.get("until", 0)):
        C.drop(mode_path())
        return None
    return d


def role_on(argv):
    mins = DEFAULT_MIN
    if len(argv) > 2:
        try:
            mins = max(1, min(480, int(argv[2])))
        except ValueError:
            pass
    C.save_json(mode_path(), {"until": time.time() + mins * 60, "minutes": mins})
    print("hands-free ON for %d minutes: long chat replies must carry audio (scripts/tts.sh file out.m4a \"...\")." % mins)


def role_status():
    d = active()
    if not d:
        print("hands-free is off")
        sys.exit(1)
    print("hands-free ON, %d minutes left" % max(1, int((float(d["until"]) - time.time()) // 60)))


def role_note(data):
    if not active():
        return
    name = str(data.get("tool_name") or "")
    if not any(t in name for t in REPLY_TOOLS):
        return
    ti = data.get("tool_input") or {}
    text = str(ti.get("text") or "")
    files = ti.get("files") or []
    has_audio = any(str(f).lower().endswith(AUDIO_EXT) for f in files if isinstance(f, (str, os.PathLike)))
    debt = C.load_json(debt_path())
    if has_audio:
        C.drop(debt_path())
    elif len(text) >= MIN_CHARS:
        C.save_json(debt_path(), {"ts": time.time(), "blocks": int(debt.get("blocks", 0)), "chars": len(text)})


def role_check(data):
    if not active():
        C.drop(debt_path())
        return
    d = C.load_json(debt_path())
    if not d:
        return
    if data.get("stop_hook_active") and int(d.get("blocks", 0)) > 0:
        C.drop(debt_path())
        return
    n = int(d.get("blocks", 0)) + 1
    if n > MAX_BLOCKS:
        C.drop(debt_path())
        return
    d["blocks"] = n
    C.save_json(debt_path(), d)
    print(json.dumps({"decision": "block", "reason": (
        "HANDS-FREE MODE is on: the user asked for listenable replies. Your last chat reply was %d characters of text "
        "with no audio attached. Write a short spoken version (what you would say out loud, not a raw read of the "
        "text), render it with `bash scripts/tts.sh file <name>.m4a \"<narration>\"`, and send it with the reply tool's "
        "`files` argument, with the same words as text. This blocks at most once more, then gives up." % int(d.get("chars", 0)))}))


def main():
    role = sys.argv[1] if len(sys.argv) > 1 else ""
    if role == "off":
        C.drop(mode_path())
        C.drop(debt_path())
        print("hands-free off")
        return
    if role == "on":
        role_on(sys.argv)
        return
    if role == "status":
        role_status()
        return
    if C.killed(KILL_NAME):
        return
    data = C.read_stdin()
    {"note": role_note, "check": role_check}.get(role, lambda _: None)(data)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        pass            # fail open, always
