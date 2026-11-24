---

name: rollcall
description: Who in the fleet is reachable, and each machine's one-line status. Use right after a session start or a plan switch, or when asked for a roll call, before you rely on another machine's session being there. Prints one table and sends nobody a message.
version: 1.0.0
---

# rollcall: who is reachable, and what each one last said

Each machine publishes one status line (its headline) to its own ref on origin, and the roster of members is one more ref. A
lead reads them back, matches them to the sessions it can see, and prints one table. Nothing here messages anyone.

## What to do

1. Run `bash scripts/fleet-rollcall.sh --json`. It is read-only (it changes no branch, file or index). Each row has `name`,
   `aliases`, `headline`, `age_seconds`, `age` and `stale` (over 2 hours); a member that never published has a `null`
   headline. If it says the roster is missing, say so in the table's first line and use the refs it did list.
2. Call the ListAgents tool for the sessions you can see.
3. Match each roster member to the listing's rows by its name or any of its aliases, ignoring case.
4. Print one table, a row per roster member:

   | member | live state | address to message | headline | age |
   | ------ | ---------- | ------------------ | -------- | --- |
   - live state is `running`, `idle` or `offline`, as the listing shows it.
   - the address is the matching row's name, plus its `[ref]` when two rows share that name.
   - a member with NO matching row prints its last headline and age, and "not reachable: may need a restart".
   - an age marked stale keeps its STALE flag.

Send no message to anyone, and do not start or restart a session: the table is the whole job.

## Keeping your own line current

Update your headline with `TALOS_MACHINE=<your machine> bash scripts/fleet-state-push.sh "<one line>"` in the same turn your
live state file's NOW line changes. A headline is at most 160 characters, one line, plain ASCII. Never write a name of a
person or company, a path or an id in it: the personal-data scan catches some of that, never all of it. The roster is
published with `bash scripts/fleet-state-push.sh --roster <file>` (one member per line: `name alias1 alias2 ...`); it is
never committed to the repository.
