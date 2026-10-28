#!/usr/bin/env python3
"""dream/apply.py: step 4. NO LLM. The only code in the dream cycle that writes into wiki/.

Applies ONLY type=link proposals the judge accepted (max 15 a night) into the from-note's `## Related`
(`- [[to]] - context (dream <date>)`), de-duplicated, ABOVE any <!-- TIMELINE:APPEND-ONLY --> separator. Links
only: no prose edits, no frontmatter edits. Ledger: <run>/applied.json, plus preimage/ copies for a byte-exact undo.
Every other accepted item (and links over the cap) is appended to memory/dream/QUEUE.md with its quotes, file:line
and a proposed action. If the file memory/dream/QUEUE-ONLY exists, links are queued too and nothing is applied.
One row is added to wiki/_changelog.md when links were applied.

  python3 scripts/dream/apply.py                       # today's run
  python3 scripts/dream/apply.py memory/dream/2026-10-28 --max 15 [--dry-run]

apply.py refuses unless verified.json carries the seal verify_quotes.py put in verify-summary.json (an HMAC with a
key kept outside the agent folder), so a proposal can only get here by passing the quote check.
Inputs in the run dir: verified.json (verify_quotes.py) and judged.json
  ({"judgements":[{"id":"p-0001","decision":"accept|reject","reason":"..."}], "spotcheck":[...]} or a bare list).
"""
import argparse
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C  # noqa: E402

MAX_LINKS = 15
ACTIONS = {
    "contradiction": "Decide which statement is current; then correct the stale one, or mark that note `status: superseded` with `superseded_by:`.",
    "supersession": "Add `status: superseded` and `superseded_by: [[{to}]]` to the frontmatter of the OLD note (body untouched, never deleted).",
    "stale-fact": "Check the primary source; if stale, add a dated correction (never rewrite a timeline entry).",
    "flattened-date": "Restore the date or 'ongoing' qualifier the source had; keep the original wording in the timeline.",
    "link": "Add `- [[{to}]]` to `## Related` of [[{from}]] (not applied: over the nightly cap, or queue-only mode).",
}


def sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()[:16]


def insert_related(s, bullet):
    """(new_text, created_section). The bullet goes at the end of the last `## Related`, above any timeline."""
    cut = len(s)
    mi = s.find(C.TIMELINE_MARK)
    if mi >= 0:
        cut = mi
        heads = list(re.finditer(r"(?m)^##\s+.*$", s[:mi]))
        if heads and re.match(r"##\s+Timeline\b", heads[-1].group(0)):
            cut = heads[-1].start()
    pre, post = s[:cut], s[cut:]
    rel = list(re.finditer(r"(?m)^##\s+Related\b[^\n]*$", pre))
    if rel:
        start = rel[-1].end()
        nxt = re.search(r"(?m)^##\s+", pre[start:])
        end = start + nxt.start() if nxt else len(pre)
        before, sec, after = pre[:start], pre[start:end], pre[end:]
        sec2 = sec.rstrip("\n") + "\n" + bullet
        sec2 += "\n\n" if (after or post) else "\n"
        return before + sec2 + after + post, False
    pre2 = pre.rstrip("\n") + "\n\n## Related\n" + bullet + ("\n\n" if post else "\n")
    return pre2 + post, True


def clean_ctx(txt):
    t = re.sub(r"\[\[|\]\]|\|", "", str(txt or "")).replace("\n", " ")
    t = re.sub(r"\s+", " ", t).strip().rstrip(".")
    return (t[:150].rsplit(" ", 1)[0] if len(t) > 150 else t) or "related"


def has_link(s, to):
    return bool(re.search(r"\[\[" + re.escape(to) + r"(\||\]|#)", s))


def frozen(s):
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n", s, re.S)
    return bool(m and re.search(r"(?mi)^status:\s*[\"']?(superseded|archived)\b", m.group(1)))


def judged_map(path):
    d = C.jload(path, [])
    items = d.get("judgements", []) if isinstance(d, dict) else d
    return {str(j.get("id")): j for j in items if isinstance(j, dict)}


def queue_entry(v, j, date, why):
    key = sha("%s|%s|%s|%s" % (v.get("type"), v.get("from"), v.get("to"), C.norm(v.get("quote_from", ""))[:60]))
    L = ["- [ ] **%s** (%s, %s): %s  <!-- dq:%s -->" % (v["type"], v["id"], date, C.norm(v.get("claim") or v.get("why") or "")[:300], key)]
    L.append("  - from: [[%s]]" % v.get("from") + (" -> [[%s]]" % v.get("to") if v.get("to") else "") + ("  (%s)" % why if why else ""))
    L.append('  - quote A (%s:%s): "%s"' % (v.get("file_from"), v.get("line_from") or "?", C.norm(v.get("quote_from", ""))[:400]))
    if v.get("quote_to"):
        L.append('  - quote B (%s:%s): "%s"' % (v.get("file_to"), v.get("line_to") or "?", C.norm(v.get("quote_to", ""))[:400]))
    if j and j.get("reason"):
        L.append("  - judge: " + C.norm(j["reason"])[:240])
    L.append("  - proposed action: " + ACTIONS.get(v["type"], "Review.").format(to=v.get("to", ""), **{"from": v.get("from", "")}))
    return key, "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("run_dir", nargs="?", default=None)
    ap.add_argument("--max", type=int, default=MAX_LINKS)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--unsealed", action="store_true", help="skip the seal check (hand-made verified.json; humans only)")
    a = ap.parse_args(argv)
    run = os.path.abspath(a.run_dir) if a.run_dir else C.run_dir()
    date = os.path.basename(run.rstrip("/"))
    ledger_p = os.path.join(run, "applied.json")
    if os.path.exists(ledger_p) and not a.force and not a.dry_run:
        print("already applied for %s (applied.json exists); use revert.py first or --force" % date)
        return 1
    if not a.unsealed and not C.seal_ok(run):
        print("refusing: %s/verified.json is not the file verify_quotes.py wrote (missing or wrong seal). "
              "Re-run verify_quotes.py. Nothing was changed." % date)
        return 1
    queue_only = os.path.exists(C.QUEUE_ONLY)
    ver = C.jload(os.path.join(run, "verified.json"), [])
    jm = judged_map(os.path.join(run, "judged.json"))
    slugs = C.wiki_slugs()
    nf = C.NameFilter()
    applied, skipped, queued, rejected = [], [], [], []
    touched = {}
    wiki_real = os.path.realpath(C.WIKI)
    for v in ver:
        j = jm.get(v["id"])
        if not j or str(j.get("decision", "")).lower() != "accept":
            rejected.append({"id": v["id"], "type": v["type"], "reason": (j or {}).get("reason", "no judgement")})
            continue
        if v["type"] != "link":
            queued.append((v, j, ""))
            continue
        if queue_only:
            queued.append((v, j, "queue-only mode"))
            continue
        fs, ts = slugs.get(v.get("from"), []), slugs.get(v.get("to"), [])
        if len(fs) != 1 or len(ts) != 1 or v["from"] == v["to"]:
            skipped.append({"id": v["id"], "reason": "slug missing/ambiguous"})
            continue
        path = fs[0]
        rp = os.path.realpath(path)
        if (not rp.startswith(wiki_real + os.sep) or C.is_personal_path(path) or os.path.basename(path).startswith("_")
                or not C.allowed_input(C.rel(path))):
            skipped.append({"id": v["id"], "reason": "not an ordinary wiki note"})
            continue
        ctx = clean_ctx(v.get("why") or v.get("claim"))
        if nf.hits(ctx) or nf.hits(v["to"]) or nf.hits(v["from"]):
            skipped.append({"id": v["id"], "reason": "personal-name in context"})
            continue
        s = C.read(path)
        if frozen(s):
            skipped.append({"id": v["id"], "reason": "note is superseded/archived"})
            continue
        if has_link(s, v["to"]):
            skipped.append({"id": v["id"], "reason": "dup"})
            continue
        if len(applied) >= a.max:
            queued.append((v, j, "over nightly cap"))
            continue
        bullet = "- [[%s]] - %s (dream %s)" % (v["to"], ctx, date)
        s2, created = insert_related(s, bullet)
        if a.dry_run:
            applied.append({"id": v["id"], "from": v["from"], "to": v["to"], "bullet": bullet})
            continue
        touched.setdefault(path, s)
        C.write(path, s2)
        applied.append({"id": v["id"], "from": v["from"], "to": v["to"], "file": C.rel(path), "bullet": bullet,
                        "created_section": created, "before_sha": sha(s), "after_sha": sha(s2)})
    if a.dry_run:
        print("DRY RUN: would apply %d links, queue %d, skip %d, rejected %d%s" %
              (len(applied), len(queued), len(skipped), len(rejected), " (queue-only mode)" if queue_only else ""))
        return 0
    pdir = os.path.join(run, "preimage")
    for path, txt in touched.items():
        C.write(os.path.join(pdir, C.rel(path).replace("/", "__")), txt)
    C.jdump({"date": date, "max": a.max, "queue_only": queue_only, "applied": applied, "skipped": skipped,
             "rejected": rejected, "queued": [{"id": v["id"], "type": v["type"]} for v, _, _ in queued]}, ledger_p)
    existing = C.read(C.QUEUE)
    new = []
    for v, j, why in queued:
        key, txt = queue_entry(v, j, date, why)
        if "dq:%s" % key not in existing:
            new.append(txt)
    if new:
        head = "" if existing else ("# Dream cycle QUEUE\n\nNeeds your decision. Every item has verbatim quotes and a proposed action. "
                                    "Nothing here was applied. Tick `[x]` when handled; nothing reads this file to edit the wiki.\n")
        os.makedirs(os.path.dirname(C.QUEUE), exist_ok=True)
        with open(C.QUEUE, "a", encoding="utf-8") as fh:
            fh.write(head + "\n## %s\n" % date + "\n".join(new) + "\n")
    if applied:
        C.changelog_add("| %s | **Dream cycle: %d links added.** Nightly consolidation added %d `## Related` links (each tagged "
                        "`(dream %s)`; ledger `memory/dream/%s/applied.json`; undo with `python3 scripts/dream/revert.py %s`). "
                        "Links only, no prose edits. First: `%s` -> `%s`. |" %
                        (date, len(applied), len(applied), date, date, date, applied[0]["from"], applied[0]["to"]))
    print("dream apply %s: applied %d, queued %d, skipped %d, rejected %d%s" %
          (date, len(applied), len(new), len(skipped), len(rejected), " (queue-only mode)" if queue_only else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
