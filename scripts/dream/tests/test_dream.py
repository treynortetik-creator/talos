#!/usr/bin/env python3
"""Dream-cycle tests. Everything runs in a FAKE agent folder inside a temp dir: the test copies scripts/dream into
<tmp>/agent/scripts/dream, so the "root = parents of the script" logic is what is exercised. HOME and XDG_CONFIG_HOME
point at temp dirs; the real wiki, ~/.config and the network are never touched. Fake people only (Dana Ruiz, Acme).

  python3 scripts/dream/tests/test_dream.py        (or: bash scripts/test-dream.sh)
"""
import contextlib
import datetime
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.dont_write_bytecode = True
SRC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))          # the real scripts/dream
TMP = os.path.realpath(tempfile.mkdtemp(prefix="dreamtest-"))
AGENT = os.path.join(TMP, "agent")
HOME = os.path.join(TMP, "home")
CFG = os.path.join(TMP, "cfg")
VAULT = os.path.join(TMP, "vault")
DREAM_SCRIPTS = os.path.join(AGENT, "scripts", "dream")
SENTINEL = "SENTINEL_PERSONAL_9917"
FIXED = "2026-10-16"
TODAY = datetime.date.today().isoformat()
TL = "<!-- TIMELINE:APPEND-ONLY -->"

os.makedirs(HOME, exist_ok=True)
os.environ["HOME"] = HOME
os.environ["XDG_CONFIG_HOME"] = CFG
os.environ["XDG_STATE_HOME"] = os.path.join(TMP, "state")


def w(rel, text, base=None):
    p = os.path.join(base or AGENT, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return p


def rd(rel):
    with open(os.path.join(AGENT, rel), encoding="utf-8") as fh:
        return fh.read()


def build_agent(vault=False):
    """A fresh fake agent folder. The dream scripts are a COPY, so the root really is derived from their location."""
    shutil.rmtree(AGENT, ignore_errors=True)
    shutil.rmtree(VAULT, ignore_errors=True)
    shutil.rmtree(CFG, ignore_errors=True)
    os.makedirs(os.path.join(AGENT, "scripts"))
    shutil.copytree(SRC, DREAM_SCRIPTS, ignore=shutil.ignore_patterns("tests", "__pycache__", "*.pyc"))
    fm = lambda t: "---\ntitle: %s\ntype: concept\nstatus: living\n---\n" % t
    tl = "\n## Timeline\n\n" + TL + "\n- **2026-01-01** | src | @dana-ruiz - evidence one. Confidence: high\n"
    w("wiki/concepts/alpha.md", fm("Alpha") + "# Alpha\nThe Acme renewal is on 2025-11-01 per the contract.\n\n## Related\n- [[gamma]] - old\n")
    w("wiki/concepts/beta.md", fm("Beta") + "# Beta\nBeta says the Acme renewal is 2024-11-01 in the ledger.\n")
    w("wiki/concepts/gamma.md", fm("Gamma") + "# Gamma\nGamma text.\n")
    w("wiki/people/dana-ruiz.md", fm("Dana Ruiz") + "# Dana Ruiz\nProfile text.\n\n## Related\n- [[gamma]] - x\n" + tl)
    w("wiki/people/eps.md", fm("Eps") + "# Eps\nNo related section here.\n" + tl)
    w("wiki/meetings/2026-10-15-sync.md", fm("Sync") + "# Sync\nThey said the Acme renewal moved to 2025-11-01 in this meeting.\n")
    w("wiki/examples/shipped-example.md", fm("Example") + "# Example\nFictional shipped example.\n")
    w("memory/2026-10-15.md", "## Work\n- Shipped the dream cycle spec\n- Dinner with Zed Quux tonight\n"
      "- May's recital moved\n- May meeting about Acme moved\n- Visit to Lakeside Clinic on Friday\n- Called Mira about plans\n")
    w("memory/personal/secret.md", SENTINEL + " finances\n")
    w("memory/.env", "API_KEY=" + SENTINEL + "\n")
    w(".env", "API_KEY=" + SENTINEL + "\n")
    w("wiki/personal/leak.md", SENTINEL + " under a wiki/personal path\n")
    w("wiki/_changelog.md", "# Changelog\n\nOne line per change. Newest first.\n\n| Date | What changed |\n|---|---|\n| 2026-10-01 | **x** y |\n")
    if vault:
        w("people/zed-quux.md", SENTINEL + " friend\n", VAULT)
        w("people/mira-vance.md", SENTINEL + " friend\n", VAULT)
        w("people/may-ellis.md", SENTINEL + " friend\n", VAULT)
        w("people/_index.md", SENTINEL + "\n", VAULT)
        w("_guard-terms.txt", "# private terms\nLakeside Clinic\n\n", VAULT)
        w("vault-dir", VAULT + "\n", CFG + "/talos")


def run(script, *args, cwd=None):
    env = dict(os.environ, HOME=HOME, XDG_CONFIG_HOME=CFG, PYTHONDONTWRITEBYTECODE="1")
    env.pop("PYTHONPATH", None)
    r = subprocess.run([sys.executable, os.path.join(DREAM_SCRIPTS, script)] + list(args),
                       capture_output=True, text=True, env=env, cwd=cwd or TMP, timeout=120)
    return r


def jl(rel):
    return json.loads(rd(rel))


def load_common():
    """Import the COPIED common.py (its ROOT is the fake agent)."""
    for m in ("common", "verify_quotes", "apply"):
        sys.modules.pop(m, None)
    sys.path.insert(0, DREAM_SCRIPTS)
    try:
        return importlib.import_module("common")
    finally:
        sys.path.remove(DREAM_SCRIPTS)


class TestCollect(unittest.TestCase):
    def setUp(self):
        build_agent(vault=True)

    def collect(self, *args):
        r = run("collect.py", *args)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return os.path.join("memory", "dream", TODAY if "--date" not in args else args[args.index("--date") + 1])

    def test_no_args_defaults_and_root_from_location(self):
        r = run("collect.py", cwd=HOME)                           # from an unrelated cwd, no arguments at all
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        run_dir = "memory/dream/" + TODAY
        coll = jl(run_dir + "/collect.json")
        self.assertEqual(coll["date"], TODAY)
        self.assertEqual(coll["note_count"], 7)                    # 5 wiki + meeting + daily; examples/personal/.env out
        self.assertTrue(any("recall" in e for e in coll["errors"]))  # no recall.py in the fake agent: degraded, recorded
        self.assertTrue(os.path.isdir(os.path.join(AGENT, run_dir, "shards")))
        self.assertTrue(os.path.isdir(os.path.join(AGENT, run_dir, "proposals")))
        self.assertFalse(os.path.exists(os.path.join(HOME, "memory")))

    def test_personal_never_appears(self):
        run_dir = self.collect("--no-recall")
        blob = ""
        for dp, _, fns in os.walk(os.path.join(AGENT, run_dir)):
            for fn in fns:
                blob += open(os.path.join(dp, fn), encoding="utf-8").read()
        self.assertNotIn(SENTINEL, blob)
        coll = jl(run_dir + "/collect.json")
        self.assertTrue(all("personal" not in n["path"].split("/") for n in coll["notes"]))
        self.assertTrue(all(".env" not in n["path"] for n in coll["notes"]))
        self.assertTrue(all("examples" not in n["path"].split("/") for n in coll["notes"]))
        self.assertGreaterEqual(coll["personal_paths_excluded"], 2)

    def daily_text(self, run_dir):
        for f in os.listdir(os.path.join(AGENT, run_dir, "shards")):
            for n in jl(run_dir + "/shards/" + f)["notes"]:
                if n["kind"] == "daily-log":
                    return n["text"]
        return ""

    def test_name_filter_from_vault_filenames_and_terms(self):
        txt = self.daily_text(self.collect("--no-recall"))
        self.assertIn("Shipped the dream cycle spec", txt)
        self.assertIn("May meeting about Acme", txt)               # a month-name used as a month survives
        for bad in ("Zed Quux", "May's recital", "Lakeside Clinic", "Mira"):
            self.assertNotIn(bad, txt)
        coll = jl("memory/dream/%s/collect.json" % TODAY)
        self.assertTrue(coll["vault_configured"])
        self.assertGreaterEqual(coll["daily_log_lines_dropped"], 4)

    def test_no_vault_means_empty_filter(self):
        build_agent(vault=False)
        txt = self.daily_text(self.collect("--no-recall"))
        self.assertIn("Zed Quux", txt)                              # nothing is filtered without a vault
        coll = jl("memory/dream/%s/collect.json" % TODAY)
        self.assertFalse(coll["vault_configured"])
        self.assertEqual(coll["name_filter_terms"], 0)

    def test_filter_uses_filenames_only(self):
        C = load_common()
        nf = C.NameFilter()
        self.assertTrue(nf.hits("lunch with zed quux"))
        self.assertTrue(nf.hits("Zed called"))
        self.assertTrue(nf.hits("the lakeside clinic visit"))
        self.assertFalse(nf.hits("Zedmund is unrelated"))
        self.assertFalse(nf.hits("the board meets in May"))
        self.assertTrue(nf.hits("May's birthday"))
        self.assertNotIn(SENTINEL.lower(), " ".join(nf.terms))
        self.assertNotIn("_index", " ".join(nf.terms))

    def test_is_personal_path_and_allowed_input(self):
        C = load_common()
        self.assertTrue(C.is_personal_path(os.path.join(AGENT, "memory/personal/x.md")))
        self.assertTrue(C.is_personal_path(os.path.join(AGENT, "wiki/Personal/x.md")))
        for r in ("wiki/personal/leak.md", "memory/personal/secret.md", "memory/.env", ".env", "wiki/examples/shipped-example.md",
                  "wiki/_changelog.md", "memory/dream/QUEUE.md", "memory/STATE.md", "wiki/README.md"):
            self.assertFalse(C.allowed_input(r), r)
        for r in ("wiki/concepts/alpha.md", "memory/2026-10-15.md"):
            self.assertTrue(C.allowed_input(r), r)

    def test_cap_and_shard_size(self):
        for i in range(14):
            w("wiki/concepts/n%d.md" % i, "---\ntitle: N%d\n---\ntext %d\n" % (i, i))
        run_dir = self.collect("--no-recall", "--max-notes", "5", "--date", "2026-10-17")
        coll = jl(run_dir + "/collect.json")
        self.assertEqual(coll["note_count"], 5)
        self.assertGreater(len(coll["rolled_over"]), 0)
        self.assertEqual(coll["shard_count"], 2)                    # 5 notes, shards of at most 4
        for f in os.listdir(os.path.join(AGENT, run_dir, "shards")):
            self.assertLessEqual(len(jl(run_dir + "/shards/" + f)["notes"]), 4)

    def test_default_cap_is_twelve(self):
        for i in range(20):
            w("wiki/concepts/m%d.md" % i, "---\ntitle: M%d\n---\ntext %d\n" % (i, i))
        coll = jl(self.collect("--no-recall") + "/collect.json")
        self.assertEqual(coll["note_count"], 12)

    def test_candidate_links_adamic_adar(self):
        # hub1 and hub2 both link x and y; x and y do not link each other: they are an Adamic-Adar pair
        for n in ("hub1", "hub2"):
            w("wiki/concepts/%s.md" % n, "---\ntitle: %s\n---\n[[xx]] [[yy]] [[zz]]\n" % n)
        for n in ("xx", "yy", "zz"):
            w("wiki/concepts/%s.md" % n, "---\ntitle: %s\n---\nbody\n" % n)
        coll = jl(self.collect("--no-recall") + "/collect.json")
        pairs = {frozenset((p["a"].lower(), p["b"].lower())) for p in coll["candidate_links"]}
        self.assertIn(frozenset(("xx", "yy")), pairs)

    def test_git_mode_uses_commit_times(self):
        if not shutil.which("git"):
            self.skipTest("git not installed")
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="t",
                   GIT_COMMITTER_EMAIL="t@example.com", GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
        for cmd in (["init", "-q"], ["add", "wiki", "memory"], ["commit", "-q", "-m", "x"]):
            self.assertEqual(subprocess.run(["git", "-C", AGENT] + cmd, env=env, capture_output=True).returncode, 0)
        old = 15 * 10 ** 8
        for dp, _, fns in os.walk(AGENT):
            for fn in fns:
                os.utime(os.path.join(dp, fn), (old, old))          # mtimes say "years ago"; only git says "just now"
        coll = jl(self.collect("--no-recall", "--date", "2026-10-18") + "/collect.json")
        self.assertGreaterEqual(coll["note_count"], 5)

    def test_refuses_to_recollect_an_applied_night(self):
        self.collect("--no-recall")
        w("memory/dream/%s/applied.json" % TODAY, "{}")
        r = run("collect.py", "--no-recall")
        self.assertEqual(r.returncode, 1)


class TestVerify(unittest.TestCase):
    def setUp(self):
        build_agent()

    def verify(self, props):
        pf = os.path.join(TMP, "props.json")
        json.dump(props, open(pf, "w"))
        r = run("verify_quotes.py", pf)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return json.load(open(os.path.join(TMP, "verified.json"))), json.load(open(os.path.join(TMP, "dropped.json")))

    def test_true_and_fake(self):
        good = {"type": "contradiction", "from": "alpha", "to": "beta", "claim": "dates differ",
                "quote_from": "The Acme renewal is on 2025-11-01\nper the contract", "file_from": "wiki/concepts/alpha.md",
                "quote_to": "the Acme  renewal is 2024-11-01 in the ledger", "file_to": "wiki/concepts/beta.md"}
        fake = dict(good, quote_to="the Acme renewal is 2023-01-01 in the ledger")
        v, d = self.verify([good, fake])
        self.assertEqual(len(v), 1)
        self.assertEqual(len(d), 1)
        self.assertEqual(d[0]["drop_reason"], "quote_to-not-verbatim")
        self.assertEqual(v[0]["line_from"], 7)
        self.assertEqual(v[0]["id"], "p-0001")

    def test_ellipsis_and_short(self):
        p = {"type": "stale-fact", "from": "alpha", "claim": "c", "quote_from": "Acme renewal ... per the contract", "file_from": "wiki/concepts/alpha.md"}
        v, d = self.verify([p, dict(p, quote_from="Alpha")])
        self.assertEqual(len(v), 1)
        self.assertEqual(len(d), 1)

    def test_link_needs_both_and_slugs(self):
        p = {"type": "link", "from": "alpha", "to": "beta", "claim": "both about Acme",
             "quote_from": "Acme renewal is on 2025-11-01", "file_from": "wiki/concepts/alpha.md",
             "quote_to": "Acme renewal is 2024-11-01", "file_to": "wiki/concepts/beta.md"}
        v, d = self.verify([p, dict(p, to="nonexistent"), dict(p, quote_to="")])
        self.assertEqual(len(v), 1)
        self.assertEqual({x["drop_reason"] for x in d}, {"slug-to-unresolved", "missing-quote_to"})

    def test_personal_env_and_escape_dropped(self):
        a = {"type": "stale-fact", "from": "x", "claim": "c", "quote_from": SENTINEL + " finances", "file_from": "memory/personal/secret.md"}
        b = {"type": "stale-fact", "from": "x", "claim": "c", "quote_from": "API_KEY=" + SENTINEL, "file_from": "memory/.env"}
        c = {"type": "stale-fact", "from": "x", "claim": "c", "quote_from": "does not matter at all here", "file_from": "../../etc/passwd"}
        d_ = {"type": "stale-fact", "from": "x", "claim": "c", "quote_from": SENTINEL + " under a wiki/personal path", "file_from": "wiki/personal/leak.md"}
        v, d = self.verify([a, b, c, d_])
        self.assertEqual(v, [])
        self.assertEqual({x["drop_reason"] for x in d},
                         {"file_from:personal-path", "file_from:env-file", "file_from:outside-agent-folder"})

    def test_vault_name_dropped(self):
        build_agent(vault=True)
        b = {"type": "stale-fact", "from": "alpha", "claim": "Dinner with Zed Quux", "quote_from": "Acme renewal is on 2025-11-01",
             "file_from": "wiki/concepts/alpha.md"}
        v, d = self.verify([b])
        self.assertEqual(v, [])
        self.assertEqual(d[0]["drop_reason"], "personal-name")

    def test_run_dir_default_no_args(self):
        os.makedirs(os.path.join(AGENT, "memory/dream", TODAY, "proposals"))
        good = {"type": "stale-fact", "from": "alpha", "claim": "c", "quote_from": "Acme renewal is on 2025-11-01", "file_from": "wiki/concepts/alpha.md"}
        w("memory/dream/%s/proposals/shard-01.json" % TODAY, json.dumps([good, good]))
        w("memory/dream/%s/proposals/shard-02.json" % TODAY, "[]")
        r = run("verify_quotes.py", cwd=HOME)
        self.assertEqual(r.returncode, 0, r.stderr)
        s = jl("memory/dream/%s/verify-summary.json" % TODAY)
        self.assertEqual((s["proposals"], s["verified"], s["dropped"]), (2, 1, 1))
        self.assertEqual(jl("memory/dream/%s/dropped.json" % TODAY)[0]["drop_reason"], "duplicate")


class TestApplyRevert(unittest.TestCase):
    A, B, D, E = "wiki/concepts/alpha.md", "wiki/concepts/beta.md", "wiki/people/dana-ruiz.md", "wiki/people/eps.md"

    def setUp(self):
        build_agent()
        self.rel = "memory/dream/" + FIXED
        self.run_dir = os.path.join(AGENT, self.rel)
        os.makedirs(self.run_dir)

    def prop(self, i, t, frm, to, ff, ft):
        return {"id": "p-%04d" % i, "type": t, "from": frm, "to": to, "claim": "%s relates to %s" % (frm, to),
                "why": "both cover the Acme renewal (%d)" % i, "quote_from": "q one", "file_from": ff, "quote_to": "q two", "file_to": ft}

    def stage(self, ver, accept, reject=(), sealed=True):
        json.dump(ver, open(os.path.join(self.run_dir, "verified.json"), "w"))
        jd = [{"id": "p-%04d" % i, "decision": "accept", "reason": "ok"} for i in accept] + \
             [{"id": "p-%04d" % i, "decision": "reject", "reason": "weak"} for i in reject]
        json.dump({"judgements": jd}, open(os.path.join(self.run_dir, "judged.json"), "w"))
        if sealed:
            load_common().write_seal(self.run_dir)

    def test_roundtrip(self):
        A, B, D, E = self.A, self.B, self.D, self.E
        ver = [self.prop(1, "link", "alpha", "beta", A, B),            # alpha has Related -> append
               self.prop(2, "link", "beta", "alpha", B, A),            # beta has none -> new section
               self.prop(3, "link", "dana-ruiz", "beta", D, B),        # timeline note, has Related
               self.prop(4, "link", "eps", "beta", E, B),              # timeline note, no Related
               self.prop(5, "link", "alpha", "gamma", A, B),           # dup (alpha already links gamma)
               self.prop(6, "contradiction", "alpha", "beta", A, B),
               self.prop(7, "link", "gamma", "alpha", A, B),           # judged reject
               self.prop(8, "link", "gamma", "beta", A, B)]            # over cap
        self.stage(ver, (1, 2, 3, 4, 5, 6, 8), (7,))
        files = {f: rd(f) for f in (A, B, D, E, "wiki/concepts/gamma.md", "wiki/_changelog.md")}
        r = run("apply.py", self.run_dir, "--max", "4")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        led = jl(self.rel + "/applied.json")
        self.assertEqual(len(led["applied"]), 4)
        self.assertEqual([s["reason"] for s in led["skipped"]], ["dup"])
        self.assertEqual(len(led["rejected"]), 1)
        a = rd(A)
        self.assertIn("- [[beta]] - both cover the Acme renewal (1) (dream %s)" % FIXED, a)
        self.assertGreater(a.index("[[beta]]"), a.index("[[gamma]]"))
        d = rd(D)
        self.assertLess(d.index("[[beta]] -"), d.index(TL))
        self.assertEqual(d[d.index(TL):], files[D][files[D].index(TL):])                  # separator and below byte-identical
        e = rd(E)
        self.assertLess(e.index("## Related"), e.index("## Timeline"))
        self.assertEqual(e[e.index("## Timeline"):], files[E][files[E].index("## Timeline"):])
        self.assertEqual(rd("wiki/concepts/gamma.md"), files["wiki/concepts/gamma.md"])  # reject + over-cap target untouched
        q = rd("memory/dream/QUEUE.md")
        for needle in ("contradiction", "over nightly cap", "proposed action", "quote A (wiki/concepts/alpha.md"):
            self.assertIn(needle, q)
        cl = rd("wiki/_changelog.md")
        self.assertIn("Dream cycle: 4 links added", cl)
        self.assertLess(cl.index("Dream cycle: 4 links"), cl.index("2026-10-01"))        # newest first, under the header
        self.assertLess(cl.index("|---|---|"), cl.index("Dream cycle: 4 links"))
        # idempotent: a second run refuses and changes nothing
        snap = {f: rd(f) for f in (A, B, D, E, "wiki/_changelog.md", "memory/dream/QUEUE.md")}
        r2 = run("apply.py", self.run_dir)
        self.assertEqual(r2.returncode, 1)
        self.assertEqual({f: rd(f) for f in snap}, snap)
        # revert -> byte exact
        r3 = run("revert.py", FIXED)
        self.assertEqual(r3.returncode, 0, r3.stdout + r3.stderr)
        for f in (A, B, D, E, "wiki/concepts/gamma.md"):
            self.assertEqual(rd(f), files[f], f)
        self.assertIn("Dream cycle revert " + FIXED, rd("wiki/_changelog.md"))
        self.assertIn("Dream cycle: 4 links added", rd("wiki/_changelog.md"))           # the original row is never deleted
        self.assertTrue(os.path.exists(os.path.join(self.run_dir, "applied.reverted.json")))

    def test_tampered_or_unsealed_verified_is_refused(self):
        self.stage([self.prop(1, "link", "alpha", "beta", self.A, self.B)], (1,))
        ver = jl(self.rel + "/verified.json")
        ver.append(self.prop(2, "link", "gamma", "beta", self.A, self.B))           # a forged extra proposal
        json.dump(ver, open(os.path.join(self.run_dir, "verified.json"), "w"))
        json.dump({"judgements": [{"id": "p-0001", "decision": "accept"}, {"id": "p-0002", "decision": "accept"}]},
                  open(os.path.join(self.run_dir, "judged.json"), "w"))
        before = {f: rd(f) for f in (self.A, self.B, "wiki/concepts/gamma.md")}
        r = run("apply.py", self.run_dir)
        self.assertEqual(r.returncode, 1)
        self.assertIn("refusing", r.stdout)
        self.assertEqual({f: rd(f) for f in before}, before)
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "applied.json")))
        os.remove(os.path.join(self.run_dir, "verify-summary.json"))
        self.stage([self.prop(1, "link", "alpha", "beta", self.A, self.B)], (1,), sealed=False)    # never sealed at all
        self.assertEqual(run("apply.py", self.run_dir).returncode, 1)
        self.assertEqual(run("apply.py", self.run_dir, "--unsealed").returncode, 0)                  # a human can still hand-feed it

    def test_dry_run_changes_nothing(self):
        self.stage([self.prop(1, "link", "alpha", "beta", self.A, self.B)], (1,))
        before = rd(self.A)
        r = run("apply.py", self.run_dir, "--dry-run")
        self.assertEqual(r.returncode, 0)
        self.assertIn("would apply 1", r.stdout)
        self.assertEqual(rd(self.A), before)
        self.assertFalse(os.path.exists(os.path.join(self.run_dir, "applied.json")))

    def test_only_accepted_links_touch_the_wiki(self):
        ver = [self.prop(1, "supersession", "alpha", "beta", self.A, self.B),
               self.prop(2, "stale-fact", "alpha", "", self.A, ""),
               self.prop(3, "link", "alpha", "beta", self.A, self.B)]
        self.stage(ver, (1, 2), (3,))
        before = {f: rd(f) for f in (self.A, self.B)}
        run("apply.py", self.run_dir)
        self.assertEqual({f: rd(f) for f in before}, before)
        self.assertEqual(jl(self.rel + "/applied.json")["applied"], [])
        self.assertIn("supersession", rd("memory/dream/QUEUE.md"))

    def test_never_writes_underscore_or_frozen_or_personal_targets(self):
        w("wiki/concepts/old.md", "---\ntitle: Old\nstatus: superseded\n---\n# Old\ntext\n")
        w("wiki/_index.md", "# Index\n- [[alpha]]\n")
        ver = [self.prop(1, "link", "old", "beta", "wiki/concepts/old.md", self.B),
               self.prop(2, "link", "_index", "beta", "wiki/_index.md", self.B)]
        self.stage(ver, (1, 2))
        before = (rd("wiki/concepts/old.md"), rd("wiki/_index.md"))
        run("apply.py", self.run_dir)
        self.assertEqual((rd("wiki/concepts/old.md"), rd("wiki/_index.md")), before)
        self.assertEqual(len(jl(self.rel + "/applied.json")["skipped"]), 2)

    def test_queue_only_mode_applies_nothing(self):
        ver = [self.prop(1, "link", "alpha", "beta", self.A, self.B), self.prop(2, "stale-fact", "alpha", "", self.A, "")]
        self.stage(ver, (1, 2))
        w("memory/dream/QUEUE-ONLY", "")
        before = {f: rd(f) for f in (self.A, self.B, "wiki/_changelog.md")}
        r = run("apply.py", self.run_dir)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual({f: rd(f) for f in before}, before)
        led = jl(self.rel + "/applied.json")
        self.assertEqual(led["applied"], [])
        self.assertTrue(led["queue_only"])
        q = rd("memory/dream/QUEUE.md")
        self.assertIn("queue-only mode", q)
        self.assertIn("**link**", q)
        self.assertIn("**stale-fact**", q)
        self.assertIn("queue-only", run("digest.py", FIXED).stdout)

    def test_queue_entries_not_duplicated_across_nights(self):
        self.stage([self.prop(1, "stale-fact", "alpha", "", self.A, "")], (1,))
        run("apply.py", self.run_dir)
        n1 = rd("memory/dream/QUEUE.md").count("dq:")
        d2 = os.path.join(AGENT, "memory/dream/2026-10-17")
        os.makedirs(d2)
        shutil.copy(os.path.join(self.run_dir, "verified.json"), d2)
        shutil.copy(os.path.join(self.run_dir, "judged.json"), d2)
        run("apply.py", d2)
        self.assertEqual(rd("memory/dream/QUEUE.md").count("dq:"), n1)

    def test_surgical_revert_keeps_later_edits(self):
        self.stage([self.prop(1, "link", "beta", "gamma", self.B, self.A)], (1,))
        run("apply.py", self.run_dir)
        txt = rd(self.B).replace("Beta says", "Beta states").replace("\n\n## Related", "\nA later human edit.\n\n## Related")
        w(self.B, txt)
        run("revert.py", FIXED)
        now = rd(self.B)
        self.assertNotIn("[[gamma]]", now)
        self.assertIn("A later human edit.", now)
        self.assertIn("Beta states", now)
        self.assertNotIn("## Related", now)

    def test_no_args_pipeline_for_today(self):
        """Every script works with NO arguments against today's run folder (what the restricted job's exact commands do)."""
        r = run("collect.py", cwd=HOME)
        self.assertEqual(r.returncode, 0, r.stderr)
        today = os.path.join(AGENT, "memory/dream", TODAY)
        b = run("budget.py", cwd=HOME)
        self.assertEqual(b.returncode, 0, b.stderr)
        self.assertGreaterEqual(json.loads(b.stdout)["allowed_shards"], 1)
        prop = {"type": "link", "from": "alpha", "to": "beta", "claim": "both about Acme", "why": "both cover the Acme renewal date",
                "quote_from": "Acme renewal is on 2025-11-01", "file_from": self.A,
                "quote_to": "Acme renewal is 2024-11-01", "file_to": self.B}
        w("memory/dream/%s/proposals/shard-01.json" % TODAY, json.dumps([prop, dict(prop, quote_to="Acme renewal was never mentioned")]))
        v = run("verify_quotes.py", cwd=HOME)
        self.assertEqual(json.loads(v.stdout)["verified"], 1)
        w("memory/dream/%s/judged.json" % TODAY, json.dumps({"judgements": [{"id": "p-0001", "decision": "accept", "reason": "same renewal"}]}))
        ap = run("apply.py", cwd=HOME)
        self.assertEqual(ap.returncode, 0, ap.stdout + ap.stderr)
        self.assertIn("- [[beta]] - both cover the Acme renewal date", rd(self.A))
        d = run("digest.py", cwd=HOME)
        self.assertEqual(d.stdout.strip(), "Dream: 1 link added.")
        self.assertEqual(open(os.path.join(today, "digest.txt")).read().strip(), "Dream: 1 link added.")
        self.assertEqual(os.listdir(HOME), [] if os.path.isdir(HOME) else [])

    def test_digest_line(self):
        w(self.rel + "/collect.json", json.dumps({"note_count": 9}))
        json.dump([{"id": "p-0001", "type": "stale-fact", "claim": "Acme renewal date", "from": "alpha"},
                   {"id": "p-0002", "type": "contradiction", "claim": "x", "from": "a"}], open(os.path.join(self.run_dir, "verified.json"), "w"))
        json.dump([{"id": "p-0001", "decision": "accept"}, {"id": "p-0002", "decision": "accept"}], open(os.path.join(self.run_dir, "judged.json"), "w"))
        json.dump({"applied": [{}] * 9, "queued": []}, open(os.path.join(self.run_dir, "applied.json"), "w"))
        r = run("digest.py", FIXED)
        self.assertEqual(r.stdout.strip(), "Dream: 9 links added, 1 stale fact queued (Acme renewal date), 1 contradiction queued.")
        self.assertEqual(rd(self.rel + "/digest.txt").strip(), r.stdout.strip())

    def test_digest_quiet_night(self):
        w(self.rel + "/collect.json", json.dumps({"note_count": 3}))
        self.assertEqual(run("digest.py", FIXED).stdout.strip(), "Dream: quiet night, 3 notes scanned, nothing worth acting on.")


class TestBudget(unittest.TestCase):
    def setUp(self):
        build_agent()

    def test_ceiling_limits_shards(self):
        for i in range(1, 6):
            w("memory/dream/%s/shards/shard-%02d.json" % (FIXED, i), "x" * 400000)
        r = run("budget.py", os.path.join(AGENT, "memory/dream", FIXED))
        out = json.loads(r.stdout)
        self.assertEqual(out["total_shards"], 5)
        self.assertTrue(out["ceiling_hit"])
        self.assertLess(out["allowed_shards"], 5)
        self.assertEqual(jl("memory/dream/%s/run.json" % FIXED)["shards_run"], out["allowed_shards"])

    def test_small_run_not_capped(self):
        for i in range(1, 4):
            w("memory/dream/%s/shards/shard-%02d.json" % (FIXED, i), "x" * 20000)
        out = json.loads(run("budget.py", os.path.join(AGENT, "memory/dream", FIXED), "--proposals", "10").stdout)
        self.assertEqual(out["allowed_shards"], 3)
        self.assertFalse(out["ceiling_hit"])


class TestLayout(unittest.TestCase):
    def test_no_hardcoded_names_or_env_root(self):
        bad = ("treynor", "tetik", "virgil", "safelyyou", "/Users/", ".virgil", "DREAM_REPO", "DREAM_STATE", "TALOS_HOME")
        for fn in os.listdir(SRC):
            if fn.endswith(".py"):
                txt = open(os.path.join(SRC, fn), encoding="utf-8").read().lower()
                for b in bad:
                    self.assertNotIn(b.lower(), txt, "%s mentions %s" % (fn, b))


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
