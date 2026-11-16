#!/usr/bin/env bash
# test-reranker-step.sh -- kit/install.sh's reranker step, run for real (fake HOME, no Chronos) against a copy of the kit whose
# memory/setup.sh and memory/fetch-reranker.sh are stubs with a chosen exit code, and whose venv python only records its calls.
# Nothing is downloaded. Also: --reranker-auto is documented once.
set -uo pipefail
export PYTHONDONTWRITEBYTECODE=1
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'chmod -R u+w "$SB" 2>/dev/null; rm -rf "$SB"' EXIT
HOME="$SB/home" talos_test_sandbox "$SB"
unset XDG_DATA_HOME TALOS_RERANK_MODEL_DIR TALOS_MEM_BYTES CLAUDE_PROJECT_DIR

[ "$(bash "$KIT/install.sh" --help | grep -c -- --reranker-auto)" = 1 ] && ok "--help documents --reranker-auto once" || no "--reranker-auto is documented $(bash "$KIT/install.sh" --help | grep -c -- --reranker-auto) times"
[ "$(grep -c -- '--reranker-auto)' "$KIT/install.sh")" = 1 ] && ok "install.sh has one --reranker-auto case arm" || no "duplicate --reranker-auto case arm"

KC="$SB/kit"; cp -R "$KIT" "$KC"; rm -rf "$KC/.git"
cat > "$KC/scripts/memory/setup.sh" <<'STUB'
#!/bin/bash
exit "${STUB_SETUP_RC:-0}"
STUB
cat > "$KC/scripts/memory/fetch-reranker.sh" <<'STUB'
#!/bin/bash
echo "fetch $*" >> "$STUB_LOG/fetch.calls"
echo "stub fetch ran"
exit "${STUB_FETCH_RC:-0}"
STUB
chmod +x "$KC/scripts/memory/setup.sh" "$KC/scripts/memory/fetch-reranker.sh"

# install_run <name> <fetch rc> <setup rc> <flags...>: a real install; sets OUT, RC, A (agent), LOG
install_run() {
  local name="$1"; STUB_FETCH_RC="$2"; STUB_SETUP_RC="$3"; shift 3
  export HOME="$SB/$name"; rm -rf "$HOME"; mkdir -p "$HOME"
  export XDG_CONFIG_HOME="$HOME/.config" XDG_DATA_HOME="$HOME/.local/share" TALOS_VENDOR_DIR="$HOME/.local/share/talos"
  mkdir -p "$XDG_DATA_HOME/talos/venv/bin"
  LOG="$SB/$name.log"; mkdir -p "$LOG"; export STUB_LOG="$LOG" STUB_FETCH_RC STUB_SETUP_RC
  printf '#!/bin/bash\necho "$*" >> "%s/py.calls"\n' "$LOG" > "$XDG_DATA_HOME/talos/venv/bin/python"; chmod +x "$XDG_DATA_HOME/talos/venv/bin/python"
  A="$HOME/agent"
  OUT="$(bash "$KC/install.sh" --agent-dir "$A" --no-chronos --no-load "$@" 2>&1)"; RC=$?
}
M() { [ -e "$A/.index/.rerank-wanted" ] && echo kept || echo gone; }
probed() { grep -q -- "mem_rerank.py --probe $A --force" "$LOG/py.calls" 2>/dev/null && echo yes || echo no; }

install_run rc0 0 0 --with-memory-search --reranker-auto
{ [ "$RC" = 0 ] && [ "$(M)" = gone ] && [ "$(probed)" = yes ]; } && ok "fetch rc 0: marker gone, the probe ran with --force, install exits 0" || no "rc 0 wrong (rc=$RC marker=$(M) probed=$(probed))" "$(printf '%s' "$OUT" | tail -5)"

install_run rc3 3 0 --with-memory-search --reranker-auto
{ [ "$RC" = 0 ] && [ "$(M)" = gone ] && [ "$(probed)" = no ]; } && ok "fetch rc 3 (skipped for memory): marker gone, no probe" || no "rc 3 wrong (rc=$RC marker=$(M) probed=$(probed))" "$(printf '%s' "$OUT" | tail -5)"

install_run rc1 1 0 --with-memory-search --reranker-auto
{ [ "$RC" = 0 ] && [ "$(M)" = kept ] && [ "$(probed)" = no ] && <<<"$OUT" grep -q 'not downloaded; search works without it. Retry:'; } \
  && ok "fetch rc 1: marker kept, the retry line printed, no probe, install still exits 0" || no "rc 1 wrong (rc=$RC marker=$(M) probed=$(probed))" "$(printf '%s' "$OUT" | tail -5)"

install_run nosearch 0 0 --reranker-auto
{ [ "$RC" = 0 ] && [ "$(M)" = gone ] && [ ! -e "$LOG/fetch.calls" ] && <<<"$OUT" grep -q 'reranker: skipped (semantic search is not set up). Add it later: bash .*scripts/memory/setup.sh --rerank'; } \
  && ok "--reranker-auto without search: one skip line, nothing fetched, no marker" || no "auto without search wrong (rc=$RC marker=$(M))" "$(printf '%s' "$OUT" | tail -5)"

install_run setupfail 0 1 --with-memory-search --reranker-auto
{ [ "$RC" = 0 ] && [ "$(M)" = gone ] && [ ! -e "$LOG/fetch.calls" ] && <<<"$OUT" grep -q 'reranker: skipped (semantic search is not set up)'; } \
  && ok "--reranker-auto when the search setup failed: skipped, nothing fetched, no marker" || no "auto after failed setup wrong (rc=$RC marker=$(M))" "$(printf '%s' "$OUT" | tail -5)"

install_run explicit 0 0 --with-reranker
{ [ "$RC" = 0 ] && [ -e "$LOG/fetch.calls" ] && [ "$(M)" = gone ]; } && ok "an explicit --with-reranker still fetches without --with-memory-search" || no "explicit --with-reranker wrong (rc=$RC)" "$(printf '%s' "$OUT" | tail -5)"

echo "  reranker-step: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
