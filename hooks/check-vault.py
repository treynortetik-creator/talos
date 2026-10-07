#!/usr/bin/env python3
"""check-vault.py: PreToolUse. Ask before text from a private vault is written somewhere work-visible.

Only matters if you adopted a personal vault (`./install.sh --with-vault DIR`; see optional/personal/). Inert
otherwise, and inert if you have not written any guard terms.

HOW IT WORKS. You keep a list of terms that only appear in your private life (a family member's name, a clinic, a
hometown, an account nickname) in <vault>/_guard-terms.txt, one per line, `#` for comments. THAT FILE LIVES IN
THE VAULT, NEVER IN THIS KIT, and the kit ships none. When the agent writes or edits a file OUTSIDE the vault and
the text it is about to write contains one of your terms, the write pauses and asks you first. The vault location
is read from ~/.config/talos/vault-dir (written by the installer).

HONEST SCOPE. A tripwire at the Write/Edit/MultiEdit tools, not a fence. It does not see `cat > file` through the
shell, a chat message, or an MCP call, and it only knows the terms you listed. It catches carelessness, which is
the usual case; it does not stop a determined leak. Matching is case-insensitive on whole words.
On anything unexpected it fails OPEN in a live session and CLOSED (deny) in an unattended run; an `ask` becomes a
deny when nobody is there to answer. Kill switch: check-vault.off
"""
import json
import os
import re
import sys

try:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import _talos_common as C  # noqa: E402
except Exception as _e:        # the shared helpers will not load: fail open in a live session, CLOSED when unattended
    if os.environ.get("CHRONOS_RUN") == "1" or os.environ.get("TALOS_UNATTENDED") == "1":
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
              "permissionDecisionReason": "Talos check-vault could not load hooks/_talos_common.py (" + type(_e).__name__ + ": " + str(_e)[:120] + ") and this run is unattended, so the action is blocked rather than allowed unchecked."}}))
    else:
        print("{}")
    sys.exit(0)

KILL_NAME = "check-vault.off"


def vault_dir():
    cfg = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "talos", "vault-dir")
    try:
        with open(cfg, encoding="utf-8") as fh:
            v = fh.readline().strip()
        return os.path.realpath(os.path.expanduser(v)) if v else ""
    except OSError:
        return ""


def load_terms(vault):
    try:
        with open(os.path.join(vault, "_guard-terms.txt"), encoding="utf-8") as fh:
            return [l.strip() for l in fh if l.strip() and not l.lstrip().startswith("#")]
    except FileNotFoundError:
        return []                 # no terms file: nothing to guard (this is configuration, not an error)
    # any OTHER failure (permissions, an I/O error) propagates: guard_failed() allows it in a live session and blocks it unattended


def strings(v):
    if isinstance(v, str):
        return [v]
    if isinstance(v, list):
        return [x for i in v for x in strings(i)]
    if isinstance(v, dict):
        return [x for i in v.values() for x in strings(i)]
    return []


def main():
    C.arm_guard_timeout("check-vault")
    if C.killed(KILL_NAME):
        print("{}")
        return
    vault = vault_dir()
    if not vault or not os.path.isdir(vault):
        print("{}")
        return
    terms = load_terms(vault)
    if not terms:
        print("{}")
        return
    d = C.read_stdin()
    ti = d.get("tool_input") or {}
    path = ti.get("file_path") or ti.get("path") or ti.get("notebook_path") or ""
    if not isinstance(path, str) or not path:
        print("{}")
        return
    full = os.path.realpath(path if os.path.isabs(path) else os.path.join(os.getcwd(), os.path.expanduser(path)))
    if full == vault or full.startswith(vault + os.sep):
        print("{}")                 # writing inside the vault is the point of the vault
        return
    payload = {k: v for k, v in ti.items() if k not in ("file_path", "path", "notebook_path", "old_string")}
    body = "\n".join(strings(payload))     # content, new_string, edits[].new_string, ...: every string, whole
    hits = []
    for t in terms:
        if re.search(r"(?<!\w)" + re.escape(t) + r"(?!\w)", body, re.I):
            hits.append(t)
    if not hits:
        print("{}")
        return
    C.log_jsonl("vault-guard.jsonl", {"event": "ask", "target": os.path.relpath(full, C.ROOT) if full.startswith(C.ROOT + os.sep) else "(outside agent folder)", "n": len(hits)})
    print(C.pretool_json("ask", (
        "This write contains %d term%s from your personal vault's guard list (%s) and its destination is outside "
        "the vault:\n  %s\n\nPersonal-vault content may be used as context but must never be copied into work notes, "
        "commits, documents or messages. Allow it only if you are sure this text is not private."
        % (len(hits), "" if len(hits) == 1 else "s", ", ".join(hits[:5]), path))))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        C.guard_failed("check-vault", e)
