#!/usr/bin/env bash
# test-rerank-probe.sh -- mem_rerank.py --probe: times one warm and one COLD rerank and keeps them in <agent>/.index/rerank-time.json.
# Driven with the system python3 and monkeypatched installed()/rerank(): no model and no onnxruntime are needed.
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home"; mkdir -p "$HOME"
talos_test_sandbox "$SB"
unset XDG_DATA_HOME TALOS_RERANK_MODEL_DIR
MR="$KIT/scripts/memory"

# run <agent> <mode> [force]: mode = ok | notinstalled | fail | coldfail ; prints stdout, exit code in $RC
run() {
  python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import mem_rerank as m
mode = sys.argv[3]
m.installed = lambda: mode != "notinstalled"
m.time_cold = (lambda q, p: None) if mode == "coldfail" else (lambda q, p: 4.2)
m.rerank = (lambda q, p: (list(p), None)) if mode == "fail" else (lambda q, p: (list(p), [0.0] * len(p)))
sys.exit(m.probe(sys.argv[2], force=(len(sys.argv) > 4)))' "$MR" "$1" "$2" ${3:+force}
}
mkagent(){ rm -rf "$1"; mkdir -p "$1/memory" "$1/.hidden" "$1/node_modules/x"; local i; for i in $(seq 1 "$2"); do echo "note $i" > "$1/memory/n$i.md"; done
  echo hidden > "$1/.hidden/h.md"; echo nm > "$1/node_modules/x/m.md"; }
J(){ python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

A="$SB/a"; mkagent "$A" 20
out="$(run "$A" ok)"; rc=$?
F="$A/.index/rerank-time.json"
{ [ "$rc" = 0 ] && [ -f "$F" ] && [ "$(J "$F" n)" = 15 ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["seconds"]>=0 and d["measured"].endswith("Z") and isinstance(d["cpus"],int)' "$F"; } \
  && ok "20 notes: the JSON has n 15, seconds, a Z timestamp and cpus; exit 0" || no "probe JSON wrong (rc=$rc)" "$out"
[ "$(printf '%s\n' "$out" | grep -c .)" = 1 ] && <<<"$out" grep -qE '^reranking speed here: [0-9.]+ s for 15 notes( \(cold start [0-9.]+ s\))?$' \
  && ok "stdout is the one line 'reranking speed here: <s> s for 15 notes'" || no "stdout wrong" "$out"

{ [ "$(J "$F" cold_seconds)" = 4.2 ] && <<<"$out" grep -q 'cold start 4.2 s'; } && ok "the file has cold_seconds beside seconds, and the line quotes the cold time" || no "cold_seconds missing" "$out"
m1="$(J "$F" measured)"; sleep 1
out="$(run "$A" ok)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(J "$F" measured)" = "$m1" ] && <<<"$out" grep -q 'not timed again'; } && ok "a second run straight after is skipped, the file unchanged" || no "second run not skipped (rc=$rc)" "$out"
out="$(run "$A" ok force)"; rc=$?
{ [ "$rc" = 0 ] && [ "$(J "$F" measured)" != "$m1" ]; } && ok "force=True measures again" || no "force did not re-measure (rc=$rc)" "$out"

python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import mem_rerank' "$MR" 2>/dev/null && ok "mem_rerank imports with the system python3" || no "mem_rerank import failed"
grep -q -- '--force' "$MR/mem_rerank.py" && ok "the CLI knows --force" || no "no --force in mem_rerank.py"

B="$SB/b"; mkagent "$B" 1
out="$(run "$B" ok)"; rc=$?
{ [ "$rc" = 0 ] && [ ! -e "$B/.index/rerank-time.json" ] && <<<"$out" grep -q 'too few notes'; } && ok "1 note: writes nothing, says there are too few notes" || no "1-note case wrong (rc=$rc)" "$out"

C="$SB/c"; mkagent "$C" 20
out="$(run "$C" notinstalled)"; rc=$?
{ [ "$rc" = 0 ] && [ ! -e "$C/.index/rerank-time.json" ] && <<<"$out" grep -q 'not downloaded'; } && ok "model not installed: writes nothing, says it is not downloaded" || no "not-installed case wrong (rc=$rc)" "$out"

D="$SB/d"; mkagent "$D" 20
out="$(run "$D" fail)"; rc=$?
{ [ "$rc" = 0 ] && [ ! -e "$D/.index/rerank-time.json" ] && [ "$(printf '%s\n' "$out" | grep -c .)" = 1 ] && <<<"$out" grep -q 'timing failed'; } && ok "rerank failing (scores None): writes nothing, one line saying the timing failed" || no "failure case wrong (rc=$rc)" "$out"

G="$SB/g"; mkagent "$G" 20
out="$(run "$G" coldfail)"; rc=$?
{ [ "$rc" = 0 ] && [ -f "$G/.index/rerank-time.json" ] && ! grep -q cold_seconds "$G/.index/rerank-time.json" && <<<"$out" grep -q 'cold start timing failed'; } && ok "cold timing failing: no cold_seconds is written (so rerank stays off by default) and the line says so" || no "cold failure case wrong (rc=$rc)" "$out"
# an older file with only a warm time is measured again, not skipped as fresh
python3 -c 'import json,sys; json.dump({"seconds": 2.0, "n": 15, "measured": "2099-01-01T00:00:00Z", "cpus": 4}, open(sys.argv[1], "w"))' "$G/.index/rerank-time.json"
out="$(run "$G" ok)"; rc=$?
{ [ "$(J "$G/.index/rerank-time.json" cold_seconds)" = 4.2 ] && ! <<<"$out" grep -q 'not timed again'; } && ok "a probe file without cold_seconds is measured again even when recent" || no "old-format file skipped" "$out"
# the REAL cold path: a fresh worker child (a stand-in venv python speaking the worker protocol) is started, asked once, and closed
H="$SB/h"; mkagent "$H" 20; mkdir -p "$SB/fakevenv"
printf '#!/bin/bash\nexec python3 -c '"'"'\nimport json, sys\nfor line in sys.stdin:\n    if line.strip():\n        print(json.dumps({"scores": [float(i) for i in range(len(json.loads(line)["paths"]))]}), flush=True)'"'"'\n' > "$SB/fakevenv/python"; chmod +x "$SB/fakevenv/python"
out="$(python3 -c '
import sys
sys.path.insert(0, sys.argv[1])
import mem_rerank as m
m.installed = lambda: True
m.MEM_PY = sys.argv[3]
sys.exit(m.probe(sys.argv[2]))' "$MR" "$H" "$SB/fakevenv/python")"; rc=$?
{ [ "$rc" = 0 ] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["cold_seconds"]>=0 and d["seconds"]>=0' "$H/.index/rerank-time.json"; } && ok "the cold timing starts a fresh worker process through the real worker protocol and writes both fields" || no "real cold path failed (rc=$rc)" "$out"

E="$SB/e"; mkagent "$E" 20
{ [ ! -d "$E/.index" ] && run "$E" ok >/dev/null && [ -f "$E/.index/rerank-time.json" ]; } && ok ".index/ missing: created" || no ".index/ was not created"

echo "  rerank-probe: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
