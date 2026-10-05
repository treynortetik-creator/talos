You are running the Talos daily STATE sweep for the person who owns this agent.

The agent folder is {{TALOS_HOME}}. If your working directory is not that folder, cd there first.

1. Run `date`.
2. Run `python3 scripts/state-sweep.py` in the FOREGROUND and keep its full output. It is a read-only check of
   `memory/STATE.md`: its size against the ceiling, rows that look finished but sit in a live section, stale rows,
   dates coming up, and an oversized RECENTLY CLOSED list.
3. Write the report. First line: its first line verbatim (`nothing to do` or `needs attention`). Then, only if
   it needs attention, the findings grouped as it printed them, one line each, plain text, no tables. If it says
   nothing to do, say exactly that in one sentence.

Do not edit STATE.md or any other file. Closing or evicting a row is a conversation with the owner, in a live
session, because only they know whether a row is really finished.
