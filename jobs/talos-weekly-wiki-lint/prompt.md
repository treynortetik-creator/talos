You are running the Talos weekly wiki check for the person who owns this agent.

The agent folder is {{TALOS_HOME}}, and it is your working directory. This job is RESTRICTED: Chronos starts it
with read and search tools and exactly four commands (named below), and no write tool at all. Anything else is
refused by the permission system. Do not `cd`.

0. Refresh the memory search index, if it is installed: run in the FOREGROUND, exactly,
   `bash {{TALOS_HOME}}/scripts/memory/refresh-index.sh` and wait for it (a second when nothing changed). If it
   says memory search is not installed, skip this step silently. If it fails any other way, carry on and say in
   the report that the search index is stale.

1. Run `date`.
2. Run, exactly, `python3 {{TALOS_HOME}}/scripts/wiki-lint.py wiki --extra-dir memory` and keep its full output.
3. Run, exactly, `python3 {{TALOS_HOME}}/scripts/deep-dive-select.py wiki` if that script exists, and note the
   top three entries of its queue (these are the stubs and thin notes most worth filling in).
4. Run, exactly, `bash {{TALOS_HOME}}/scripts/claude-md-lint.sh` if that script exists, and keep its output. It checks that
   `CLAUDE.md` is under its word cap, that every red-marked rule carries an `[R-nn]` key, and that every key
   has an entry in `memory/rules-ledger.md`. Report any line that begins `FAIL`, and any expired observation it
   lists. Do not edit `CLAUDE.md`.
5. Run `git status --short -- memory wiki .learnings` (no pipe) if the folder is a git repository, and count the
   uncommitted lines yourself.
6. Your final message IS the report (Chronos writes the report file). First line: `clean` or the number of lint errors and warnings. Then the lint findings
   grouped by kind, one line each with the note path. Then the config lint result (one line). Then the three
   deep-dive candidates. Then the uncommitted count. Plain text, no tables. If the lint is clean and nothing else needs attention, say
   exactly that in one sentence.

Do not fix anything. Fixing is a conversation with the owner, in a live session.
