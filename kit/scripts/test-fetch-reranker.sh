#!/usr/bin/env bash
# test-fetch-reranker.sh -- memory/fetch-reranker.sh: the memory gate (--if-enough-memory), the dry run, and that an explicit
# request is never second-guessed. A fake curl first on PATH logs its arguments; the real model is never downloaded.
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$KIT/scripts/_test-env.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
no(){ FAIL=$((FAIL+1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; }
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
FB="$SB/fakebin"; mkdir -p "$FB"
CALLS="$SB/curl.calls"
cat > "$FB/curl" <<FAKE
#!/bin/bash
echo "\$*" >> "$CALLS"
out=""; while [ \$# -gt 0 ]; do case "\$1" in -o) out="\$2"; shift 2 ;; *) shift ;; esac; done
[ -n "\$out" ] && printf 'FAKEMODEL' > "\$out"
exit 0
FAKE
chmod +x "$FB/curl"
export PATH="$FB:$PATH"
export HOME="$SB/home"; mkdir -p "$HOME"
talos_test_sandbox "$SB"
export XDG_DATA_HOME="$SB/data"
GIB=$((1024*1024*1024))
S="$KIT/scripts/memory/fetch-reranker.sh"
fresh(){ rm -rf "$XDG_DATA_HOME"; : > "$CALLS"; }

fresh
out="$(TALOS_MEM_BYTES=$((2*GIB)) bash "$S" --if-enough-memory 2>&1)"; rc=$?
n="$(printf '%s\n' "$out" | grep -c .)"
{ [ "$rc" = 3 ] && [ "$n" = 1 ] && <<<"$out" grep -q 'skipped' && <<<"$out" grep -q '2 GiB' \
  && <<<"$out" grep -q 'bash scripts/memory/fetch-reranker.sh' && [ ! -s "$CALLS" ]; } \
  && ok "2 GiB with --if-enough-memory: exit 3, one line saying skipped and how to add it, curl never called" \
  || no "2 GiB gate wrong (rc=$rc lines=$n)" "$out"

fresh
out="$(TALOS_MEM_BYTES=$((8*GIB)) bash "$S" --if-enough-memory 2>&1)"; rc=$?
c="$(grep -c . "$CALLS")"
{ [ "$rc" = 0 ] && [ "$c" = 3 ] && grep -q 'tokenizer.json' "$CALLS" && grep -q 'config.json' "$CALLS" && grep -q 'model_int8.onnx' "$CALLS"; } \
  && ok "8 GiB with --if-enough-memory: exit 0 and curl fetched the three files" || no "8 GiB wrong (rc=$rc curl calls=$c)" "$out"

fresh
out="$(TALOS_MEM_BYTES=abc bash "$S" --if-enough-memory 2>&1)"; rc=$?
{ [ "$rc" = 3 ] && <<<"$out" grep -q 'could not be read' && [ ! -s "$CALLS" ]; } \
  && ok "unreadable memory: exit 3, says so, downloads nothing (never guesses)" || no "unreadable memory wrong (rc=$rc)" "$out"

fresh
out="$(TALOS_MEM_BYTES=$((2*GIB)) bash "$S" 2>&1)"; rc=$?
c="$(grep -c . "$CALLS")"
{ [ "$rc" = 0 ] && [ "$c" = 3 ]; } && ok "without --if-enough-memory, 2 GiB still downloads (an explicit request is never second-guessed)" || no "explicit request second-guessed (rc=$rc calls=$c)" "$out"

fresh
out="$(TALOS_MEM_BYTES=$((2*GIB)) bash "$S" --dry-run --if-enough-memory 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && <<<"$out" grep -q 'would be skipped' && [ ! -s "$CALLS" ] && [ ! -e "$XDG_DATA_HOME" ]; } \
  && ok "--dry-run --if-enough-memory with 2 GiB: says it would be skipped, exit 0, nothing fetched" || no "dry-run skip wrong (rc=$rc)" "$out"

fresh
out="$(TALOS_MEM_BYTES=$((8*GIB)) bash "$S" --dry-run --if-enough-memory 2>&1)"; rc=$?
{ [ "$rc" = 0 ] && <<<"$out" grep -q 'Dry run: nothing was downloaded' && [ ! -s "$CALLS" ]; } \
  && ok "--dry-run --if-enough-memory with 8 GiB: the usual dry-run text, exit 0" || no "dry-run 8 GiB wrong (rc=$rc)" "$out"

bash "$S" --bogus >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "an unknown flag: usage, exit 2" || no "unknown flag exited $rc"

# the marker of the agent this script belongs to: gone after a successful run by hand, kept after a failed one
AG="$SB/agent"; mkdir -p "$AG/scripts/memory" "$AG/.index"; : > "$AG/.talos-version"
cp "$S" "$AG/scripts/memory/"; cp "$KIT/scripts/_agent_root.py" "$AG/scripts/"
fresh; : > "$AG/.index/.rerank-wanted"
(cd "$AG" && TALOS_MEM_BYTES=$((8*GIB)) bash scripts/memory/fetch-reranker.sh >/dev/null 2>&1); rc=$?
{ [ "$rc" = 0 ] && [ ! -e "$AG/.index/.rerank-wanted" ]; } && ok "a successful run by hand removes the agent's .rerank-wanted marker" || no "marker not removed (rc=$rc)"
fresh; : > "$AG/.index/.rerank-wanted"; printf '#!/bin/bash\nexit 22\n' > "$FB/curl"
(cd "$AG" && bash scripts/memory/fetch-reranker.sh >/dev/null 2>&1); rc=$?
{ [ "$rc" = 1 ] && [ -e "$AG/.index/.rerank-wanted" ]; } && ok "a failed download keeps the marker" || no "marker wrong after a failed download (rc=$rc)"

echo "  fetch-reranker: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
