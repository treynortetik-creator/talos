# UPGRADE — instructions for the agent

**You are a Claude Code agent. The person who started you is already running an agent from
an older version of this kit, and wants the new one without losing what you remember. This
file is your procedure.**

Work through it in order. Confirm each step before moving on. Talk to them like a person —
they have a working agent and something is about to be written over. Say what you are doing
before you do it.

> **If they have NO agent yet, you are in the wrong file.** That is `BOOTSTRAP.md`, and this
> procedure will refuse to run against an empty folder.

---

## What an upgrade actually is

You update the clone (`git pull` in the folder you ran `./install.sh` from), then this procedure carries
the new code into the agent folder. `./install.sh` is for first installs and refuses a folder that already
has `.talos-version`. Two halves, and the whole job is keeping them apart:

- **CODE** — hooks, scripts, templates, the docs. Replaced wholesale. This is what they are
  upgrading *for*.
- **THEIR DATA** — `memory/`, the wiki notes, their edited `CLAUDE.md`, `.env`,
  `.claude/settings.json`, `.learnings/`. Never written. Not merged, not
  "carefully updated." Not touched.

The boundary is a file: **`.upgradeignore` at the root of the new kit.** It is the same
gitignore-style idiom, and it lists what an upgrade must never overwrite.
Everything it does not name is code. Read it — it explains its own hard cases — and do not
improvise around it.

🔴 **Both ways of getting this wrong are silent.**

- A plain copy that refuses to overwrite (`cp -n`, which is also the by-hand fallback in a first
  install; `install.sh` itself uses a tar pipe into an empty folder) keeps any file that already exists. Point an old agent at a new kit that way and they keep every old hook,
  receive none of the fixes, and are told it worked.
- "Just copy it all over" destroys months of accumulated notes in about a second.

Neither prints an error. That is why this is a script and a checklist rather than judgement.

---

## Step 0 — Orient (touch nothing yet)

1. **`python3 --version`.** The hooks and the linter are Python and the upgrade's own tooling
   is Python. If it errors, stop and send them to `xcode-select --install` (15-40 minutes on a
   work network, and it looks frozen the whole time). Everything below would appear to work
   and leave them with a dead hook.

2. **Find the two folders and say them out loud.**
   - the **new kit**: the updated clone (`git pull` first), containing `BOOTSTRAP.md` and
     `scripts/upgrade.sh`.
   - their **agent folder**: the one with their `memory/` and `wiki/` in it.

   🔴 **If those are the same folder, stop.** Copying the new kit *on top of* the running agent is
   the most destructive way to start. If it has already happened, go to "If the new kit was already
   copied over the agent" at the bottom.

3. **`pwd` on the agent folder.** If the path contains `CloudStorage`, `Google Drive`,
   `OneDrive` or `Dropbox`, say so before writing: a sync client mid-upgrade can resurrect
   half the old files an hour later. Pausing sync for ten minutes is the fix.

**Write nothing yet.**

---

## Step 1 — Find out what they are running

```bash
cat "<agent folder>/.talos-version"
```

- **The file exists** → it names the version, the commit it was installed from (`source_commit`), and
  when it was installed. Tell them the jump: *"you are on 1.0.0, this is 1.2.0."*
- 🔴 **The file does not exist** → **this is normal and it is not a fault.** Nothing before
  1.0.0 stamped a version, so every agent installed before then is unstamped, including the
  first one anybody outside this project ever ran. Say exactly that, because "your install is
  missing a file" is the wrong thing for them to hear about their working agent. The upgrade
  handles it and writes the stamp on the way out.

Do not try to reconstruct the old version from file dates or by diffing. It does not change
what the upgrade does, and a confident wrong answer is worse than "unstamped, pre-1.0.0."

---

## Step 2 — Read the plan before anything is written

```bash
bash "<new kit>/scripts/upgrade.sh" --into "<agent folder>" --dry-run
```

This writes nothing. It prints five lists and you must actually read them:

| Section | What it means | What to do |
|---|---|---|
| **NEW** | files this kit adds | nothing — expected |
| **UPDATED** | code that changes | skim it. Recognise the fixes they came for. |
| **PROTECTED** | matched `.upgradeignore`; never written | this is their data. Check their notes are in it. |
| **ONLY IN YOUR FOLDER** | in their folder, not in the kit | 🔴 read this one properly, see step 3 |
| **HOOKS TO RECONCILE** | hooks the kit registers that their settings do not | 🔴 step 6 |

🔴 **If `PROTECTED` is 0, or does not include `memory/` and their wiki notes, STOP.** Either
`.upgradeignore` is missing from the new kit or you are pointed at the wrong folder. Do not
continue and do not "fix" it by hand — an upgrade that thinks the user owns nothing is one
command away from proving it.

Show them the counts in one line. Do not paste the whole plan into the chat unless they ask.

---

## Step 3 — Deal with what is only in their folder

The upgrade **never deletes anything** — not one path, ever. So anything the new kit stopped
shipping stays where it is, and gets listed instead. Two kinds show up:

- **Theirs.** Notes, exports, an archive they downloaded, a folder they made. Leave it. Say
  nothing beyond "these are yours, untouched."
- **Ours, from an older release.** Early builds shipped files this kit no longer has, for example
  `hooks/job-inbox.py` and the `.agent-state/` mailbox from the pre-CLI design (see "Coming from the
  Desktop-app era" below). They are dead weight now.

🔴 **Order matters for hooks.** If a stale file is one that `.claude/settings.json` still registers as a
hook, remove that **registration first** and delete the file **second**. A hook whose script is missing makes
`python3` exit 2, and a `UserPromptSubmit` or `PreToolUse` hook that exits 2 **blocks every prompt or every
Bash call**. (The hook commands this kit ships now fail open when their file is missing; an old registration
does not.) `upgrade.sh` lists these under `HOOKS TO RECONCILE` as `STALE`.

**Offer to delete the second kind, one file at a time, and never delete anything without a
yes.** A pruning step that guesses is how an upgrade eats a file somebody wrote that happens
to resemble one we stopped shipping.

---

## Step 4 — Back up. This step is not optional and it is not skippable.

`upgrade.sh` takes a full copy before it writes a single byte, with no flag to turn that off,
and refuses to continue if the copy comes back short. You do not have to do anything for this
— but you do have to **tell them where it went and what the undo command is**, in that
message, before you run the upgrade. A backup nobody can find is not a backup.

If their folder is a git repo, the script also commits a pre-upgrade snapshot. Both, not
either: git is undo, the copy is what survives a bad git.

---

## Step 5 — Run it

```bash
bash "<new kit>/scripts/upgrade.sh" --into "<agent folder>"
```

In order, it: backs up → writes only the NEW and UPDATED files → **re-reads the bytes on disk
and proves every protected file is byte-for-byte what it was**, using a second pass that
shares no code with the one that did the writing → stamps `.talos-version` → runs the gate.

If it stops with `PROTECTED FILES WERE CHANGED`, that is a bug in the kit and not in their
folder. Roll back (step 8), tell them plainly that the upgrade was defective and their data is
intact, and report it. Do not attempt a repair.

---

## Step 6 — Reconcile the hooks by hand

🔴 **This is the step that is easy to skip and expensive to skip.**

`.claude/settings.json` is protected, because it holds permission grants they have built up
over months and cannot reconstruct. The price of that protection is that a **new hook can ship
and never be registered** — the silent no-op, back by another door.

So `upgrade.sh` prints a `HOOKS TO RECONCILE` section naming every hook the new kit registers
that their settings.json does not. If it lists anything:

1. Open `<new kit>/templates/dot-claude/settings.json` and their `.claude/settings.json`.
2. Merge the missing **hooks** entries into theirs. **Keep their `permissions` block exactly
   as it is** — that is the part that is theirs.
3. ⚠️ **Do not retype the JSON from memory or from a comment.** Copy the block. A dropped
   brace here half-breaks the continuity layer and nothing says so.
4. `python3 -m json.tool "<agent folder>/.claude/settings.json" >/dev/null` must succeed.
5. If the new kit added hook *files* that need to be executable:
   `chmod +x "<agent folder>"/hooks/*.py`

Then re-run `bash scripts/verify-install.sh` in their folder — it fails if the pre-tool guard is
unregistered, which is the check that catches a merge you thought you did.

**New jobs.** If the new kit ships a job the old one did not, `python3 scripts/talos-jobs.py register
--agent-dir "<agent folder>" --kit-dir "<new kit>"` adds it to Chronos, disabled. Jobs that already exist,
and any prompt the user edited, are never overwritten. **The upgrade never touches Chronos itself.** To
move Chronos to a newer commit, bump `CHRONOS_PINNED_REF` in `install.sh` after testing, or pull the
vendored clone by hand.

**A worked example.** An agent installed from a kit that predates the pre-tool guard gets the new code, the
gate goes green (the new code is sound), and `verify-install.sh` reports exactly one failure: guard
unregistered. That is this step's work, not a fault of the upgrade. Do the merge, re-run, and it clears.

---

## Step 7 — The gate: every check green, or roll back

```bash
cd "<agent folder>" && bash scripts/self-test.sh
```

`upgrade.sh` already ran this. Run it again yourself after the hook merge, and read the last
line.

- **`ALL <n> CHECKS PASSED`** (the number grows as the suite does) → the code you
  just installed works in their folder. Done.
- **Anything else** → 🔴 **roll back.** Not "investigate first," not "probably fine." They
  have a working agent and a backup taken four minutes ago; the cost of rolling back is
  nothing and the cost of leaving a half-upgraded agent in place is a week of strange
  behaviour they will not connect to today.

**One thing this is not:** `verify-install.sh` is a *report*, not the gate. It grades **their
setup**, which can be legitimately incomplete — an interview that never finished, an empty
wiki — without anything being wrong with the new code. Read its output to them, do not roll
back on it, and if it fails, fix the setup afterwards using `BOOTSTRAP.md`.

---

## Step 8 — Rolling back

```bash
bash "<new kit>/scripts/upgrade.sh" --rollback "<the backup folder>" --into "<agent folder>"
```

It restores every file the upgrade changed and removes every file the upgrade added, using the
receipt written into the backup. **It does not touch their data at all**, because the upgrade
never did either. The full pre-upgrade copy stays in the backup folder afterwards; tell them
they can delete it once they are happy.

---

## Step 9 — Report the diff, then close out

Give them a short, specific summary. Not "the upgrade succeeded":

- version: `<old or "unstamped">` → `<new>`
- **what changed for them.** Name the two or three fixes in this release that they will
  actually notice, in their words, not the changelog's.
- files added / files updated / files protected — the counts from the plan
- anything left on their plate: hooks merged (or not), stale files they declined to delete,
  `verify-install.sh` failures that are about setup rather than the upgrade

Then two things, in this order:

1. **Skim `.upgradeignore` in the new kit.** If they have put something valuable somewhere it
   does not name — a folder of their own at the root is fine, since nothing is ever deleted,
   but a file sitting *inside* a kit directory is not — say so now, while it is cheap.
2. 🔴 **Tell them to exit `claude` and start it again in the folder.** The new hooks register at
   session start. Until they do, they are running the new files with the old session, and the
   thing they upgraded for is not loaded yet.

Finally: write one line in `memory/` about the upgrade — version, date, anything you had to
merge by hand. The next session inherits nothing else about today.

---

## Done-criteria — verify each, out loud

- [ ] `.talos-version` exists and names the new version
- [ ] `bash scripts/self-test.sh` in their folder ends in `ALL <n> CHECKS PASSED`
- [ ] `python3 -m json.tool .claude/settings.json` succeeds
- [ ] `bash scripts/verify-install.sh` output has been read to them, failures explained
- [ ] their `CLAUDE.md` still contains whatever they added to it by hand
- [ ] `ls memory/` and `ls wiki/` show their notes, at the count they had this morning
- [ ] the backup folder exists, and they know the path and the undo command
- [ ] `python3 hooks/session-start.py` prints valid JSON
- [ ] If a box cannot be checked, **say which and why.** Do not report success you did not
      verify.

---

## Have a SUB-AGENT audit it. You do not get to grade your own upgrade.

Same reason as BOOTSTRAP step 7.9, and more so: you have just spent twenty minutes moving
files and you will "remember" merging a hooks block you did not merge. Launch one with this
brief, verbatim:

> You are auditing a Talos Agent upgrade another agent just performed. **Assume nothing it
> claims is true.** The files on disk are your only evidence.
>
> 1. `cat .talos-version` — what version does this folder claim to be running?
> 2. Run `bash scripts/self-test.sh` and report the last line exactly, including every FAIL.
> 3. Run `bash scripts/verify-install.sh` and report every FAIL.
> 4. Open `.claude/settings.json`. Which hook scripts (everything under `hooks/` that the new kit's
>    `templates/dot-claude/settings.json` registers) are registered, and on which events? **Name any
>    that are missing, and any registered command whose script file does not exist.**
> 5. Open `CLAUDE.md`. Is it a rendered config, or does it start with
>    `# Setup is not finished.`? **If it is the placeholder, the upgrade overwrote their
>    config and that is a data-loss event — say so first, loudest.**
> 6. `ls memory/` and `ls wiki/` — are there real notes with real content, or template text?
>    **Quote a line from two of them as proof.**
>
> 🔴 **Report only. Fix nothing.** Name the file and the line. An auditor that edits is an
> auditor that hides what it found.
>
> End with one line: **UPGRADE SOUND** or **UPGRADE HAS PROBLEMS: <list>**.

If it comes back with problems, fix them and run a **new** sub-agent. Do not argue with the
audit and do not have the same one re-check its own complaint.

---

## If the new kit was already copied over the agent

It happens: they ran `cp -R` of the clone into their agent folder. What you have depends on what the copy did.

1. **Stop writing anything.**
2. If the folder is a git repo — and it should be, BOOTSTRAP step 7 makes one —
   `git status` will show exactly which of their files were overwritten, and
   `git stash list` / `git log` gives you the undo. Restore their files from git first:
   `git checkout -- memory wiki CLAUDE.md .learnings`
3. If it is not a repo and files were overwritten, tell them plainly what was lost and check
   Time Machine or their sync provider's version history before doing anything else. Do not
   run the upgrade on top of the damage.

---

## Coming from 1.0.x: the hot-file config, the ledger and the new hooks (1.1.0)

1.1.0 changes what `CLAUDE.md` is meant to look like, and adds files that an existing agent does not have. The
upgrade replaces code and adds files, and **never edits their `CLAUDE.md`**, so these are conversations, not
automatic steps. Offer them, one at a time, and never do one without a yes.

1. **The hooks (step 6 already covers this).** `HOOKS TO RECONCILE` will list the new ones: `claim-gate.py`,
   `append-only-guard.py`, `timeline-guard.py`, `agent-log.py`, `channel-debt.py`, `check-vault.py`, `hands-free.py` and the `statusLine`. The last one is not a hook
   but lives in the same file; merge it too. All of them are optional, and `verify-install.sh` reports them as
   notes rather than failures.
2. **`memory/rules-ledger.md`.** New agents get it in BOOTSTRAP. For an existing one, render
   `templates/rules-ledger.md.tmpl` (replace `{{FAMILIAR_NAME}}` and `{{USER_NAME}}` with the names in their
   `CLAUDE.md`). `verify-install.sh` fails without it, because the new lint reads it.
3. **A shorter `CLAUDE.md`.** The old template was long paragraphs with the story of every rule. The new one is
   one trigger line per rule, keyed `[R-nn]`, under 3,000 words. Show them the new `templates/CLAUDE.md.tmpl`
   next to their file and **offer** to move their own promoted rules to trigger form, with the stories going into
   the ledger under the same keys. Keep their persona, people, preferences and guardrails exactly as written.
   Back up their file first (`cp CLAUDE.md CLAUDE.md.bak-before-hotfile`), and finish with
   `bash scripts/claude-md-lint.sh`. If they decline, nothing breaks: the lint will simply report the old file
   as over the cap. Do not shorten it behind their back.
4. **Memory search is opt-in.** Mention `bash scripts/memory/setup.sh` and `setup/memory-search.md`; do not run it
   unasked (it downloads about 370 MB).
5. **Chronos moves to 0.2.1 only if they update it** (`git pull` in the Chronos clone, then re-run its
   `install.sh`). The upgrade never touches Chronos. New jobs arrive with `talos-jobs.py register`, disabled.
   `talos-memory-index` is now a plain command job and needs Chronos 0.2.1; on an older one `register` skips it
   and says so. An already-registered `talos-memory-index` that still runs `claude -p` keeps working. To switch it
   to the command version: remove that one entry from `~/.config/chronos/jobs.json` and delete
   `~/.config/chronos/jobs/talos-memory-index/`, then run `python3 scripts/talos-jobs.py register --agent-dir .`
   and `python3 scripts/talos-jobs.py enable talos-memory-index`.

---

## Coming from the Desktop-app era

Early builds of this kit (before the CLI port, 1.0.0-cli) were written for the Claude desktop app: scheduled
work went through the app's scheduled-tasks feature and a job mailbox (`.agent-state/inbox/`,
`hooks/job-inbox.py`). The mailbox is gone. If an agent comes from one of those, after the upgrade:

1. Delete the old scheduled tasks in the desktop app (or their `~/.claude/scheduled-tasks/<task>/` folders).
2. 🔴 `.claude/settings.json` still registers `job-inbox.py` on `UserPromptSubmit`. **Remove that entry
   FIRST, before deleting the file.** The old command was `python3 "$CLAUDE_PROJECT_DIR/hooks/job-inbox.py"`;
   with the file gone, `python3` exits 2 and a `UserPromptSubmit` hook that exits 2 **blocks every prompt you
   type**. It does not fail open. (If it has already happened: the prompt is refused with a hook error;
   edit `.claude/settings.json` from a plain terminal and delete the entry.)
3. Only then delete `.agent-state/` (once it is empty) and the stale `hooks/job-inbox.py` if the upgrade
   listed it.
4. Install Chronos (`./install.sh --agent-dir` refuses an existing install, so run Chronos's own installer, then
   `talos-jobs.py register`) and re-create the brief as a Chronos job (`MORNING-BRIEF.md`).

---

## What the recipient can read

Everything above is written for you, the agent. If they want to understand the boundary
themselves, `.upgradeignore` is the file to point them at — it is commented, it is short, and
it explains every hard call. They can also interrogate it directly:

```bash
bash "<new kit>/scripts/upgrade.sh" --explain memory/STATE.md wiki/me.md hooks/session-start.py
```

which prints `PROTECT` or `CODE` for each path, with the pattern that decided it.
