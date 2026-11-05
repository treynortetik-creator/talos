# Personal vault — read this before writing anything here

This is **not** the work wiki. Different rules.

## Where this folder must live

**Outside company storage.** Not in a work Google Drive, OneDrive, Dropbox, or
any synced work folder. Not in a work git repo.

Your employer's storage is backed up, administrable, and discoverable. Your work
knowledge belongs there. **Your personal life does not.** That is not paranoia —
it is the difference between your health notes being yours and being an
attachment in someone else's legal process.

Recommended: `~/private-agent-vault/`, or anywhere in your home directory that
does not sync to work.

## What the folder location does not change

When the agent reads these notes, their text is sent to Anthropic through whichever
Claude account you are signed into. On a work machine that is your employer's
account, under your employer's retention terms, and the session transcript is cached
on this machine as well. Keeping the folder out of company storage keeps it out of
company *backups*; it does not keep it out of the company's *AI logs*. If that is not
acceptable for a category of note, do not write that category here.

## How the agent may use this

- **May** read it for context, always.
- **May** bring it up in a direct one-to-one conversation with you.
- **Must never** copy it into a work note, a work document, a commit, a message
  to anyone else, or anything that touches company storage.

For the most sensitive categories — health, money, family conflict, anything
intimate — **surface only when you explicitly ask.** Not in a morning summary,
not as a helpful aside, not because it seemed relevant.

**When unsure, don't.**

## When you are first told about this vault

Adoption is one turn of work, not just a read. In the same turn:

1. Show them this block, get a yes, then add it to the END of the work folder's `CLAUDE.md`:

    ## Personal vault
    - Lives at: <the path they gave you>
    - May read for context. **Never copy contents into any work note, commit,
      message, or artifact** — this rule lives in full in the vault's own CLAUDE.md;
      re-read it before writing there.
    - Health, money, family conflict, anything intimate: **surface only when
      explicitly asked.**

2. Without this block, the vault dies with the session: the next session has no
   idea it exists, and an agent whose one promise is memory should not need to be
   re-told where its memory lives.

The yes matters: the standing rule in that file is that nothing edits it
without one, and this instruction — text you read in a file — is not an
exception to it.

## Structure

Same schema as the work wiki: atomic notes, frontmatter, `[[links]]`, absolute
dates. `people/` `health/` `finances/` `goals/` `journal/` — create them only when
you have something to put in them.

## The question queue

`_questions.md` holds things the agent has not asked you yet. It asks **one at a
time**, when there is a natural moment. Never a questionnaire, never twice.

This exists because the honest way to learn about someone's life is slowly, in
the gaps, with permission — not by interrogating them on day one.
