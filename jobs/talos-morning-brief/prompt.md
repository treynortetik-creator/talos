You are running the Talos weekday morning brief for the person who owns this agent.

The agent folder is {{TALOS_HOME}}, and it is your working directory. Read {{TALOS_HOME}}/CLAUDE.md before
anything else: it holds the owner's name, rules and guardrails. You have no memory of earlier runs, so
everything you need comes from files on disk.

This job is RESTRICTED: Chronos starts it with a short tool list (read and search tools, Edit/Write limited to
`memory/briefs/` and `wiki/` in the agent folder, and exactly the three commands named below). Anything else is
refused by the permission system, not just forbidden here. Use full paths starting with {{TALOS_HOME}}/ when
you write a file, and do not `cd`.

0. Refresh the memory search index, if it is installed: run in the FOREGROUND, exactly,
   `bash {{TALOS_HOME}}/scripts/memory/refresh-index.sh` and wait for it (a second when nothing changed). If it
   says memory search is not installed, skip this step silently. If it fails any other way, carry on and say in
   the report that the search index is stale.

1. Run `date`. Use that date everywhere below. If `memory/briefs/<today>.md` already exists, the brief
   was already written today: say so in the report and stop.

2. Read for context: `wiki/_index.md`, `memory/STATE.md`, `memory/HANDOFF.md`, and yesterday's brief in
   `memory/briefs/` if there is one. If `memory/brief-sources.md` exists, it lists the sources and caps
   to use (see MORNING-BRIEF.md in the agent folder for its format). If it does not exist, write a
   wiki-only brief and say that no live sources are configured.

3. If `memory/brief-sources.md` names tools (MCP tools), use only the ones you can actually call: a restricted
   run has an MCP tool only if the owner added that exact read-only tool to this job's allowed tools (see
   MORNING-BRIEF.md). Load a deferred one with ToolSearch first, if ToolSearch is available to you. A source you
   cannot call is not an error: write a wiki-only brief for it and say in the brief which source was skipped.
   Pull the last 24 hours, within the caps in that file (default: 20 mail threads, 30 chat messages, meeting
   SUMMARIES only, never full transcripts: one transcript can fill the context window and end the run).
   Calendar: today and tomorrow.

4. Write the brief to `{{TALOS_HOME}}/memory/briefs/<today>.md`. Lead with what needs action. Then: what is on today and
   what the wiki already knows about the people in those meetings, what changed since yesterday's brief,
   and anything with a deadline inside 48 hours. Short enough to read standing up. Mark anything you
   inferred rather than read as an inference.

5. File selectively, at most five wiki writes in total. File only: (a) a person who appears in two or
   more sources, (b) a durable fact that changes an existing note (a role, a date, an owner), (c) a stub
   for a named thing the wiki has never heard of, plus the inbound [[link]] added to the note where the
   name came up (a stub with no inbound link is invisible). Never file meeting recaps, anything already
   present, speculation about people, or the brief itself. Follow the schema in `wiki/README.md` (four
   frontmatter keys, at least two outbound links, kebab-case names) and add one line to
   `wiki/_changelog.md`, newest first. Wiki files are written at `{{TALOS_HOME}}/wiki/...`. If more than five things deserve filing, file five and say in the
   brief that a human should look.

6. If you wrote any wiki note, finish by running, exactly,
   `python3 {{TALOS_HOME}}/scripts/wiki-lint.py wiki --extra-dir memory` and mention a non-clean result in the
   brief.

7. Your final message IS the Chronos report (Chronos writes the report file for you; you cannot, and need not).
   It is what gets delivered to the owner's phone or notification centre, and only its first few hundred
   characters survive. Start it with the three most important things from the brief as plain text (no tables,
   no markdown headings), then the path to the full brief, then anything that failed or was skipped.
