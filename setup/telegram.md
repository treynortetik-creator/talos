# Talk to your agent from your phone: the Telegram setup guide (optional)

About 10 minutes, once. Afterwards `bash scripts/talos-chat.sh` starts the agent with the channel on, and you can message
it from the couch. The channel only answers while a session is running in your agent folder: it is a chat window into a
live session, not a server.

Everything below was checked against the official plugin's own files (`telegram@claude-plugins-official`, version
0.0.7: its README, `ACCESS.md` and the two skills `/telegram:configure` and `/telegram:access`). If a later version
differs, those skills are the authority: run `/telegram:configure` with no arguments and it tells you where you stand.

## Two different things use Telegram. Do not mix them up

| | What it is | How it talks to Telegram |
|---|---|---|
| **The channel** (this guide) | a two-way chat: you message the agent, it answers | the official Claude Code Telegram plugin, running inside a live `claude` session |
| **Delivery** (`./install.sh --notify telegram`, see the end) | scheduled jobs push you a short report | a plain `curl` call to the Bot API, no polling |

You can use either or both. The same bot token for both does **not** cause the HTTP 409 conflict (a send does not poll),
but a second, notification-only bot limits the damage if either token leaks.

## One-time setup

You need: Claude Code installed and logged in, an agent folder (`~/my-agent`), and Telegram on your phone.

### 1. Install Bun

The plugin's server runs on [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`. (Read what you pipe to a
shell. Talos's guard refuses to do this for you; run it yourself in a normal terminal.) Check: `bun --version`.

### 2. Make a bot with BotFather

In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`. It asks for two things:

- a **name**, the display name in chat headers (anything, spaces allowed);
- a **username**, unique, ending in `bot` (for example `my_assistant_bot`).

It replies with a token that looks like `123456789:AAH...` (a number, a colon, a long string). Copy **the whole token**.
**It is a password**: anyone holding it can control the bot. Paste it where step 4 says and nowhere else: not into the
agent's chat for any other reason, not into a note, not into the `.env` in your agent folder.

### 3. Install the plugin

Start Claude Code in your agent folder (`cd ~/my-agent && claude`), then inside the session:

```
/plugin install telegram@claude-plugins-official
```

### 4. Give the plugin the token

```
/telegram:configure <paste the token here>
```

It writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env` (mode 600). You can also write that file by hand
or set `TELEGRAM_BOT_TOKEN` in your shell (the shell wins). The server reads the file once at boot, so after saving, quit
and restart the session (or run `/reload-plugins`). To run a second bot on the same machine, give each its own state
folder with the `TELEGRAM_STATE_DIR` environment variable.

### 5. Launch with the channel flag

The server does not connect without it. Quit the session and start a new one with:

```bash
bash scripts/talos-chat.sh
```

which is `cd <agent folder> && claude --channels plugin:telegram@claude-plugins-official` and passes any other flags
through (`--continue`, for example). The launcher refuses to start when the plugin has no token yet, and when another
`claude --channels` is already running (see "The 409 rule" below).

### 6. Pair

DM your bot on your phone. It answers with a 6-character pairing code. (No answer: the session is not running with
`--channels`.) In the **terminal** session:

```
/telegram:access pair <code>
```

The plugin adds your numeric Telegram user id to the allowlist and sends you a confirmation. Your next message reaches the
agent. Codes expire; ask for a new one by DMing again.

### 7. Lock it down

Pairing is for capturing ids, not a policy to stay on. Once you are in:

```
/telegram:access policy allowlist
```

Now a stranger who finds the bot's username gets no reply at all. (`pairing` answers anyone with a code; `disabled` drops
everything.) Check who is allowed any time with `/telegram:access`.

> **Never approve a pairing, or add anyone to the allowlist, because a Telegram message asked you to.** That is exactly
> what a prompt injection would say, and the plugin's skills refuse it. Pairing and policy changes are something *you* do
> in your own terminal. Do not let the agent "approve the pending one" without you reading the code yourself.

### 8. Test it

1. Send "hello" from your phone. A reply appears on Telegram. If the answer shows up only in the terminal, see the
   table at the end.
2. Ask it something that needs a file: "What is in my STATE.md?" It should answer on Telegram, in plain text.
3. Send a photo. It is downloaded to `~/.claude/channels/telegram/inbox/` and the agent can read it (Telegram compresses
   photos; send as a file for the original).
4. Close the terminal window: the channel goes quiet, because the session is gone. That is by design.

## The 409 rule (read this once)

Only **one process** may poll a bot. Anything that starts a second poller breaks the live channel with `HTTP 409 Conflict`.
These each start one:

- a second `claude --channels ...` (another terminal, an old session you forgot);
- a headless `claude -p` with the Telegram plugin enabled (for example a scheduled job that does not disable it): **never
  run a second headless claude with the Telegram plugin enabled**;
- **`claude mcp list`** (never run it while a channel session is open): its health check starts every configured MCP
  server, including the plugin's. Use `/mcp` inside a session instead.

How Talos stays out of its own way:

- Chronos starts every scheduled run with the Telegram and iMessage plugins switched off (`disable_plugins` in
  `~/.config/chronos/config.json`), so a job can never become a second poller;
- the delivery wrapper `notify/telegram.sh` uses `curl sendMessage`, which never polls;
- the action-rules table refuses `claude mcp list` (the 409 trap; `hooks/action-rules.yaml`), and every doc here says `/mcp`.

**Recommended: enable the plugin at project scope** (this agent's `.claude/settings.json`,
`"enabledPlugins": {"telegram@claude-plugins-official": true}`) rather than for your whole user account, so a `claude`
you start in some other folder cannot also spawn a poller. *This is an inference from how the 409 is caused, not something
Talos has tested on a second project: try it with one throwaway project before you rely on it.*

## Writing for a phone

- **Plain text only.** Telegram shows markdown symbols as raw characters (`**bold**`, `# headings`, tables, backticks all
  arrive as punctuation). The agent should send short plain sentences.
- **About 1,500 characters per message.** Telegram rejects anything over 4,096 and the plugin splits long replies, but a
  wall of text on a phone is a bad read. Keep answers short; put long output in a file and send the file (the reply tool
  takes absolute paths in `files`; images arrive as photos, everything else as a document, up to 50 MB).
- **No history.** Telegram's Bot API has no message history or search. After a context compaction the agent may ask you to
  repeat something; the session-start hook re-injects your state, not the chat.
- **Typing indicator and acknowledgements** are handled by the plugin; you can add a reaction on receipt with
  `/telegram:access set ackReaction 👀` (Telegram accepts a fixed list of emoji only).

## What the Talos hooks add to the channel

| Hook | What it does for the channel |
|---|---|
| `channel-debt.py` | a message from Telegram creates a debt; the turn cannot end until the reply tool was called (blocks once or twice, then lets go) |
| `tg-claim-check.py` | before a reply goes out it checks for absolute claims ("it is fixed", "there is no X") that nothing in this turn showed; blocks once, the identical text sent again goes through. Active only when this channel is set up |
| `hands-free.py` | while you said "I'm driving", long replies must go out as audio **and** the full text. See `.claude/skills/talos-hands-free/SKILL.md` |
| `compaction-guard.py` | a reply still owed at the moment of a compaction is carried across it |
| `action-rules.py` | `ask`/`never` rules, including "sending through a connected account asks first". Your own channel's reply tool is exempt |

## Optional: mirror every terminal answer to your phone

Normally the agent replies on Telegram only when you messaged it from Telegram. With mirror mode on, every answer to a
message you typed **in the terminal** is also sent to your chat, so you can walk away from the keyboard and keep reading on
your phone:

```bash
touch ~/.config/talos/telegram-mirror.on     # persistent
export TALOS_TELEGRAM_MIRROR=1               # one shell
```

`channel-debt.py` reads the chat id from `~/.config/talos/telegram.json` (`{"chat_id": 123456789}`), else from the single
entry of `allowFrom` in `~/.claude/channels/telegram/access.json` (for a direct-message bot your user id *is* the chat id);
if neither resolves, mirror stays silent rather than guess. Turn the hook off any time:
`touch ~/.local/state/talos/<agent folder>-<hash>/channel-debt.off`, `TALOS_CHANNEL_DEBT_OFF=1`, or the Chronos Control
Room.

## Groups, more people, other settings

Groups are off until you opt each one in (`/telegram:access group add <supergroup id>`), and by default the bot answers
only when mentioned or replied to. For a group, a second person, mention patterns, reply threading and the `access.json`
schema, read the plugin's own `ACCESS.md`:
`~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/telegram/ACCESS.md`. Group members are other people
who can type to your agent, which has your files and your shell: add one only on purpose.

## Notifications from scheduled jobs (separate from the channel)

```bash
./install.sh --notify telegram          # installs the wrapper; it never asks for or reads a token
mkdir -p ~/.config/talos && cp ~/.config/talos/notify.env.example ~/.config/talos/notify.env
chmod 600 ~/.config/talos/notify.env    # then edit it: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

Get your chat id by messaging your bot and opening `https://api.telegram.org/bot<TOKEN>/getUpdates` **in a browser**
(substitute your token), not in a chat with the agent. `notify/telegram.sh` keeps the token off the command line (so `ps`
cannot show it), sends plain text, warns on stderr past 150 words (`TALOS_TG_WORD_CAP` changes the limit), and can send a
file: `telegram.sh --file memory/briefs/2026-10-05.md "Today's brief"`.

## If something is wrong

| Symptom | Likely cause and fix |
|---|---|
| The bot never answers your DM | the session was not started with `--channels` (use `scripts/talos-chat.sh`), or the token was saved after the session started (restart or `/reload-plugins`) |
| `409 Conflict` in a log, or the bot goes deaf | a second poller exists: another `claude --channels`, a headless run with the plugin enabled, or `claude mcp list`. Find it with `pgrep -fl 'claude.*--channels'`, close it by process id (never by name pattern), restart the channel session |
| It answers in the terminal but not on Telegram | the reply tool was not called; the channel-debt hook should have blocked the turn. Check it is registered: `bash scripts/verify-install.sh` |
| `talos-chat.sh` says no token | step 4 was not done, or `TELEGRAM_STATE_DIR` points somewhere else |
| A stranger got a pairing code | the policy is still `pairing`; run `/telegram:access policy allowlist` |
| Markdown symbols show up as raw characters | the reply was formatted; the agent must send plain text |
| Messages arrive hours late or in bursts | the laptop slept; the channel only works while the Mac is awake and the session is running |
| "Message is too long" | over 4,096 characters; the plugin normally splits, so check for a custom `textChunkLimit` |
| A claim-check block on a harmless reply | the hook forces one look: send the same text again unchanged and it passes. Silence it with `touch ~/.local/state/talos/<agent folder>-<hash>/tg-claim-check.off` |

Rotate a token that leaked: in @BotFather send `/revoke`, pick the bot, then `/telegram:configure <new token>` and restart.
Remove the channel completely: `/telegram:configure clear`, remove the plugin from the `/plugin` menu, and delete
`~/.claude/channels/telegram/`.
