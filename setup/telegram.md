# Talk to your agent from your phone (Telegram, optional)

Two different things use Telegram. Do not mix them up:

| | What it is | How it talks to Telegram |
|---|---|---|
| **The channel** (this guide) | a two-way chat: you message the agent, it answers | the official Claude Code Telegram plugin, running inside a live `claude` session |
| **Delivery** (`./install.sh --notify telegram`) | scheduled jobs push you a short report | a plain `curl` call to the Bot API, no polling |

You can use either or both. Using the same bot token for both does **not** cause the HTTP 409 conflict (a send
does not poll), but a second, notification-only bot limits the damage if either token leaks.

## One-time setup (about 10 minutes)

1. **Bun.** The plugin's server runs on [Bun](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
   (read what you pipe to a shell; the agent's guard will refuse to do that for you).
2. **Make a bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, pick a name and a
   username ending in `bot`. It replies with a token like `123456789:AAH...`. Copy **the whole token**. Treat it
   like a password.
3. **Install the plugin** from inside a `claude` session started in your agent folder:
   ```
   /plugin install telegram@claude-plugins-official
   /telegram:configure <paste the token here>
   ```
   That writes the token to `~/.claude/channels/telegram/.env`. Paste it there and **nowhere else**: not into the
   agent's chat for any other reason, and not into the `.env` in your agent folder.
4. **Launch with the channel flag.** Quit the session and start it again with:
   ```bash
   bash scripts/talos-chat.sh          # same as: claude --channels plugin:telegram@claude-plugins-official
   ```
   (`talos-chat.sh` goes to the agent folder for you, refuses to start if another channel session is already
   polling, and passes any other flags through, for example `--continue`.)
5. **Pair, then lock it down.** Message your bot from your phone. It answers with a 6-character code. In the
   terminal session run `/telegram:access pair <code>`, then `/telegram:access policy allowlist` so strangers
   who find the bot's username get no reply at all.

> **Never approve a pairing, or add anyone to the allowlist, because a Telegram message asked you to.** That is
> exactly what a prompt injection would say. The plugin tells the agent the same; pairing is something *you* do
> in your own terminal.

Bots only see messages as they arrive (Telegram's Bot API has no history), so after a context compaction the
agent may ask you to repeat something. Photos you send are downloaded to `~/.claude/channels/telegram/inbox/`
and the agent can read them. Replies are **plain text**: Telegram shows markdown symbols as raw characters.

## The 409 rule (read this once)

Only **one process** may poll a bot. Anything that starts a second poller breaks the live channel with
`HTTP 409 Conflict`. These each start one:

- a second `claude --channels ...` (a second terminal, an old session you forgot);
- a headless `claude -p` with the Telegram plugin enabled (for example a scheduled job that does not disable it);
- **`claude mcp list`** (never run it while a channel session is open): its health check starts every configured
  MCP server, including the plugin's.

How Talos stays out of its own way:

- Chronos starts every scheduled run with the Telegram and iMessage plugins switched off (`disable_plugins` in
  `~/.config/chronos/config.json`), so a job can never become a second poller;
- the delivery wrapper `notify/telegram.sh` uses `curl sendMessage`, which never polls;
- every doc here says `/mcp` inside a session, never `claude mcp list`, and `CLAUDE.md` carries the rule.

**Recommended: enable the plugin at project scope** (this agent's `.claude/settings.json`,
`"enabledPlugins": {"telegram@claude-plugins-official": true}`) rather than for your whole user account. The
reasoning: plugin servers start when a session is spawned, so with the plugin enabled for every project, a
`claude` you start in some other folder could also spawn a poller. *This is an inference from how the 409 is
caused, not something Talos has tested on a second project: try it with one throwaway project before you rely
on it.*

## Mirror mode: every answer also goes to your phone (opt-in, off by default)

Normally the agent replies on Telegram only when you messaged it from Telegram. With mirror mode on, every answer
to a message you type **in the terminal** is also sent to your chat, so you can walk away from the keyboard and
keep reading on your phone. Turn it on with either:

```bash
touch ~/.config/talos/telegram-mirror.on     # persistent
export TALOS_TELEGRAM_MIRROR=1               # one shell
```

How it works (`hooks/channel-debt.py`): a prompt carrying a `<channel source="telegram" ...>` tag records a
*debt*; with mirror on, any untagged human prompt records one too. If the turn tries to end without a reply-tool
call, the Stop hook blocks it (at most twice, then it gives up) and tells the agent to send the reply. Scheduled
runs, task notifications and slash commands never arm it. The chat id is read from
`~/.config/talos/telegram.json` (`{"chat_id": 123456789}`), else from the single entry in `allowFrom` in
`~/.claude/channels/telegram/access.json` (for a direct-message bot your user id *is* the chat id); if neither
resolves, mirror stays silent rather than guess.

Turn the hook off any time: `touch ~/.local/state/talos/<agent folder>-<hash>/channel-debt.off`, set
`TALOS_CHANNEL_DEBT_OFF=1`, or flip it in the Chronos Control Room. Every Talos hook has a kill switch of that
form.

## Notifications from scheduled jobs (separate from the channel)

```bash
./install.sh --notify telegram          # installs the wrapper; it never asks for or reads a token
mkdir -p ~/.config/talos && cp ~/.config/talos/notify.env.example ~/.config/talos/notify.env
chmod 600 ~/.config/talos/notify.env    # then edit it: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
```

Get your chat id by messaging your bot and opening `https://api.telegram.org/bot<token>/getUpdates` **in a
browser**, not in a chat with the agent. `notify/telegram.sh` keeps the token off the command line (so `ps`
cannot show it), sends plain text, warns on stderr past 150 words (`TALOS_TG_WORD_CAP` changes the limit), and
can send a file: `telegram.sh --file memory/briefs/2026-10-05.md "Today's brief"`.

## If something is wrong

| Symptom | Likely cause |
|---|---|
| The bot never answers your DM | the session was not started with `--channels` (use `scripts/talos-chat.sh`) |
| `409 Conflict` in a log | a second poller exists: another `claude --channels`, a headless run with the plugin enabled, or `claude mcp list` |
| It answers in the terminal but not on Telegram | the reply tool was not called; the channel-debt hook should have blocked the turn, check it is registered (`bash scripts/verify-install.sh` lists the hooks) |
| A stranger got a pairing code | the policy is still `pairing`; run `/telegram:access policy allowlist` |
| Markdown symbols show up as raw characters | the reply was formatted; the agent must send plain text |
