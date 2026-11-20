#!/usr/bin/env python3
"""mod-fallback.py: what the Talos mod needs from two events that Claude Code may never hand it.

On a machine with managed settings, and for every Team and Enterprise organization, Claude Code's built-in security plugin
(cc-plugin-sec-default@builtin) seats itself outermost and passes some events on past user plugins: the talos-app-mod's
`classic.Stop`, `session.append`, `classic.PreModelSwitch` and `classic.PostModelSwitch` hooks are skipped there (Dante's
setup, 2026-11-19, Claude Code 2.1.328). A settings.json hook like this one is not a plugin and runs whatever the plugin
order, so the two that matter go through here:

  Stop            the engine's `background_tasks` (what is still in flight) go to
                  $TALOS_APP_HOME/state/agents-stop/<session id>.json, which the mod reads on its 2 s tick, so a background
                  shell or monitor that ended leaves the app's agents panel.
  PreModelSwitch  the mod's own `/model` (the app's Model control) is allowed past Claude Code's cache-miss confirmation,
                  and only that: the mod writes a one-shot ticket ($TALOS_APP_HOME/state/model-ticket.json: the model, an
                  expiry within 15 s, a nonce) while its switch is in flight. A switch from the command line that names that
                  model, before the expiry, is allowed once and the ticket is spent. Anything else gets no decision (Claude
                  Code asks as it would without Talos).

The Talos home is TALOS_APP_HOME, else ~/.config/talos/app (the mod's own rule). Nothing is created when it is not there (an
agent without the Talos app). It never blocks or fails a turn: every path exits 0, and it prints a decision only to allow.
Python 3.9, standard library only.
"""
import json
import os
import re
import sys
import time

sys.dont_write_bytecode = True

SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MAX_INPUT = 4 * 1024 * 1024
MAX_TICKET = 4096
MAX_TASKS = 200
# an alias the bridge's ticket may name, against the full id Claude Code resolved it to (controls.ts ticketMatches)
ALIAS = re.compile(r"^(default|best|fable|opus|sonnet|haiku)(\[1m\])?$")


def talos_home():
    h = os.environ.get("TALOS_APP_HOME") or os.path.join(os.environ.get("HOME", ""), ".config", "talos", "app")
    return h if os.path.isabs(h) and os.path.isdir(h) else None


def write_atomic(path, text):
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)
    os.replace(tmp, path)


def text(v, n):
    return v[:n] if isinstance(v, str) else None


def on_stop(event, home):
    sid = event.get("session_id")
    tasks = event.get("background_tasks")
    if not isinstance(sid, str) or not SESSION_ID.match(sid) or not isinstance(tasks, list):
        return
    out = []
    for t in tasks[:MAX_TASKS]:
        if not isinstance(t, dict):
            continue
        row = {k: text(t.get(k), n) for k, n in (("id", 120), ("type", 32), ("status", 32), ("description", 200), ("command", 80))}
        out.append({k: v for k, v in row.items() if v is not None})
    body = {"v": 1, "at": int(time.time() * 1000), "session_id": sid, "background_tasks": out}
    write_atomic(os.path.join(home, "state", "agents-stop", sid + ".json"), json.dumps(body, separators=(",", ":")))


def ticket_matches(ticket_model, to_model):
    if ticket_model == to_model:
        return True
    m = ALIAS.match(ticket_model)
    if not m or not isinstance(to_model, str):
        return False
    return m.group(1) == "default" or m.group(1) in to_model


def on_pre_model_switch(event, home):
    path = os.path.join(home, "state", "model-ticket.json")
    try:
        st = os.lstat(path)
        if not os.path.isfile(path) or os.path.islink(path) or st.st_size == 0 or st.st_size > MAX_TICKET:
            return
        with open(path, encoding="utf-8") as f:
            ticket = json.load(f)
    except (OSError, ValueError):
        return
    if not isinstance(ticket, dict) or ticket.get("v") != 1:
        return
    want, exp = ticket.get("to_model"), ticket.get("exp_ms")
    if not isinstance(want, str) or not want or not isinstance(exp, (int, float)) or isinstance(exp, bool):
        return
    now_ms = time.time() * 1000
    # the mod never writes one for longer than its switch's 15 s: anything later is not the mod's
    if now_ms > exp or exp > now_ms + 16000:
        return
    # the session the mod runs in: another session's /model (a thread session under the same Talos home) is not it
    sid = ticket.get("session_id")
    if sid is not None and sid != event.get("session_id"):
        return
    source = event.get("source")
    if source is not None and source != "command":
        return  # a picker or SDK switch is not the mod's
    if "requested_model" in event:
        asked = "default" if event.get("requested_model") is None else event.get("requested_model")
        if asked != want:
            return
    elif not ticket_matches(want, event.get("to_model")):
        return
    # spend it before saying yes: whoever renames it first owns it, so it is used once
    spent = "%s.spent.%d" % (path, os.getpid())
    try:
        os.rename(path, spent)
        os.unlink(spent)
    except OSError:
        return
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreModelSwitch", "permissionDecision": "allow"}}))


def main():
    try:
        raw = sys.stdin.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            return
        event = json.loads(raw) if raw.strip() else {}
        if not isinstance(event, dict):
            return
        home = talos_home()
        if home is None:
            return
        name = event.get("hook_event_name")
        if name == "Stop":
            on_stop(event, home)
        elif name == "PreModelSwitch":
            on_pre_model_switch(event, home)
    except Exception:  # noqa: BLE001 - a fallback must never fail a turn
        return


if __name__ == "__main__":
    main()
    sys.exit(0)
