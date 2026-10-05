# APPLE-NOTES — mining the notes you take yourself

**Optional, macOS only. Runs as part of the seed, in Step 3, alongside the four connectors.**

Every other source in this kit captures what *happened* to you: mail you received, meetings you
were invited to, channels you sat in. This one captures **what you concluded** — the note you
chose to type while the meeting was still going. It has already been through a human filter
deciding it was worth writing down, which makes it, per staged word, the densest source in the kit.

It is also the only source with no work/personal boundary, so it has two gates the others do not.

---

## Why this is allowed when Google Drive and Notion are not

`SEED-WIKI.md` closes the connector list at Gmail, Calendar, Slack and Zoom, and turns away shared
document stores on two grounds. **That closure stands.** Apple Notes is not a connector and is not
a document store; it is a local, single-user app. Checked against the same two tests, it passes
both:

- **Reach.** The objection to Drive is that a recency listing returns whatever the whole company
  touched, and a bare listing can surface a spreadsheet of individual customer
  records nobody asked for. Apple Notes cannot do that. It is one person's own note store on
  their own machine, and nothing another person wrote can appear in it. That is a **tighter** blast
  radius than Gmail, which is full of other people's words.
- **Yield.** The objection is that documents do not tell you who works with whom. True of a file
  store, false here: meeting notes are a person's own account of a conversation, and they routinely
  name the people, the decision and the open question in one paragraph.

**Do not use this as precedent to re-open the connector list.** Drive, Notion, SharePoint, Dropbox
and Confluence are still out, for the reasons written in `SEED-WIKI.md`.

---

## 🔴 The gate, and why it has two stages

**Folder names do not predict folder contents. This was measured, not assumed.**

The first real test of the puller pointed at a folder whose name sounded entirely work-adjacent.
It returned private personal content: a diary-style entry, and notes on personal life goals.
Nothing in the folder name predicted either one, and the person who picked that folder would not
have predicted it either.

So folder opt-in alone is not enough. The flow is three steps and **you may not collapse them**:

### Step 1 — show them their own folders

```
python3 scripts/apple-notes-pull.py --list-folders
```

Read-only. Prints folder names and note counts, no bodies. Show the user the list and ask **which
folders are work**. There is deliberately no default and no `--all`.

### Step 2 — dry run, and make them read the titles

```
python3 scripts/apple-notes-pull.py --folders "Work,Meetings" --days 30 --dry-run
```

Writes a manifest of titles and dates and **no bodies**. Hand the user that list and ask plainly:

> "Anything on this list you would not want an agent quoting back to you in a work meeting?"

### Step 3 — pull what survived

```
python3 scripts/apple-notes-pull.py --folders "Work,Meetings" --days 30 \
  --exclude "personal,therapy,medical,journal"
```

`--exclude` matches substrings of the title, case-insensitively. Notes land in
`.seed-staging/apple-notes/` as plain text with a `SOURCE / FOLDER / TITLE / MODIFIED` header, which
is the same staging contract the other four sources use, so `seed-quotecheck.py` reads them for free.

---

## What the agent does with them

Treat a staged note as **the user's own words**, and that changes two things:

- **It is a quotable primary source about what THEY thought.** Unlike a Zoom summary, which is
  model output and must never be quoted as speech (see `SEED-WIKI.md`), a note is literally what
  they typed. Quote it as theirs.
- **It is NOT evidence about what anyone else said.** A note reading `Dana wants to cut scope` is
  the user's paraphrase of Dana, recorded from memory, possibly hours later. File it as
  *"per your notes, Dana argued for cutting scope"* — never as a Dana quote. This is the same
  rule the kit already applies to Zoom summaries, for the same reason.

**What to extract, in priority order:**

1. **Decisions and their reasons.** The highest-value thing in any note store and the thing that
   vanishes fastest from everywhere else.
2. **Named people, and what the user thinks they own.** Cross-reference against the people notes
   the connectors produced; a name appearing in both is real, a name appearing only here is a stub.
3. **Open questions and to-dos.** These become the `open_q` field the deep-dive selector ranks on,
   which is how a note the user wrote turns into a topic the agent goes and researches.
4. **Recurring vocabulary.** Project code names, internal acronyms, shorthand. This is the fastest
   route to an agent that speaks the user's actual language.

**Do not file:** grocery lists, passwords, anything medical, anything about family, anything that
reads as a diary. If one slips past the gates, **delete the staged file and tell the user which
note it was** — do not quietly summarize it into a wiki note and move on.

---

## Limits, stated plainly

- **macOS only.** Apple ships no Notes API; the only access is AppleScript against the local app,
  so this cannot run on Windows, on Linux, or in a scheduled cloud task.
- **The first run triggers a macOS Automation prompt.** If it is dismissed, the fix is
  System Settings → Privacy & Security → Automation, not re-running the script.
- **Password-protected notes are skipped.** AppleScript cannot read them. The count is always
  reported so a locked note never looks like an empty folder.
- **Shared notes are included** if they are in a folder the user named. A note someone else shared
  into their account is their copy, but the words may be someone else's — same paraphrase rule.
- **Formatting is lost.** Tables, checklists and attachments come through as plain text or not at
  all. Checklists survive as `-` bullets; images do not survive.
