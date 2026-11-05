#!/usr/bin/env python3
"""memory-reflex.py: UserPromptSubmit. Look up the names in a message automatically, so "check the wiki before you
answer" stops depending on the agent remembering to.

WHAT IT DOES. Your message names a person, project, organisation or vendor that has a note in your wiki. This hook finds
the name, resolves it against <state>/gazetteer.json (built from your own wiki by scripts/wiki-gazetteer.py), and injects
up to 3 POINTERS as context: the note path and its one-line description. No model, no search index, no file reads
beyond that one JSON. It does not read the note for the agent; it says the note exists, so the agent reads it BEFORE
answering instead of after being corrected. Nothing is hard-coded: the names come from YOUR notes' titles, filenames and
`aliases:` frontmatter, so an empty wiki means no pointers and a growing wiki means better ones.

HOW A NAME IS RESOLVED (strict order; the first arm that hits decides)
  1. alias   explicit `aliases:` frontmatter field
  2. title   exact title / title minus a trailing (parenthetical) / filename slug / entity head
  3. surname a last name that exactly one person note has (and only for an isolated capitalised word)
  A name that lands on 2+ notes is DROPPED, not guessed. A one-word title that is also somebody's first name is vetoed
  by the `given` table. Ordinary English words that happen to be names are honoured only in the middle of a sentence.
  Precision over recall: a wrong pointer costs more than a missed one. scripts/test-memory-reflex.sh must show ZERO
  wrong pointers.

LIMITS (by design)
  - at most 3 pointers; a note already pointed at in this session (session_id) is skipped;
  - robot prompts (<scheduled-*>, <task-notification>, <cross-session-message>, <system-reminder>) and slash commands are
    ignored; a chat-channel prompt (<channel ...>) is read for the text inside the tag;
  - output is capped near 120 words; the whole run is a JSON load plus a regex pass (well under 150 ms);
  - only notes under wiki/ are in the gazetteer. A private vault is never read, indexed or pointed at.

LOG   <state>/reflex-log.jsonl  (pointers sent and names dropped as ambiguous; never prompt text)
KILL  memory-reflex.off (file in the state folder, TALOS_MEMORY_REFLEX_OFF=1, or the Chronos Control Room)
BUILD python3 scripts/wiki-gazetteer.py   (session start refreshes it in the background when your notes are newer)

FAILS OPEN, ALWAYS: any exception -> print nothing, exit 0. It can never block or delay a prompt.
"""
import json
import os
import re
import sys
import time
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _talos_common as C  # noqa: E402

KILL_NAME = "memory-reflex.off"
STATE = C.state_dir()
GAZ = os.path.join(STATE, "gazetteer.json")
LOG_NAME = "reflex-log.jsonl"
SESS_DIR = os.path.join(STATE, "reflex-sessions")

MAX_POINTERS = 3
MAX_WORDS_OUT = 120
MAX_DESC_WORDS = 26
MAX_CHARS_IN = 6000
MAX_NGRAM = 6

ROBOT_PREFIXES = ("<scheduled-task", "<scheduled-cron", "<cross-session-message",
                  "<task-notification", "<system-reminder", "<command-name", "<command-message",
                  "<local-command")
SLASH = re.compile(r"^/[A-Za-z][\w:\-]*(?:\s|$)")

CONNECTORS = {"of", "the", "and", "vs", "for", "de", "van", "von", "la", "di", "da", "le", "du"}
# capitalised words that open a sentence/command but are not part of a name
OPENERS = set("""ask tell ping email text call thanks thank hey hi hello cc and see per with from for did does do what who
whom when why how can could would should will is are was were check send loop remind say said let make get add
update review read open run show find draft write schedule meet meeting also then so but or if now ok okay yes no
please just is its it's i we you he she they my our your his her their give pull grab fetch look tag note log
forward reply forwarded dm slack zoom re fwd after before about on in at to by of as this that these those here
there where which while until once again still""".split())

TOK = re.compile(r"[^\W_]+(?:['\u2019][^\W_]+)*", re.U)
SEP_OK = re.compile(r"^(?:[ \t]+|-)$")           # one hop between name words: spaces, or a single hyphen
STRIP = [
    re.compile(r"```.*?```", re.S),
    re.compile(r"`[^`\n]*`"),
    re.compile(r"https?://\S+"),
    re.compile(r"\S+@\S+\.\S+"),
    re.compile(r"\S*/\S*"),                         # paths and anything slashed
]


def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("\u2019", "'")
    s = re.sub(r"'s\b", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " ".join(s.split())


def log(rec):
    C.log_jsonl(LOG_NAME, rec, keep_lines=1500)


def prompt_text(data):
    """-> text, or None for a prompt we must not touch."""
    p = data.get("prompt")
    if not isinstance(p, str):
        return None
    head = p.lstrip()
    if head.startswith(ROBOT_PREFIXES) or SLASH.match(head):
        return None
    if head.startswith("<channel"):
        m = re.match(r"<channel\b([^>]*)>(.*?)(?:</channel>\s*)?$", head, re.S)
        head = m.group(2) if m else head
    return head[:MAX_CHARS_IN]


def tokenize(text):
    """Strip code/urls/paths, then tokenise with sentence-start and adjacency info."""
    for rx in STRIP:
        text = rx.sub(lambda m: " " * len(m.group(0)), text)      # same length: offsets stay true
    toks = []
    for m in TOK.finditer(text):
        raw = m.group(0)
        s, e = m.start(), m.end()
        # sentence start: nothing but quotes/brackets/bullets between here and a terminator or line start
        j = s - 1
        while j >= 0 and text[j] in " \t\"'([{*_>#\u201c\u2018":
            j -= 1
        sentence_start = j < 0 or text[j] in ".!?:;\n\r"
        # "Node.js", "report.md", "notes.Final": a dotted token is a file or domain, not a name
        dotted = bool(re.match(r"\.[A-Za-z0-9]", text[e:e + 2])) or (s >= 2 and text[s - 1] == "." and text[s - 2].isalnum())
        toks.append({"raw": raw, "k": "" if dotted else norm(raw), "s": s, "e": e, "ss": sentence_start})
    # adjacency: may token i join token i+1 into one name?
    for i in range(len(toks) - 1):
        gap = text[toks[i]["e"]:toks[i + 1]["s"]]
        toks[i]["join"] = bool(SEP_OK.match(gap))
    if toks:
        toks[-1]["join"] = False
    return toks


def case_state(raw):
    if len(raw) > 1 and raw.isupper():
        return "caps"
    if raw[:1].isupper():
        return "title"
    return "lower"


def is_cap_word(t):
    return t["raw"][:1].isupper() and not (len(t["raw"]) == 1 and t["raw"] == "I")


def name_part(toks, i):
    """Is toks[i] plausibly part of someone's name (capitalised, and not a sentence opener)?"""
    t = toks[i]
    if not is_cap_word(t):
        return False
    if t["ss"] and t["k"] in OPENERS:
        return False
    return True


def isolated(toks, i):
    prev_part = i > 0 and toks[i - 1]["join"] and name_part(toks, i - 1)
    next_part = i + 1 < len(toks) and toks[i]["join"] and name_part(toks, i + 1)
    return not (prev_part or next_part)


def uniq(seq):
    out = []
    for x in seq:
        if x not in out:
            out.append(x)
    return out


def rule_ok_multi(note, n, toks_slice):
    """Case rule for a multi-word TITLE hit."""
    if note.get("pe"):
        return True                                  # a person's full name: any case
    caps_ok = all(is_cap_word(t) or t["k"] in CONNECTORS for t in toks_slice)
    if note.get("e") and n >= 3:
        return True
    return caps_ok


def resolve(toks, g):
    notes = g["notes"]
    alias, title, surname, given = g["alias"], g["title"], g["surname"], g["given"]
    ordinary, caps, ignore = set(g.get("ordinary", ())), set(g.get("caps", ())), set(g.get("ignore", ()))
    ranked, dropped = [], []
    i, N = 0, len(toks)
    while i < N:
        matched = False
        # ---- multi-word spans, longest first
        top = min(MAX_NGRAM, N - i)
        for n in range(top, 1, -1):
            if not all(toks[i + d]["join"] for d in range(n - 1)):
                continue
            sl = toks[i:i + n]
            key = " ".join(t["k"] for t in sl)
            if key in alias:
                hits, arm = list(alias[key]), 0
            elif key in title:
                hits, arm = [h for h in title[key] if rule_ok_multi(notes[h], n, sl)], 1
            else:
                continue
            if not hits:
                continue
            hits = uniq(hits)
            if len(hits) >= 2:
                dropped.append({"name": key, "why": "ambiguous", "n": len(hits)})
            else:
                ranked.append({"idx": hits[0], "arm": arm, "len": n, "pos": sl[0]["s"], "name": key})
            i += n
            matched = True
            break
        if matched:
            continue
        # ---- single word
        t = toks[i]
        k, st = t["k"], case_state(t["raw"])
        if k and k not in ignore and (len(k) >= 3 or k in alias):
            if k in alias:                                         # explicit alias: any case, trusted
                hits = uniq(alias[k])
                if len(hits) >= 2:
                    dropped.append({"name": k, "why": "ambiguous", "n": len(hits)})
                else:
                    ranked.append({"idx": hits[0], "arm": 0, "len": 1, "pos": t["s"], "name": k})
            else:
                ok_case = (st == "title") or (st == "caps" and k in caps)
                tit = [h for h in title.get(k, []) if notes[h].get("e")]
                if st == "lower" and tit and k not in ordinary and len(k) >= 5 and not notes[tit[0]].get("pe"):
                    ok_case = True                                 # "quasarfin", "acmecorp": coined names
                if ok_case and k in ordinary and (st != "title" or t["ss"]):
                    ok_case = False                                # "Ready" opens sentences; "Orrery" does not
                if ok_case:
                    main = list(tit)
                    if st == "title" and k in surname and isolated(toks, i):
                        main += surname[k]
                    main = uniq(main)
                    if main:
                        cands = uniq(main + (list(given.get(k, [])) if any(notes[h].get("pe") for h in main) else []))
                        if len(cands) >= 2:
                            dropped.append({"name": k, "why": "ambiguous", "n": len(cands)})
                        else:
                            arm = 1 if main[0] in tit else 2
                            ranked.append({"idx": main[0], "arm": arm, "len": 1, "pos": t["s"], "name": k})
        i += 1
    return ranked, dropped


def seen_path(sid):
    return os.path.join(SESS_DIR, sid + ".json")


def load_seen(sid):
    try:
        with open(seen_path(sid)) as f:
            d = json.load(f)
        return set(d.get("sent", []))
    except Exception:
        return set()


def save_seen(sid, sent):
    try:
        os.makedirs(SESS_DIR, exist_ok=True)
        with open(seen_path(sid), "w") as f:
            json.dump({"sent": sorted(sent), "ts": int(time.time())}, f)
        if int(time.time()) % 50 == 0:                             # rare housekeeping: drop sessions >3 days old
            cutoff = time.time() - 3 * 86400
            for n in os.listdir(SESS_DIR):
                p = os.path.join(SESS_DIR, n)
                if os.path.getmtime(p) < cutoff:
                    os.remove(p)
    except Exception:
        pass


def clip(desc, n):
    desc = re.sub(r"\[\[([^\]|]*)(?:\|([^\]]*))?\]\]", lambda m: m.group(2) or m.group(1), desc)
    desc = re.sub(r"[*`_]{1,3}", "", desc)                          # markdown emphasis is noise in a pointer
    desc = re.sub(r"^[^\w\"'(\[]+", "", desc)                       # leading emoji / bullets
    w = desc.split()
    return " ".join(w) if len(w) <= n else " ".join(w[:n]) + "..."


def render(chosen, notes):
    lines = []
    budget = MAX_DESC_WORDS
    for _ in range(4):
        lines = []
        for r in chosen:
            nt = notes[r["idx"]]
            d = clip(nt.get("d") or "", budget) or "(no description; title: %s)" % nt.get("t", "")
            lines.append("- %s: %s - %s" % (re.sub(r"\s*[\(\[].*$", "", nt.get("t", "")).strip() or nt["p"], nt["p"], d))
        text = ("Memory reflex (exact name match, no model). Read these notes before answering about them:\n"
                + "\n".join(lines))
        if len(text.split()) <= MAX_WORDS_OUT:
            return text
        budget = max(6, budget - 7)
    return text


def main():
    t0 = time.time()
    if C.killed(KILL_NAME):
        return
    raw = sys.stdin.read(2_000_000)
    data = json.loads(raw or "{}")
    if not isinstance(data, dict):
        return
    text = prompt_text(data)
    if not text or not text.strip():
        return
    with open(GAZ, encoding="utf-8") as f:
        g = json.load(f)
    toks = tokenize(text)
    if not toks:
        return
    ranked, dropped = resolve(toks, g)
    if not ranked and not dropped:
        return
    notes = g["notes"]
    sid = data.get("session_id")
    sid = sid if isinstance(sid, str) and 0 < len(sid) <= 128 and re.fullmatch(r"[\w\-]+", sid) else "anon"
    seen = load_seen(sid)
    # best first: alias > title > surname, longer span, entity before concept, earlier in message
    ranked.sort(key=lambda r: (r["arm"], -r["len"], 0 if notes[r["idx"]].get("e") else 1, r["pos"]))
    chosen, paths = [], set()
    # notes are looked up under THIS agent folder; a gazetteer built for another folder (or a stale entry) points at nothing
    for r in ranked:
        p = notes[r["idx"]]["p"]
        if p in seen or p in paths:
            continue
        if not C.contained(os.path.join(C.ROOT, p)) or not os.path.exists(os.path.join(C.ROOT, p)):
            continue                                                # stale gazetteer entry: never point at a ghost
        chosen.append(r)
        paths.add(p)
        if len(chosen) >= MAX_POINTERS:
            break
    ms = round((time.time() - t0) * 1000, 1)
    log({"sid": sid, "ms": ms,
         "pointers": [{"path": notes[r["idx"]]["p"], "arm": ("alias", "title", "surname")[r["arm"]], "name": r["name"]} for r in chosen],
         "dropped": dropped[:6]})
    if not chosen:
        return
    save_seen(sid, seen | paths)
    out = render(chosen, notes)
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                         "additionalContext": out}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass                                                        # fail open, always
    sys.exit(0)
