#!/usr/bin/env python3
"""
deep-dive-select.py — pick which topics earn a deeper crawl, deterministically.

WHY THIS IS A SCRIPT AND NOT A JUDGMENT CALL
--------------------------------------------
"Have the agent identify the top topics" is the step where a deep-dive phase goes
wrong. An agent asked to rank by importance ranks by what reads impressively, and
you get five dives on the CEO and the reorg while the person the user actually
works with every day stays a stub.

So the selector uses the ONE signal the graph already gives you for free:

    something many notes point at, that we know almost nothing about.

High in-degree says the corpus thinks it matters. Low word count says we failed to
capture it. That intersection is the research queue, it is explainable to the user,
and it DRAINS — every dive that fills a stub removes it from the ranking. An
importance-ranker never terminates.

⚠️ MENTION FREQUENCY IS NOT THE SIGNAL, and this is not hypothetical. A profile-refresh
script in the reference agent this kit came from originally counted any dated file
containing an entity's name as "activity." Writing an artifact that merely name-dropped a
project re-flagged its profile, twice, before anyone diagnosed it. Counting mentions finds whatever is
verbose. Counting inbound links finds what is load-bearing.

WHAT SCORES
-----------
  dangling      a [[link]] whose target file does not exist at all.       weight 3.0
                The graph names something and we have literally nothing.
                These outrank everything and they should.
  deficit       inbound [[wikilinks]] / body words, x100. The core metric.
                Asks whether what we wrote is proportional to how much the
                graph leans on it. A note with 210 referrers and 865 words is
                COVERED; one with 164 referrers and 114 words is a hole.
  multi-source  the name appears in 2+ .seed-staging/<source>/ dirs.      weight 1.5
                Someone who shows up in email AND calendar AND Slack is
                structural. Someone in one thread is an artifact.
  open-question the note has unanswered `## Open questions` bullets.      weight 1.0
                An explicit research target the user already wrote down.

Usage:
    python3 scripts/deep-dive-select.py wiki [--staging .seed-staging] [--n 5]
    python3 scripts/deep-dive-select.py wiki --json      # machine-readable
"""
from __future__ import annotations
import argparse, json, math, re, sys
from collections import defaultdict
from pathlib import Path

SKIP = {"_index", "_changelog", "_privacy-and-sharing", "README", "_lint",
        "_onboarding-progress"}
LINK = re.compile(r"\[\[([^\]|#]+)")
FM = re.compile(r"\A---\n(.*?)\n---\n", re.S)
# A dive is only worth spawning for things a connector crawl can actually deepen.
DIVEABLE = {"person", "project", "concept", "topic", "team", "meeting", "org", "system"}
PEOPLE = {"person"}


def slug(s: str) -> str:
    """Link target -> note stem. Strips path prefixes: [[../people/dana-ruiz]] and
    [[dana-ruiz]] are the same note, and treating them as different invents
    phantom dangling targets that then rank at the top of the queue."""
    s = s.strip().split("/")[-1]
    if s.lower().endswith(".md"):
        s = s[:-3]
    return s.lower().replace(" ", "-")


def parse(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8", errors="replace")
    m = FM.match(raw)
    meta, body = {}, raw
    if m:
        body = raw[m.end():]
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"').strip("'")
    # Related is navigation, not content -- counting it would make every note look fat.
    body_wo_rel = re.split(r"^##+\s*Related\s*$", body, flags=re.M | re.I)[0]
    open_q = 0
    qm = re.search(r"^##+\s*Open questions\s*$(.*?)(?=^##|\Z)", body, flags=re.M | re.I | re.S)
    if qm:
        open_q = len([l for l in qm.group(1).splitlines() if l.strip().startswith(("-", "*"))])
    return {
        "slug": path.stem,
        "path": str(path),
        "title": meta.get("title", path.stem),
        "type": meta.get("type", "").lower(),
        "status": meta.get("status", "").lower(),
        "words": len(re.findall(r"[A-Za-z][\w'-]*", body_wo_rel)),
        "open_q": open_q,
        "links": {slug(x) for x in LINK.findall(body)},
    }


def staging_hits(names: dict[str, str], staging: Path) -> dict[str, int]:
    """How many distinct source dirs mention each title. Cheap, case-insensitive."""
    hits: dict[str, set] = defaultdict(set)
    if not staging.is_dir():
        return {}
    for srcdir in [d for d in staging.iterdir() if d.is_dir()]:
        blob = ""
        for f in list(srcdir.rglob("*"))[:400]:
            if f.is_file():
                try:
                    blob += f.read_text(encoding="utf-8", errors="replace").lower()
                except OSError:
                    pass
        for sl, title in names.items():
            if title and title.lower() in blob:
                hits[sl].add(srcdir.name)
    return {k: len(v) for k, v in hits.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("wiki")
    ap.add_argument("--staging", default=".seed-staging")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--people", type=int, default=3,
                    help="how many of --n are reserved for type:person (default 3)")
    ap.add_argument("--shortlist", type=int, default=20,
                    help="how many ranked candidates to offer beyond the auto-picked slate")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    wiki = Path(a.wiki)
    if not wiki.is_dir():
        print(f"no such wiki dir: {wiki}", file=sys.stderr)
        return 2

    notes = [parse(p) for p in sorted(wiki.rglob("*.md"))
             if p.stem not in SKIP and "examples" not in p.parts and not p.stem.startswith("_lint")]
    by_slug = {n["slug"]: n for n in notes}

    indeg: dict[str, int] = defaultdict(int)
    for n in notes:
        for tgt in n["links"]:
            if tgt != n["slug"]:
                indeg[tgt] += 1

    hits = staging_hits({n["slug"]: n["title"] for n in notes}, Path(a.staging))

    rows = []
    # Dangling targets first: referenced by name, no file at all.
    for tgt, deg in indeg.items():
        if tgt not in by_slug and tgt not in {k.lower() for k in SKIP}:
            rows.append({"slug": tgt, "title": tgt.replace("-", " "), "type": "dangling",
                         "indeg": deg, "words": 0, "sources": hits.get(tgt, 0), "open_q": 0,
                         "score": round(3.0 * deg, 2),
                         "why": f"referenced by {deg} note(s), no file exists"})
    for n in notes:
        if n["type"] and n["type"] not in DIVEABLE:
            continue
        deg, words = indeg.get(n["slug"], 0), n["words"]
        if deg == 0 and n["open_q"] == 0:
            continue  # orphan with nothing asked -- lint's problem, not the crawler's
        # Coverage deficit: how many notes depend on this per word we actually wrote.
        # indeg*thinness let a 210-inbound / 865-word note outrank a 164-inbound /
        # 114-word one, which is backwards -- the fat note is COVERED. A ratio asks
        # "is what we know proportional to how much the graph leans on it."
        deficit = deg / max(words, 25)
        score = deficit * 100 + hits.get(n["slug"], 0) * 1.5 + n["open_q"] * 1.0
        if n["status"] == "stub":
            score += 2.0
        why = [f"{deg} inbound", f"{words}w"]
        if hits.get(n["slug"], 0) >= 2:
            why.append(f"{hits[n['slug']]} sources")
        if n["open_q"]:
            why.append(f"{n['open_q']} open q")
        rows.append({**{k: n[k] for k in ("slug", "title", "type")},
                     "indeg": deg, "words": words, "sources": hits.get(n["slug"], 0),
                     "open_q": n["open_q"], "score": round(score, 2), "why": ", ".join(why)})

    rows.sort(key=lambda r: (-r["score"], r["slug"]))

    # Shape the slate so the selector cannot collapse onto one type.
    # The quota is a CEILING on people, not just a floor. Filling `rest` from all
    # remaining rows let five hot people take every slot and relegate the project to
    # the shortlist -- which is the exact collapse the shape was meant to prevent.
    ppl = [r for r in rows if r["type"] in PEOPLE][:a.people]
    non = [r for r in rows if r["type"] not in PEOPLE]
    rest = non[:max(a.n - len(ppl), 0)]
    # If there are not enough non-people to fill the slate, let people take the slack
    # rather than returning a short slate.
    if len(ppl) + len(rest) < a.n:
        spare = [r for r in rows if r["type"] in PEOPLE and r not in ppl]
        rest += spare[:a.n - len(ppl) - len(rest)]
    picked = sorted((ppl + rest)[:a.n], key=lambda r: -r["score"])

    if a.json:
        print(json.dumps({
            "picked": picked,
            "shortlist": [x for x in rows if x not in picked][:a.shortlist],
            "ceiling": 8,
        }, indent=2))
        return 0

    if not picked:
        print("Nothing qualifies for a deep dive. That is a real answer:")
        print("the seed either covered everything it touched, or it pulled too little to rank.")
        return 0

    print(f"Deep-dive slate ({len(picked)} of {len(rows)} candidates):\n")
    for i, r in enumerate(picked, 1):
        print(f"{i}. {r['title']}  [{r['type']}]  score {r['score']}")
        print(f"   {r['why']}")
    rest_ranked = [x for x in rows if x not in picked][:a.shortlist]
    if rest_ranked:
        print(f"\nShortlist — next {len(rest_ranked)} by the same score. Offer these; the user")
        print("may add any of them, and may also name a topic that is not on the list at all.")
        for i, r in enumerate(rest_ranked, len(picked) + 1):
            print(f"{i:3}. {r['title']}  [{r['type']}]  score {r['score']}  ({r['why']})")
        print("\n\u26a0\ufe0f  Additions cost a full diver each. Zoom is the binding constraint;")
        print("   8 total dives is the practical ceiling for one run.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
