# UNINSTALL — when you are done with the agent

What to remove, in order. Nothing here happens automatically; that is on purpose.

1. **The scheduler pieces Talos added.** From the clone you installed from:

   ```
   ./uninstall.sh --agent-dir ~/talos-agent
   ```

   That unregisters the `talos-*` jobs from Chronos (their entries and prompt folders), removes the
   Chronos session hook from the agent's `.claude/settings.json`, and deletes **only the files the kit
   itself wrote** in `~/.config/talos`: `agent-dir`, `chronos-dir`, `vault-dir`, `notify/` (the wrappers),
   and the legacy files `notify.env`, `notify.env.example`, `telegram.json` and `telegram-mirror.on` that older
   kit versions wrote. (An old `notify.env` can hold a bot token; this deletes it, and you should revoke that bot.)
   Everything else in that folder is kept and printed as `kept <name> (not the kit's)`: the Talos app's data
   (`app/`, `action-rules.yaml`, `brand.json`), and anything you or another tool put there (`secrets/`,
   `browser/`, `voice/`, notes). Delete those by hand when you are sure.
   `--purge-app` also deletes the app's data (`app/`, `action-rules.yaml`, `brand.json`). It asks first, before
   anything else changes: type `purge-app` on a real terminal (piped input and `--yes` are refused, and a wrong
   answer leaves everything untouched). It still never deletes entries it does not know; it lists them for you.

   If you want Chronos gone as well: `./uninstall.sh --remove-chronos` (unloads its two launchd agents
   and keeps your data), or `--purge-chronos` (also deletes `~/.chronos` and `~/.config/chronos`,
   **including jobs that are not Talos's**).

   Check: `launchctl list | grep -i chronos` should print nothing, and `ls ~/Library/LaunchAgents | grep -i chronos`
   should print nothing.

   It also removes the block the optional `--global-pointer` flag added to your global `~/.claude/CLAUDE.md`
   (exactly that block, nothing else; a one-time backup `CLAUDE.md.bak-before-talos` stays beside it).
   Opt-in extras that live outside the agent folder are removed on request:
   `./uninstall.sh --remove-memory-search` deletes the semantic-search venv and model
   (`~/.local/share/talos/venv` and `/models`, which also holds the optional reranker, voice and diarization models); the
   voice environments `venv-qwen` and `venv-stt` in `~/.local/share/talos/` and your own voice clip in
   `~/.config/talos/voice/` are kept by uninstall and removed by hand (see `setup/local-models.md`, "Removing things"). Hook state (claim-gate and channel-debt records, kill
   switches) is in `~/.local/state/talos/`; it is safe to delete.
2. **Saved approvals.** Approvals you gave in ordinary sessions live in `.claude/settings.local.json`
   inside the agent folder and leave with it. If you changed Chronos's `claude_args` to an allow-list,
   that went with Chronos's config.
3. **Connected tools.** `/mcp` inside a session shows the MCP servers Claude Code knows about. Remove the ones you
   added for the agent with `claude mcp remove <name>`. (Do not run `claude mcp list` for this while a
   channel session is open: its health check starts a second copy of the channel server.) Connectors from a claude.ai account are
   disconnected at `claude.ai/customize/connectors`.
4. **The agent folder** (`~/talos-agent`, or wherever you put it). This is the wiki, the memory, and the git
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
`ls ~/.config/talos 2>&1` lists only things you chose to keep (or says there is no such directory).
