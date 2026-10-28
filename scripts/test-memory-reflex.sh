#!/usr/bin/env bash
# test-memory-reflex.sh -- hooks/memory-reflex.py + scripts/wiki-gazetteer.py against a made-up wiki.
#
# SCORING (both ways at once):
#   ideal   = the notes a careful human would say the message is naming
#   missed  = ideal but not returned     -> recall cost, tolerated (a "pin" says what the hook returns today)
#   wrong   = returned but not ideal     -> a misleading pointer, FORBIDDEN. This suite must show ZERO.
#   pin     = what the hook is expected to return today; drift from it fails, so an accepted miss cannot silently
#             become a wrong pointer later.
# Everything runs in a throwaway agent folder with a throwaway HOME / XDG; nothing touches your real state.
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home" XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"; mkdir -p "$HOME"
unset CHRONOS_RUN TALOS_UNATTENDED CHRONOS_CONFIG
export KIT SB
python3 - <<'PY'
import json, os, subprocess, sys, time, shutil

KIT, SB = os.environ["KIT"], os.environ["SB"]
A = os.path.join(SB, "agent")
os.makedirs(os.path.join(A, "hooks")); os.makedirs(os.path.join(A, "scripts")); os.makedirs(os.path.join(A, "wiki"))
for f in os.listdir(os.path.join(KIT, "hooks")):
    if f.endswith(".py"):
        shutil.copy(os.path.join(KIT, "hooks", f), os.path.join(A, "hooks", f))
shutil.copy(os.path.join(KIT, "scripts", "wiki-gazetteer.py"), os.path.join(A, "scripts", "wiki-gazetteer.py"))
HOOK = os.path.join(A, "hooks", "memory-reflex.py")
GAZ = os.path.join(A, "scripts", "wiki-gazetteer.py")
fails, timings = [], []
tot = {"cases": 0, "ideal": 0, "missed": 0, "wrong": 0, "pass": 0}


def note(path, title, typ, extra="", desc="a made-up note", body=None):
    full = os.path.join(A, "wiki", path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as fh:
        fh.write("---\ntitle: %s\ntype: %s\ndescription: %s\n%s---\n\n# %s\n%s\n" % (title, typ, desc, extra, title, body or ""))


# ---- a made-up wiki. Nobody here is real.
note("me.md", "Riley Quinn", "person", desc="the owner of this agent")
note("people/dana-ruiz.md", "Dana Ruiz", "person", desc="Vendor lead at Acme")
note("people/marcus-chen.md", "Marcus Chen", "person", "aliases: [Marc, Chen-san]\n", desc="Design lead")
note("people/priya-venkataraghavan.md", "Priya Venkataraghavan", "person")
note("people/sam-one.md", "Sam One", "person", "aliases: [Sammy]\n")
note("people/sam-two.md", "Sam Two", "person", "aliases: [Sammy]\n")
note("people/maria-hollowell.md", "Maria Hollowell", "person")
note("people/dave-hollowell.md", "Dave Hollowell", "person")
note("people/linus.md", "Linus", "person")
note("people/linus-testwell.md", "Linus Testwell", "person")
note("people/grant-ellis.md", "Grant Ellis", "person")
note("people/porter-lane.md", "Porter Lane", "person")
note("people/old-person.md", "Olaf Obsolete", "person", "status: superseded\n")
note("people/secret-person.md", "Sven Secretive", "person", "confidential: true\n")
note("projects/quasarfin.md", "Quasarfin", "project", "aliases: [QF]\n", desc="The Quasarfin migration")
note("projects/orrery-platform.md", "Orrery Platform", "project", desc="Platform rollout")
note("projects/ready.md", "Ready", "project", desc="A side project")
note("orgs/acme-corp.md", "Acme Corp", "org", desc="The main vendor")
note("concepts/wibble-wobble-theory.md", "Wibble Wobble Theory", "concept")
note("examples/jo-example.md", "Jo Example", "person", desc="shipped worked example")
note("_changelog.md", "Changelog", "meta")
note("index.md", "Index", "meta")
os.makedirs(os.path.join(SB, "cfg", "talos"), exist_ok=True)
open(os.path.join(SB, "cfg", "talos", "reflex-ignore.txt"), "w").write("# names that are in every message\nacme corp helper\n")

W = "wiki/"
DANA, MARCUS, PRIYA = W + "people/dana-ruiz.md", W + "people/marcus-chen.md", W + "people/priya-venkataraghavan.md"
MARIA, GRANT, PORTER = W + "people/maria-hollowell.md", W + "people/grant-ellis.md", W + "people/porter-lane.md"
QF, ORRERY, ACME = W + "projects/quasarfin.md", W + "projects/orrery-platform.md", W + "orgs/acme-corp.md"
READY, WIBBLE = W + "projects/ready.md", W + "concepts/wibble-wobble-theory.md"

env = dict(os.environ)
r = subprocess.run([sys.executable, GAZ], capture_output=True, text=True, env=env, cwd=A)
if r.returncode != 0 or "wiki-gazetteer:" not in r.stdout:
    print("  FAIL gazetteer build: %s %s" % (r.stdout[-200:], r.stderr[-300:])); sys.exit(1)
sd = subprocess.run([sys.executable, "-c", "import sys; sys.path.insert(0,'hooks'); import _talos_common as C; print(C.state_dir())"],
                    capture_output=True, text=True, cwd=A).stdout.strip()
GAZFILE = os.path.join(sd, "gazetteer.json")
if not os.path.exists(GAZFILE):
    print("  FAIL the gazetteer was not written to the per-agent state folder: %s" % sd); sys.exit(1)
g = json.load(open(GAZFILE))
paths_in = {n["p"] for n in g["notes"]}


def check(name, cond, detail=""):
    print("  %s %s%s" % ("ok  " if cond else "FAIL", name, ("   " + detail) if detail and not cond else ""))
    if not cond:
        fails.append(name)
    else:
        tot["pass"] += 1


print("wiki-gazetteer.py")
check("the gazetteer lands in the per-agent state folder, outside the agent folder", sd.startswith(os.path.join(SB, "state")) and not GAZFILE.startswith(A))
check("superseded, confidential, meta files and wiki/examples are left out",
      not (paths_in & {W + "people/old-person.md", W + "people/secret-person.md", W + "_changelog.md", W + "index.md", W + "examples/jo-example.md"}))
check("the owner's own name (title of wiki/me.md) is on the ignore list", "riley quinn" in g["ignore"] and "riley" in g["ignore"])
check("names from ~/.config/talos/reflex-ignore.txt are on the ignore list", "acme corp helper" in g["ignore"])
gj = json.dumps(g)
check("nothing outside wiki/ is in the file (no memory/, no vault, no home path)", "memory/" not in gj and "/Users/" not in gj and "/home/" not in gj)
r = subprocess.run([sys.executable, GAZ, "--check"], capture_output=True, text=True, cwd=A, env=env)
check("--check says fresh right after a build", r.returncode == 0 and r.stdout.strip() == "fresh")
future = time.time() + 5
os.utime(os.path.join(A, "wiki", "people", "dana-ruiz.md"), (future, future))
r = subprocess.run([sys.executable, GAZ, "--check"], capture_output=True, text=True, cwd=A, env=env)
check("--check says STALE when a note is newer", r.returncode == 1 and "STALE" in r.stdout)
r = subprocess.run([sys.executable, GAZ, "--if-stale", "--quiet"], capture_output=True, text=True, cwd=A, env=env)
os.utime(GAZFILE, (future + 10, future + 10))
r2 = subprocess.run([sys.executable, GAZ, "--if-stale"], capture_output=True, text=True, cwd=A, env=env)
check("--if-stale rebuilds when stale and is silent and does nothing when fresh", r.returncode == 0 and r2.returncode == 0 and r2.stdout == "")


def run(prompt, sid="t", raw=None, extra_env=None):
    payload = raw if raw is not None else json.dumps({"session_id": sid, "hook_event_name": "UserPromptSubmit", "prompt": prompt})
    e = dict(os.environ); e.update(extra_env or {})
    t0 = time.time()
    r = subprocess.run([sys.executable, HOOK], input=payload, capture_output=True, text=True, env=e, timeout=10, cwd=A)
    timings.append((time.time() - t0) * 1000)
    if r.returncode != 0 or r.stderr.strip():
        return None, "crash rc=%s %s" % (r.returncode, r.stderr[:120]), ""
    out = r.stdout.strip()
    if not out:
        return set(), "", ""
    try:
        ctx = json.loads(out)["hookSpecificOutput"]["additionalContext"]
    except Exception:
        return None, "bad output %r" % out[:100], ""
    paths = set(l.split(": ", 1)[1].split(" - ", 1)[0].strip() for l in ctx.splitlines() if l.startswith("- ") and ": " in l)
    return paths, "", ctx


def score(cases):
    for c in cases:
        label, prompt = c[0], c[1]
        ideal = set(c[2]) if len(c) > 2 and c[2] is not None else set()
        pin = set(c[3]) if len(c) > 3 and c[3] is not None else ideal
        got, err, ctx = run(prompt, sid="s-%d" % tot["cases"])
        tot["cases"] += 1
        tot["ideal"] += len(ideal)
        if got is None:
            fails.append("%s: %s" % (label, err)); print("  FAIL %-52s %s" % (label, err)); continue
        wrong, missed = got - ideal, ideal - got
        tot["wrong"] += len(wrong); tot["missed"] += len(missed)
        bad = []
        if wrong: bad.append("WRONG " + ",".join(sorted(wrong)))
        if got != pin: bad.append("pin drift: got %s want %s" % (sorted(got), sorted(pin)))
        if len(ctx.split()) > 150: bad.append("over 150 words (%d)" % len(ctx.split()))
        if len(got) > 3: bad.append("more than 3 pointers")
        if bad:
            fails.append("%s: %s" % (label, "; ".join(bad))); print("  FAIL %-52s %s" % (label, "; ".join(bad)))
        else:
            tot["pass"] += 1
            print("  ok   %-52s %d ptr%s" % (label, len(got), "  (missed %s)" % ",".join(sorted(os.path.basename(m) for m in missed)) if missed else ""))


print("memory-reflex.py -- made-up wiki (exact-name resolution, wrong pointers forbidden)")
score([
    ("full name", "What did Dana Ruiz say about the renewal?", [DANA]),
    ("full name, lowercase", "ping dana ruiz about the monthly check-in", [DANA]),
    ("possessive full name", "Marcus Chen's mock-ups were good", [MARCUS]),
    ("surname only, unique", "Ruiz's calendar is full this week", [DANA]),
    ("surname after opener", "Ask Venkataraghavan when the deck is due", [PRIYA]),
    ("first name only (ambiguous: linus)", "Linus said he would send it", []),
    ("first name only, unique, unaliased", "Dana wants the doc by Friday", [], []),
    ("project, mid-sentence", "How is Quasarfin doing lately?", [QF]),
    ("project, lowercase coined name", "quasarfin needs a new owner this week", [QF]),
    ("project + person", "Draft the Orrery Platform update for Dana Ruiz", [ORRERY, DANA]),
    ("org", "Acme Corp renewal came up again", [ACME]),
    ("ordinary word that is a project", "Ready when you are, give me a minute", []),
    ("ordinary word as sentence opener", "Grant them access tomorrow", []),
    ("ordinary word, real person full name", "Let's grant access to Grant Ellis", [GRANT]),
    ("outsider with a known surname", "Thomas Edison invented the bulb", []),
    ("outsider + our surname, run of names", "Jane Porter filed the report", []),
    ("surname held by two people", "Hollowell sent the data over", []),
    ("full name of one Hollowell", "Maria Hollowell sent the data over", [MARIA]),
    ("alias, capitalised", "Marc called about the launch", [MARCUS]),
    ("alias, lowercase", "marc called about the launch", [MARCUS]),
    ("alias, hyphenated", "Chen-san is on the call", [MARCUS]),
    ("alias, two letters", "QF launches Monday", [QF]),
    ("alias held by two notes", "Sammy called twice", []),
    ("superseded note is invisible", "Olaf Obsolete wrote it", []),
    ("confidential note is invisible", "Sven Secretive wrote it", []),
    ("shipped example is invisible", "Jo Example wrote it", []),
    ("the owner's own name is never pointed at", "Riley Quinn needs the update", []),
    ("the agent's name is never pointed at", "Talos, Claude Code needs an update", []),
    ("weekday", "meeting on Tuesday at 3", []),
    ("concept needs title case", "wibble wobble theory is odd", []),
    ("concept in title case", "Explain Wibble Wobble Theory", [WIBBLE]),
    ("made-up person", "Zorblax Quimby will join the call", []),
    ("made-up near-miss", "Dana Ruizz and Marcus Chan", []),
    ("generic capitalised words", "Please Review The Quarterly Budget Today", []),
    ("path stripped", "read wiki/people/dana-ruiz.md and summarize", []),
    ("code span stripped", "run `Dana Ruiz` through the script", []),
    ("url stripped", "see https://example.com/Dana-Ruiz for details", []),
    ("robot: scheduled-task", '<scheduled-task name="x">Dana Ruiz Marcus Chen</scheduled-task>', []),
    ("robot: task-notification", "<task-notification>agent finished: Dana Ruiz</task-notification>", []),
    ("robot: cross-session", "<cross-session-message>Dana Ruiz</cross-session-message>", []),
    ("robot: system-reminder", "<system-reminder>Dana Ruiz</system-reminder>", []),
    ("slash command", "/brief Dana Ruiz", []),
    ("empty prompt", "", []),
    ("emoji and unicode", "\U0001F525 Dana Ruiz — café über", [DANA]),
    ("chat channel tag is read for its text", '<channel source="telegram" chat_id="1" message_id="1" user="u" ts="x">Dana Ruiz said so</channel>', [DANA]),
])
got, err, ctx = run("Dana Ruiz, Marcus Chen, Priya Venkataraghavan, Maria Hollowell and Quasarfin", sid="cap")
check("cap: exactly 3 pointers, all legitimate", got is not None and len(got) == 3 and got <= {DANA, MARCUS, PRIYA, MARIA, QF}, str(got))

print("memory-reflex.py -- session dedupe, kill switch, fail-open")
g1, _, _ = run("Dana Ruiz said so", sid="dedupe-1")
g2, _, _ = run("Dana Ruiz and Marcus Chen agree", sid="dedupe-1")
g3, _, _ = run("Dana Ruiz again", sid="dedupe-2")
check("dedupe: first mention points", g1 == {DANA})
check("dedupe: repeat in the same session skipped, a new one kept", g2 == {MARCUS})
check("dedupe: a different session points again", g3 == {DANA})
got, _, _ = run("Dana Ruiz", sid="k1", extra_env={"TALOS_MEMORY_REFLEX_OFF": "1"})
check("kill switch: TALOS_MEMORY_REFLEX_OFF=1 silences it", got == set())
os.makedirs(sd, exist_ok=True); open(os.path.join(sd, "memory-reflex.off"), "w").close()
got, _, _ = run("Dana Ruiz", sid="k2")
check("kill switch: memory-reflex.off in the state folder silences it", got == set())
os.remove(os.path.join(sd, "memory-reflex.off"))
check("kill switch name is a string literal in the hook", '"memory-reflex.off"' in open(HOOK).read())
for name, raw in (("malformed JSON", '{"garbage'), ("empty stdin", ""), ("prompt is not a string", '{"prompt": 42}'), ("JSON list", "[1,2]")):
    got, err, _ = run(None, raw=raw)
    check("fail-open: " + name, got == set(), str(err))
os.rename(GAZFILE, GAZFILE + ".hold")
got, err, _ = run("Dana Ruiz", sid="nogaz")
check("fail-open: no gazetteer file", got == set(), str(err))
open(GAZFILE, "w").write("{not json")
got, err, _ = run("Dana Ruiz", sid="badgaz")
check("fail-open: corrupt gazetteer", got == set(), str(err))
os.remove(GAZFILE); os.rename(GAZFILE + ".hold", GAZFILE)
got, err, _ = run("filler words go here. " * 400 + "Dana Ruiz", sid="big")
check("huge paste: names past the 6000-character window are ignored", got == set(), str(err))
os.remove(os.path.join(A, "wiki", "people", "marcus-chen.md"))
got, err, _ = run("Marcus Chen is here", sid="ghost")
check("a note deleted since the last build is never pointed at (no ghosts)", got == set(), str(err))
logp = os.path.join(sd, "reflex-log.jsonl")
logtxt = open(logp).read() if os.path.exists(logp) else ""
check("the log records pointers, never the prompt text", logtxt and "said so" not in logtxt and "Quarterly Budget" not in logtxt)
srt = sorted(timings)
check("speed: median under 150 ms, worst under 600 ms (%d runs; median %.0f ms, worst %.0f ms)" % (len(srt), srt[len(srt) // 2], srt[-1]),
      srt[len(srt) // 2] < 150 and srt[-1] < 600)

print("  memory-reflex: %d cases, %d ideal pointers, %d missed, %d wrong" % (tot["cases"], tot["ideal"], tot["missed"], tot["wrong"]))
check("ZERO wrong pointers across the whole suite", tot["wrong"] == 0)
print("  reflex: PASS %d FAIL %d" % (tot["pass"], len(fails)))
sys.exit(1 if fails else 0)
PY
