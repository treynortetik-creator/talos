#!/usr/bin/env python3
"""plugin-settings.py: the .claude/settings.json half of moving an agent onto the Talos plugin (and back).

    plugin-settings.py fresh      --agent DIR --template FILE --kit-home DIR
    plugin-settings.py to-plugin  --agent DIR --release DIR --kit-home DIR --migration ID
    plugin-settings.py from-plugin --agent DIR --migration ID
    plugin-settings.py reconcile  --agent DIR --old-release DIR --new-release DIR [--migration ID] [--dry-run]
    plugin-settings.py is-plugin  --agent DIR                 # exit 0 when settings.json already names the marketplace
    plugin-settings.py save-last-good --agent DIR             # exit 0 saved, 3 store not reachable

Used by install.sh (fresh) and by migrations/*-plugin-move.sh (to-plugin / from-plugin). Not for hand use.

What it changes in settings.json, and only that: two keys are added (extraKnownMarketplaces.talos-local, a local folder, and
enabledPlugins["talos@talos-local"]) and the commands of the OWNER's own hooks (a script in hooks/ that the release does not ship)
are pointed at custom/hooks/, in whatever spelling they were written ($CLAUDE_PROJECT_DIR/hooks/x, "$CLAUDE_PROJECT_DIR"/hooks/x,
${CLAUDE_PROJECT_DIR}/hooks/x, hooks/x, ./hooks/x, hooks/sub/x, ~/<agent>/hooks/x, $HOME/<agent>/hooks/x, <agent folder>/hooks/x), with PYTHONPATH set so the moved script still finds
_talos_common. The kit's own hook commands stay exactly as they are: they reach the active release through the hooks/ link, and
being fixed text they never change per release. (The plugin registers no hooks: a plugin that only project settings enable is
skipped in a folder nobody trusted, which `claude -p` runs in, so guards must live here.) Permissions, statusLine, env, Chronos's
absolute-path hook and every other key stay as they are.

Before changing the file it keeps a copy next to it (<file>.bak-<migration id>) and prints a line; if the Talos app's
restore-last-good store is reachable ($TALOS_APP_HOME/last-good exists) it also saves a version there, in the format
apps/bridge/src/last-good.ts reads. The reverse is exact: when settings.json is still what to-plugin wrote, the original bytes
come back; if the owner has edited it since, only Talos's own changes are undone and the rest is kept (a .bak of that file is
kept too). Python 3.9, standard library only.
"""
import argparse
import copy
import datetime
import hashlib
import json
import os
import re
import shutil
import sys

PLUGIN_KEY = "talos@talos-local"
MARKETPLACE = "talos-local"
STATE_DIR = ".talos-pre-plugin"
STATE_FILE = "plugin-move.json"
PYPATH = 'export PYTHONPATH="$CLAUDE_PROJECT_DIR/hooks${PYTHONPATH:+:$PYTHONPATH}"; '
SETTINGS = os.path.join(".claude", "settings.json")


def sha(b):
    return hashlib.sha256(b).hexdigest()


def render(d):
    return (json.dumps(d, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def load(path):
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    if not isinstance(d, dict):
        raise SystemExit("plugin-settings: %s is not a JSON object; nothing was changed" % path)
    return d


def write_atomic(path, data, mode=None):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(data)
    if mode is not None:
        os.chmod(tmp, mode)
    os.replace(tmp, path)


def backup(path, mig, suffix=""):
    """Keep the file's current bytes as <path>.bak-<id>[suffix] (once) and say so. The migration runner checks this."""
    bak = "%s.bak-%s%s" % (path, mig, suffix)
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
    print("migrate: %s touches %s (outside the Talos zone); the original is kept as %s" % (
        mig, os.path.relpath(path, os.path.dirname(os.path.dirname(path))), os.path.basename(bak)))
    return bak


def market_entry(kit_home):
    return {"source": {"source": "directory", "path": os.path.abspath(kit_home)}}


def release_hook_scripts(release):
    d = os.path.join(release, "hooks")
    return {n for n in os.listdir(d) if re.fullmatch(r"[A-Za-z0-9_.-]+\.(py|sh)", n)} if os.path.isdir(d) else set()


# --------------------------------------------------------------------------- settings transforms
def with_plugin_keys(cfg, kit_home):
    """Add the marketplace and the enabled plugin. Returns (what the keys held before, for the reverse)."""
    prev = {"marketplace": copy.deepcopy((cfg.get("extraKnownMarketplaces") or {}).get(MARKETPLACE)),
            "enabled": (cfg.get("enabledPlugins") or {}).get(PLUGIN_KEY)}
    cur = prev["marketplace"]
    same = (isinstance(cur, dict) and isinstance(cur.get("source"), dict) and cur["source"].get("source") == "directory"
            and isinstance(cur["source"].get("path"), str) and os.path.realpath(cur["source"]["path"]) == os.path.realpath(kit_home))
    if not same:        # the same folder reached through a symlink is the same marketplace: leave the entry as it is
        cfg.setdefault("extraKnownMarketplaces", {})[MARKETPLACE] = market_entry(kit_home)
    cfg.setdefault("enabledPlugins", {})[PLUGIN_KEY] = True
    return prev


def hook_ref_re(agent):
    """A reference to <agent>/hooks/<script>, in any spelling a settings.json command can use: $CLAUDE_PROJECT_DIR/hooks/x,
    "$CLAUDE_PROJECT_DIR"/hooks/x, ${CLAUDE_PROJECT_DIR}/hooks/x, the agent folder's absolute path (as given or resolved), or a
    relative hooks/x (not preceded by a path character, so custom/hooks/x and other-folder/hooks/x are not matched)."""
    paths = sorted({os.path.abspath(agent), os.path.realpath(agent)}, key=len, reverse=True)
    homes = []                  # the agent folder as ~/x and $HOME/x, when it is under the home folder
    for h in {os.path.abspath(os.path.expanduser("~")), os.path.realpath(os.path.expanduser("~"))}:
        for p in paths:
            if p.startswith(h.rstrip("/") + "/"):
                homes.append(p[len(h.rstrip("/")) + 1:])
    homes = sorted(set(homes), key=len, reverse=True)
    alts = [r'"?\$\{?CLAUDE_PROJECT_DIR\}?"?/', "(?:%s)/" % "|".join(re.escape(p) for p in paths)]
    if homes:
        alts.append(r'(?:~|"?\$\{?HOME\}?"?)/(?:%s)/' % "|".join(re.escape(p) for p in homes))
    alts.append(r"(?<![\w./$}~-])\./")
    alts.append(r"(?<![\w./$}~-])")
    return re.compile(r"(?P<pre>%s)hooks/(?P<name>(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:py|sh))" % "|".join(alts))


def move_owner_hooks(cfg, scripts, agent):
    """Point the owner's own hook commands (a script the release does not ship) at custom/hooks/. The kit's own commands are
    not touched. Returns [{event, entry, hook, old, new}] for the reverse."""
    rewritten = []
    ref = hook_ref_re(agent)
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        return rewritten
    for event, entries in hooks.items():
        for ei, entry in enumerate(entries if isinstance(entries, list) else []):
            hl = entry.get("hooks") if isinstance(entry, dict) else None
            for hi, h in enumerate(hl if isinstance(hl, list) else []):
                cmd = h.get("command") if isinstance(h, dict) else None
                if not isinstance(cmd, str):
                    continue
                owner = [m for m in ref.finditer(cmd) if m.group("name") not in scripts]
                if not owner:
                    continue
                new = ref.sub(lambda m: m.group(0) if m.group("name") in scripts else m.group("pre") + "custom/hooks/" + m.group("name"), cmd)
                if any(m.group("name").endswith(".py") for m in owner):
                    new = PYPATH + new
                rewritten.append({"event": event, "entry": ei, "hook": hi, "old": cmd, "new": new})
                h["command"] = new
    return rewritten


def restore_kit_hooks(cfg, removed, rewritten):
    for r in rewritten:                      # owner hook commands back to hooks/ (found by command: entry numbers shifted)
        for entries in (cfg.get("hooks") or {}).values():
            for e in entries if isinstance(entries, list) else []:
                for h in (e.get("hooks") or []) if isinstance(e, dict) else []:
                    if isinstance(h, dict) and h.get("command") == r["new"]:
                        h["command"] = r["old"]
    for r in sorted(removed, key=lambda x: x["entry"]):
        lst = cfg.setdefault("hooks", {}).setdefault(r["event"], [])
        if r["whole"]:
            lst.insert(min(r["entry"], len(lst)), copy.deepcopy(r["value"]))
            continue
        for e in lst:
            if isinstance(e, dict) and e.get("matcher") == r["matcher"] and isinstance(e.get("hooks"), list):
                e["hooks"] = copy.deepcopy(r["value"]) + e["hooks"]
                break
        else:
            lst.insert(min(r["entry"], len(lst)), {"matcher": r["matcher"], "hooks": copy.deepcopy(r["value"])})


def without_plugin_keys(cfg, prev):
    mk = cfg.get("extraKnownMarketplaces")
    if isinstance(mk, dict):
        if prev.get("marketplace") is None:
            mk.pop(MARKETPLACE, None)
        else:
            mk[MARKETPLACE] = prev["marketplace"]
        if not mk:
            del cfg["extraKnownMarketplaces"]
    en = cfg.get("enabledPlugins")
    if isinstance(en, dict):
        if prev.get("enabled") is None:
            en.pop(PLUGIN_KEY, None)
        else:
            en[PLUGIN_KEY] = prev["enabled"]
        if not en:
            del cfg["enabledPlugins"]


# --------------------------------------------------------------------------- last-good store (apps/bridge/src/last-good.ts)
LAST_GOOD_FILES = (".mcp.json", ".claude/settings.json", ".claude/settings.local.json")


def last_good_dir():
    home = os.environ.get("TALOS_APP_HOME") or os.path.expanduser("~/.config/talos/app")
    return os.path.join(home, "last-good")


def save_last_good(agent):
    """Save the agent's setup files as a new version in the Talos app's restore-last-good store. Returns its name, or None
    when the store is not reachable (the bridge has never run here: no last-good folder) or nothing could be saved."""
    d = last_good_dir()
    if not os.path.isdir(d):
        return None
    files = {}
    for rel in LAST_GOOD_FILES:
        p = os.path.join(agent, rel)
        try:
            if os.path.isfile(p) and os.path.getsize(p) <= 1024 * 1024:
                text = open(p, encoding="utf-8").read()
                if isinstance(json.loads(text), dict):
                    files[rel] = text
        except Exception:
            continue
    if not files:
        return None
    names = [n for n in os.listdir(d) if re.fullmatch(r"\d{8}T\d{9}Z", n)]
    ms = int(datetime.datetime.now(datetime.timezone.utc).timestamp() * 1000)
    if names:
        t = max(datetime.datetime.strptime(n[:-4], "%Y%m%dT%H%M%S").replace(tzinfo=datetime.timezone.utc).timestamp() * 1000 + int(n[-4:-1])
                for n in names)
        ms = max(ms, int(t) + 1)
    when = datetime.datetime.fromtimestamp(ms / 1000, datetime.timezone.utc)
    name = when.strftime("%Y%m%dT%H%M%S") + "%03dZ" % (ms % 1000)
    tmp = os.path.join(d, ".tmp-plugin-move-%d" % os.getpid())
    shutil.rmtree(tmp, ignore_errors=True)
    for rel, text in files.items():
        os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
        fd = os.open(os.path.join(tmp, rel), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
    meta = {"v": 1, "agent_dir": agent, "saved_at": when.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (ms % 1000),
            "files": [r for r in LAST_GOOD_FILES if r in files], "source": "start"}
    fd = os.open(os.path.join(tmp, "meta.json"), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(meta, indent=2) + "\n")
    os.rename(tmp, os.path.join(d, name))
    return name


# --------------------------------------------------------------------------- commands
def cmd_fresh(a):
    tmpl = load(a.template)
    cfg = copy.deepcopy(tmpl)       # the hooks are registered here, not by the plugin (see the top of this file)
    with_plugin_keys(cfg, a.kit_home)
    os.makedirs(os.path.join(a.agent, ".claude"), exist_ok=True)
    write_atomic(os.path.join(a.agent, SETTINGS), render(cfg))


def record_is_current(state_path, cfg, before):
    """True when plugin-move.json already describes the move this call would make: it is there, and either settings.json is
    already moved or still holds the bytes the record was made from (a crash between the two writes). A record is never
    replaced by a later up: it holds the ORIGINAL file, and a second up only sees the already-moved one."""
    try:
        with open(state_path, encoding="utf-8") as fh:
            st = json.load(fh)
    except Exception:
        return False
    if MARKETPLACE in (cfg.get("extraKnownMarketplaces") or {}):
        return True
    if before is None:
        return not st.get("settings_existed")
    return st.get("original_sha256") == sha(before)


def cmd_to_plugin(a):
    agent = os.path.abspath(a.agent)
    path = os.path.join(agent, SETTINGS)
    state_path = os.path.join(agent, STATE_DIR, STATE_FILE)
    scripts = release_hook_scripts(a.release)
    if os.path.exists(path):
        cfg = load(path)
        before = open(path, "rb").read()
    else:
        cfg, before = {}, None
    new = copy.deepcopy(cfg)
    rewritten = move_owner_hooks(new, scripts, agent)
    prev = with_plugin_keys(new, a.kit_home)
    if before is not None and new == cfg:
        print("plugin-move: settings.json already names the plugin and has no owner hooks to move; unchanged")
        return
    name = save_last_good(agent)
    if name:
        print("plugin-move: saved the current setup in the restore-last-good store (version %s)" % name)
    else:
        print("plugin-move: the restore-last-good store is not reachable here; the .bak next to settings.json is the saved copy")
    after = render(new)
    if before is not None:
        backup(path, a.migration)
    else:
        print("migrate: %s creates %s (outside the Talos zone)" % (a.migration, SETTINGS))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # The record first (atomic), then settings.json: a crash between the two leaves a record of a move that has not happened,
    # which the re-run recognises (record_is_current), never a moved settings.json that nothing can undo.
    if not record_is_current(state_path, cfg, before):
        os.makedirs(os.path.dirname(state_path), exist_ok=True)
        write_atomic(state_path, (json.dumps({
            "v": 1, "migration": a.migration, "settings_existed": before is not None,
            "original_sha256": sha(before) if before is not None else None, "after_sha256": sha(after),
            "removed_hooks": [], "rewritten_hooks": rewritten, "previous": prev}, indent=2) + "\n").encode("utf-8"))
    write_atomic(path, after, os.stat(path).st_mode & 0o777 if before is not None else None)
    print("plugin-move: settings.json: moved %d owner hook command%s to custom/hooks, added the %s marketplace and enabled %s" % (
        len(rewritten), "" if len(rewritten) == 1 else "s", MARKETPLACE, PLUGIN_KEY))


def cmd_from_plugin(a):
    agent = os.path.abspath(a.agent)
    path = os.path.join(agent, SETTINGS)
    state_path = os.path.join(agent, STATE_DIR, STATE_FILE)
    if not os.path.exists(state_path):
        print("plugin-move: no record of a plugin-move in %s; settings.json left as it is" % STATE_DIR)
        return
    st = json.load(open(state_path, encoding="utf-8"))
    mig = a.migration
    if os.path.exists(path):
        cur = open(path, "rb").read()
        if st.get("settings_existed") and sha(cur) == st["original_sha256"]:
            # A re-run after a crash between writing the original bytes back and removing the record (the migration removes it
            # next). The file is already right: do not parse and re-render it (that changes its bytes), and say what is true.
            print("plugin-move: settings.json is already back to its original bytes; nothing to do")
            return
        if sha(cur) == st["after_sha256"] and st.get("settings_existed"):
            bak = "%s.bak-%s" % (path, st["migration"])
            if os.path.exists(bak) and sha(open(bak, "rb").read()) == st["original_sha256"]:
                backup(path, mig, "-down")
                write_atomic(path, open(bak, "rb").read(), os.stat(path).st_mode & 0o777)
                print("plugin-move: settings.json is back to its original bytes")
                return
        cfg = json.loads(cur.decode("utf-8"))
        backup(path, mig, "-down")
        restore_kit_hooks(cfg, st.get("removed_hooks") or [], st.get("rewritten_hooks") or [])
        without_plugin_keys(cfg, st["previous"])
        if not st.get("settings_existed") and not cfg:
            os.remove(path)
            print("plugin-move: removed the settings.json the move had created")
        else:
            write_atomic(path, render(cfg), os.stat(path).st_mode & 0o777)
            print("plugin-move: settings.json had changed since the move, so only Talos's own changes were undone")
    else:
        print("plugin-move: settings.json is gone; nothing to restore")


# --------------------------------------------------------------------------- reconcile: each release's hook list (R2-6)
KIT_HOOK = re.compile(r"\$\{?CLAUDE_PROJECT_DIR\}?\"?/hooks/([A-Za-z0-9_.-]+\.(?:py|sh))")


def _kit_script(hook):
    cmd = hook.get("command") if isinstance(hook, dict) else None
    m = KIT_HOOK.search(cmd) if isinstance(cmd, str) else None
    return m.group(1) if m else None


def flat_hooks(hooks):
    """[(key, entry, index, hook)] for every hook command that runs a kit script; key = (event, matcher, script, nth)."""
    out, seen = [], {}
    for event, entries in (hooks.items() if isinstance(hooks, dict) else []):
        for entry in entries if isinstance(entries, list) else []:
            hl = entry.get("hooks") if isinstance(entry, dict) else None
            for i, h in enumerate(hl if isinstance(hl, list) else []):
                script = _kit_script(h)
                if script is None:
                    continue
                base = (event, entry.get("matcher"), script)
                n = seen.get(base, 0)
                seen[base] = n + 1
                out.append((base + (n,), entry, i, h))
    return out


def reconcile_hooks(cfg, old_hooks, new_hooks):
    """Make the kit's hook entries in cfg match `new_hooks` (the release's template), three-way against `old_hooks` (the release
    the agent ran until now). Only hook commands that run a kit script ($CLAUDE_PROJECT_DIR/hooks/<name>) are ever touched.
      * in the new list, not in the file:    added, unless the old list had it (the owner removed it: stays removed)
      * in both, same command:               nothing
      * in both, file still equals the old:  command replaced by the new one (renamed, new flags)
      * in both, file differs from the old:  the owner edited it: kept, reported
      * in the old list, not in the new:     removed, unless the file differs from the old one (the owner edited it: kept)
    Returns the report lines; cfg is changed in place."""
    lines, touched = [], set()
    old = {k: h for k, _, _, h in flat_hooks(old_hooks)}
    new_flat = flat_hooks(new_hooks)
    new = {k: h for k, _, _, h in new_flat}
    have = {k: (e, i, h) for k, e, i, h in flat_hooks(cfg.get("hooks"))}
    hooks = cfg.get("hooks")
    if not isinstance(hooks, dict):
        hooks = cfg["hooks"] = {}
    for key, tentry, _, th in new_flat:
        event, matcher, script, _ = key
        if key in have:
            entry, i, cur = have[key]
            if cur == th:
                continue
            if key in old and cur == old[key]:
                entry["hooks"][i] = copy.deepcopy(th)
                lines.append("reconcile: %s %s: updated to this release's command" % (event, script))
            else:
                lines.append("reconcile: %s %s: kept your edit (this release's command differs)" % (event, script))
        elif key in old:
            lines.append("reconcile: %s %s: kept your removal (not put back)" % (event, script))
        else:
            ne = {k: copy.deepcopy(v) for k, v in tentry.items() if k != "hooks"}
            ne["hooks"] = [copy.deepcopy(th)]
            lst = hooks.setdefault(event, [])
            if not isinstance(lst, list):
                lines.append("reconcile: %s is not a list in settings.json; %s was not added" % (event, script))
                continue
            at = len(lst)                       # keep the template's order: before the next kit entry that follows it there
            for k2, _, _, _ in new_flat:
                if k2[0] == event and new_flat.index(next(x for x in new_flat if x[0] == k2)) > new_flat.index(next(x for x in new_flat if x[0] == key)) \
                        and k2 in have and any(e is have[k2][0] for e in lst):
                    at = next(n for n, e in enumerate(lst) if e is have[k2][0])
                    break
            lst.insert(at, ne)
            lines.append("reconcile: %s %s: added" % (event, script))
    for key, oh in old.items():
        if key in new or key not in have:
            continue
        entry, i, cur = have[key]
        if cur == oh:
            entry["hooks"][i] = None
            touched.add(key[0])
            lines.append("reconcile: %s %s: removed (this release no longer ships it)" % (key[0], key[2]))
        else:
            lines.append("reconcile: %s %s: kept your edit (this release no longer ships it)" % (key[0], key[2]))
    for event in touched:        # only events this call removed something from: drop the entries and events that are now empty
        lst = hooks.get(event)
        if not isinstance(lst, list):
            continue
        for e in lst:
            if isinstance(e, dict) and isinstance(e.get("hooks"), list):
                e["hooks"] = [h for h in e["hooks"] if h is not None]
        hooks[event] = [e for e in lst if not (isinstance(e, dict) and e.get("hooks") == [])]
        if not hooks[event]:
            del hooks[event]
    return lines


def _indent_of(text):
    m = re.search(r"^( +)\S", text, re.M)
    return len(m.group(1)) if m else 2


def release_version_of(release):
    try:
        return open(os.path.join(release, "VERSION"), encoding="utf-8").read().strip() or "unknown"
    except OSError:
        return "unknown"


def template_hooks_of(release):
    p = os.path.join(release, "templates", "dot-claude", "settings.json")
    try:
        with open(p, encoding="utf-8") as fh:
            d = json.load(fh)
        return d.get("hooks") or {}, None
    except FileNotFoundError:
        return {}, "no settings template"
    except ValueError as e:
        return {}, "its settings template is not valid JSON (%s)" % e


def cmd_reconcile(a):
    agent = os.path.abspath(a.agent)
    path = os.path.join(agent, SETTINGS)
    new_hooks, bad = template_hooks_of(a.new_release)
    if bad:
        raise SystemExit("plugin-settings: the new release has %s; nothing was changed" % bad)
    old_hooks, _ = template_hooks_of(a.old_release)
    if not os.path.exists(path):
        print("reconcile: there is no settings.json in %s; nothing to reconcile" % agent)
        return
    try:
        raw = open(path, "rb").read()
        cfg = json.loads(raw.decode("utf-8"))
    except ValueError as e:
        raise SystemExit("plugin-settings: %s is not valid JSON (%s); it was left alone" % (path, e))
    if not isinstance(cfg, dict):
        raise SystemExit("plugin-settings: %s is not a JSON object; it was left alone" % path)
    new = copy.deepcopy(cfg)
    lines = reconcile_hooks(new, old_hooks, new_hooks)
    if new == cfg:
        for l in lines:
            print(l)
        print("reconcile: settings.json already matches this release's hook list")
        return
    for l in lines:
        print(l)
    if a.dry_run:
        print("reconcile: dry run; settings.json was not written")
        return
    mig = a.migration if a.migration != "manual" else "update-%s-to-%s" % (release_version_of(a.old_release), release_version_of(a.new_release))
    name = save_last_good(agent)
    if name:
        print("reconcile: saved the current setup in the restore-last-good store (version %s)" % name)
    backup(path, mig)
    write_atomic(path, (json.dumps(new, indent=_indent_of(raw.decode("utf-8")), ensure_ascii=False) + "\n").encode("utf-8"), os.stat(path).st_mode & 0o777)
    print("reconcile: settings.json hook list now matches release %s" % release_version_of(a.new_release))


def cmd_is_plugin(a):
    p = os.path.join(a.agent, SETTINGS)
    try:
        cfg = load(p)
    except Exception:
        sys.exit(1)
    sys.exit(0 if MARKETPLACE in (cfg.get("extraKnownMarketplaces") or {}) and (cfg.get("enabledPlugins") or {}).get(PLUGIN_KEY) else 1)


def cmd_save_last_good(a):
    name = save_last_good(os.path.abspath(a.agent))
    if name:
        print(name)
    sys.exit(0 if name else 3)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=["fresh", "to-plugin", "from-plugin", "is-plugin", "save-last-good", "reconcile"])
    ap.add_argument("--agent", required=True)
    ap.add_argument("--template")
    ap.add_argument("--old-release")
    ap.add_argument("--new-release")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--release")
    ap.add_argument("--kit-home")
    ap.add_argument("--migration", default="manual")
    a = ap.parse_args()
    {"fresh": cmd_fresh, "to-plugin": cmd_to_plugin, "from-plugin": cmd_from_plugin, "is-plugin": cmd_is_plugin,
     "save-last-good": cmd_save_last_good, "reconcile": cmd_reconcile}[a.cmd](a)
    return 0


if __name__ == "__main__":
    sys.exit(main())
