You are running the Talos weekly wiki check for the person who owns this agent.

The agent folder is {{TALOS_HOME}}. If your working directory is not that folder, cd there first.

0. Refresh the memory search index, if it is installed: when
   `test -x "${XDG_DATA_HOME:-$HOME/.local/share}/talos/venv/bin/python"` succeeds, run in the FOREGROUND
   `"${XDG_DATA_HOME:-$HOME/.local/share}/talos/venv/bin/python" scripts/memory/mem_index.py --quiet` and wait
   for it (a second when nothing changed). If it fails, carry on and say in the report that the search index
   is stale. If the venv does not exist, skip this step silently.

1. Run `date`.
2. Run `python3 scripts/wiki-lint.py wiki --extra-dir memory` and keep its full output.
3. Run `python3 scripts/deep-dive-select.py wiki` if that script exists, and note the top three entries
   of its queue (these are the stubs and thin notes most worth filling in).
4. Run `bash scripts/claude-md-lint.sh` if that script exists, and keep its output. It checks that
   `CLAUDE.md` is under its word cap, that every red-marked rule carries an `[R-nn]` key, and that every key
   has an entry in `memory/rules-ledger.md`. Report any line that begins `FAIL`, and any expired observation it
   lists. Do not edit `CLAUDE.md`.
5. Run `git status --short -- memory wiki .learnings | head -20` if the folder is a git repository, and
   note how many files are uncommitted.
6. Write the report. First line: `clean` or the number of lint errors and warnings. Then the lint findings
   grouped by kind, one line each with the note path. Then the config lint result (one line). Then the three
   deep-dive candidates. Then the uncommitted count. Plain text, no tables. If the lint is clean and nothing else needs attention, say
   exactly that in one sentence.

Do not fix anything. Fixing is a conversation with the owner, in a live session.
