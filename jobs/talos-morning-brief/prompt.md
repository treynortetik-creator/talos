You are running the Talos weekday morning brief for the person who owns this agent.

The agent folder is {{TALOS_HOME}}. If your working directory is not that folder, cd there first and read
its CLAUDE.md before anything else: it holds the owner's name, rules and guardrails. You have no memory of
earlier runs, so everything you need comes from files on disk.

0. Refresh the memory search index, if it is installed: when
   `test -x "${XDG_DATA_HOME:-$HOME/.local/share}/talos/venv/bin/python"` succeeds, run in the FOREGROUND
   `"${XDG_DATA_HOME:-$HOME/.local/share}/talos/venv/bin/python" scripts/memory/mem_index.py --quiet` and wait
   for it (a second when nothing changed). If it fails, carry on and say in the report that the search index
   is stale. If the venv does not exist, skip this step silently.

1. Run `date`. Use that date everywhere below. If `memory/briefs/<today>.md` already exists, the brief
   was already written today: say so in the report and stop.

2. Read for context: `wiki/_index.md`, `memory/STATE.md`, `memory/HANDOFF.md`, and yesterday's brief in
   `memory/briefs/` if there is one. If `memory/brief-sources.md` exists, it lists the sources and caps
   to use (see MORNING-BRIEF.md in the agent folder for its format). If it does not exist, write a
   wiki-only brief and say that no live sources are configured.

3. If `memory/brief-sources.md` names tools (MCP tools), they are deferred: load them with ToolSearch
   before you call them, read-only ones only. Pull the last 24 hours, within the caps in that file
   (default: 20 mail threads, 30 chat messages, meeting SUMMARIES only, never full transcripts: one
   transcript can fill the context window and end the run). Calendar: today and tomorrow.

4. Write the brief to `memory/briefs/<today>.md`. Lead with what needs action. Then: what is on today and
   what the wiki already knows about the people in those meetings, what changed since yesterday's brief,
   and anything with a deadline inside 48 hours. Short enough to read standing up. Mark anything you
   inferred rather than read as an inference.

5. File selectively, at most five wiki writes in total. File only: (a) a person who appears in two or
   more sources, (b) a durable fact that changes an existing note (a role, a date, an owner), (c) a stub
   for a named thing the wiki has never heard of, plus the inbound [[link]] added to the note where the
   name came up (a stub with no inbound link is invisible). Never file meeting recaps, anything already
   present, speculation about people, or the brief itself. Follow the schema in `wiki/README.md` (four
   frontmatter keys, at least two outbound links, kebab-case names) and add one line to
   `wiki/_changelog.md`, newest first. If more than five things deserve filing, file five and say in the
   brief that a human should look.

6. Finish with `python3 scripts/wiki-lint.py wiki --extra-dir memory` if you wrote any wiki note, and
   mention a non-clean result in the brief.

7. The Chronos report is what gets delivered to the owner's phone or notification centre, and only its
   first few hundred characters survive. Start the report with the three most important things from the
   brief as plain text (no tables, no markdown headings), then the path to the full brief, then anything
   that failed or was skipped.
