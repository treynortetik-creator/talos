# UNINSTALL — when you are done with the agent

What to remove, in order. Nothing here happens automatically; that is on purpose.

1. **The scheduler pieces Talos added.** From the clone you installed from:

   ```
   ./uninstall.sh --agent-dir ~/my-agent
   ```

   That unregisters the `talos-*` jobs from Chronos (their entries and prompt folders), removes the
   Chronos session hook from the agent's `.claude/settings.json`, and deletes `~/.config/talos`
   (the notify wrappers; **a `notify.env` with a Telegram token lives there, so this deletes the token
   too**: revoke the bot with @BotFather if you will not use it again).

   If you want Chronos gone as well: `./uninstall.sh --remove-chronos` (unloads its two launchd agents
   and keeps your data), or `--purge-chronos` (also deletes `~/.chronos` and `~/.config/chronos`,
   **including jobs that are not Talos's**).

   Check: `launchctl list | grep -i chronos` should print nothing, and `ls ~/Library/LaunchAgents | grep -i chronos`
   should print nothing.

   It also removes the block the optional `--global-pointer` flag added to your global `~/.claude/CLAUDE.md`
   (exactly that block, nothing else; a one-time backup `CLAUDE.md.bak-before-talos` stays beside it).
   Opt-in extras that live outside the agent folder are removed on request:
   `./uninstall.sh --remove-memory-search` deletes the semantic-search venv and model
   (`~/.local/share/talos/venv` and `/models`); the optional voice models are in `~/.local/share/talos/models/`
   (`kokoro/` and `ggml-*.bin`), delete them by hand. Hook state (claim-gate and channel-debt records, kill
   switches) is in `~/.local/state/talos/`; it is safe to delete. The Telegram plugin's own token and pairing live
   in `~/.claude/channels/telegram/`; remove them with `/plugin uninstall telegram@claude-plugins-official` and
   revoke the bot with @BotFather.
2. **Saved approvals.** Approvals you gave in ordinary sessions live in `.claude/settings.local.json`
   inside the agent folder and leave with it. If you changed Chronos's `claude_args` to an allow-list,
   that went with Chronos's config.
3. **Connected tools.** `/mcp` inside a session shows the MCP servers Claude Code knows about. Remove the ones you
   added for the agent with `claude mcp remove <name>`. (Do not run `claude mcp list` for this while a
   Telegram channel session is open: its health check starts a second poller, HTTP 409.) Connectors from a claude.ai account are
   disconnected at `claude.ai/customize/connectors`.
4. **The agent folder** (`~/my-agent`, or wherever you put it). This is the wiki, the memory, and the git
   history of both. **If anyone else should keep the knowledge, hand the folder over before deleting it.**
   The personal vault is not in it and must never be.
5. **The personal vault** (`~/private-agent-vault/`, if you made one). Yours to keep or delete. If you keep
   the agent and drop the vault, remove the "Personal vault" block from the agent's `CLAUDE.md`.
6. **Session transcripts.** Claude Code caches transcripts in plaintext under
   `~/.claude/projects/<folder-slug>/` for 30 days by default (`cleanupPeriodDays`). Delete the slug folder
   for the agent. Its `memory/` subfolder is Claude Code's built-in auto memory; this kit turns that off,
   but delete it too if it exists. Chronos keeps its own run logs and reports in `~/.chronos/logs` and
   `~/.chronos/state/reports`; `--purge-chronos` removes them, otherwise delete them by hand.
7. **What you cannot delete from here.** Whatever the agent already sent to Anthropic is governed by your
   agreement with them and their retention terms, not by anything on this machine. If that matters for
   your data, find out before, not after.

Done when `ls ~/.claude/projects | grep -i <your agent folder name>` prints nothing and
`ls ~/.config/talos 2>&1` says there is no such directory.
