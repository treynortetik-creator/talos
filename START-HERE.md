# START HERE

You are about to give yourself a working memory that survives across sessions.

**Read this whole page before you type anything.** It is short. Talos runs in the Claude Code
command-line tool, in a Terminal window, on a Mac.

---

## What you are building

An AI agent that lives in a folder on your machine, remembers what you told it last week, and gets
better at your job the longer you use it.

Concretely, after setup you will be able to close your laptop, come back tomorrow, say "where were
we," and get a real answer instead of a blank stare.

**Time, honestly: 45-60 minutes, in one sitting or two.** The interview stops at a natural point
after about 25 minutes and tells you how to resume. If you say yes to the optional pre-fill from
your email, calendar and chat, add one to three hours (a capped 30-day pull took an hour end to end),
and do that part on a day you can leave the laptop open. Add 15 minutes today if Claude Code is not
installed yet.

---

## Step 1 — Install Claude Code (do this first)

Open Terminal (`Cmd+Space`, type `Terminal`, press Enter).

**First, check you have Python 3**, because the memory hook and the linter need it:

```
python3 --version
```

If that errors on a Mac, run `xcode-select --install` and accept the dialog. **Budget 15-40
minutes**: it is a large download and it looks completely frozen the entire time. Do not cancel it.
It only happens once. It also installs `git`, which the installer needs.

Install Claude Code from Anthropic's official installer (read it first if you like, it is a plain
script) and check it worked:

```
curl -fsSL https://claude.ai/install.sh | bash
claude --version
```

Close and reopen Terminal if `claude` is not found. You should see a version number. If you still see
`command not found`, see Troubleshooting at the bottom.

Then log in:

```
claude
```

The first time, it walks you through login in a browser. Run `/status` inside it and **confirm the
account shown is the one you meant to use**, then `/exit`.

> **If you are setting this up on a work machine or for work data:** which account you sign in with,
> and what data may go to Anthropic under it, is a question for whoever owns your organisation's
> security and compliance, not for this kit. Ask before pointing the agent at anything regulated.
> A personal account is fine while you learn the tooling on your own material.

---

## Step 2 — Get the kit and run the installer

```
git clone https://github.com/treynortetik-creator/talos.git
cd talos
./install.sh
```

That does the mechanical parts:

- **Copies** the kit into `~/my-agent` (change it with `--agent-dir`). Your agent lives in the copy,
  not in the clone, so your memory never sits inside a git checkout that has a remote.
- Writes `.claude/settings.json` (the hooks) and `.talos-version` in the copy.
- **Installs Chronos**, the scheduler that lets the agent do things on a schedule, and registers five
  Talos jobs, all switched off for now. **Do not want scheduling? Run `./install.sh --no-chronos`.** The agent
  works the same; nothing runs on a timer. See the README, "Chronos".

Run `./install.sh --dry-run` first if you want to see the plan without changing anything.

> **Not in Google Drive / OneDrive / Dropbox.** The installer refuses those. Two processes editing the
> same file mid-sync corrupts it. It also refuses `~/Desktop`, `~/Documents` and `~/Downloads` when
> Chronos is on, because macOS privacy rules can stop scheduled jobs reading them.

---

## Step 3 — Let the agent set itself up

```
cd ~/my-agent
claude
```

The first time, it asks whether you trust the folder. **Say yes**, it is your folder. Then type, exactly:

```
Read BOOTSTRAP.md and set me up.
```

It reads the instructions, interviews you, and builds the agent's config and memory as it goes.
**You just answer questions.** The interview runs in waves and stops after wave 4; expect about 25
minutes to get there. You do not have to do it all in one sitting.

Two things that are normal:

- **A permission prompt for every file write.** Approve each, or say: `You can write to the wiki folder
  without asking each time.` Do not blanket-approve everything: the one time it asks to do something
  surprising is the time you want to be reading.
- **"Which tools do you have connected?"** Late in setup the agent offers to pre-fill its knowledge
  base from your recent mail, calendar, chat and meetings. It can only use MCP servers your Claude Code
  already has. **This kit installs none.** See what is connected with `/mcp` inside a session. (Do not run `claude mcp list`
  while a Telegram-channel session is open: its health check starts a second poller, HTTP 409.) The how-to is at `code.claude.com/docs/en/mcp`. Nothing in setup
  requires one. Without one you just skip the pre-fill.

---

## Step 4 — Decide about the personal vault (optional, 1 minute)

By default this kit installs **only** a work knowledge base. That is deliberate.

If you also want your agent to know about your personal life, you can add a private vault. **It must
live outside any synced or shared storage.** To add it, in a plain Terminal window (type `/exit`
first if you are still in the agent):

```
mkdir -p ~/private-agent-vault
cp -R ~/my-agent/optional/personal/. ~/private-agent-vault/
```

Then tell your agent: `My personal vault is at ~/private-agent-vault. Read its CLAUDE.md.` It shows you
a short block to add to its config; say yes. **Skip this if you are unsure.** A work-only agent is
useful on its own.

(On a brand-new install you can do the copy in one step: `./install.sh --with-vault ~/private-agent-vault`. It
also records the vault for the optional guard in `hooks/check-vault.py`. If you copied by hand, record it with
`mkdir -p ~/.config/talos && echo ~/private-agent-vault > ~/.config/talos/vault-dir`. The guard asks before a term from
`<vault>/_guard-terms.txt`, a list **you** write, is saved anywhere outside the vault.)

---

## Optional, whenever you like: talk to it from your phone

If you want to message your agent from Telegram instead of sitting at the terminal, the one-time setup is in
[`setup/telegram.md`](setup/telegram.md) (about 10 minutes), and afterwards `bash scripts/talos-chat.sh` starts it with
the channel on. Skip it for now if you are not sure; nothing else depends on it.

## Day two — the moment that matters

At the end of your first session, say:

```
Update the handoff file before I go.
```

Then **exit, and come back tomorrow.** Run `cd ~/my-agent && claude` and ask:

```
Where did we leave off?
```

It will know. That is the whole point of this thing, and it is the moment most people decide whether
they actually want it. It happens on day two, not day one.

## What to do next

Open `HOMEWORK.md`. It is a two-week track from "I have an agent" to "my agent runs a real piece of
my job". That is where the value is; setup is just the cost of entry.

---

## Troubleshooting

**`claude: command not found` after install**
Close and reopen Terminal completely. If it persists, run `ls ~/.local/bin/claude`. If it exists, add
`export PATH="$HOME/.local/bin:$PATH"` to your `~/.zshrc`, then reopen Terminal.

**The agent does not seem to know about the setup files**
Confirm you are in the right folder: `pwd` should show your agent folder and `ls` should show
`CLAUDE.md`. Claude Code reads the folder you started it in (and its parents), not one you point at later.

**`cd: too many arguments`**
Your path has a space in it. Put quotes around the whole path, and use `$HOME` instead of `~` inside the
quotes (a tilde inside quotes is not expanded): `cd "$HOME/some folder/my-agent"`. Easiest of all: type
`cd ` (with the space), then **drag the folder from Finder into Terminal**.

**I cannot type a new line in my message, Enter just sends it**
You never need one. Write it as one long sentence. (`Shift+Enter` inserts a newline in Apple Terminal
and iTerm2.)

**It keeps asking permission for everything**
Look at the mode indicator at the bottom of the screen and press `Shift+Tab` to cycle modes. Starting
out, being asked is correct.

**`./install.sh` says "refusing: ..."**
It tells you why: a non-empty folder, cloud-synced storage, or a macOS-protected folder. Each has a
fix in the message.

**The installer cannot clone Chronos**
The Chronos repository may still be private. Use a local checkout with `--chronos-path DIR`, or skip it
with `--no-chronos`.

**Something else**
Tell your agent what happened, in plain language. It has this whole kit available and can usually
diagnose its own setup. That is the point.
