#!/bin/bash
# Talos uninstaller. Removes what install.sh put OUTSIDE your agent folder. Never deletes the agent folder.
#
#   ./uninstall.sh [--agent-dir DIR] [--remove-chronos | --purge-chronos] [--keep-clone] [--yes]
#
#   (default)          unregister the talos-* jobs from Chronos (their prompts and entries), remove the
#                      Chronos SessionStart hook from the agent's settings, remove ~/.config/talos
#   --agent-dir DIR    the agent folder whose settings.json carries the Chronos hook (default: the folder
#                      install.sh recorded in ~/.config/talos/agent-dir, else ~/my-agent)
#   --remove-chronos   also run Chronos's own uninstaller (unloads and removes its two launchd agents; keeps data)
#   --purge-chronos    same, plus delete ~/.chronos and ~/.config/chronos. Takes ANY jobs you added yourself with it.
#   --keep-clone       leave the pinned Chronos clone in ~/.local/share/talos
#   --remove-memory-search  also delete the shared semantic-search venv and model cache
#                      (~/.local/share/talos/venv and /models). A per-agent .index/ lives in the agent folder.
#   --yes              do not ask before the destructive options
#
# Your agent folder (memory, wiki, notes) is yours: delete it by hand when you are sure. See UNINSTALL.md.
set -u
KIT="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR=""; RM_CHRONOS=0; PURGE=0; KEEP_CLONE=0; YES=0; RM_MEM=0
while [ $# -gt 0 ]; do
  case "$1" in
    --agent-dir) AGENT_DIR="${2:?}"; shift 2 ;;
    --remove-chronos) RM_CHRONOS=1; shift ;;
    --purge-chronos) RM_CHRONOS=1; PURGE=1; shift ;;
    --keep-clone) KEEP_CLONE=1; shift ;;
    --remove-memory-search) RM_MEM=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help) awk 'NR>1 { if ($0 ~ /^#/) print; else exit }' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
# Default to the folder install.sh recorded; fall back to the historical default.
if [ -z "$AGENT_DIR" ]; then
  _rec="${XDG_CONFIG_HOME:-$HOME/.config}/talos/agent-dir"
  [ -f "$_rec" ] && AGENT_DIR="$(head -1 "$_rec")"
  [ -n "$AGENT_DIR" ] || AGENT_DIR="$HOME/my-agent"
fi
case "$AGENT_DIR" in "~"|"~/"*) AGENT_DIR="$HOME${AGENT_DIR#\~}" ;; esac
PY="$(command -v python3 || echo /usr/bin/python3)"
VENDOR="${TALOS_VENDOR_DIR:-$HOME/.local/share/talos}"
CFG="${CHRONOS_CONFIG:-$HOME/.config/chronos/config.json}"

REMEMBERED=""
[ -f "${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-dir" ] && REMEMBERED="$(head -1 "${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-dir")"

echo "== Talos jobs"
if [ -f "$CFG" ]; then "$PY" "$KIT/scripts/talos-jobs.py" unregister; else echo "  no Chronos config at $CFG; nothing to unregister"; fi

echo "== Chronos session hook"
EDITED_SETTINGS=0
if [ -d "$AGENT_DIR/.claude" ]; then
  _hm="$("$PY" "$KIT/scripts/talos-jobs.py" hook-remove --agent-dir "$AGENT_DIR")"
  [ -z "$_hm" ] || printf '%s\n' "$_hm"
  case "$_hm" in *"removed the Chronos SessionStart hook"*) EDITED_SETTINGS=1 ;; esac
else echo "  no $AGENT_DIR/.claude; skipped"; fi

echo "== Global pointer"
"$PY" "$KIT/scripts/global-pointer.py" remove

echo "== Talos config"
TCFG="${XDG_CONFIG_HOME:-$HOME/.config}/talos"
# Chronos's `notify` may point at a wrapper inside the folder we are about to delete. chronos-notify swallows
# the failure, so every OTHER job's alert would silently stop. Clear it first, only if it is ours.
if [ -f "$CFG" ]; then
  TCFGP="$TCFG" CFGP="$CFG" "$PY" - <<'PYEOF'
import json, os
p = os.environ["CFGP"]; tcfg = os.environ["TCFGP"].rstrip("/") + "/"
try:
    c = json.load(open(p))
except Exception:
    raise SystemExit(0)
n = str(c.get("notify") or "")
if n.startswith(tcfg):
    c["notify"] = ""
    mode = os.stat(p).st_mode & 0o777
    tmp = p + ".tmp.%d" % os.getpid()
    json.dump(c, open(tmp, "w"), indent=2); open(tmp, "a").write("\n")
    os.chmod(tmp, mode); os.replace(tmp, p)
    print("  cleared Chronos's notify (it pointed at %s)" % n)
PYEOF
fi
if [ -d "$TCFG" ]; then rm -rf "$TCFG" && echo "  removed $TCFG"; else echo "  none"; fi

if [ "$RM_CHRONOS" = 1 ]; then
  echo "== Chronos"
  if [ "$PURGE" = 1 ] && [ "$YES" != 1 ]; then
    read -r -p "--purge-chronos deletes ~/.chronos and ~/.config/chronos, including jobs that are not Talos's. Type 'purge': " ans
    [ "$ans" = purge ] || { echo "aborted before touching Chronos."; exit 1; }
  fi
  CH=""
  for d in "$REMEMBERED" "$VENDOR/chronos"; do [ -n "$d" ] && [ -x "$d/uninstall.sh" ] && { CH="$d"; break; }; done
  if [ -n "$CH" ]; then
    if [ "$PURGE" = 1 ]; then "$CH/uninstall.sh" --purge --yes; else "$CH/uninstall.sh"; fi
  else
    echo "  could not find a Chronos checkout with uninstall.sh; run its ./uninstall.sh yourself."
  fi
fi

if [ "$RM_MEM" = 1 ]; then
  echo "== Semantic memory search"
  _data="${XDG_DATA_HOME:-$HOME/.local/share}/talos"
  for d in venv models; do
    if [ -d "$_data/$d" ]; then rm -rf "$_data/$d" && echo "  removed $_data/$d"; else echo "  no $_data/$d"; fi
  done
  echo "  (the per-agent index, <agent folder>/.index/, stays with the agent folder and can be deleted by hand)"
fi

if [ "$KEEP_CLONE" != 1 ] && [ -d "$VENDOR/chronos" ]; then
  if [ "$RM_CHRONOS" = 1 ] || [ ! -f "$CFG" ]; then rm -rf "$VENDOR/chronos" && echo "removed the pinned Chronos clone at $VENDOR/chronos"; rmdir "$VENDOR" 2>/dev/null || true
  else echo "kept the Chronos clone at $VENDOR/chronos (Chronos is still installed; pass --remove-chronos to remove both)"; fi
fi
echo
if [ "$EDITED_SETTINGS" = 1 ]; then
  echo "Done. Your agent folder ($AGENT_DIR) is yours and nothing in it was deleted."
  echo "The one change inside it: the Chronos hook entry was removed from $AGENT_DIR/.claude/settings.json."
else
  echo "Done. Your agent folder ($AGENT_DIR) was not touched."
fi
