#!/usr/bin/env python3
"""claim-gate.py: an absolute claim about the world must name its evidence.

TWO ROLES (argv[1]):
  (none)   Stop. Look at the message that just went out and QUEUE a notice. Never blocks.
  inject   UserPromptSubmit. Hand the queued notice to the next turn as context, then clear it.

WHY IT EXISTS. The commonest way an agent becomes useless is saying "there is no X" or "that is broken" before it
tested anything. "Verify before asserting" in CLAUDE.md is prose, and prose has no instant at which it fires.
This hook has one: the moment a sentence ships.

WHAT FIRES. The last assistant message holds a CLAIM PHRASE ("there is no", "does not exist", "is broken",
"not available", "confirmed", "verified", ...) in a sentence with no EVIDENCE marker (a `command` in backticks, a
file path, a URL, a date, "(checked: ...)", "returned", "exit 0", "per the docs", "you said", ...). Table rows,
quotes, code blocks, and plans or conditionals ("will", "when", "once", "if the") are ignored.

WHY IT DOES NOT BLOCK. A Stop hook runs AFTER the message is already on screen. Blocking there cannot unsay
anything: it makes the model re-send a near-identical message, so the person reads the same paragraph twice with a
hook complaint in between. So the verdict is DEFERRED: it is written to the state folder and injected on the NEXT
prompt, where it shapes the next message instead of duplicating the last one.

State, a log of every verdict (tune the phrase lists from it; narrow an exception rather than loosening the
gate), and kill switches are described in hooks/_talos_common.py. Kill switch for this hook: claim-gate.off
FAILS OPEN, ALWAYS: any exception means allow, and it never emits a `decision`, so it cannot wedge a turn.
"""
import hashlib
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "claim-gate.off"
MAX_QUOTE = 3
MERGE_WINDOW = 180      # two Stops with no prompt between them (a sub-agent notice, a continued turn) top up one notice
MAX_PENDING = 6         # a wall of quotes trains dismissal
PENDING_TTL = 2 * 3600  # a notice nobody collected in 2h belongs to a dead session


def _paths():
    d = C.state_dir()
    return (os.path.join(d, "claim-gate.json"), os.path.join(d, "claim-gate-pending.json"))


CLAIM = re.compile(
    r"\b(?:there(?:'s| (?:is|are|was|were)) no\b|"
    r"(?:does|do|did)n(?:'|o)t exist|"
    r"no such\b|"
    r"(?:is|are|was|were) (?:broken|dead|down|gone|missing|impossible|unavailable)\b|"
    r"(?:is|are)n(?:'|o)t (?:available|possible|exposed|supported|installed|reachable)\b|"
    r"not available\b|"
    r"cannot be done|can(?:'|no)t be (?:done|reached|found)|"
    r"(?:does|do)n(?:'|o)t (?:support|expose|have|exist)\b|"
    r"has no\b|have no\b|"
    r"\bconfirmed\b|\bverified\b)",
    re.I,
)

EVIDENCE = re.compile(
    r"`[^`]+`|"                                                      # a command or identifier in backticks
    r"\(checked[:)]|\(verified[:)]|\(source[:)]|"                    # an explicit marker
    r"(?:checked|verified|measured|tested|probed)(?:\s+\w+){0,3}\s+(?:20\d\d-\d\d-\d\d|at \d|\d{1,2}:\d\d)|"
    r"https?://|"                                                    # a URL
    r"(?:^|[\s(])(?:~|/)?[\w.-]+/[\w./-]+|"                          # a path with a slash
    r"\b[\w-]+\.(?:md|py|sh|json|jsonl|txt|html|yml|yaml|ts|js)\b|"  # a file name
    r"\b(?:returned|returns|printed|exit(?:ed)?(?: code)? \d|rc=\d|output|stdout|stderr|line \d+|row \d+|\d+ (?:rows|lines|entries|files|bytes|results))\b|"
    r"\b(?:per|according to) (?:the )?(?:docs?|spec|page|source|log|README|manual|transcript|ledger)\b|"
    r"\b(?:he|she|they|you|the user) (?:said|says|told|confirmed|reported|wrote)\b|"
    r"\b(?:the (?:docs?|page|spec|log|file|output|screenshot|transcript) (?:says?|shows?|lists?|reads?))\b|"
    r"\b20\d\d-\d\d-\d\d\b",                                         # a dated observation
    re.I,
)

SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
# A plan or a conditional is not a claim about the world ("the deploy ships once the tests are verified").
PLAN = re.compile(r"\b(?:will|when|once|until|before|after|going to|plan(?:s|ned)? to|if it|if the|if they|so that)\b", re.I)


def _last_message(data):
    """Prefer the documented field; fall back to the transcript tail. Either may be absent."""
    m = data.get("last_assistant_message")
    if isinstance(m, str) and m.strip():
        return m, "field"
    tp = data.get("transcript_path")
    if not tp or not os.path.exists(tp):
        return "", "none"
    try:
        with open(tp, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 400000))
            tail = f.read().decode("utf-8", "replace").splitlines()
        for line in reversed(tail):
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("type") != "assistant":
                continue
            content = (rec.get("message") or {}).get("content") or []
            texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
            if texts:
                return "\n".join(texts), "transcript"
    except Exception:
        pass
    return "", "none"


def strip_noise(text):
    """Drop fenced code, table rows and block quotes from consideration."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    return "\n".join(l for l in text.splitlines() if not (l.strip().startswith("|") or l.strip().startswith(">")))


def offending(text):
    hits = []
    for sent in SENT_SPLIT.split(strip_noise(text)):
        s = sent.strip()
        if len(s) < 12 or not CLAIM.search(s):
            continue
        if EVIDENCE.search(s) or PLAN.search(s):
            continue
        hits.append(s)
    return hits


def check(data):
    """Stop role. Analyse the message that just shipped and QUEUE a notice. Prints nothing."""
    last_p, pend_p = _paths()
    msg, how = _last_message(data)
    sid = str(data.get("session_id", ""))
    rec = {"session_id": sid[:8], "how": how}
    if not msg:
        rec["verdict"] = "allow-empty"
        C.log_jsonl("claim-gate.jsonl", rec)
        return
    h = hashlib.sha1(msg.encode("utf-8", "replace")).hexdigest()[:12]
    if C.load_json(last_p).get("hash") == h:     # never flag the same message twice (a Stop can fire twice over one)
        rec.update(verdict="allow-repeat", hash=h)
        C.log_jsonl("claim-gate.jsonl", rec)
        return
    hits = offending(msg)
    if not hits:
        rec.update(verdict="allow", hash=h)
        C.log_jsonl("claim-gate.jsonl", rec)
        return
    C.save_json(last_p, {"hash": h, "session_id": sid, "ts": time.time()})
    now = time.time()
    pend = C.load_json(pend_p)
    if pend.get("hits") and pend.get("session_id") == sid and now - float(pend.get("ts", 0)) < MERGE_WINDOW:
        merged = list(pend["hits"])
        for x in hits:
            if x not in merged:
                merged.append(x)
        pend["hits"] = merged[:MAX_PENDING]
        verdict = "flag-merged"
    else:
        pend = {"session_id": sid, "hash": h, "ts": now, "hits": hits[:MAX_PENDING]}
        verdict = "flag"
    C.save_json(pend_p, pend)
    rec.update(verdict=verdict, hash=h, n=len(hits), sample=[x[:140] for x in hits[:MAX_QUOTE]])
    C.log_jsonl("claim-gate.jsonl", rec)
    # No `decision` on stdout, deliberately (see the module docstring).


def inject(data):
    """UserPromptSubmit role. Hand the queued notice to the turn that can still act on it, once."""
    _, pend_p = _paths()
    pend = C.load_json(pend_p)
    hits = pend.get("hits") or []
    if not hits:
        C.drop(pend_p)
        return
    age = time.time() - float(pend.get("ts", 0))
    if age > PENDING_TTL:
        C.drop(pend_p)
        C.log_jsonl("claim-gate.jsonl", {"verdict": "inject-stale", "n": len(hits)})
        return
    # Only the session that earned the notice gets it. The file is per agent folder, not per session, so
    # another session's first prompt must not collect it.
    owner, me = str(pend.get("session_id") or ""), str(data.get("session_id") or "")
    if owner and me and owner != me:
        C.log_jsonl("claim-gate.jsonl", {"verdict": "inject-skip-other", "n": len(hits)})
        return
    C.drop(pend_p)
    C.log_jsonl("claim-gate.jsonl", {"verdict": "inject", "n": len(hits), "hash": pend.get("hash")})
    quoted = "\n".join("  - " + (x if len(x) <= 220 else x[:217] + "...") for x in hits[:MAX_QUOTE])
    more = "\n  (+%d more)" % (len(hits) - MAX_QUOTE) if len(hits) > MAX_QUOTE else ""
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": (
        "=== CLAIM GATE: YOUR LAST TURN ===\n"
        "These sentences asserted something about the world with no evidence in the same sentence:\n"
        + quoted + more + "\n\n"
        "That message is already sent and already read. Do NOT re-send it, re-state it, correct the wording or "
        "apologise for it: repeating yourself is the failure this design avoids.\n"
        "This applies to what you write NEXT. Before you rely on or repeat any of those claims, prove it and carry "
        "the proof in the sentence (a command and its output, a file path, a URL, a date, the person who said it), "
        "for example \"there is no X (checked: `ls ...`)\", or label it an inference. If checking shows one was "
        "WRONG, say so once, plainly, in the course of the work. A claim you cannot stand up gets dropped, not "
        "softened.\n"
        "=== end claim gate ===")}}))


def main():
    if C.killed(KILL_NAME):
        return
    role = sys.argv[1] if len(sys.argv) > 1 else ""
    data = C.read_stdin()
    {"inject": inject, "check": check, "": check}.get(role, lambda _: None)(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass            # fail open, always
