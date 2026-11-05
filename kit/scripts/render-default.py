#!/usr/bin/env python3
"""render-default.py -- render a working default agent into a folder, with no setup interview.

    python3 scripts/render-default.py --into <agent folder>

Writes CLAUDE.md (from templates/CLAUDE.md.tmpl), the five memory files, a stub wiki/me.md and wiki/_onboarding-progress.md
(state not_offered). Floor rules and a neutral persona are filled in; whatever the interview would have captured (the owner, their
people, how they work, how they want output) reads "not yet captured". It refuses, writing nothing and exiting non-zero, unless
CLAUDE.md is missing or is byte-identical to the shipped placeholder (kit/CLAUDE.md): a tuned CLAUDE.md is never touched.
Other existing files are never overwritten. Running the interview later replaces these with real answers."""
import argparse
import hashlib, datetime, pathlib, re, sys

NOT_YET = "not yet captured (ask the owner, or ask to set up the agent (the talos-interview skill))"
VALUES = {
    "FAMILIAR_NAME": "Talos",
    "FAMILIAR_PERSONA": "A direct, capable assistant that remembers what the owner tells it.",
    "FAMILIAR_TONE": "Plain, brief, no filler.",
    "NEVER_DO": "Send, publish, delete, spend or share anything without the owner's yes (see .claude/rules/talos-defaults.md).",
    "GUARDRAILS": "No regulated data is recorded until the owner says what applies. Secrets live only in `.env`.",
    "DATE": datetime.date.today().isoformat(),
}
PLACEHOLDER_MARKER = "<!-- talos:placeholder -->"
# sha256 of the shipped kit/CLAUDE.md. Pinned here because in an installed agent this script sits beside the live
# CLAUDE.md, so "the shipped file" is not on disk to compare with. scripts/kit-default-agent.test.ts keeps it in step.
PLACEHOLDER_SHA256 = "aaffb8f84d57549527f1753b5efe4aa747ce842637f0f076e469931415861439"
ME_STUB = """---
title: Me
type: person
created: {d}
updated: {d}
status: stub
---
# Me

The owner of this agent. Not yet captured: role, goals, timezone. Fill this in as it comes up, or run the setup interview
(see [[README]] and [[_index]]).
"""
INDEX_SHIPPED = "*(the agent creates these during setup — this list is empty on purpose)*"
INDEX_ME = "- [[me]] — the owner of this agent (stub until captured)"
PROGRESS_STATE = "**Interview state:** not_offered. The agent already works; the interview is optional and can be started any time.\n\n"


def render(text: str) -> str:
    return re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: VALUES.get(m.group(1), NOT_YET), text)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--into", required=True)
    dst = pathlib.Path(ap.parse_args().into)
    kit = pathlib.Path(__file__).resolve().parent.parent
    cfg = dst / "CLAUDE.md"
    # The one overwrite this script ever does is replacing the shipped placeholder, byte for byte. A file that only
    # contains the marker (the owner quoted it, or wrote under the placeholder) is somebody's config.
    if cfg.exists() and hashlib.sha256(cfg.read_bytes()).hexdigest() != PLACEHOLDER_SHA256:
        print(f"refusing: {cfg} exists and is not the shipped placeholder, so it may be tuned. Nothing was changed.", file=sys.stderr)
        return 2
    plan = {"CLAUDE.md": "templates/CLAUDE.md.tmpl"}
    for n in ("STATE", "tasks", "decisions-ledger", "HANDOFF", "rules-ledger"):
        plan[f"memory/{n}.md"] = f"templates/{n}.md.tmpl"
    for out, src in plan.items():
        target = dst / out
        if target.exists() and out != "CLAUDE.md":
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(render((kit / src).read_text()))
    me = dst / "wiki" / "me.md"
    if not me.exists():
        me.parent.mkdir(parents=True, exist_ok=True)
        me.write_text(ME_STUB.format(d=VALUES["DATE"]))
    prog = dst / "wiki" / "_onboarding-progress.md"
    if not prog.exists():
        text = (kit / "templates/_onboarding-progress.md.tmpl").read_text()
        head, sep, rest = text.partition("\n\n")
        prog.write_text(head + sep + PROGRESS_STATE + rest)
    # Link the stub from the shipped, still-empty index. An index the owner has already written is left alone.
    idx = dst / "wiki" / "_index.md"
    if idx.exists():
        t = idx.read_text()
        if INDEX_SHIPPED in t and "[[me]]" not in t:
            idx.write_text(t.replace(INDEX_SHIPPED, INDEX_ME, 1))
    print(f"rendered the default agent into {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
