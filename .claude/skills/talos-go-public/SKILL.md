---
name: talos-go-public
description: Gate for making a GitHub repo public: account check, secret scan plus a personal/employer content read, fresh squashed repo, README/LICENSE/tag, logged-out verification. On demand only. Use when the user says "make X public", "open source this", "squash it into a fresh repo", or "check for leaks before going public".
---

# go-public: the gate before a repo becomes public

Public is irreversible. A leaked key can be rotated; a customer list, a salary, a medication or a child's routine
cannot. The helper is `bash scripts/go-public.sh`. It is read-only by default and only creates or changes anything
when given `--yes-i-reviewed`. **The scanner finds patterns; it cannot judge content. The content read (step 4) is
yours.**

## Hard rules

- **Only repos the user has NAMED.** "Make the apps public" is not a name. Never infer a repo from a list, a sweep
  or an org. If unsure which one, ask.
- **Account:** the publish account comes from config, never from you. `gh api user -q .login` must equal the account in
  `${XDG_CONFIG_HOME:-~/.config}/talos/github-account`, or `$TALOS_GITHUB_ACCOUNT`, or `--account NAME`. No config or a
  mismatch: STOP and tell the user exactly what the script printed. **Never switch or log in to a `gh` account
  yourself:** it is machine-wide state and breaks git auth in every repo. The user does it.
- **Never print a secret value**, not even part of one. Report `file:line` and the type only (the script does). A
  sub-agent brief must name the safe command, because "never print secrets" alone is not enough; say which tool and
  flag (for example `gitleaks --redact=100`).
- **Never rewrite history in place or flip an old repo.** GitHub keeps `refs/pull/*` and commit URLs after a force-push.
  Always recreate a fresh repo; the old one stays private or the user deletes it.
- **Nothing becomes public without the user's explicit yes on the scan report.** `recreate` only ever makes a PRIVATE
  repo; `publish` is a separate command and a separate yes.
- Say what you could NOT check (binaries, images, private submodules). Never write "clean"; write "no findings in X, Y, Z".

## Steps

1. **Confirm the name.** Echo back the exact repo(s) and where each lives on disk.
2. **Account + scan, read-only:** `bash scripts/go-public.sh check <path>` (add `--account NAME` if no config yet).
   The scan uses the same patterns as `scripts/test-privacy.sh` (API keys, tokens, PEM keys, personal emails,
   home-folder paths, long ids) over the working tree AND every commit, flags data/credential file types, and applies
   the user's private denylist if `TALOS_PRIVACY_DENYLIST=/path/to/file` is set (one term per line; the file lives
   OUTSIDE the repo and is never committed or echoed). If gitleaks is installed, run it too with redaction as a
   second opinion.
3. **Ask for the denylist if there is none.** Employer, customers, family names, hometown, ids: only the user knows
   them. Offer to create the file outside the repo, then re-scan.
4. **Content read.** Read the file list and the files, or have a sub-agent read them (judgment stays with you). Look for:
   - **Employer:** customer or facility names, internal docs, exports, pipeline or budget data, tickets, chat or
     meeting content, product internals, anything under NDA or covered by privacy law.
   - **Personal:** health, finances, salary, home location, family, daily schedule, anything from a private vault,
     the agent's own memory folders.
   - **Maintainer junk:** build logs, audit notes, journals, learnings files, system prompts. Ship by allowlist.
   - Comments explaining why a guard exists stay; prose narrating version history goes.
5. **Report to the user** (a file, a table: finding, file:line, type, severity, proposed fix: remove / rewrite / waive).
   Findings only in history die with the recreate; findings in HEAD need an edit. A real credential means: tell the
   user to rotate it now, whatever the plan. Ask for the yes and **stop until it comes.**
6. **Fix HEAD**, re-run `check` until clean or each leftover is waived by the user in words.
7. **Plan the recreate:** `bash scripts/go-public.sh plan <path> <new-name>`. It prints the steps, the file count and the
   commit author that will become public (check that it is not a personal address). Show the plan.
8. **README and LICENSE** must be in the tree first: ask the user which license (MIT is a common default), write an
   honest README, re-run `check`.
9. **Recreate, still private:** `bash scripts/go-public.sh recreate <path> <new-name> --yes-i-reviewed`. It re-checks
   the account and the scan, copies tracked-and-unignored files into a fresh dir, makes ONE commit, creates a private
   repo, pushes, and tags (`--tag vX.Y.Z`, default v0.1.0).
10. **Ask once more:** "Make `<owner/repo>` public?" Only on a yes:
    `bash scripts/go-public.sh publish <owner/repo> --yes-i-reviewed`.
11. **Verify logged out:** `bash scripts/go-public.sh verify <owner/repo>` (plain curl, no credentials: HTTP 200 and the
    API says `private=false`). Open the README and release page too. Report the URL.
12. **Log it** in the project's doc. Remind the user the old repo and its history still exist; deleting it is their call.

## Gotchas

- Forks and PRs keep old commits: check `gh repo view --json forkCount` before reusing a name that was ever public.
- Submodules, vendored dirs, `node_modules`, `.env.example` with real values, screenshots of dashboards, image
  metadata, notebooks with saved output.
- A zip or release asset is a second publish surface: scan it too.
- Demo data is invented, not "anonymized" real data.
- This skill is INSTRUCTED behaviour; what the script itself ENFORCES is: no change without `--yes-i-reviewed`, account
  match, scan clean before a recreate, and README and LICENSE present.
