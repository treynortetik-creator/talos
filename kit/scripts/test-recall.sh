#!/usr/bin/env bash
# test-recall.sh -- does memory search work, and does it fail honestly when part of it is missing?
#
#   (a) ALWAYS runs. No venv, no model, no network, no dependencies beyond python3. Builds a throwaway agent
#       folder with a few notes and checks the lexical arm, the corpus rules (examples, changelog and personal/
#       are never searched), the JSON and --batch output, the zero-result diagnosis, and every fallback banner
#       (NOT INSTALLED / NO INDEX / INDEX STALE / UNAVAILABLE / live), using a fake semantic backend.
#   (b) TALOS_TEST_SEMANTIC=1 only. Builds the REAL stack (a venv with fastembed + sqlite-vec + apsw and the
#       small embedding model, about 230 MB of downloads the first time), indexes the fixture, and checks that a
#       query sharing no word with a note still finds it, that a second index run is a no-op, that a concurrent
#       run says "already running", that a stale lock is stolen, and that mixing embedding models is refused.
#       TALOS_TEST_XDG=/some/dir keeps the venv and model between runs.
#
# Everything happens inside a temp HOME; it never touches your real ~/.local, ~/.claude or any agent folder.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s%s\n' "$1" "${MODETAG:+ [$MODETAG]}"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s%s\n' "$1" "${MODETAG:+ [$MODETAG]}"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"
export HOME="$SB/home"; mkdir -p "$HOME"
talos_test_sandbox "$SB"
export XDG_DATA_HOME="$SB/xdg"          # recall.py and the hooks look for the venv here, never in the real ~/.local

mkfixture() {   # $1 = dir. A tiny agent folder with the search scripts and a handful of notes
  local F="$1"; rm -rf "$F"; mkdir -p "$F/scripts/memory" "$F/wiki/people" "$F/wiki/concepts" "$F/wiki/examples" "$F/wiki/personal" "$F/memory"
  cp "$KIT/scripts/recall.py" "$F/scripts/"; cp "$KIT"/scripts/memory/*.py "$KIT"/scripts/memory/setup.sh "$F/scripts/memory/"
  printf -- '---\ntitle: Alex Rivera\ntype: person\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Alex Rivera\nOwner of this agent. See [[dana-ruiz]] and [[fleet-vehicles]].\n' > "$F/wiki/me.md"
  printf -- '---\ntitle: Dana Ruiz\ntype: person\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Dana Ruiz\nDana leads vendor procurement and approves contracts over ten thousand dollars. See [[alex-rivera]].\n' > "$F/wiki/people/dana-ruiz.md"
  printf -- '---\ntitle: Fleet vehicles\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Fleet vehicles\nThe delivery van needed new brake pads and an oil change at the shop in March 2026. See [[dana-ruiz]].\n' > "$F/wiki/concepts/fleet-vehicles.md"
  printf -- '---\ntitle: Quarterly budget\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Quarterly budget\nThe budget review happens in the first week of each quarter. See [[dana-ruiz]].\n' > "$F/wiki/concepts/quarterly-budget.md"
  printf -- '---\ntitle: Team offsite\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Team offsite\nA two day planning retreat with a catered dinner. See [[quarterly-budget]].\n' > "$F/wiki/concepts/team-offsite.md"
  printf -- '# 2026-03-02\nSigned off the vendor renewal with Dana.\n' > "$F/memory/2026-03-02.md"
  printf -- '---\ntitle: Fake\n---\n# Fake example\nzanzibar is a made-up shipped example word.\n' > "$F/wiki/examples/fake.md"
  printf -- '# Diary\nravenclaw is private and must never be indexed.\n' > "$F/wiki/personal/diary.md"
  printf -- '# Changelog\n| 2026-03-01 | changelogword |\n' > "$F/wiki/_changelog.md"
  mkdir -p "$F/wiki/Personal" "$F/wiki/PERSONAL"
  printf -- '# Diary two\nhufflepuff is private and must never be indexed.\n' > "$F/wiki/Personal/d.md"
  printf -- '# Diary three\nslytherin is private and must never be indexed.\n' > "$F/wiki/PERSONAL/e.md"
}

R() { ( cd "$F" && python3 scripts/recall.py "$@" 2>&1 ); }

# Every output check runs in BOTH keyword modes: "rg" (ripgrep found; skipped, visibly, when this machine has none) and
# "norg" (TALOS_RG forced to a missing file, so the note-by-note fallback runs). The mode is an exported environment
# variable, so every recall call in the check, however it is spelled, sees it.
setmode() {   # $1 = rg | norg ; returns 1 when the mode cannot run here
  MODETAG="$1"
  if [ "$1" = norg ]; then export TALOS_RG=/nonexistent/rg; return 0; fi
  unset TALOS_RG
  [ -n "$RGREAL" ] && return 0
  echo "  skip (no ripgrep on this machine): the rg-mode checks"; MODETAG=""; return 1
}
runmodes() {  # $1 = function holding the checks
  local m; for m in rg norg; do if setmode "$m"; then "$1"; fi; done
  unset TALOS_RG; MODETAG=""
}
mkfixture "$SB/agent-probe"; RGREAL="$( cd "$SB/agent-probe/scripts" && env -u TALOS_RG python3 -c 'import recall; print(recall.find_rg() or "")' )"

# ===================================================================================== (a)
general_checks() {
F="$SB/agent-a"; mkfixture "$F"

out="$(R "vendor contract")"
<<<"$out" grep -q 'wiki/people/dana-ruiz.md' && ok "lexical arm finds a note by its terms" || no "lexical arm did not find dana-ruiz.md" "$out"
<<<"$out" grep -q 'semantic: NOT INSTALLED' && ok "with no venv the first line says NOT INSTALLED and names the fix" || no "no NOT INSTALLED banner" "$(<<<"$out" head -2)"
out="$(cd "$F" && python3 scripts/recall.py "vendor contracts" --rerank 2>&1)"
{ <<<"$out" grep -q 'rerank: requested but NOT applied' && <<<"$out" grep -q 'dana-ruiz'; } && ok "--rerank without the semantic stack says so on the banner line and still answers in the normal order" || no "--rerank without semantic misbehaved" "$(<<<"$out" head -3)"
out="$(cd "$F" && RECALL_RERANK=1 python3 scripts/recall.py "vendor contracts" --json 2>&1)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["rerank"]["vendor contracts"]["applied"] is False' 2>/dev/null && ok "RECALL_RERANK=1 reports rerank status in --json (applied: false here)" || no "RECALL_RERANK=1 not honoured in --json" "$out"
out="$(cd "$F" && python3 scripts/recall.py "vendor contracts" --json 2>&1)"
<<<"$out" grep -q '"rerank"' && no "rerank status present although it was not requested" || ok "without --rerank nothing about reranking appears (default OFF)"

out="$(R "vendor contract" --json)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["semantic"]=="not-installed" and d["results"][0]["file"].endswith("dana-ruiz.md")' 2>/dev/null \
  && ok "--json is valid and reports semantic: not-installed" || no "--json output wrong" "$out"
out="$(R --batch "vendor contract" "brake pads" "budget review")"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d["batch"]; assert set(b)=={"vendor contract","brake pads","budget review"} and b["brake pads"][0]["file"].endswith("fleet-vehicles.md")' 2>/dev/null \
  && ok "--batch answers several queries in one call as valid JSON" || no "--batch output wrong" "$out"

out="$(R "vendor" -k abc)"; [ "$?" != 0 ] || <<<"$out" grep -q 'needs a positive number' && ok "recall: -k with a non-number is a usage error, not a traceback" || no "-k abc mishandled" "$out"
<<<"$out" grep -qi traceback && no "recall printed a traceback on a bad -k" || ok "recall: no traceback for a bad -k"
out="$(R "vendor" -k)"; <<<"$out" grep -q 'needs a positive number' && ok "recall: a trailing -k with no value is a usage error" || no "trailing -k mishandled" "$out"
out="$(R "-5 vendor" --json)"; printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["query"]=="-5 vendor"' 2>/dev/null && ok "recall: a query word that starts with - is kept in the query" || no "dash query word dropped" "$out"
out="$(R "xylophone concerto")"
<<<"$out" grep -q 'NO RESULTS -- search verified working' && <<<"$out" grep -q 'positive control "alex"' \
  && ok "a miss on a healthy corpus is EMPTY: the control term (the title of wiki/me.md) was found" || no "empty diagnosis wrong" "$out"

E="$SB/agent-empty"; mkfixture "$E"; rm -rf "$E/wiki" "$E/memory"; mkdir -p "$E/wiki"
out="$( cd "$E" && python3 scripts/recall.py "anything at all" 2>&1 )"
<<<"$out" grep -q 'SEARCH DEGRADED' && <<<"$out" grep -qi 'corpus is EMPTY' \
  && ok "an empty wiki is BROKEN (nothing to search), never reported as 'nothing recorded'" || no "empty-corpus diagnosis wrong" "$out"

bad=""
for w in zanzibar ravenclaw changelogword hufflepuff slytherin; do
  o="$(R "$w" --json)"; printf '%s' "$o" | python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin)["results"] else 1)' 2>/dev/null || bad="$bad $w"
done
[ -z "$bad" ] && ok "wiki/examples, the changelog and anything under personal/ (any capitalisation) are never searched" || no "excluded content leaked into search:$bad"

if [ -x /usr/bin/python3 ] && /usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 9) else 1)' 2>/dev/null; then
  o="$( cd "$F" && /usr/bin/python3 scripts/recall.py "vendor contract" 2>&1 )"
  <<<"$o" grep -q 'dana-ruiz.md' && ok "recall.py runs on Apple's python 3.9 (stdlib only)" || no "recall.py failed on python 3.9" "$o"
else echo "  skip python 3.9 check (the system python is not 3.9 here)"; fi
}
runmodes general_checks


# ---- fallback banners, with a FAKE semantic backend (a shell script that stands in for the venv's python)
V="$XDG_DATA_HOME/talos/venv/bin"; mkdir -p "$V"
mkdb() { python3 - "$F/.index/memory.db" <<'PY'
import os, sqlite3, sys
p = sys.argv[1]; os.makedirs(os.path.dirname(p), exist_ok=True)
c = sqlite3.connect(p); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT, heading TEXT, text TEXT)")
c.execute("INSERT INTO chunks(path,heading,text) VALUES('wiki/concepts/fleet-vehicles.md','Fleet vehicles','van')"); c.commit(); c.close()
for ext in ("-wal", "-shm"):               # a cleanly closed WAL database leaves neither file; reproduce that state exactly
    try: os.remove(p + ext)
    except OSError: pass
PY
}
printf '#!/bin/bash\nexit 1\n' > "$V/python"; chmod +x "$V/python"
out="$(R "vendor contract")"
<<<"$out" grep -q 'semantic: NOT INSTALLED' && ok "a venv without the memory-search marker (a voice-only venv) is NOT INSTALLED, not a broken index" || no "voice-only venv misreported" "$(<<<"$out" head -2)"
touch "$V/../.talos-memory-ok"
out="$(R "vendor contract")"
<<<"$out" grep -q 'semantic: NO INDEX' && ok "a venv with no index says NO INDEX and prints the command to build it" || no "no NO INDEX banner" "$(<<<"$out" head -2)"

mkdb
printf '#!/bin/bash\ncat >/dev/null\nexit 1\n' > "$V/python"
out="$(R "vendor contract")"; touch "$F/.index/.last-index-ok"
<<<"$out" grep -q 'semantic: UNAVAILABLE' && <<<"$out" grep -q 'dana-ruiz.md' \
  && ok "a crashing semantic backend says UNAVAILABLE and the lexical answer still arrives" || no "UNAVAILABLE fallback wrong" "$out"

cat > "$V/python" <<'FAKE'
#!/bin/bash
# stands in for mem_search.py: answers every query with the fleet-vehicles note, a note no query term appears in
python3 -c '
import json, sys
qs = json.load(sys.stdin)
hit = {"path": "wiki/concepts/fleet-vehicles.md", "heading": "Fleet vehicles", "score": 0.83, "distance": 0.5, "snippet": "The delivery van needed new brake pads"}
print(json.dumps({"model": "fake", "batch": {q: [hit] for q in qs}}))'
FAKE
chmod +x "$V/python"
out="$(R "automobile servicing garage")"
<<<"$out" grep -q 'semantic: live' && <<<"$out" grep -qE '1\. \[semantic +\] wiki/concepts/fleet-vehicles.md' \
  && ok "a semantic-only hit is found, tagged semantic, and the header says live" || no "semantic fusion wrong" "$out"
out="$(R "brake pads")"
<<<"$out" grep -qE '1\. \[lexical\+semantic\] wiki/concepts/fleet-vehicles.md' \
  && ok "a note found by BOTH arms is tagged lexical+semantic" || no "dual-arm tag wrong" "$out"

touch -t 202601010000 "$F/.index/.last-index-ok"
out="$(R "brake pads")"
<<<"$out" grep -q 'semantic: INDEX STALE' && ok "an index older than 48h says INDEX STALE (and still searches)" || no "stale banner wrong" "$(<<<"$out" head -2)"
touch "$F/.index/.last-index-ok"

# ---- session-start launches a DETACHED refresh when the index is stale, and never when headless
mkdir -p "$F/hooks"; cp "$KIT/hooks/session-start.py" "$F/hooks/"; cp "$KIT/hooks/_talos_common.py" "$F/hooks/"
cat > "$V/python" <<FAKE
#!/bin/bash
echo "\$@" > "$SB/refresh.called"
FAKE
chmod +x "$V/python"
touch -t 202601010000 "$F/.index/.last-index-ok"
rm -f "$SB/refresh.called"
( cd "$F" && CHRONOS_RUN=1 CLAUDE_PROJECT_DIR="$F" python3 hooks/session-start.py >/dev/null 2>&1 ); sleep 1
[ ! -e "$SB/refresh.called" ] && ok "a headless (CHRONOS_RUN=1) session start launches no indexer, even with a stale index" || no "indexer was launched in a headless run"
( cd "$F" && CLAUDE_PROJECT_DIR="$F" python3 hooks/session-start.py >/dev/null 2>&1 ); sleep 1
[ -e "$SB/refresh.called" ] && grep -q 'mem_index.py' "$SB/refresh.called" && ok "an interactive session start with a stale index launches mem_index.py (detached)" || no "no refresh launched on a stale index"
rm -f "$SB/refresh.called"; touch "$F/.index/.last-index-ok"
( cd "$F" && CLAUDE_PROJECT_DIR="$F" python3 hooks/session-start.py >/dev/null 2>&1 ); sleep 1
[ ! -e "$SB/refresh.called" ] && ok "a fresh index (under 6h) launches nothing" || no "a fresh index still triggered a refresh"
rm -f "$V/../.talos-memory-ok" "$SB/refresh.called"; touch -t 202601010000 "$F/.index/.last-index-ok"
( cd "$F" && CLAUDE_PROJECT_DIR="$F" python3 hooks/session-start.py >/dev/null 2>&1 ); sleep 1
[ ! -e "$SB/refresh.called" ] && ok "a shared venv WITHOUT the memory packages (voice only) never launches an indexer that would crash every session" || no "indexer launched from a voice-only venv"
rm -rf "$XDG_DATA_HOME"

# ===================================================================================== (c)
# Nyx search upgrades (a stub semantic arm and a stub reranker; no model, no network):
#   link menu, fast keyword arm (ripgrep), rerank by default for questions, loud degraded warning, preimage exclusion.
export XDG_DATA_HOME="$SB/xdg-c"; mkdir -p "$XDG_DATA_HOME"      # no venv here yet: lexical only
files_of() { python3 -c 'import json,sys; print("\n".join(r["file"] for r in json.load(sys.stdin)["results"]))'; }
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }   # jget 'expr on d' < json

# ---- (c1) fast keyword arm: ONE rg pass, same ranked lists as the fallback, a note when rg is missing
FA="$SB/agent-fast"; mkfixture "$FA"
for i in 1 2 3 4 5 6; do printf -- '---\ntitle: Note %s\ntype: concept\n---\n# Note %s\nVENDOR terms and the Contract number %s. Budget review %s.\n' "$i" "$i" "$i" "$i" > "$FA/wiki/concepts/tie-$i.md"; done
printf -- '---\ntitle: Vendor contract\ntype: concept\n---\n# Vendor contract\nplain\n' > "$FA/wiki/concepts/vendor-contract.md"
printf -- '# Upper\nuppercasexylo is only here\n' > "$FA/wiki/concepts/Upper.MD"; printf -- '# Mixed\nmixedcasezeta is only here\n' > "$FA/wiki/concepts/Mixed.Md"
FR() { ( cd "$FA" && python3 scripts/recall.py "$@" ); }
if [ -n "$RGREAL" ]; then
  printf '#!/bin/bash\necho call >> "%s/rg.calls"\nexec "%s" "$@"\n' "$SB" "$RGREAL" > "$SB/rgwrap"; chmod +x "$SB/rgwrap"
  badq=""
  for q in "vendor contract" "budget review quarter" "brake pads oil change" "dana" "fleet fleet vehicles" "zzznomatch" "VENDOR Contract" "uppercasexylo" "mixedcasezeta"; do
    a="$(TALOS_RG="$SB/rgwrap" FR "$q" --json -k 20 2>/dev/null)"; b="$(TALOS_RG=/nonexistent/rg FR "$q" --json -k 20 2>/dev/null)"
    [ "$a" = "$b" ] && [ -n "$a" ] || badq="$badq [$q]"
  done
  [ -z "$badq" ] && ok "fast keyword arm: identical results (order, ties, scores) to the fallback on 9 queries" || no "fast arm and fallback disagree on:$badq"
  rm -f "$SB/rg.calls"; TALOS_RG="$SB/rgwrap" FR "vendor contract budget review" --json >/dev/null 2>&1
  [ "$(wc -l < "$SB/rg.calls" | tr -d ' ')" = 1 ] && ok "fast keyword arm: ONE rg pass covers all the query words" || no "rg was not called exactly once: $(cat "$SB/rg.calls" 2>/dev/null)"
  n1="$(TALOS_RG="$SB/rgwrap" FR uppercasexylo --json 2>/dev/null | files_of)"; n2="$(TALOS_RG="$SB/rgwrap" FR mixedcasezeta --json 2>/dev/null | files_of)"
  { [ "$n1" = "wiki/concepts/Upper.MD" ] && [ "$n2" = "wiki/concepts/Mixed.Md" ]; } && ok "fast keyword arm: notes named .MD and .Md are found (the corpus accepts any case of .md)" || no "upper/mixed-case extension lost on the fast path" "$n1 // $n2"
  rm -f "$SB/rg.calls"; TALOS_RG="$SB/rgwrap" FR --batch "vendor" "budget" "contract" --json >/dev/null 2>&1
  [ "$(wc -l < "$SB/rg.calls" | tr -d ' ')" = 3 ] && ok "fast keyword arm: --batch makes one rg pass per query" || no "batch rg calls wrong"
else echo "  skip (no ripgrep on this machine): rg-vs-fallback comparison"; fi
# the note: a forced bad TALOS_RG is a misconfiguration (says so on every run, stderr only); machine-read output stays clean
err="$(TALOS_RG=/nonexistent/rg FR "vendor contract" 2>&1 >/dev/null)"; err2="$(TALOS_RG=/nonexistent/rg FR "vendor contract" 2>&1 >/dev/null)"
{ [ "$(printf '%s\n' "$err" | grep -c 'ripgrep unavailable')" = 1 ] && [ "$(printf '%s\n' "$err2" | grep -c 'ripgrep unavailable')" = 1 ]; } && ok "a forced TALOS_RG that cannot run: the slower path says so on stderr, on every run" || no "bad-TALOS_RG note wrong" "$err // $err2"
out="$(TALOS_RG=/nonexistent/rg FR "vendor contract" 2>/dev/null)"
<<<"$out" grep -q 'ripgrep unavailable' && no "the ripgrep note leaked into stdout" "$out" || ok "the ripgrep note goes to stderr, never stdout"
err="$(TALOS_RG=/nonexistent/rg FR --batch "vendor" "budget" "contract" 2>&1 >/dev/null)$(TALOS_RG=/nonexistent/rg FR "vendor" --json 2>&1 >/dev/null)"
[ -z "$err" ] && ok "--batch and --json print no ripgrep note (stdout and stderr both clean)" || no "note printed for machine-read output" "$err"
out="$(TALOS_RG=/nonexistent/rg FR --batch "vendor" "budget" 2>&1)"; printf '%s' "$out" | python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null && ok "--batch output with stderr merged in is still valid JSON without ripgrep" || no "batch output polluted" "$out"
# no ripgrep and TALOS_RG unset is a normal setup: the note prints at most once a day (stamp in .index/), fail-soft on a read-only folder
NR() { ( cd "$1/scripts" && env -u TALOS_RG python3 -c '
import sys, recall
recall._RG_CACHE.append(None)      # no ripgrep on this machine
sys.exit(recall.main(sys.argv[1:]))' "${@:2}" 2>&1 >/dev/null ); }
FN="$SB/agent-norg"; mkfixture "$FN"
n1="$(NR "$FN" "vendor contract")"; n2="$(NR "$FN" "vendor contract")"
{ [ "$(printf '%s\n' "$n1" | grep -c 'ripgrep unavailable')" = 1 ] && [ -z "$n2" ] && [ -f "$FN/.index/rg-off-note-date" ]; } && ok "no ripgrep, TALOS_RG unset: the note prints once, then not again the same day" || no "once-a-day note wrong" "$n1 // $n2"
printf '2000-01-01\n' > "$FN/.index/rg-off-note-date"; n3="$(NR "$FN" "vendor contract")"
<<<"$n3" grep -q 'ripgrep unavailable' && ok "no ripgrep: the note prints again on a new day" || no "note did not return on a new day" "$n3"
rm -rf "$FN/.index"; n4="$(NR "$FN" --batch "vendor" "budget")$(NR "$FN" "vendor" --json)"
{ [ -z "$n4" ] && [ ! -e "$FN/.index/rg-off-note-date" ]; } && ok "no ripgrep: --batch / --json print no note and do not use up the day's note" || no "machine-read run printed or stamped" "$n4"
FRO="$SB/agent-ro"; mkfixture "$FRO"; : > "$FRO/.index"      # .index is a FILE: nothing can be stamped
r1="$(NR "$FRO" "vendor contract")"; r2="$( cd "$FRO/scripts" && env -u TALOS_RG python3 -c '
import sys, recall
recall._RG_CACHE.append(None)
rc = recall.main(["vendor contract"]); sys.exit(rc)' 2>/dev/null | grep -c 'dana-ruiz' )"
{ <<<"$r1" grep -q 'ripgrep unavailable' && ! <<<"$r1" grep -qi traceback && [ "$r2" -ge 1 ]; } && ok "no ripgrep on a folder that cannot be written: the note still prints, results still arrive, no traceback" || no "read-only .index mishandled" "$r1 // $r2"
out="$(TALOS_RG=/nonexistent/rg FR "vendor contract" 2>/dev/null)"
<<<"$out" grep -q 'tie-1.md' && ok "no ripgrep: results still arrive (fallback path)" || no "fallback returned nothing" "$out"
printf '#!/bin/bash\nexit 2\n' > "$SB/rgbad"; chmod +x "$SB/rgbad"
a="$(TALOS_RG="$SB/rgbad" FR "vendor contract" --json 2>"$SB/rgbad.err")"; b="$(TALOS_RG=/nonexistent/rg FR "vendor contract" --json 2>/dev/null)"
TALOS_RG="$SB/rgbad" FR "vendor contract" >/dev/null 2>"$SB/rgbad.err"
{ [ "$a" = "$b" ] && grep -q 'ripgrep unavailable' "$SB/rgbad.err"; } && ok "a ripgrep that fails (exit 2) falls back to the same results and says so" || no "failing rg not handled" "$(cat "$SB/rgbad.err")"
mkdir -p "$SB/claude-code/vendor/ripgrep"; printf '#!/bin/bash\nexit 0\n' > "$SB/claude-code/vendor/ripgrep/rg"; chmod +x "$SB/claude-code/vendor/ripgrep/rg"
got="$( cd "$FA/scripts" && env -u TALOS_RG PATH="$SB/claude-code/vendor/ripgrep:/usr/bin:/bin" python3 -c 'import recall; print(recall.find_rg())' )"
[ "$got" != "$SB/claude-code/vendor/ripgrep/rg" ] && ok "a ripgrep bundled inside Claude Code is never used" || no "bundled rg was picked"
mkdir -p "$SB/x/node_modules/@anthropic-ai/claude-code/vendor/ripgrep" "$SB/people/claude/.cargo/bin" "$SB/y/.claude/bin"
for d in "$SB/x/node_modules/@anthropic-ai/claude-code/vendor/ripgrep" "$SB/people/claude/.cargo/bin" "$SB/y/.claude/bin"; do printf '#!/bin/bash\nexit 0\n' > "$d/rg"; chmod +x "$d/rg"; done
FINDRG() { ( cd "$FA/scripts" && env -u TALOS_RG PATH="$1:/usr/bin:/bin" python3 -c 'import recall; print(recall.find_rg())' ); }
[ "$(FINDRG "$SB/people/claude/.cargo/bin")" = "$SB/people/claude/.cargo/bin/rg" ] && ok "a ripgrep in a home folder that merely has 'claude' in its name is used" || no "rg under a folder named claude rejected"
[ "$(FINDRG "$SB/x/node_modules/@anthropic-ai/claude-code/vendor/ripgrep")" != "$SB/x/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/rg" ] && ok "a ripgrep inside node_modules/@anthropic-ai/ is rejected" || no "npm-bundled rg accepted"
[ "$(FINDRG "$SB/y/.claude/bin")" != "$SB/y/.claude/bin/rg" ] && ok "a ripgrep under a .claude/ folder is rejected" || no ".claude rg accepted"
got="$( cd "$FA/scripts" && TALOS_RG="$SB/rgbad" python3 -c 'import recall; print(recall.find_rg())' )"
[ "$got" = "$SB/rgbad" ] && ok "TALOS_RG names the ripgrep to use" || no "TALOS_RG ignored: $got"

menu_checks() {
# ---- (c2) link menu
mkmenu() {   # $1 = dir, $2 = wiki folder relative to it
  local M="$1" W="$2"; mkfixture "$M"
  if [ "$W" != wiki ]; then mkdir -p "$M/memory"; mv "$M/wiki" "$M/$W"; printf 'layout=2\n' > "$M/.talos-version"; cp "$KIT/scripts/_talos_layout.py" "$M/scripts/"; fi
  mkdir -p "$M/$W/spokes"
  printf -- '---\ntitle: Orbit hub\ntype: concept\ndescription: the index everything links to\n---\n# Orbit hub\n' > "$M/$W/hub.md"
  printf -- '---\ntitle: Alpha note\ntype: concept\ndescription: "Alpha facts, see [[beta-note]]"\n---\n# Alpha note\nbody\n' > "$M/$W/alpha-note.md"
  printf -- '---\ntitle: Beta note\ntype: person\n---\n# Beta note\nbody\n' > "$M/$W/beta-note.md"
  printf -- '---\ntitle: Zeppelin routes\ntype: concept\n---\n# Zeppelin routes\nSee [[alpha-note]], [[Beta-Note|the beta]], [[hub]] and [[no-such-note]].\n' > "$M/$W/zeppelin.md"
  local i; for i in $(seq 1 31); do printf -- '---\ntitle: Spoke %s\ntype: concept\n---\n# Spoke %s\nlinks to [[hub]]\n' "$i" "$i" > "$M/$W/spokes/s$i.md"; done
}
FM="$SB/agent-menu"; mkmenu "$FM" wiki
MR() { ( cd "$FM" && python3 scripts/recall.py "$@" 2>&1 ); }
out="$(MR "zeppelin" --expand)"
{ <<<"$out" grep -q 'alpha-note (concept) -- Alpha facts, see beta-note' && <<<"$out" grep -q 'beta-note (person) -- (no description)'; } \
  && ok "link menu: each linked note shows its type and one-line description ((no description) when absent; [[links]] in it flattened)" || no "link menu lines wrong" "$out"
{ <<<"$out" grep -q 'skipped 1 hubs: hub (in 3[0-9])' && ! <<<"$out" grep -q 'hub (concept)'; } && ok "link menu: a hub (top 1%, at least 30 inbound) is left out and counted in 'skipped N hubs'" || no "hub not skipped" "$out"
<<<"$out" grep -q 'unresolved: no-such-note' && ok "link menu: a link that matches no note is listed as unresolved" || no "unresolved not listed" "$out"
out="$(MR "zeppelin" --expand --hubs)"
{ <<<"$out" grep -q 'hub (concept)' && ! <<<"$out" grep -q 'skipped'; } && ok "--hubs includes the hub notes" || no "--hubs did not include the hub" "$out"
a="$(MR "alpha beta zeppelin note" --json -k 20 | files_of)"; b="$(MR "alpha beta zeppelin note" --json --expand -k 20 | files_of)"
[ -n "$a" ] && [ "$a" = "$b" ] && ok "link menu: the ranking is identical with and without --expand" || no "--expand changed the ranking" "$a // $b"
out="$(MR "zeppelin" --json --expand)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d["results"][0]; assert "alpha-note" in r["links"]; m=r["link_menu"]; assert [x["slug"] for x in m["links"]]==["alpha-note","beta-note"] and m["hubs_skipped"][0]["slug"]=="hub"' 2>/dev/null \
  && ok "--json --expand keeps the plain links list and adds link_menu (links and hubs_skipped)" || no "--json link_menu wrong" "$out"
C="$FM/.index/wiki-inbound.json"
[ -f "$C" ] && ok "inbound counts are cached under the agent's .index/" || no "no inbound cache at $C"
b1="$(jget 'd["built"]' < "$C")"; sleep 1; MR "zeppelin" --expand >/dev/null; b2="$(jget 'd["built"]' < "$C")"
[ "$b1" = "$b2" ] && ok "inbound cache: reused while no note is newer than it" || no "cache rebuilt for no reason ($b1 vs $b2)"
printf -- '---\ntitle: Gamma\ntype: concept\n---\n# Gamma\nSee [[hub]].\n' > "$FM/wiki/gamma.md"
MR "zeppelin" --expand >/dev/null
jget '"gamma" in d["paths"]' < "$C" | grep -q True && ok "inbound cache: rebuilt when a note is newer than it" || no "cache not rebuilt after a new note"
FM2="$SB/agent-menu2"; mkmenu "$FM2" memory/wiki
out="$( cd "$FM2" && python3 scripts/recall.py "zeppelin" --expand 2>&1 )"
{ <<<"$out" grep -q 'alpha-note (concept)' && <<<"$out" grep -q 'skipped 1 hubs'; } && ok "link menu on a layout-2 agent: the wiki folder comes from the layout resolver (memory/wiki)" || no "layout-2 link menu wrong" "$out"
}
runmodes menu_checks


# ---- (c3) which queries are questions
python3 - "$FA/scripts" <<'PY' && ok "question detection: 14 questions and 14 non-questions classified as expected" || no "question detection table failed"
import sys
sys.path.insert(0, sys.argv[1])
import recall
yes = ["what did we decide", "Why is the van late", "how do I renew", "who owns the contract", "when is the review", "where are the keys",
       "which vendor won", "did Dana approve it", "does this repeat", "is the shop open", "are we late", "was it signed", "were they there",
       "can I book the room", "should we renew", "vendor contract?", "vendor decision", "the decided plan", "Decision log", "notes on contract?"]
no_ = ["vendor contract", "budget review", "dana ruiz", "brake pads", "ISH-5252", "the vendor", "whatever", "howard", "island", "diditall",
       "candle", "whoever signs", "isolated vendor", "decisive moment"]
bad = [q for q in yes if not recall.is_question_shaped(q)] + [q for q in no_ if recall.is_question_shaped(q)]
assert not bad, bad
assert len(yes) >= 14 and len(no_) >= 14
PY

# ---- (c4) preimage copies are never indexed or returned
PRE="$FA/memory/dream/2026-11-15/preimage"; mkdir -p "$PRE"; printf -- '# Copy\nzebrafoxtrot vendor contract copy\n' > "$PRE/wiki__people__dana-ruiz.md"
printf -- '# Kept\nzebrafoxtrot is in a real note\n' > "$FA/memory/dream-notes.md"
out="$(FR "zebrafoxtrot" --json 2>/dev/null)"
printf '%s' "$out" | python3 -c 'import json,sys; fs=[r["file"] for r in json.load(sys.stdin)["results"]]; assert fs==["memory/dream-notes.md"], fs' 2>/dev/null \
  && ok "a dream-cycle preimage copy is not searched; a real note beside it is" || no "preimage copy leaked into the lexical arm" "$out"
python3 - "$FA/scripts/memory" <<'PY' && ok "is_index_excluded (mem_common) and corpus.source_files agree: preimage out, everything else in" || no "is_index_excluded table failed"
import os, sys
sys.path.insert(0, sys.argv[1])
import corpus, mem_common as M
for p in ("memory/dream/2026-11-15/preimage/x.md", "/srv/agent/memory/dream/2026-11-15/preimage/sub/x.md", "memory\\dream\\2026-11-15\\preimage\\x.md"):
    assert M.is_index_excluded(p), p
for p in ("memory/dream-notes.md", "memory/dream/2026-11-15/applied.md", "wiki/preimage/x.md", "memory/2026-11-15.md", "wiki/dream/a/preimage-x.md"):
    assert not M.is_index_excluded(p), p
assert not any("preimage" in f for f in corpus.source_files(corpus.ROOT))
PY

# ---- (c5) rerank by default for questions, degraded warning: a stub semantic arm and a stub reranker worker (real protocol)
V="$XDG_DATA_HOME/talos/venv/bin"; mkdir -p "$V" "$SB/block" "$SB/rr-ok/onnx"; touch "$V/../.talos-memory-ok" "$SB/rr-ok/tokenizer.json" "$SB/rr-ok/onnx/model_int8.onnx"
printf 'raise ImportError("blocked for the test")\n' > "$SB/block/onnxruntime.py"          # force mem_rerank to use its worker child
cat > "$V/python" <<FAKE
#!/bin/bash
[ -e "$SB/sem-fail" ] && exit 1
case " \$* " in
 *" --worker "*) exec python3 -c '
import json, sys
for line in sys.stdin:
    if line.strip():
        n = len(json.loads(line)["paths"])
        print(json.dumps({"scores": [float(i) for i in range(n)]}), flush=True)' ;;
esac
exec python3 -c '
import json, os, sys
qs = json.load(sys.stdin)
path = "memory/dream/2026-11-15/preimage/wiki__people__dana-ruiz.md" if os.path.exists("$SB/sem-preimage") else "wiki/concepts/fleet-vehicles.md"
hit = {"path": path, "heading": "H", "score": 0.83, "distance": 0.5, "snippet": "The delivery van"}
print(json.dumps({"model": "fake", "batch": {q: [hit] for q in qs}}))'
FAKE
chmod +x "$V/python"
F="$SB/agent-c"; mkfixture "$F"; mkdb; touch "$F/.index/.last-index-ok"
RC() { ( cd "$F" && PYTHONPATH="$SB/block" TALOS_RG=/nonexistent/rg python3 scripts/recall.py "$@" 2>"$SB/last.err" ); }   # stdout; stderr kept for ERR
ERR() { grep -v 'ripgrep unavailable' "$SB/last.err"; }
Q="what did we decide about the vendor contract"
probe() { mkdir -p "$F/.index"; printf '{"seconds": 1.0, "cold_seconds": %s, "n": 15, "measured": "2026-11-15T00:00:00Z", "cpus": 4}\n' "$1" > "$F/.index/rerank-time.json"; }   # $1 = the COLD time
probe_warm_only() { mkdir -p "$F/.index"; printf '{"seconds": %s, "n": 15, "measured": "2026-11-15T00:00:00Z", "cpus": 4}\n' "$1" > "$F/.index/rerank-time.json"; }
NOTE="$F/.index/rerank-off-note-date"
applied() { jget 'd.get("rerank",{}).get(sys.argv[2] if False else "'"$Q"'",{}).get("applied",False)'; }
export TALOS_RERANK_MODEL_DIR="$SB/rr-ok"

rm -f "$F/.index/rerank-time.json" "$NOTE"
out="$(RC "$Q" --json)"; e="$(ERR)"
{ [ "$(applied <<<"$out")" = False ] && <<<"$e" grep -q 'reranking is off on this computer (no timing yet); use --rerank to force it'; } \
  && ok "rerank default: OFF for a question with no .index/rerank-time.json, and says why once" || no "no-probe case wrong" "$e"
RC "$Q" --json >/dev/null; e="$(ERR)"; [ -z "$e" ] && ok "rerank default: the 'off' line prints once a day, not on every query" || no "note repeated" "$e"
printf '{ broken' > "$F/.index/rerank-time.json"; rm -f "$NOTE"
RC "$Q" --json >/dev/null; e="$(ERR)"; <<<"$e" grep -q '(no timing yet)' && ok "rerank default: an unreadable timing file counts as no timing yet" || no "bad probe file not handled" "$e"
probe 9.0; rm -f "$NOTE"; out="$(RC "$Q" --json)"; e="$(ERR)"
{ [ "$(applied <<<"$out")" = False ] && <<<"$e" grep -q '(it took 9.0 s)'; } && ok "rerank default: OFF when the measured time is 9.0 s" || no "9.0 s case wrong" "$e"
probe_warm_only 3.0; rm -f "$NOTE"; out="$(RC "$Q" --json)"; e="$(ERR)"
{ [ "$(applied <<<"$out")" = False ] && <<<"$e" grep -q '(no timing yet)'; } && ok "rerank default: a probe file with a warm time but no cold_seconds (an older install) keeps it OFF, 'no timing yet'" || no "warm-only probe turned rerank on" "$e"
probe 9.0; rm -f "$NOTE"; RC "$Q" --json >/dev/null; <<<"$(ERR)" grep -q 'it took 9.0 s' && ok "rerank default: the off line quotes the COLD time, even when the warm time is 1.0 s" || no "cold time not quoted"
probe 8.0; out="$(RC "$Q" --json)"; [ "$(applied <<<"$out")" = False ] && ok "rerank default: 8.0 s is not under 8.0, so OFF" || no "8.0 s case wrong"
probe 3.0; rm -f "$NOTE"
out="$(RC "$Q" --json)"; e="$(ERR)"
{ [ "$(applied <<<"$out")" = True ] && [ -z "$e" ]; } && ok "rerank default: ON for a question at 3.0 s with the model present (nothing printed to stderr)" || no "3.0 s case wrong" "$e"
a="$(RC "$Q" --json --no-rerank | files_of)"; b="$(<<<"$out" files_of)"
[ -n "$a" ] && [ "$(printf '%s\n' "$a" | sed '1!G;h;$!d')" = "$b" ] && ok "rerank default: the stub reranker really re-sorted (order reversed against --no-rerank)" || no "rerank did not change the order" "$a // $b"
out="$(RC "vendor contract" --json)"; [ "$(jget 'd.get("rerank",{})' <<<"$out")" = "{}" ] && ok "rerank default: a non-question (a plain topic) is never reranked automatically" || no "non-question reranked"
out="$(RC "$Q" --json --no-rerank)"; [ "$(applied <<<"$out")" = False ] && ok "--no-rerank turns it off" || no "--no-rerank ignored"
out="$(TALOS_RECALL_RERANK=0 RC "$Q" --json)"; [ "$(applied <<<"$out")" = False ] && ok "TALOS_RECALL_RERANK=0 turns it off" || no "env off ignored"
probe 9.0
out="$(RC "$Q" --json --rerank)"; [ "$(applied <<<"$out")" = True ] && ok "--rerank forces it on even when the measured time is 9.0 s" || no "--rerank did not force"
out="$(TALOS_RECALL_RERANK=1 RC "$Q" --json)"; [ "$(applied <<<"$out")" = True ] && ok "TALOS_RECALL_RERANK=1 forces it on" || no "env on ignored"
out="$(TALOS_RECALL_RERANK=0 RC "$Q" --json --rerank)"; [ "$(applied <<<"$out")" = True ] && ok "flags beat the environment (--rerank over TALOS_RECALL_RERANK=0)" || no "flag did not beat env"
probe 3.0; out="$(TALOS_RECALL_RERANK=1 RC "$Q" --json --no-rerank)"; [ "$(applied <<<"$out")" = False ] && ok "flags beat the environment (--no-rerank over TALOS_RECALL_RERANK=1)" || no "--no-rerank did not beat env"
rm -f "$NOTE"; out="$(TALOS_RERANK_MODEL_DIR="$SB/rr-none" RC "$Q" --json)"; e="$(ERR)"
{ [ "$(applied <<<"$out")" = False ] && <<<"$e" grep -q '(model not installed)'; } && ok "rerank default: OFF with a fast probe but no reranker model, and says 'model not installed'" || no "model-missing case wrong" "$e"

# degraded warning
out="$(RC "$Q")"; rc=$?
first="$(<<<"$out" head -1)"; last="$(<<<"$out" tail -1)"
{ [ "$rc" = 0 ] && case "$first" in recall:*) true ;; *) false ;; esac && case "$last" in WARNING*|NOTE*) false ;; *) true ;; esac && ! <<<"$out" grep -q 'DOWN'; } && ok "healthy: no degraded warning, first line is the normal banner" || no "healthy run printed a warning" "$first"
printf '%s' "$(RC "$Q" --json)" | python3 -c 'import json,sys; assert "degraded" not in json.load(sys.stdin)' 2>/dev/null && ok "healthy: --json has no degraded object" || no "degraded present when healthy"
touch "$SB/sem-fail"
out="$(RC "vendor contract")"; rc=$?
first="$(<<<"$out" head -1)"; last="$(<<<"$out" tail -1)"
{ [ "$rc" = 0 ] && case "$first" in WARNING*) true ;; *) false ;; esac && [ "$first" = "$last" ] && <<<"$out" grep -q 'dana-ruiz.md'; } \
  && ok "semantic backend failing: the FIRST and LAST text lines are the same loud WARNING, exit 0, lexical results still printed" || no "degraded text wrong (rc=$rc)" "$first // $last"
out="$(RC "vendor contract" --json)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); x=d["degraded"]["semantic"]; assert x["reason"] and d["semantic"]=="unavailable" and d["results"]' 2>/dev/null && ok "semantic backend failing: --json carries degraded.semantic with the reason" || no "degraded json wrong" "$out"
out="$(RC --batch "vendor contract" "brake pads" --json)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["degraded"]["semantic"]["queries"]==["vendor contract","brake pads"]' 2>/dev/null && ok "--batch: degraded names the queries it hit" || no "batch degraded wrong" "$out"
rm -f "$SB/sem-fail"
probe 3.0
out="$(TALOS_RERANK_MODEL_DIR="$SB/rr-none" RC "$Q" --rerank)"; first="$(<<<"$out" head -1)"; last="$(<<<"$out" tail -1)"
{ case "$first" in NOTE:*RERANKER*) true ;; *) false ;; esac && [ "$first" = "$last" ]; } && ok "a forced rerank that cannot run: first and last line say the reranker did not run, results still arrive" || no "rerank-degraded text wrong" "$first // $last"
out="$(TALOS_RERANK_MODEL_DIR="$SB/rr-none" RC "$Q" --rerank --json)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["degraded"]["rerank"]["reason"] and "semantic" not in d["degraded"]' 2>/dev/null && ok "a forced rerank that cannot run: --json carries degraded.rerank" || no "rerank-degraded json wrong" "$out"
out="$(RC "vendor contract" --json -k 1)"; touch "$SB/sem-preimage"
out="$(RC "automobile servicing" --json)"; rm -f "$SB/sem-preimage"
printf '%s' "$out" | python3 -c 'import json,sys; assert not [r for r in json.load(sys.stdin)["results"] if "preimage" in r["file"]]' 2>/dev/null && ok "a semantic hit on a preimage path (old index) is dropped from the results" || no "preimage semantic hit returned" "$out"
rm -f "$V/../.talos-memory-ok"
out="$(RC "vendor contract")"; first="$(<<<"$out" head -1)"
case "$first" in recall:*) ok "semantic NOT INSTALLED is the opt-in state, not a degraded warning" ;; *) no "not-installed raised a warning" "$first" ;; esac
unset TALOS_RERANK_MODEL_DIR
rm -rf "$XDG_DATA_HOME"

# ===================================================================================== (b)
if [ "${TALOS_TEST_SEMANTIC:-0}" = 1 ]; then
  [ -n "${TALOS_TEST_XDG:-}" ] && export XDG_DATA_HOME="$TALOS_TEST_XDG" || export XDG_DATA_HOME="$SB/xdg-real"
  PYV="$XDG_DATA_HOME/talos/venv/bin/python"
  F="$SB/agent-b"; mkfixture "$F"
  # always run setup.sh: it is idempotent (a no-op when the venv and model are already there) and it writes the
  # marker that says this shared venv has the memory-search packages
  [ -x "$PYV" ] && echo "  (reusing the venv at $XDG_DATA_HOME/talos/venv)" || echo "  (building the real venv and downloading the small model; a few minutes the first time)"
  bash "$F/scripts/memory/setup.sh" --agent-dir "$F" --embed-model small --no-index --no-job >"$SB/setup.out" 2>&1 \
    && [ -e "$XDG_DATA_HOME/talos/venv/.talos-memory-ok" ] && ok "[real] setup.sh builds (or reuses) the venv, installs the pinned packages, downloads the model and writes the ready marker" \
    || { no "[real] setup.sh failed" "$(tail -5 "$SB/setup.out")"; echo "  semantic: PASS $PASS FAIL $FAIL"; exit 1; }
  find "$F/wiki" "$F/memory" -type f | sort | xargs shasum -a 256 > "$SB/src.sums"

  out="$("$PYV" "$F/scripts/memory/mem_index.py" --full --embed-model small 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'new/changed' && [ -s "$F/.index/memory.db" ]; } && ok "[real] mem_index.py builds the index" || no "[real] indexing failed (rc=$rc)" "$(printf '%s' "$out" | tail -4)"
  [ -e "$F/.index/.last-index-ok" ] && ok "[real] a clean index run writes the freshness stamp" || no "[real] no .last-index-ok stamp"
  chunks="$(python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(",".join(sorted(set(r[0] for r in c.execute("select path from chunks")))))' "$F/.index/memory.db")"
  case "$chunks" in *personal*|*examples*|*_changelog*) no "[real] excluded files were indexed: $chunks" ;; *) ok "[real] personal/, examples/ and the changelog are not in the index" ;; esac

  out="$(R "automobile servicing garage")"
  <<<"$out" grep -q 'semantic: live' && <<<"$out" grep -qE '1\. \[semantic +\] wiki/concepts/fleet-vehicles.md' \
    && ok "[real] a query sharing no word with the note still finds it, via semantic search, ranked first" \
    || no "[real] semantic-only query did not return fleet-vehicles.md first" "$(<<<"$out" head -8)"

  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"
  <<<"$out" grep -q ' 0 new/changed' && ok "[real] a second index run reports 0 new/changed" || no "[real] second run was not a no-op" "$out"

  sleep 30 & HOLD=$!
  mkdir -p "$F/.index/.mem_index.lock.d"; echo "$HOLD" > "$F/.index/.mem_index.lock.d/pid"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'already running'; } && ok "[real] a concurrent run prints 'already running' and exits 0" || no "[real] concurrent run not refused" "$out"
  kill "$HOLD" 2>/dev/null; wait "$HOLD" 2>/dev/null
  echo 999999 > "$F/.index/.mem_index.lock.d/pid"      # a dead pid: the lock must be stolen
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'new/changed'; } && ok "[real] a lock held by a dead pid is stolen" || no "[real] stale lock not stolen (rc=$rc)" "$out"
  [ ! -e "$F/.index/.mem_index.lock.d" ] && ok "[real] the lock is released when the run ends" || no "[real] lock folder left behind"

  mkdir -p "$F/.index/.mem_index.lock.d"          # a lock folder with NO pid yet: a run that is just starting
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'starting; skipping' && [ -d "$F/.index/.mem_index.lock.d" ]; } && ok "[real] a brand-new pid-less lock folder is a run that is starting, not an abandoned lock: it is not stolen" || no "young pid-less lock stolen (rc=$rc)" "$out"
  touch -t 202601010000 "$F/.index/.mem_index.lock.d"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && <<<"$out" grep -q 'new/changed'; } && ok "[real] an OLD pid-less lock folder is treated as abandoned and stolen" || no "old pid-less lock not stolen (rc=$rc)" "$out"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" --embed-model base 2>&1)"; rc=$?
  { [ "$rc" = 2 ] && <<<"$out" grep -q -- '--full'; } && ok "[real] switching embedding models without --full is refused" || no "[real] model mix not refused (rc=$rc)" "$out"

  echo "% a new note appears" > /dev/null
  printf -- '---\ntitle: Recycling\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Recycling\nGlass and cardboard go in the blue bins on Thursday. See [[team-offsite]].\n' > "$F/wiki/concepts/recycling.md"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"
  <<<"$out" grep -q ' 1 new/changed' && ok "[real] a new note is picked up incrementally (1 new/changed)" || no "[real] incremental pickup wrong" "$out"
  find "$F/wiki" "$F/memory" -type f ! -name recycling.md | sort | xargs shasum -a 256 > "$SB/src2.sums"
  grep -v recycling "$SB/src.sums" | diff -q - "$SB/src2.sums" >/dev/null && ok "[real] indexing never modified a source note" || no "[real] a source file changed during indexing"
else
  echo "  skip real semantic checks (set TALOS_TEST_SEMANTIC=1; optionally TALOS_TEST_XDG=/dir to keep the venv between runs)"
fi

export HOME="$REALHOME"
echo "  recall: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
