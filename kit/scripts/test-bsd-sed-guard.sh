#!/usr/bin/env bash
# test-bsd-sed-guard.sh -- hooks/bsd-sed-guard.py: exit 2 = blocked, exit 0 = allowed. Throwaway HOME/XDG.
export PYTHONDONTWRITEBYTECODE=1
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SB="$(mktemp -d)" || exit 2
case "$SB" in /*/*) ;; *) echo "suspicious temp dir '$SB'" >&2; exit 2 ;; esac
trap 'rm -rf "$SB"' EXIT
export HOME="$SB/home" XDG_STATE_HOME="$SB/state" XDG_CONFIG_HOME="$SB/cfg"; mkdir -p "$HOME"
unset CHRONOS_RUN TALOS_UNATTENDED
export TALOS_BSD_SED_FORCE=1
H="$KIT/hooks/bsd-sed-guard.py"
PASS=0; FAIL=0
check() { local want=$1; shift; local got
  python3 -c 'import json,sys; print(json.dumps({"tool_name":"Bash","tool_input":{"command":sys.argv[1]}}))' "$*" | python3 "$H" 2>/dev/null
  got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "  FAIL want=$want got=$got :: $*"; fi; }
# blocked: the GNU forms
check 2 "sed -i 's/a/b/' file.txt"
check 2 'sed -i "s/a/b/" file.txt'
check 2 "sed -E -i 's/a/b/' f"
check 2 "sed -i -e 's/a/b/' f"
check 2 "sed -i s/a/b/ f"
check 2 "cd x && sed -i 's/a/b/g' src/a.ts"
check 2 "sed -i '3d' f"
# allowed: BSD-correct forms and everything that is not an in-place edit
check 0 "sed -i '' 's/a/b/' f"
check 0 "sed -i.bak 's/a/b/' f"
check 0 "sed -i'' 's/a/b/' f"
check 0 "sed -i '' -e 's/a/b/' f"
check 0 "sed -n '1,5p' f"
check 0 "cat f | sed 's/a/b/'"
check 0 "echo sed -i is a GNU-ism"
check 0 "python3 - <<'EOT'
print(\"sed -i 's/a/b/' f\")
EOT"
check 0 "ls -la"
# stands down when it is not Apple's sed
( export TALOS_BSD_SED_FORCE=0; got=$(python3 -c 'import json; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"sed -i \"s/a/b/\" f"}}))' | PATH="$SB/gnu:$PATH" python3 "$H" 2>/dev/null; echo $?)
  mkdir -p "$SB/gnu"; printf '#!/bin/sh\nexit 0\n' > "$SB/gnu/sed"; chmod +x "$SB/gnu/sed"
  got=$(python3 -c 'import json; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"sed -i \"s/a/b/\" f"}}))' | PATH="$SB/gnu:$PATH" python3 "$H" 2>/dev/null; echo $?)
  [ "$got" = 0 ] ) && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "  FAIL guard did not stand down when sed on PATH is not /usr/bin/sed"; }
# fail open on garbage, non-Bash tools and the kill switch
got=$(printf 'not json' | python3 "$H" 2>/dev/null; echo $?); [ "$got" = 0 ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "  FAIL garbage input did not fail open"; }
got=$(printf '{"tool_name":"Read","tool_input":{"command":"sed -i s/a/b/ f"}}' | python3 "$H" 2>/dev/null; echo $?); [ "$got" = 0 ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "  FAIL a non-Bash tool was blocked"; }
got=$(python3 -c 'import json; print(json.dumps({"tool_name":"Bash","tool_input":{"command":"sed -i \"s/a/b/\" f"}}))' | TALOS_BSD_SED_GUARD_OFF=1 python3 "$H" 2>/dev/null; echo $?); [ "$got" = 0 ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "  FAIL the kill switch did not turn it off"; }
grep -q '"bsd-sed-guard.off"' "$H" && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); echo "  FAIL kill-switch name is not a string literal"; }
echo "  bsd-sed-guard: PASS $PASS FAIL $FAIL"
[ "$FAIL" -eq 0 ]
