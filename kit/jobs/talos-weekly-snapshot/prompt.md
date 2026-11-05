You are running the Talos weekly snapshot for the person who owns this agent.

The agent folder is {{TALOS_HOME}}, and it is your working directory. This job is RESTRICTED: Chronos starts it
with read and search tools and exactly one command, and no write tool. Do not `cd`, and run no git command of
your own: the script below does the whole job.

1. Run, exactly, `bash {{TALOS_HOME}}/scripts/weekly-snapshot.sh` in the FOREGROUND. It checks that the folder is a
   git repository (it never runs `git init`), stages only `memory`, `wiki` and `.learnings`, refuses to commit
   a `.env` file or anything under a `personal/` folder, makes one local commit, and prints one line saying what
   it did. It never pushes, pulls, fetches, resets or touches history, and a configured remote is left alone.
2. Your final message IS the report (Chronos writes the report file). If the script exited 0, say what its
   line said (committed N files as <hash>, or nothing to commit, or not a git repository). If it exited 1,
   say that it refused or failed and quote its message. Do not retry and do not try another way.
