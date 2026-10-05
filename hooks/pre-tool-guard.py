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

Everything else is allowed. A refused command comes back to the agent with the reason, so it
can do the safe thing instead (name the paths, ask the user, use the Read tool).

WHAT IT IS NOT
--------------
It matches the command TEXT. A determined agent could go around it (`find … -delete`,
`python3 -c 'import shutil; shutil.rmtree(...)'`, a script that reads .env), and a crash in this
file fails OPEN (a non-blocking hook error lets the tool proceed) so a bug here can never brick
the agent. That is the trade: tripwire, not fence. The fence is the user not pasting secrets in.

LESSON BAKED IN (2026-08-30): patterns meant for one FIELD must be anchored to argument
position. A regex for `-r` run against the whole line matched `-r` inside folder names, and every
`rm` in a project whose folder name contained a hyphen-r word was reported as recursive. Flags
below require whitespace before them.

INSTALL: registered in .claude/settings.json under PreToolUse with matcher "Bash".
"""
import json, re, sys

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


def check(command):
    if any(rx.match(command) for rx in ALLOW):
        return None
    for rx, why in RULES:
        if rx.search(command):
            return why
    return None


def main():
    try:
        payload = json.load(sys.stdin)
        if payload.get("tool_name") != "Bash":
            return 0
        cmd = str((payload.get("tool_input") or {}).get("command") or "")
        why = check(cmd)
        if why is None:
            return 0
        sys.stderr.write("Talos guard refused this command: it %s\n" % why)
        return 2          # exit 2 = block, stderr goes back to the agent as the reason
    except Exception:
        return 0          # fail open: a broken guard must never brick the agent


if __name__ == "__main__":
    sys.exit(main())
