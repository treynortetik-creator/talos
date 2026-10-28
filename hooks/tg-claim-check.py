#!/usr/bin/env python3
"""tg-claim-check.py: an outbound chat message must not assert what this turn did not show.

WHY. The Stop-hook claim gate (claim-gate.py) only sees the final chat message of a turn. A reply sent through the
Telegram reply tool lives in a TOOL INPUT, so it never passes through it, and it is read on a phone, before any fix could
land. A message like "the deploy is fixed and live (the ticket is closed)" after a turn whose own tool results said "in
progress" is exactly the claim that should be stopped for one second look.

ONLY ACTIVE WHEN THE TELEGRAM CHANNEL IS SET UP (the plugin's access.json or .env under ~/.claude/channels/telegram/, or
a delivery config at ~/.config/talos/notify.env; TALOS_TG_CLAIM_FORCE=1 forces it on for tests). Registered for the
Telegram reply and edit tools only.

ROLE (argv[1])
  pre   PreToolUse on the Telegram reply / edit tool. A finding BLOCKS ONCE (permissionDecision deny + the sentences). The
        identical text sent again passes: the model is the judge of last resort, the hook only forces one look. It only ever
        denies; it never allows or asks, so it cannot widen a permission.

Detector: cheap and local, no model call (budget about 150 ms). A sentence is flagged when it carries a claim (see CLAIM) and
no evidence: no marker in the sentence and no support in THIS turn's tool results, tool calls or prompt (read from the
transcript the hook payload names).

SHADOW MODE: create tg-claim-check.shadow in the state folder and it logs "shadow-block" to tg-claim-check.jsonl and emits
nothing. Run it in shadow first on a new setup: the transcript can lag the live conversation, so live evidence may be
thinner than an offline replay's.

FAILS OPEN, ALWAYS. Kill switch: tg-claim-check.off (file in the state folder, TALOS_TG_CLAIM_CHECK_OFF=1, or the Chronos
Control Room). The log (state folder) holds a hash and counts, never the message text beyond a 140-character sample of the
flagged sentence.
"""
import hashlib, json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "tg-claim-check.off"
STATE = C.state_dir()
SHADOW = os.path.join(STATE, "tg-claim-check.shadow")   # present = log what it WOULD do, emit nothing
SEEN = os.path.join(STATE, "tg-claim-check-seen.json")
LOG_NAME = "tg-claim-check.jsonl"
TAIL_BYTES = 4_000_000
MAX_QUOTE = 4

# ---------------------------------------------------------------- which calls carry outbound text
TG_TOOL = re.compile(r"telegram.*__(?:reply|edit_message)$")


def channel_configured():
    """True when the Telegram channel plugin (or the delivery wrapper) has been set up on this machine."""
    if os.environ.get("TALOS_TG_CLAIM_FORCE") == "1":
        return True
    home = os.path.expanduser("~")
    cfg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    for p in (os.path.join(home, ".claude", "channels", "telegram", "access.json"),
              os.path.join(home, ".claude", "channels", "telegram", ".env"),
              os.path.join(cfg, "talos", "notify.env")):
        if os.path.exists(p):
            return True
    return False


def outbound_text(name, inp):
    """-> ('tg', None, text) or None."""
    if not isinstance(inp, dict) or not TG_TOOL.search(name):
        return None
    t = inp.get("text") or ""
    return ("tg", None, t) if isinstance(t, str) and t.strip() else None


# ---------------------------------------------------------------- this turn's evidence
def _human_prompt(rec):
    if rec.get('type') != 'user' or rec.get('isMeta') or rec.get('isSidechain'):
        return False
    c = (rec.get('message') or {}).get('content')
    if isinstance(c, list):
        if any(isinstance(x, dict) and x.get('type') == 'tool_result' for x in c):
            return False
        c = "\n".join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
    return isinstance(c, str) and bool(c.strip()) and not c.lstrip().startswith('<task-notification>')


def turn_parts(records, stop_id=None):
    """(kind, text) parts of the CURRENT turn, stopping before tool_use stop_id. kinds: prompt, notif,
    result, input, outinput (another outbound call's text), asst (own prose: never evidence)."""
    parts = []
    for rec in records:
        if rec.get('isSidechain'):
            continue
        t = rec.get('type')
        if t == 'user':
            hp = _human_prompt(rec)
            if hp:
                parts = []
            c = (rec.get('message') or {}).get('content')
            if isinstance(c, str):
                parts.append(('prompt' if hp else 'notif', c))
                continue
            for x in c or []:
                if not isinstance(x, dict):
                    continue
                if x.get('type') == 'tool_result':
                    cc = x.get('content')
                    if isinstance(cc, list):
                        cc = "\n".join(y.get('text', '') for y in cc if isinstance(y, dict))
                    parts.append(('result', str(cc or '')))
                elif x.get('type') == 'text':
                    parts.append(('prompt' if hp else 'notif', x.get('text', '')))
        elif t == 'assistant':
            for x in (rec.get('message') or {}).get('content') or []:
                if not isinstance(x, dict):
                    continue
                if x.get('type') == 'tool_use':
                    if stop_id and x.get('id') == stop_id:
                        return parts
                    nm = x.get('name', '')
                    kind = 'outinput' if outbound_text(nm, x.get('input') or {}) else 'input'
                    parts.append((kind, json.dumps(x.get('input') or {})))
                elif x.get('type') == 'text':
                    parts.append(('asst', x.get('text', '')))
    return parts


def parts_from_transcript(path, stop_id=None):
    if not path or not os.path.exists(path):
        return []
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - TAIL_BYTES))
            lines = f.read().decode('utf-8', 'replace').splitlines()
    except Exception:
        return []
    recs = []
    for line in lines:
        try:
            recs.append(json.loads(line))
        except Exception:
            continue
    # only the records from the last human prompt on
    start = 0
    for i in range(len(recs) - 1, -1, -1):
        if _human_prompt(recs[i]):
            start = i
            break
    return turn_parts(recs[start:], stop_id)


EVIDENCE_KINDS = ('prompt', 'notif', 'result', 'input', 'outinput')


def evidence_text(parts):
    return "\n".join(t for k, t in parts if k in EVIDENCE_KINDS).lower().replace("\\n", " ")


# ---------------------------------------------------------------- detector (round 0 = claim-gate.py A1, unchanged)
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
    r"`[^`]+`|"
    r"\(checked[:)]|\(verified[:)]|\(source[:)]|"
    r"(?:checked|verified|measured|tested|probed)(?:\s+\w+){0,3}\s+(?:20\d\d-\d\d-\d\d|at \d|\d{1,2}:\d\d)|"
    r"https?://|"
    # LOOP R12 (R9 retried): ...and a path must LOOK like a path: rooted (~/, /, ./), or ending in a file extension,
    # or 2+ slashes with no capitalised segment. "Fri/Sat/Sun/Mon", "and/or" and model ids like
    # "vendor/model-2.5" are not citations.
    r"(?:^|[\s(])(?:~/|\.{1,2}/|/)[\w.-]+[\w./-]*|(?:^|[\s(])[\w.-]+(?:/[\w.-]+)*/[\w-]+\.(?-i:[a-z][a-z0-9]{0,5})\b|(?:^|[\s(])(?-i:[a-z0-9_.-]+(?:/[a-z0-9_.-]+){2,}/?)|"
    r"\b[\w-]+\.(?:md|py|sh|json|jsonl|txt|html|yml|yaml|ts|js)\b|"
    r"\b(?:returned|returns|printed|exit(?:ed)?(?: code)? \d|rc=\d|output|stdout|stderr|line \d+|row \d+|\d+ (?:rows|lines|entries|files|bytes|results))\b|"
    r"\b(?:per|according to) (?:the )?(?:docs?|spec|page|source|log|README|manual|transcript|ledger)\b|"
    r"\b(?:he|she|they|you|the user) (?:said|says|told|confirmed|reported|wrote)\b|"
    r"\b(?:the (?:docs?|page|spec|log|file|output|screenshot|transcript) (?:says?|shows?|lists?|reads?))\b|"
    r"\b(?:ticket|body|blog|post|draft|email|message|FAQ|README|note|notes|article|thread|doc) (?:says?|said|reads?|states?|stated|claims?|claimed)\b|"
    r"\b20\d\d-\d\d-\d\d\b|"
    r"\b(?:agent|reviewer|report|audit|re-?check|re-?clone|research|QA|sweep|scan)\b[^.]{0,40}?\b(?:says?|said|shows?|showed|found|finds|reports?|reported|named|passed|lists?)\b",
    re.I,
)
NEG_CONFIRM = re.compile(
    r"\b(?:not|never|nobody|no one|\w+n't|cannot|can't)\s+(?:\w+\s+){0,2}?(?:confirmed|verified)\b", re.I)
# LOOP R14: clauses joined by a spaced dash are checked on their own, so evidence in one clause no longer
# covers a bare claim in the other ("Dana told Sam X -- she has not tried it"). Semicolons stay
# joined: R13 showed they usually carry the hedge for the clause before them.
SENT_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+|\s+[—–]\s+")
PLAN = re.compile(r"\b(?:will|when|once|until|before|after|going to|plan(?:s|ned)? to|if it|if the|if they|so that|"
                  r"if you|should|would|could|might|let's|you can)\b", re.I)
SUPPORT_MIN = 0.7
NUM_SUPPORT_MIN = 0.3
STOP = set("""about above after again against also already among another because been before being
below between both but cannot could did does doing down during each else even every from further
had has have having here into itself just like more most much must never none nothing once only
other ours over same should some such than that their theirs them then there these they this those
through under until very was were what when where which while whom whose will with within without
would your yours yourself the and for are not you its it's that's there's isn't doesn't don't
didn't can't won't wasn't aren't haven't hasn't now still too yet all any one two three four five
six seven eight nine ten confirmed verified gone broken dead missing available exist exists
done fine sure""".split())
WORD = re.compile(r"[a-z][a-z0-9_'.-]{3,}")
NUM = re.compile(r"\d[\d,.]*\d")


def strip_noise(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    # LOOP R4: soft-wrapped prose (a line that does not end a sentence, then an indented or lower-case
    # continuation) is one sentence, not two fragments.
    text = re.sub(r"(?<=[\w,;*\"])[ \t]*\n[ \t]+(?=[\w(*\"])|(?<=[a-z,;])\n(?=[a-z(])", " ", text)
    keep = []
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("|") or s.startswith(">"):
            continue
        keep.append(line)
    return "\n".join(keep)


def supported(sent, evidence):
    if not evidence:
        return False
    s = re.sub(r"[*`_\[\]()]", " ", sent.lower())
    nums = [n.replace(",", "") for n in NUM.findall(s)]
    ev_nums = evidence.replace(",", "")
    if any(n not in ev_nums for n in nums):
        return False
    toks = re.findall(r"[a-z0-9']+", s)
    pairs = [a + " " + b for a, b in zip(toks, toks[1:]) if not (a in STOP and b in STOP)]
    if len(pairs) < 2:
        return False
    ev = " " + " ".join(re.findall(r"[a-z0-9']+", evidence)) + " "
    if nums and all(len(re.sub(r"\D", "", n)) >= 3 for n in nums):
        if sum(1 for p in pairs if " " + p + " " in ev) / len(pairs) >= NUM_SUPPORT_MIN:
            return True
    found = sum(1 for p in pairs if " " + p + " " in ev)
    if found / len(pairs) >= SUPPORT_MIN:
        return True
    words = [w.strip(".'-") for w in WORD.findall(s)]
    words = [w for w in words if len(w) >= 4 and w not in STOP]
    return len(words) >= 2 and all(w in evidence for w in words) and found / len(pairs) >= 0.5


# ---- LOOP R1: status-word ledger. A COMPLETION/RECOVERY status word (restored, fixed, resolved, live,
# shipped, deployed, merged, published, working again, back up) attached to a named thing (ticket key,
# capitalised name, path) is a claim. It is backed only when THIS turn's evidence shows that same thing
# within 300 chars of a status word of the same family, and no contrary status (in progress, still
# broken, open, failing, to do, blocked) sits nearer to it. A ticket the turn read as "in progress" and the message calls "restored" is the archetype.
STATUS_UP = re.compile(r"(?<!not )(?<!n't )(?<!never )(?<!nobody has )\b(?:restored|fixed|resolved|repaired|working again|works again|(?:is|are|'s) back (?:up|online)|"
                       r"(?:is|are|went|now) live|shipped|deployed|merged|published|re-?enabled|unblocked)\b", re.I)
UP_EV = re.compile(r"\b(?:restored|fixed|resolved|repaired|done|closed|working|works|live|shipped|deployed|merged|published|enabled|unblocked|completed?)\b")
DOWN_EV = re.compile(r"\b(?:in progress|stopped working|not (?:fixed|working|resolved|live)|still (?:broken|failing|down|open|blocked|in progress)|broken|failing|failed|to do|blocked|reopened|pending|waiting)\b")
TICKET = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")
NAME = re.compile(r"\b[A-Z][\w.-]*[a-z0-9](?:\s+(?:in\s+|for\s+)?[A-Z][\w.-]+)+")   # multi-word proper name
WORDCAP = re.compile(r"(?<=\s)[A-Z][a-z0-9][\w.-]{2,}")


def _anchors(s):
    for rx in (TICKET, NAME, WORDCAP):
        a = [x.strip().lower() for x in rx.findall(s) if len(x.strip()) >= 3]
        if a:
            return a
    return []


def status_unbacked(s, evidence):
    """True when s claims a completion/recovery status about a named thing and this turn's evidence does
    not show that thing next to such a status (UP word in the same clause, within 120 chars, and no contrary
    status anywhere on that line)."""
    if not STATUS_UP.search(s):
        return False
    anchors = _anchors(s)
    if not anchors:
        return False
    for a in anchors:
        for m in re.finditer(re.escape(a), evidence):
            ls = evidence.rfind("\n", 0, m.start()) + 1
            le = evidence.find("\n", m.end()); le = len(evidence) if le < 0 else le
            line = evidence[max(ls, m.start() - 200): min(le, m.end() + 200)]
            # the clause holding the anchor: an UP word in the NEXT clause is about something else
            pre = evidence[max(ls, m.start() - 120): m.start()]
            post = evidence[m.end(): min(le, m.end() + 120)]
            pre = re.split(r"[.;!?|](?:\s|$)", pre)[-1]
            post = re.split(r"[.;!?|](?:\s|$)", post)[0]
            near = pre + " " + post
            if UP_EV.search(near) and not DOWN_EV.search(line):
                return False
    return True

# LOOP R4: sentences that are not claims about the world, whatever words they use: instructions
# ("Don't lead with", "Keep X separate"), purpose clauses ("so it can't sneak back", "so there's no
# question later"), judgements on a demonstrative ("That is not pestering"), relative clauses ("a company
# that is not his"), and the assistant's own in-progress work ("Digging into why...").
NOT_CLAIM = re.compile(
    r"^\W*(?:don't|do not|never|keep|use|avoid|make sure|try|stop|digging|looking|checking|working on)\b|"
    r"\bso(?: that)? (?:\w+ ){0,3}?(?:can't|cannot|won't|don't|doesn't|isn't|there's no|there is no|nothing|no)\b|"
    r"^\W*(?:that|this|it)(?:'s| is| was) (?:not|no)\b|\b(?:that|which|who) (?:is|are|was|were)(?: not|n't)\b|"
    r"\b(?:nothing|no need|not) (?:worth|to worry|a reason)\b", re.I)


# ---- LOOP R5: broad claim vocabulary, loose support. Negations ("isn't a", "does not", "none are",
# "no CLI"), capability/limit verbs ("can only", "can't", "runs in", "blocks", "requires"), superlatives
# ("the strongest"), open-status words ("unverified", "not started", "unread", "ignored", "failed",
# "over its ceiling", "triple-booked") and first-person done-claims ("I built", "re-shot") are claims.
# Such a sentence counts as backed when >= BROAD_MIN of its content words occur in this turn's evidence
# (a loose test on purpose: this widens WHAT is checked, so it must not narrow what passes).
BROAD = re.compile(
    r"\b(?:is|are|was|were|has|have|had|does|do|did|can|could)(?: not|n't)\b|\bnone (?:of|are|is|were|was|have|has)\b|\bneither\b|\bnobody (?:has|had|is|was)\b|\bnever (?:been|had|was|were|happened|existed)\b|"
    r"\bno (?!one\b|longer\b|matter\b|need\b|idea\b|rush\b|worries\b|problem\b)[a-z]+|"
    r"\b(?:can only|only (?:works?|runs?|supports?)|can't|cannot|runs? (?:in|on)|blocks|requires|needs (?:a|an|the)\b|supports|exposes)\b|"
    r"\bthe (?:strongest|best|fastest|cheapest|only|biggest|largest|first)\b|\b(?:strongest|cheapest) \w+|"
    r"\b(?:unverified|not started|unread|ignored|failed|failing|empty|over (?:its|the) (?:ceiling|limit)|triple-booked|double-booked|overdue|expired|sold out|still open)\b|"
    r"\bI (?:built|wrote|made|fixed|shipped|sent|tested|checked|confirmed|verified)\b|\bre-?(?:shot|ran|tested|checked)\b|\bvalidates?\b|\bwas added\b",
    re.I)
BROAD_MIN = 0.6


FIRST_PERSON_DONE = re.compile(r"\bI (?:built|wrote|made|fixed|shipped|sent|tested|checked|confirmed|verified)\b|\bre-?(?:shot|ran|tested|checked)\b", re.I)


def _coverage(s, evidence):
    words = [w.strip(".'-") for w in WORD.findall(re.sub(r"[*`_\[\]()]", " ", s.lower()))]
    words = [w for w in words if len(w) >= 4 and w not in STOP]
    return sum(1 for w in words if w in evidence) / len(words) if len(words) >= 2 else 0.0


def broad_unbacked(s, evidence, ran_tools=False):
    if not BROAD.search(s):
        return False
    # a first-person "I checked / I built" in a turn that ran tools reports that work; with no tool run
    # in the turn it is exactly the "I built you a scorecard" failure
    if ran_tools and FIRST_PERSON_DONE.search(s) and len(BROAD.findall(s)) == len(FIRST_PERSON_DONE.findall(s)):
        return False
    words = [w.strip(".'-") for w in WORD.findall(re.sub(r"[*`_\[\]()]", " ", s.lower()))]
    words = [w for w in words if len(w) >= 4 and w not in STOP]
    if len(words) < 2:
        return not evidence
    return sum(1 for w in words if w in evidence) / len(words) < BROAD_MIN


def check_text(text, parts, chan='tg', path=None):
    """-> list of flagged sentences. parts = this turn's (kind, text) before the call."""
    hits = []
    evidence = None
    for sent in SENT_SPLIT.split(strip_noise(text)):
        s = sent.strip()
        if len(s) < 12 or NOT_CLAIM.search(s):
            continue
        if STATUS_UP.search(s) and not PLAN.search(s) and not EVIDENCE.search(s) and not re.match(r"(?:#|[-*] \[[ x]\])", s):
            if evidence is None:
                evidence = evidence_text(parts)
            if status_unbacked(s, evidence):
                hits.append(s)
                continue
        if not PLAN.search(s) and not EVIDENCE.search(s) and not re.match(r"(?:#|[-*] \[[ x]\])", s):
            if evidence is None:
                evidence = evidence_text(parts)
            if broad_unbacked(s, evidence, any(k == 'input' for k, _ in parts)):
                hits.append(s)
                continue
        if not CLAIM.search(NEG_CONFIRM.sub(" ", s)):
            continue
        if (re.search(r"\b(?:now|kept|replaced|removed|cut|deleted|edit(?:ed)?|draft|renamed)\b", s, re.I)
                and not CLAIM.search(re.sub(r"\b(?:is|are|was|were) gone\b", " ", NEG_CONFIRM.sub(" ", s), flags=re.I))):
            continue
        if EVIDENCE.search(s) or PLAN.search(s):
            continue
        if evidence is None:
            evidence = evidence_text(parts)
        if supported(s, evidence):
            continue
        # LOOP R11: in a DOCUMENT the claim-gate phrase path gets the loose R5 test too: a document restates
        # the turn's research at length and in its own words. Telegram replies keep the strict phrasing
        # test, because that is where overreaching one-line confirmations go out (loop #2's kb21; R10).
        # ...except a "confirmed/verified" sentence: re-using the evidence's words is exactly how an
        # overreaching confirmation reads (loop #2, kb21), so those keep the strict phrasing test
        if chan in ('doc', 'rdoc') and evidence and not re.search(r"\b(?:confirmed|verified)\b", s, re.I) and _coverage(s, evidence) >= BROAD_MIN:
            continue
        if evidence and len(re.findall(r"\w+", s)) <= 6 and re.search(r"\b(?:confirmed|verified)\b", s, re.I):
            continue
        hits.append(s)
    return hits


# ---------------------------------------------------------------- hook plumbing
def _log(rec):
    C.log_jsonl(LOG_NAME, rec)


def _seen_load():
    return C.load_json(SEEN)


def _seen_save(d):
    now = time.time()
    C.save_json(SEEN, {k: v for k, v in d.items() if now - float(v) < 6 * 3600})   # forget after 6h


def _notice(hits):
    quoted = "\n".join("  - " + (x if len(x) <= 220 else x[:217] + "...") for x in hits[:MAX_QUOTE])
    more = "\n  (+%d more)" % (len(hits) - MAX_QUOTE) if len(hits) > MAX_QUOTE else ""
    return ("CLAIM CHECK: this Telegram message states things this turn's tool results do not show:\n" + quoted + more + "\n"
            "For each: check it now (and carry the proof: the command, the source, the status you read), "
            "or label it an inference, or drop it. If this turn really does back it, send the same text "
            "again unchanged and it will pass.")


def run(data):
    name = str(data.get("tool_name") or "")
    ob = outbound_text(name, data.get("tool_input") or {})
    if not ob:
        return
    chan, path, text = ob
    t0 = time.time()
    parts = parts_from_transcript(data.get("transcript_path"), data.get("tool_use_id"))
    hits = check_text(text, parts, chan, path)
    sid = str(data.get("session_id") or "")
    h = hashlib.sha1((name + "\0" + text).encode("utf-8", "replace")).hexdigest()[:12]
    rec = {"session_id": sid[:8], "role": "pre", "chan": chan, "tool": name[-40:], "hash": h,
           "n": len(hits), "ms": round((time.time() - t0) * 1000, 1)}
    if not hits:
        rec["verdict"] = "allow"
        _log(rec)
        return
    rec["sample"] = [x[:140] for x in hits[:3]]
    if os.path.exists(SHADOW):
        rec["verdict"] = "shadow-block"
        _log(rec)
        return
    seen = _seen_load()
    key = sid + ":" + h
    if key in seen:
        rec["verdict"] = "allow-resend"            # second identical send: the model stood by it
        _log(rec)
        return
    seen[key] = time.time()
    _seen_save(seen)
    rec["verdict"] = "block-once"
    _log(rec)
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                             "permissionDecisionReason": _notice(hits)}}))


def main():
    if C.killed(KILL_NAME) or not channel_configured():
        return
    role = sys.argv[1] if len(sys.argv) > 1 else "pre"
    data = C.read_stdin()
    if role == "pre" and data:
        run(data)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass   # fail open, always
