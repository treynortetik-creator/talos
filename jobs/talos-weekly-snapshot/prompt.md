You are running the Talos weekly snapshot for the person who owns this agent.

The agent folder is {{TALOS_HOME}}. If your working directory is not that folder, cd there first.

1. Run `git rev-parse --is-inside-work-tree` in the agent folder. If that fails, the folder is not a git
   repository: say so in the report and stop. Do not run `git init` here.
2. Run `git remote -v`. If a remote is configured, that is fine, but you will not use it.
3. Run `git status --porcelain -- memory wiki .learnings`. If there is nothing to commit, say so in the
   report and stop.
4. Check that no staged or changed path is a `.env` file or anything under a `personal/` folder. If one
   is, stop and report it. Do not commit.
5. Run `git add memory wiki .learnings`, then
   `git commit -m "weekly snapshot $(date +%Y-%m-%d)"`.
6. Report the number of files committed and the short commit hash.
