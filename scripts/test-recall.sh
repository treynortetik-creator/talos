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
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }

SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
REALHOME="$HOME"
export HOME="$SB/home"; mkdir -p "$HOME"
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

# ===================================================================================== (a)
F="$SB/agent-a"; mkfixture "$F"

out="$(R "vendor contract")"
printf '%s' "$out" | grep -q 'wiki/people/dana-ruiz.md' && ok "lexical arm finds a note by its terms" || no "lexical arm did not find dana-ruiz.md" "$out"
printf '%s' "$out" | grep -q 'semantic: NOT INSTALLED' && ok "with no venv the first line says NOT INSTALLED and names the fix" || no "no NOT INSTALLED banner" "$(printf '%s' "$out" | head -2)"

out="$(R "vendor contract" --json)"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["semantic"]=="not-installed" and d["results"][0]["file"].endswith("dana-ruiz.md")' 2>/dev/null \
  && ok "--json is valid and reports semantic: not-installed" || no "--json output wrong" "$out"
out="$(R --batch "vendor contract" "brake pads" "budget review")"
printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); b=d["batch"]; assert set(b)=={"vendor contract","brake pads","budget review"} and b["brake pads"][0]["file"].endswith("fleet-vehicles.md")' 2>/dev/null \
  && ok "--batch answers several queries in one call as valid JSON" || no "--batch output wrong" "$out"

out="$(R "vendor" -k abc)"; [ "$?" != 0 ] || printf '%s' "$out" | grep -q 'needs a positive number' && ok "recall: -k with a non-number is a usage error, not a traceback" || no "-k abc mishandled" "$out"
printf '%s' "$out" | grep -qi traceback && no "recall printed a traceback on a bad -k" || ok "recall: no traceback for a bad -k"
out="$(R "vendor" -k)"; printf '%s' "$out" | grep -q 'needs a positive number' && ok "recall: a trailing -k with no value is a usage error" || no "trailing -k mishandled" "$out"
out="$(R "-5 vendor" --json)"; printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["query"]=="-5 vendor"' 2>/dev/null && ok "recall: a query word that starts with - is kept in the query" || no "dash query word dropped" "$out"
out="$(R "xylophone concerto")"
printf '%s' "$out" | grep -q 'NO RESULTS -- search verified working' && printf '%s' "$out" | grep -q 'positive control "alex"' \
  && ok "a miss on a healthy corpus is EMPTY: the control term (the title of wiki/me.md) was found" || no "empty diagnosis wrong" "$out"

E="$SB/agent-empty"; mkfixture "$E"; rm -rf "$E/wiki" "$E/memory"; mkdir -p "$E/wiki"
out="$( cd "$E" && python3 scripts/recall.py "anything at all" 2>&1 )"
printf '%s' "$out" | grep -q 'SEARCH DEGRADED' && printf '%s' "$out" | grep -qi 'corpus is EMPTY' \
  && ok "an empty wiki is BROKEN (nothing to search), never reported as 'nothing recorded'" || no "empty-corpus diagnosis wrong" "$out"

bad=""
for w in zanzibar ravenclaw changelogword hufflepuff slytherin; do
  o="$(R "$w" --json)"; printf '%s' "$o" | python3 -c 'import json,sys; sys.exit(0 if not json.load(sys.stdin)["results"] else 1)' 2>/dev/null || bad="$bad $w"
done
[ -z "$bad" ] && ok "wiki/examples, the changelog and anything under personal/ (any capitalisation) are never searched" || no "excluded content leaked into search:$bad"

if [ -x /usr/bin/python3 ] && /usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 9) else 1)' 2>/dev/null; then
  o="$( cd "$F" && /usr/bin/python3 scripts/recall.py "vendor contract" 2>&1 )"
  printf '%s' "$o" | grep -q 'dana-ruiz.md' && ok "recall.py runs on Apple's python 3.9 (stdlib only)" || no "recall.py failed on python 3.9" "$o"
else echo "  skip python 3.9 check (the system python is not 3.9 here)"; fi

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
printf '%s' "$out" | grep -q 'semantic: NOT INSTALLED' && ok "a venv without the memory-search marker (a voice-only venv) is NOT INSTALLED, not a broken index" || no "voice-only venv misreported" "$(printf '%s' "$out" | head -2)"
touch "$V/../.talos-memory-ok"
out="$(R "vendor contract")"
printf '%s' "$out" | grep -q 'semantic: NO INDEX' && ok "a venv with no index says NO INDEX and prints the command to build it" || no "no NO INDEX banner" "$(printf '%s' "$out" | head -2)"

mkdb
printf '#!/bin/bash\ncat >/dev/null\nexit 1\n' > "$V/python"
out="$(R "vendor contract")"; touch "$F/.index/.last-index-ok"
printf '%s' "$out" | grep -q 'semantic: UNAVAILABLE' && printf '%s' "$out" | grep -q 'dana-ruiz.md' \
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
printf '%s' "$out" | grep -q 'semantic: live' && printf '%s' "$out" | grep -qE '1\. \[semantic +\] wiki/concepts/fleet-vehicles.md' \
  && ok "a semantic-only hit is found, tagged semantic, and the header says live" || no "semantic fusion wrong" "$out"
out="$(R "brake pads")"
printf '%s' "$out" | grep -qE '1\. \[lexical\+semantic\] wiki/concepts/fleet-vehicles.md' \
  && ok "a note found by BOTH arms is tagged lexical+semantic" || no "dual-arm tag wrong" "$out"

touch -t 202601010000 "$F/.index/.last-index-ok"
out="$(R "brake pads")"
printf '%s' "$out" | grep -q 'semantic: INDEX STALE' && ok "an index older than 48h says INDEX STALE (and still searches)" || no "stale banner wrong" "$(printf '%s' "$out" | head -2)"
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
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'new/changed' && [ -s "$F/.index/memory.db" ]; } && ok "[real] mem_index.py builds the index" || no "[real] indexing failed (rc=$rc)" "$(printf '%s' "$out" | tail -4)"
  [ -e "$F/.index/.last-index-ok" ] && ok "[real] a clean index run writes the freshness stamp" || no "[real] no .last-index-ok stamp"
  chunks="$(python3 -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(",".join(sorted(set(r[0] for r in c.execute("select path from chunks")))))' "$F/.index/memory.db")"
  case "$chunks" in *personal*|*examples*|*_changelog*) no "[real] excluded files were indexed: $chunks" ;; *) ok "[real] personal/, examples/ and the changelog are not in the index" ;; esac

  out="$(R "automobile servicing garage")"
  printf '%s' "$out" | grep -q 'semantic: live' && printf '%s' "$out" | grep -qE '1\. \[semantic +\] wiki/concepts/fleet-vehicles.md' \
    && ok "[real] a query sharing no word with the note still finds it, via semantic search, ranked first" \
    || no "[real] semantic-only query did not return fleet-vehicles.md first" "$(printf '%s' "$out" | head -8)"

  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"
  printf '%s' "$out" | grep -q ' 0 new/changed' && ok "[real] a second index run reports 0 new/changed" || no "[real] second run was not a no-op" "$out"

  sleep 30 & HOLD=$!
  mkdir -p "$F/.index/.mem_index.lock.d"; echo "$HOLD" > "$F/.index/.mem_index.lock.d/pid"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'already running'; } && ok "[real] a concurrent run prints 'already running' and exits 0" || no "[real] concurrent run not refused" "$out"
  kill "$HOLD" 2>/dev/null; wait "$HOLD" 2>/dev/null
  echo 999999 > "$F/.index/.mem_index.lock.d/pid"      # a dead pid: the lock must be stolen
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'new/changed'; } && ok "[real] a lock held by a dead pid is stolen" || no "[real] stale lock not stolen (rc=$rc)" "$out"
  [ ! -e "$F/.index/.mem_index.lock.d" ] && ok "[real] the lock is released when the run ends" || no "[real] lock folder left behind"

  mkdir -p "$F/.index/.mem_index.lock.d"          # a lock folder with NO pid yet: a run that is just starting
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'starting; skipping' && [ -d "$F/.index/.mem_index.lock.d" ]; } && ok "[real] a brand-new pid-less lock folder is a run that is starting, not an abandoned lock: it is not stolen" || no "young pid-less lock stolen (rc=$rc)" "$out"
  touch -t 202601010000 "$F/.index/.mem_index.lock.d"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"; rc=$?
  { [ "$rc" = 0 ] && printf '%s' "$out" | grep -q 'new/changed'; } && ok "[real] an OLD pid-less lock folder is treated as abandoned and stolen" || no "old pid-less lock not stolen (rc=$rc)" "$out"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" --embed-model base 2>&1)"; rc=$?
  { [ "$rc" = 2 ] && printf '%s' "$out" | grep -q -- '--full'; } && ok "[real] switching embedding models without --full is refused" || no "[real] model mix not refused (rc=$rc)" "$out"

  echo "% a new note appears" > /dev/null
  printf -- '---\ntitle: Recycling\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\nstatus: living\n---\n# Recycling\nGlass and cardboard go in the blue bins on Thursday. See [[team-offsite]].\n' > "$F/wiki/concepts/recycling.md"
  out="$("$PYV" "$F/scripts/memory/mem_index.py" 2>&1)"
  printf '%s' "$out" | grep -q ' 1 new/changed' && ok "[real] a new note is picked up incrementally (1 new/changed)" || no "[real] incremental pickup wrong" "$out"
  find "$F/wiki" "$F/memory" -type f ! -name recycling.md | sort | xargs shasum -a 256 > "$SB/src2.sums"
  grep -v recycling "$SB/src.sums" | diff -q - "$SB/src2.sums" >/dev/null && ok "[real] indexing never modified a source note" || no "[real] a source file changed during indexing"
else
  echo "  skip real semantic checks (set TALOS_TEST_SEMANTIC=1; optionally TALOS_TEST_XDG=/dir to keep the venv between runs)"
fi

export HOME="$REALHOME"
echo "  recall: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
