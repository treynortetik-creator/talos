#!/usr/bin/env python3
"""
Talos pre-tool guard — a tripwire on the obvious dangerous shell moves. Not a sandbox.

WHY THIS EXISTS
---------------
The settings template denies the agent's Read tool on `.env`. That rule does nothing about
`cat .env` through Bash, and the kit says so honestly (CLAUDE.md section 9). This hook is the
other half: it runs before every Bash command and refuses the handful of moves that are never
right for an agent working on behalf of someone who is not an engineer:

  1. reading or copying a `.env` file            (secrets; `.env.example` is fine)
  2. recursive deletes                           (`rm -r`, `rm -rf`, `rm --recursive`)
  3. `git add -A` / `git add .` / `git add --all`  (sweeps secrets and the vault into history)
  4. force pushes, `git reset --hard`, `git clean -f`
  5. piping a download into a shell              (`curl … | sh`, `wget … | bash`)
  6. writing in the Mac app's folders            (~/Library/Application Support/app.talos.desktop and <Talos home>/auto-update: Write, Edit, MultiEdit,
                                                  NotebookEdit by path; Bash by what it writes). Reading there is fine.

Everything else is allowed. A refused command comes back to the agent with the reason, so it
can do the safe thing instead (name the paths, ask the user, use the Read tool).

WHAT IT IS NOT
--------------
It matches the command TEXT. A determined agent could go around it (`find … -delete`,
`python3 -c 'import shutil; shutil.rmtree(...)'`, a script that reads .env), and a crash in this
file fails OPEN in a live session (a non-blocking hook error lets the tool proceed) so a bug here can never
brick the agent, and fails CLOSED when the run is unattended (Chronos sets CHRONOS_RUN=1): there nobody would
ever notice the guard had stopped guarding. That is the trade: tripwire, not fence. The fence is the user not pasting secrets in.

LESSON BAKED IN (2026-08-30): patterns meant for one FIELD must be anchored to argument
position. A regex for `-r` run against the whole line matched `-r` inside folder names, and every
`rm` in a project whose folder name contained a hyphen-r word was reported as recursive. Flags
below require whitespace before them.

INSTALL: registered in .claude/settings.json under PreToolUse with matcher "Bash|Write|Edit|MultiEdit|NotebookEdit".

THE MAC APP'S FOLDERS (rule 6). The Talos Mac app keeps its git checkout in ~/Library/Application Support/app.talos.desktop/, and its
updater works in <Talos home>/auto-update/ ($TALOS_APP_HOME, else ~/.config/talos/app): the copy of auto-update-apply.sh that bash runs,
pending.json, check-now.json. The updater runs git in the checkout and then the checkout's install.sh, so an agent that could write the
checkout's .git/config (core.fsmonitor), a hook or a ref, or that copy of the script, would get its code run by the updater. The agent
may read the folders and never write them. The path is resolved (~, $HOME, relative names against the call's cwd, symlinks, .., and
macOS's /System/Volumes/Data spelling) and compared without case, because macOS disks are case-insensitive. A Bash command is judged
by what it WRITES: a redirect, rm/mv/tee/touch/chmod, any word of ln (a hard link writes through the other name), the last word of
cp/install/rsync or the folder of cp -t, sed -i, curl -o/-O and wget, tar/unzip into it, find -delete/-exec, git commands that change a
repository (also by GIT_DIR=, --git-dir=, --work-tree= or the folder they run in), any word of an interpreter. Same
tripwire-not-fence honesty as above: the write guard is the main protection for the updater's git path, and the sha256-pinned release
tarball (the archive checkout) is the real fix.
"""
import json, os, re, shlex, sys


def unattended():
    # Standalone on purpose: this guard imports nothing from the kit, so a broken helper file cannot disable it.
    # Same test as hooks/_talos_common.py unattended(): Chronos exports CHRONOS_RUN=1 into every headless run.
    return os.environ.get("CHRONOS_RUN") == "1" or os.environ.get("TALOS_UNATTENDED") == "1"

# The kit's own procedures delete their two staging directories when a crawl is done. That is the
# one recursive delete that is always right here, so it is allowed when it is the ONLY target and
# the path is exactly one of those two names (review 2026-09-02, B2: the seed's cleanup step was
# refused by this guard and the agent had to improvise).
ALLOW = [
    re.compile(r'^\s*rm\s+(?:-[a-zA-Z]+\s+)*(?:\./)?\.(?:seed|dive)-staging/?\s*$'),
    # BOOTSTRAP's own setup step: create the (empty-valued) .env from the shipped example. It copies a
    # template, it does not read a secret. Anything else that touches .env stays refused.
    re.compile(r'^\s*cp\s+(?:-n\s+)?(?:\./)?\.env\.example\s+(?:\./)?\.env\s*$'),
]

RULES = [
    # 1. .env reads/copies -- any .env token that is not .env.example, as its own argument
    (re.compile(r'(?<![\w.-])\.env(?:\.(?!example\b)[\w-]+)?(?![\w.-])'),
     "reads a .env file. Secrets stay out of the agent's hands: use the value's NAME in the "
     "skill and let the process read it from the environment."),
    # 2. recursive / forced rm -- flag anchored to whitespace, so paths cannot match
    (re.compile(r'(?:^|[\s;&|(])rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s|--recursive\b)'),
     "is a recursive delete. Delete named files one at a time, or ask the user."),
    # 3. sweeping git adds
    (re.compile(r'(?:^|[\s;&|(])git\s+add\s+(?:-A\b|--all\b|\.(?:\s|$)|-a\b)'),
     "is a sweeping `git add`. Name the paths (memory wiki .claude CLAUDE.md); this is how a "
     ".env or a personal vault ends up in history."),
    # 4. history-destroying git
    (re.compile(r'(?:^|[\s;&|(])git\s+(?:push\s+[^|;&]*(?:--force\b|-f\b)|reset\s+--hard\b|clean\s+-[a-zA-Z]*f)'),
     "rewrites or discards git history. Ask the user; there is no undo for the undo."),
    # 5. download piped into a shell
    (re.compile(r'\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b'),
     "pipes a download straight into a shell. Download it, show the user, then run it."),
]


APP_WHY = ("writes in a folder the Talos app's updater runs code from (~/Library/Application Support/app.talos.desktop, its git checkout, "
           "or auto-update in the Talos home). Only the app and the owner change them. You may read them; ask the user for any change.")
APP_REL = os.path.join("Library", "Application Support", "app.talos.desktop")
TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")
# verbs whose every non-option word is written, moved or removed / whose last word is the destination
TARGET_ALL = frozenset(("rm", "rmdir", "unlink", "shred", "truncate", "chmod", "chown", "touch", "tee", "mv", "patch"))
TARGET_LAST = frozenset(("cp", "ln", "install", "rsync"))
WRAPPERS = frozenset(("sudo", "env", "command", "time", "nohup", "exec", "nice", "xargs", "timeout", "caffeinate"))
INTERPRETERS = re.compile(r'^(?:python[\d.]*|node|ruby|perl|bun|deno|php|lua|osascript|sh|bash|zsh|dash|ksh)$')
GIT_MUTATES = frozenset(("checkout", "switch", "reset", "clean", "commit", "add", "rm", "mv", "config", "pull", "fetch", "merge",
                         "rebase", "restore", "stash", "apply", "am", "cherry-pick", "revert", "update-ref", "symbolic-ref",
                         "worktree", "gc", "prune", "init", "clone", "push", "submodule"))


DATA_VOLUME = "/system/volumes/data"   # macOS spells the data volume both ways


def _home():
    return os.environ.get("HOME") or os.path.expanduser("~")


def _app_dirs():
    """The folders the app's updater runs code from, as written and as they really are, lower-cased (a symlinked home, a
    case-insensitive disk): the app's own folder (its git checkout) and auto-update in the Talos home (the copied apply script,
    pending.json, check-now.json), where the Talos home is $TALOS_APP_HOME or ~/.config/talos/app."""
    h = _home()
    bases = [os.path.join(h, APP_REL),
             os.path.join(os.environ.get("TALOS_APP_HOME") or os.path.join(h, ".config", "talos", "app"), "auto-update"),
             os.path.join(h, ".config", "talos", "app", "auto-update")]
    out = set()
    for b in bases:
        for p in (b, os.path.realpath(b)):
            out.add(p.lower())
    return out


def _resolve(p, cwd):
    """A path as the file system would take it: ~ and $HOME written out, relative names against cwd, links and .. followed,
    lower-cased, and macOS's /System/Volumes/Data spelling folded into the plain one."""
    p = re.sub(r'^~(?=/|$)', _home(), p)
    p = re.sub(r'\$\{HOME\}|\$HOME\b', _home(), p)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    r = os.path.realpath(p).lower()
    return r[len(DATA_VOLUME):] if r.startswith(DATA_VOLUME + "/") else r


def _in_app(p, cwd):
    r = _resolve(p, cwd)
    return any(r == d or r.startswith(d + os.sep) for d in _app_dirs())


def _value(w):
    """The value of an --option=value or a VAR=value word (a path hides there), else the word."""
    m = re.match(r'^-{0,2}[A-Za-z_][\w-]*=(.*)$', w, re.S)
    return m.group(1) if m else w


def _flag_values(words, flags):
    out = []
    for k, w in enumerate(words):
        if w in flags and k + 1 < len(words):
            out.append(words[k + 1])
        for fl in flags:
            if fl.startswith("--") and w.startswith(fl + "="):
                out.append(w[len(fl) + 1:])
    return out


def tool_writes_app(tool_input, cwd):
    p = tool_input.get("file_path") or tool_input.get("notebook_path") or tool_input.get("path") or ""
    return bool(p) and _in_app(str(p), cwd)


def _segment_writes_app(words, assigns, cwd):
    head, args = os.path.basename(words[0]), [w for w in words[1:] if not w.startswith("-")]
    rest = words[1:]
    if head in TARGET_ALL or head == "ln":      # a link to or from the folder writes it through the other name: every word counts
        return any(_in_app(w, cwd) for w in args)
    if head in ("cp", "mv", "install") and any(w == "-t" or w.startswith("--target-directory") for w in rest):
        if any(_in_app(w, cwd) for w in _flag_values(rest, ("-t", "--target-directory"))):
            return True
    if head in TARGET_LAST and args:
        return _in_app(args[-1], cwd)
    if head in ("sed", "perl") and any(re.match(r'^-\S*i', w) for w in rest):
        return any(_in_app(w, cwd) for w in args)
    if head == "dd":
        return any(w.startswith("of=") and _in_app(w[3:], cwd) for w in rest)
    if head == "curl":
        named = _flag_values(rest, ("-o", "--output", "--output-dir"))
        if named:
            return any(_in_app(w, cwd) for w in named)
        return any(w in ("-O", "--remote-name") for w in rest) and _in_app(".", cwd)
    if head == "wget":
        named = _flag_values(rest, ("-O", "--output-document", "-P", "--directory-prefix"))
        return any(_in_app(w, cwd) for w in named) if named else _in_app(".", cwd)
    if head == "unzip":
        return any(_in_app(w, cwd) for w in _flag_values(rest, ("-d",)))
    if head == "tar":
        extracting = any(w == "--extract" or (re.match(r'^-?[A-Za-z]*x[A-Za-z]*$', w) and (k == 0 or w.startswith("-")))
                         for k, w in enumerate(rest))
        if extracting:
            dirs = _flag_values(rest, ("-C", "--directory"))
            return any(_in_app(w, cwd) for w in dirs) if dirs else _in_app(".", cwd)
        return False
    if head == "find":
        if any(re.match(r'^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$', w) for w in rest):
            return any(_in_app(w, cwd) for w in args)
        return False
    if head == "git":
        verb = next((w for w in rest if w in GIT_MUTATES), None)
        branchy = [w for w in rest if w in ("branch", "tag")]
        if branchy and not verb:
            after = rest[rest.index(branchy[0]) + 1:]
            if after and (after[0] in ("-d", "-D", "-m", "-M", "-f", "-c", "-C", "--delete", "--force", "--move", "--copy")
                          or not after[0].startswith("-")):
                verb = branchy[0]
        if verb:
            # a path anywhere: -C <it>, --git-dir=<it>, --work-tree=<it>, GIT_DIR=<it> before the command, a word, or the folder it runs in
            if any(_in_app(_value(w), cwd) for w in rest if "/" in w) or any(_in_app(_value(w), cwd) for w in assigns) \
                    or _in_app(cwd or ".", cwd):
                return True
        return False
    if INTERPRETERS.match(head):
        dirs = _app_dirs()
        return any(any(d in w.lower() for d in dirs) for w in rest)
    return False


def bash_writes_app(command, cwd):
    """True when the command writes in one of those folders. Reading them (cat, ls, grep, cp out of them, git log) is not refused."""
    dirs = _app_dirs()
    # a path with a space in it, written however the shell takes it: \ , quotes, ~ and $HOME written out
    flat = re.sub(r'\\(.)', r'\1', command).replace('"', '').replace("'", '')
    flat = re.sub(r'(^|[\s=:;|&(<>])~(?=$|[/\s:;|&)<>])', lambda m: m.group(1) + _home(), flat)
    flat = re.sub(r'\$\{HOME\}|\$HOME\b', _home(), flat).lower().replace(DATA_VOLUME + "/", "/")
    for d in dirs:
        if re.search(r'>>?\|?\s*' + re.escape(d), flat):          # a redirect into it, whatever its spelling
            return True
    for m in re.finditer(r'>>?\|?\s*("[^"]*"|\'[^\']*\'|[^\s;|&<>()]+)', command):   # ... or through a link, a relative name, ..
        if _in_app(m.group(1).strip('"\''), cwd):
            return True
    for seg in re.split(r'[;&|\n]+|\$\(|`', command):
        try:
            words = shlex.split(seg)
        except ValueError:
            words = seg.split()
        if words:
            words[0] = words[0].lstrip('(')
        assigns = []
        while words and (words[0] in WRAPPERS or re.match(r'^[A-Za-z_]\w*=', words[0])):
            if "=" in words[0]:
                assigns.append(words[0])
            words = words[1:]
        if not words:
            continue
        head, args = os.path.basename(words[0]), [w for w in words[1:] if not w.startswith("-")]
        if head in ("cd", "pushd") and args:
            cwd = os.path.realpath(os.path.join(cwd or ".", re.sub(r'^~(?=/|$)', _home(), args[0])))
            continue
        if _segment_writes_app(words, assigns, cwd):
            return True
        if INTERPRETERS.match(head) and any(any(d in _value(w).lower() for d in dirs) for w in assigns):
            return True
    return False


def check(command):
    if any(rx.match(command) for rx in ALLOW):
        return None
    for rx, why in RULES:
        if rx.search(command):
            return why
    return None


def arm_timeout(seconds=None):
    """A hook that outlives Claude Code's hook timeout is a non-blocking error (the command would run unchecked). Fire first: a
    timeout ASKS in a live session and is refused (exit 2) when unattended, and never allows. If the verdict cannot be written,
    exit 2. TALOS_GUARD_TIMEOUT_S overrides the 20 seconds (tests use 1)."""
    try:
        import signal
        secs = int(seconds or os.environ.get("TALOS_GUARD_TIMEOUT_S") or 20)

        def _fire(signum, frame):
            code = 2
            try:
                if unattended():
                    sys.stderr.write("Talos guard did not finish within %ds in an unattended run, so this command is blocked rather "
                                     "than allowed unchecked.\n" % secs)
                    sys.stderr.flush()
                else:
                    sys.stdout.write(json.dumps({"hookSpecificOutput": {
                        "hookEventName": "PreToolUse", "permissionDecision": "ask",
                        "permissionDecisionReason": "Talos pre-tool-guard timed out checking this command after %ds, so it asks "
                                                    "instead of letting it through." % secs}}) + "\n")
                    sys.stdout.flush()
                    code = 0
            except Exception:
                pass
            os._exit(code)
        signal.signal(signal.SIGALRM, _fire)
        signal.alarm(max(1, secs))
    except Exception:
        pass


def main():
    arm_timeout()
    try:
        payload = json.load(sys.stdin)
        tool = payload.get("tool_name")
        cwd = str(payload.get("cwd") or "") or os.getcwd()
        if tool in TOOLS:                                  # rule 6 by path: the file tools never reach the Bash rules
            if not tool_writes_app(payload.get("tool_input") or {}, cwd):
                return 0
            sys.stderr.write("Talos guard refused this %s: it %s\n" % (tool, APP_WHY))
            return 2
        if tool != "Bash":
            return 0
        cmd = str((payload.get("tool_input") or {}).get("command") or "")
        why = check(cmd)
        if why is None and bash_writes_app(cmd, cwd):
            why = APP_WHY
        if why is None:
            return 0
        sys.stderr.write("Talos guard refused this command: it %s\n" % why)
        return 2          # exit 2 = block, stderr goes back to the agent as the reason
    except Exception as e:
        if unattended():  # nobody is watching: an unchecked command is worse than a refused one
            sys.stderr.write("Talos guard hit an internal error (%s: %s) in an unattended run, so this command is blocked "
                             "rather than allowed unchecked.\n" % (type(e).__name__, str(e)[:160]))
            return 2
        return 0          # fail open in a live session: a broken guard must never brick the agent


if __name__ == "__main__":
    sys.exit(main())
