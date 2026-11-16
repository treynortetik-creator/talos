# Talos on a second person's Mac: the run sheet

For the first beta user: her own Mac, managed by her company, probably with **no admin password**, and an agent folder she
already runs from the early kit (1.x). Do the steps in order. Each step says who does it and what you should see. **If what
you see is different, take a screenshot** and write down the step number, then carry on if you can.

Who does what:

- **[HER]**: the person installing Talos on her Mac. Some steps only she can do (her passwords, her clicks, typing in
  Terminal).
- **[OWNER]**: the person who runs Talos already and runs her relay.
- **[AGENT]**: her own agent (Claude Code in her Terminal, in her agent folder). It runs commands and reads output for her.
  It never types a password, and it cannot run the commands Talos keeps for a person at the keyboard (`adopt`, `enroll`).
- **[IT]**: her company's IT or GRC team. Ask them the questions in section A before install day.

Words used below: **TESTED** means it was run on a Mac for this sheet (Apple Silicon, macOS 26, a throwaway home folder, on
2026-11-13; and again as a clean-HOME dry run on a second Mac, macOS 15.7, Apple Silicon, no Homebrew on the path, steps 4 to
10, on 2026-11-13, marked DRY RUN). **READ** means it is what the code or docs say. **NOT TESTED** means nobody has seen it on a managed Mac yet; it is
the best reading, and step G lists how to find out.

## A. Before install day: questions for IT and GRC

[HER] asks these, in writing, a week ahead. A "no" to 1 or 2 stops the install; the others have a way around them.

1. **Can a personal relay hold work messages?** Talos sends messages between her Mac and her phone through a small server
   (the relay) on Railway, a cloud host. It keeps undelivered messages for up to 7 days, encrypted, and media and app
   results for 7 days (`docs/SECURITY.md`). When notification text is on, the relay can read that text. Whoever holds the
   relay's `DATA_KEY` and the Railway account (the owner, today) could read what it stores. Ask: may work content pass
   through and sit on that server?
2. **May I install developer tools in my home folder?** Node, pnpm, Bun, Claude Code, tmux and Talos itself all go under
   her home folder (`~/.local`, `~/.bun`, `~/Library/Application Support/fnm`, `~/Applications`). None needs admin. Some
   companies forbid running programs from the home folder at all.
3. **Please install the Xcode Command Line Tools** (git and python3 come with them; Appendix 1). The Mac app comes prebuilt
   (step E), so any recent version will do; only the fallback, building the app on her Mac, needs Swift 6.2 or newer (Command
   Line Tools 26 or newer). There is no way to get these without admin.
   If IT will also install **tmux** (or Homebrew), say yes; otherwise step C has a route without admin.
   **She can check this herself first, in a minute:** in Terminal, `swift --version`. `Swift version 6.2` or newer is
   enough. A lower number (6.1 and older), `xcrun: error`, or a box offering to install the developer tools means: ask IT
   to install **Command Line Tools for Xcode 26** (Software Update, or `xcode-select --install`; both need an admin). The
   installer's pre-flight (step 6) says the same, but finding it out before install day saves the morning.
4. **Does our device management allow these?** A login item (Talos starts at login), Accessibility, Screen Recording and
   Full Disk Access for Talos (all optional; see step F), and a program that keeps the Mac awake while plugged in. Only for
   the fallback build: trusting a self-made code-signing certificate in her own login keychain.
5. **Does the network let a WebSocket out to `*.up.railway.app`?** If a proxy inspects TLS, Bun needs the company's root
   certificate (`NODE_EXTRA_CA_CERTS`). Ask for the certificate file if so.
6. **Does our endpoint security block unsigned or ad hoc signed programs, or tmux, bun or a long-lived socket?** Ask what it
   does on a block (quarantine, kill, alert) and who to call.
7. **Are there managed Claude Code settings?** Talos starts Claude Code with `--plugin-dir` and a development channel
   (`--dangerously-load-development-channels server:talos-app`) and a project MCP server. Managed settings can forbid each.

## B. [OWNER] Before install day

1. Push a fresh public snapshot, so her clone has the current installer (her updates come only from the public repo). Check
   it: the snapshot must hold this sheet (`docs/MAC-SECOND-USER-RUN-SHEET.md`) and `./install.sh --apply`. On 2026-11-13 the
   public snapshot was from 2026-11-09 and had neither (DRY RUN).
2. Deploy **her own relay** on Railway from the fork, with a new `DATA_KEY` and new VAPID keys (SETUP.md, step 4). Leave
   `BRIDGE_PUBKEY` empty for now. **One relay per person:** a relay has exactly one owner and one bridge
   (`docs/SECURITY.md`, `docs/SCHEDULES.md`). Pairing her phone or Mac with the owner's relay would make them devices of
   the owner's account, with the owner's threads and agent. Never do that. This is the same as the Windows user, who has a
   relay of her own (`docs/WINDOWS-PLAN.md`).
3. Send her the relay address (`https://<her relay>`), and nothing else from Railway.
4. **Optional: her bug reports to you.** Off unless you do this; nothing she sends leaves her relay otherwise. When she taps
   Report a bug, her relay keeps the report and, with these set, sends it (her words, the marked-up screenshot, versions,
   recent errors, the cleaned log, the thread and screen, and the last messages only if she ticked them) to the bug inbox on
   **your** relay, which files it on your Mac (`docs/ERRORS.md`, "Reports from another install"). Tell her, and IT (section
   A, question 1): her reports, screenshot included, then sit on your relay and your Mac.
   - Make one secret for her install: `echo "whsec_$(openssl rand -base64 32)"`. Pick a short name for her install, lowercase
     letters, digits and `-` (for example `beta1`; never her real name: it shows in your errors list).
   - On **your** relay (Railway variables): add `BUG_INBOX_SECRETS=beta1=whsec_...` (more installs: comma separated,
     `beta1=whsec_...,beta2=whsec_...`, one secret each). Redeploy. A malformed value stops your relay from starting (it
     says which variable), so watch the deploy log. One-line check that the inbox is on (sends nothing she wrote):
     `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your relay>/api/bug-inbox` prints `401` (on: an unsigned
     post is refused) or `404` (off: `BUG_INBOX_SECRETS` is not set).
   - On **her** relay: `BUG_WEBHOOK_SECRET=whsec_...` (the same secret) and
     `BUG_TEAM_INBOX_URL=https://<your relay>/api/bug-inbox`. Redeploy.
   - Check: on her phone, Report a bug says "Goes to: your relay, then the Talos team, with the screenshot." If she ever sets
     her own webhook address in Settings > Bug reports, hers wins and the line names its host instead: nothing then reaches you.
   - Check after her first report: on your Mac, `talos-app errors list` shows a line with `install:beta1 from another install`. Your
     Mac's Talos must be new enough to file these (its hello lists `problems-install/1`); an older one leaves them waiting on
     your relay, for up to `BUFFER_DAYS` (7 days by default), after which they are gone. If nothing arrives, her relay's log
     says `bug report webhook refused` with the status (401: the two secrets differ; 404: your inbox is off).
   - To stop her reports: take her entry out of `BUG_INBOX_SECRETS` and redeploy; her relay's sends are then refused (401).
     What your inbox lets through can be cut with `BUG_INBOX_NO_SCREENSHOT`, `BUG_INBOX_NO_LOGS`, `BUG_INBOX_NO_MESSAGES` and
     `BUG_INBOX_NO_THREAD` (each `1` to leave that part out; all off by default).

## C. [HER] and [AGENT] The pre-flight

4. **[AGENT] Find her agent folder and say it out loud.** In it: `pwd` and `cat .talos-version`.
   - Expect: a path like `/Users/<her>/my-agent`, and either `No such file or directory` (a kit 1.x folder from before
     versions were stamped: normal, step D handles it) or a line `version=1.x...`.
   - If the path is under `~/Desktop`, `~/Documents` or `~/Downloads`, or in a cloud-synced folder, stop and move the folder
     first (`mv`): macOS asks for access to those folders after every Claude Code update, and the ask blocks background runs.
     `./install.sh` refuses such a folder in step D unless given `--allow-protected-folder` or `--allow-synced-folder`, the
     same flags the kit installer takes.
5. **[HER] Clone the public Talos repo** outside Desktop, Documents and Downloads, for example `git clone <public repo> ~/talos`.
   - If macOS shows **"The git command requires the command line developer tools. Would you like to install the tools
     now?"**: the Command Line Tools are not there. Click **Not Now** and wait for IT (section A, question 3). With admin,
     **Install** works too (15 to 40 minutes; it looks frozen; do not cancel).
6. **[AGENT] Run the pre-flight.** In the clone: `./install.sh --dry-run --agent-dir <her folder>`.
   - It changes nothing. Step 1 lists every tool with its version, then any problem, one line each, with the way to fix it
     that needs no admin. Exit code 3 means at least one problem. Fix them all, then run it again until step 1 passes.
   - The lines it can print, and what to do (TESTED: each tool hidden from the path and each old version faked, in
     `scripts/root-install-preflight.test.ts`):

| Line starts with                                                                     | Who                 | No-admin fix                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Node 24 or newer`                                                                   | [AGENT]             | `curl -fsSL https://fnm.vercel.app/install \| bash -s -- --force-install`, new terminal, `fnm install 24 && fnm default 24` (TESTED: Node 24.22.3 installed into a throwaway home)                                                                                                                                                                                                                                      |
| `pnpm 10.33.0 or newer`                                                              | [AGENT]             | `corepack enable pnpm` (comes with Node 24). First use asks "Corepack is about to download ... pnpm-10.33.0.tgz. Do you want to continue? [Y/n]": answer `Y` (TESTED: pnpm 10.33.0)                                                                                                                                                                                                                                     |
| `Bun 1.4.4 or newer`                                                                 | [AGENT]             | `curl -fsSL https://bun.sh/install \| bash` (into `~/.bun`); an older Bun: `bun upgrade`                                                                                                                                                                                                                                                                                                                                |
| `Claude Code 2.1.304 or newer`                                                       | [AGENT], then [HER] | `curl -fsSL https://claude.ai/install.sh \| bash` (into `~/.local/bin`) or `claude update`; then [HER] runs `claude` once and signs in to **her own** Claude account in the browser. Claude Code's installer does not change the PATH: the pre-flight then says `Claude Code is installed (...) but ~/.local/bin is not on your PATH` and the one line to run (or run the tmux block below, which adds the same folder) |
| `tmux 3.2 or newer`                                                                  | [AGENT]             | the micromamba commands below, or `brew install tmux` when Homebrew is there, or ask IT                                                                                                                                                                                                                                                                                                                                 |
| `Xcode Command Line Tools with Swift 6.2 or newer` / `Swift 6.2 or newer: found 5.x` | [IT]                | none: "ask IT for the Xcode Command Line Tools with Swift 6.2+"                                                                                                                                                                                                                                                                                                                                                         |
| `git:` / `python3 3.9 or newer`                                                      | [IT]                | they come with the Command Line Tools (see the appendix for a no-admin stopgap)                                                                                                                                                                                                                                                                                                                                         |

**tmux with no admin password** (TESTED on Apple Silicon in a throwaway home: tmux 3.8, `tmux -V`, a server started and
killed on a private socket). The pre-flight prints these exact lines when tmux is missing (`osx-64` and its own checksum on an Intel Mac):

```bash
mkdir -p ~/.local/bin ~/.local/talos-tmux-tools
curl -fsSL -o ~/.local/talos-tmux-tools/micromamba.download https://github.com/mamba-org/micromamba-releases/releases/download/2.10.0-0/micromamba-osx-arm64
echo "c547639f5caf742236641c362746abb4a3505774753ecd08fe341643670c4c01  $HOME/.local/talos-tmux-tools/micromamba.download" | shasum -a 256 -c - && mv ~/.local/talos-tmux-tools/micromamba.download ~/.local/talos-tmux-tools/micromamba && chmod +x ~/.local/talos-tmux-tools/micromamba
~/.local/talos-tmux-tools/micromamba create -y -r ~/.local/micromamba -p ~/.local/talos-tmux -c conda-forge --override-channels 'tmux=3.8_'
if [ -e ~/.local/bin/tmux ] || [ -L ~/.local/bin/tmux ]; then echo "~/.local/bin/tmux is already there and was left alone (the Mac app also looks in ~/.local/talos-tmux/bin)"; else ln -s ~/.local/talos-tmux/bin/tmux ~/.local/bin/tmux; fi
grep -qxF 'export PATH="$HOME/.local/bin:$PATH"' ~/.zprofile 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
```

micromamba is pinned to release 2.10.0-0 and checked against the SHA-256 that release publishes (Intel:
`micromamba-osx-64`, `8421462a1ef1df9f7acd114f9e2a24c1332ce4f4e29f44465b4acb44e2755172`); tmux is pinned to conda-forge's
`3.8_`. Every line is safe to run twice (TESTED: the whole block run twice in a throwaway home; one PATH line in
`~/.zprofile`, and a `~/.local/bin/tmux` that is already there is left alone).

Then a new terminal, and `tmux -V` prints `tmux 3.x`. It takes about a minute and 30 MB. The Mac app does not depend on
that PATH line: started from Finder or at login it has a bare PATH, so it looks in `~/.local/bin` and
`~/.local/talos-tmux/bin` itself, after Homebrew's folders (`TalosAppLocator.findTmux`, used by `SupervisorController` and
the setup checklist; TESTED: `TmuxLookupTests`). The `~/.zprofile` line is for Terminal and for the agent. Without tmux,
`./install.sh --no-tmux` goes on: the agent then stops when the app quits, and thread sessions are off.

## D. [AGENT] then [HER] Her kit 1.x folder

7. **[AGENT] See the plan.** `./install.sh --agent-dir <her folder>` (no `--apply`). For a kit 1.x folder with no
   `.talos-version` it prints three plans and changes nothing (TESTED: `scripts/root-install-v1.test.ts`, the folder hashed
   before and after, `.git` included):
   - a) `kit/scripts/upgrade.sh --dry-run`: NEW, UPDATED, PROTECTED, ONLY IN YOUR FOLDER, HOOKS TO RECONCILE.
     PROTECTED starts with `covers, in your folder:` and names her own areas there, `memory/` with its file count (READ).
     **Stop if `memory/` is not in that line, or if any file under `memory/` or `wiki/` appears under NEW or UPDATED**
     (kit/UPGRADE.md, step 2). HOOKS TO RECONCILE says the installer's next step adds the hooks: nothing is merged by hand.
   - b) `kit/scripts/settings-merge.py`: the hook registrations it would add to `.claude/settings.json`.
   - c) `talos-app adopt --dry-run`: the `talos-app` server it would add to `.mcp.json` (her other servers stay). On a fresh
     clone it says "not checked yet: this clone has no node_modules" instead: `--apply` installs them and checks it then
     (DRY RUN). Its
     refusals (another clone's `talos-app` server, a broken `.mcp.json` or MCP-apps catalog) stop the run here, before any
     write; `--repoint` is passed on to adopt. Adopt itself, the write, runs only when [HER] types the command in Terminal (needed only in the repoint case; see step 9);
     from an agent it is printed for her.
   - Never written by any of them: `CLAUDE.md`, `memory/`, `wiki/`, `.learnings/`, `.env`, and `.claude/settings.json`
     beyond the hook entries in b).
   - It refuses, naming each one, a folder with a link on any path a step would write (a kit file, `hooks/`, `scripts/`,
     `.mcp.json`, `.claude/settings.json`, or a `.talos-version` link, even one that leads nowhere): a write would land outside
     the folder, where no rollback reaches. Replace each link with the real file or folder, then run it again.
8. **[AGENT] Tell her what changes, and where the backup goes.** Show her the counts from a) and the hooks from b). Ask her
   yes or no. Do not go on without her yes.
9. **[HER] Do it.** In Terminal, typed by her: `./install.sh --agent-dir <her folder> --apply`, then `y` at the question.
   - First it checks everything it can without writing: the folder's place, links, upgrade.sh's dry run, that
     `settings.json` and `.mcp.json` are valid JSON and the merge would go through. A problem there stops it with nothing
     changed (TESTED: a broken `settings.json`, `scripts/root-install-v1-review.test.ts`).
   - Then upgrade.sh (a full backup next to the folder, `<folder>-backup-<time>`, and a check that no protected file moved),
     then the gate: the kit's self-test in the upgraded folder, a few minutes. The installer runs it itself (upgrade.sh gets
     `--no-gate` and prints a red "GATE NOT RUN" line that refers to that) and records a pass. A failed gate stops the carry
     before anything else is written, and every later run reruns it until it passes (TESTED, R2-1). Then settings-merge.py
     (a backup of `settings.json` next to it first), then adopt. For a fresh install there is nothing for her to type here: step 10 adds the `talos-app` server to `.mcp.json` itself (DRY RUN). She types `adopt` (with `--repoint`) only when the plan says her folder's `talos-app` server points at another clone.
   - While it runs, the folder holds a file `.talos-carry`, written before the first change and removed after the last. If
     the run stops after upgrade.sh, running the same command again finishes it (the merge and adopt, no second upgrade).
     A folder without that file is never treated as half carried, whatever its hooks look like (TESTED:
     `scripts/root-install-v1-review.test.ts`, R2-2).
   - Expect at the end: `== Carried onto this kit`, the list of what was done, and the next command.
   - Undo: the `Undo all of it:` line at the end (upgrade.sh's `--rollback`). Keep it. `.mcp.json` and
     `.claude/settings.json` are in that backup and its receipt before they are written, so the rollback puts them back
     too (TESTED: `scripts/root-install-v1-review.test.ts`, R1-6).
   - TESTED end to end on a copy of the kit 1.x layout (`scripts/v1-agent-fixture.sh`): the gate passed ("ALL 63 CHECKS
     PASSED"), the pre-tool guard hook was added and registered, her permission rule kept, and `CLAUDE.md`, `memory/`,
     `wiki/`, `.learnings/LEARNINGS.md` and `.env` were byte-for-byte the same (`cmp`) afterwards. DRY RUN: about 5 to 6
     minutes (the dependencies, then the gate, "ALL 63 CHECKS PASSED"), with `--yes` in place of her `y`.
   - If the gate fails, the last line says whose problem it is (the kit's own test, or her folder or this Mac) and the three
     steps: roll back (the command it prints), update the kit with `git pull` or fix what is named, run step 9 again. Do
     them in that order: run again without the rollback, and the folder still has the failing test (DRY RUN: rollback in
     1 s; the second run redid the upgrade and passed).
10. **[AGENT] Finish the install.** `./install.sh --agent-dir <her folder> --yes --no-app` (the prebuilt app is step E; without
    `--no-app` this step builds the app on her Mac, the fallback). The folder is now a Talos agent: it adds the launch script
    and checks the `talos-app` server. DRY RUN (with `--no-app`, Swift too
    old there): 4 seconds; it wrote the `talos-app` server into `.mcp.json` (her own server kept) and `start-talos.sh`.
    - It may print `2 notes about your own files, not part of the install` (DRY RUN: "wiki/me.md has only 1 outbound links
      (need 2)", "wiki/_onboarding-progress.md missing") and, at the end, `the install itself is done`. They are about the
      agent's notes; the agent can tidy them later with her.
    - Without the Command Line Tools' Swift 6.2 the pre-flight stops here; `--no-app` lets everything but the Mac app go
      ahead while IT installs them (DRY RUN: Swift 6.1.2 from Command Line Tools 16.4 is refused).

**Before the app is installed: `--no-app`** (READ). Steps 6 to 10 with `--no-app` set up everything but the Mac
app (DRY RUN). She can then start the agent from Terminal with `./start-talos.sh` in her folder, pair her phone (step 17,
`talos-app enroll`, a Terminal command) and use Talos from the phone while that Terminal window stays open and the Mac is
awake: the bridge is the `talos-app` server Claude Code starts from `.mcp.json`. What she does not get until the app is
built:

- **one conversation only**: no thread sessions (the app starts them on a Mac);
- **nothing restarts the agent if it stops**: not when Claude Code exits or crashes, and not at login (the app does that on a
  Mac);
- no screen control (the `screen_*` tools go through Talos.app's own helper, `docs/bridge.md`);
- no keep-awake on power (`caffeinate -dis` in a second Terminal tab is the stopgap);
- no setup checklist or Talos notifications on the Mac; macOS asks on behalf of Terminal, not Talos.

She keeps: the agent in Terminal with the Talos mod, her phone (pairing and chat), `talos-app doctor` and `talos-app update`.

Step E installs the app.

## E. [HER] The Mac app: the prebuilt Talos

The Mac app comes prebuilt: signed with the owner's Developer ID, notarized by Apple and stapled, so her Mac needs no Swift, no
build and no signing certificate, and macOS keeps her permissions across updates (they are tied to the signature, which stays the
same). Run step 10 with `--no-app`, then these steps. [OWNER] puts three values on the sheet before install day: the zip's
address (or a file to copy over), its sha256 and the team id, all printed by `apps/desktop/scripts/release-app.sh`.

11. **[AGENT] Install the prebuilt app**, from her clone:
    `bash apps/desktop/scripts/install.sh --from-release <zip address or path> --sha256 <sha256> --team <team id>` (into
    `~/Applications`, no admin). Before anything is installed it checks, in this order: the sha256, that the zip holds only
    Talos.app, the signature (`codesign --verify --strict --deep`), Gatekeeper (`spctl`: notarized Developer ID) and that the
    signer is a Developer ID of the owner's team through Apple's certificates; the last three run again just before the app is
    moved into place. Any failure ends with `install: stopped, nothing was installed:` and
    the reason (exit 9). When every check passed, and only then, it removes macOS's download flag (`com.apple.quarantine`, put on
    the zip by the browser) from the installed copy only, never from the zip, and says so in one line: "checked: sha256 matches,
    notarized by Apple, signed by team <team id>; removed the download flag". That is what lets Talos open from
    `~/Applications` with no "downloaded from the Internet" question and not from a temporary copy (TESTED with stand-ins for
    Apple's answers: `release-install-test.sh`, "the download flag"). Node is not needed for this step on a Mac that has no
    relay set yet: it prints "no relay is set ... the wait for the relay's version is skipped" (TESTED: `relay-wait-test.sh`).
    It then records her clone for the app, since a prebuilt app carries none: "Talos will use this clone
    (...) for its agent folder setup". TESTED on a Mac with local zips (`apps/desktop/scripts/release-install-test.sh`), with the
    Gatekeeper step answered by a stand-in for the cases after it; NOT TESTED with a real notarized download (no Developer ID
    certificate yet).
    - `this Talos is signed by another identity than the installed one` (exit 10): a Talos she built herself is installed.
      Run the same line with `--new-identity`, then do what it prints: in System Settings → Privacy & Security, select Talos
      under Screen & System Audio Recording and under Accessibility, press −, and press Grant in Talos's Permissions again.
12. **[HER] Open Talos** from `~/Applications`, unless it opened by itself. In Setup, Agent folder, use **Choose** with her
    folder (step 10 with `--no-app` does not name it to the app). The first time, Talos shows the clone it will run scripts from
    and asks "Use this clone"; it should be her clone from step 5. It asks again only if that record changes. macOS should show no dialog before Talos's first screen, because step 11
    removed the download flag after its checks. If macOS asks "downloaded from the Internet... Open?" anyway, step 11 printed a
    warning that the flag could not be removed: quit Talos, run the `xattr -dr com.apple.quarantine` line it printed, and open
    it again. A Talos opened with the flag still on runs from a temporary copy; it says so once in its default thread and takes
    no updates until it is moved to Applications and reopened.
13. **Later updates** are the same line with the new zip's address and sha256. Her permissions stay.
    - **If the publishing Mac is lost:** the release key lives only in its Secure Enclave and cannot be backed up, so her Talos
      stops taking automatic updates; she needs one install by hand (this step) of a build that pins the new key.

Where the zip lives (for [OWNER]): a release of a private GitHub repository needs her to sign in, so either attach the zip to a
release of the public repository when the snapshot is published, or hand her a link that expires (a signed URL from any file
host). The sha256 on the sheet is what makes either one safe to download: a different file is refused.

### Fallback: build the app on her Mac

Only if the prebuilt app cannot be used (for example, before the owner has a Developer ID certificate). This needs the Command
Line Tools with Swift 6.2 or newer (section A, question 3) and a local signing certificate.

A Talos.app built on another Mac does not work on hers: `build-app.sh` writes the path of the clone it was built from into
the app, and Create, Adopt and Choose need that clone. Such an app says: "This Talos was built from <path>, which isn't on
this Mac. Rebuild it from your own clone" (TESTED: `AgentFolderSetupTests.aCloneFromAnotherMacSaysWhereItWasBuiltAndToRebuild`).
A build made on her own Mac also carries no quarantine flag, so Gatekeeper does not stop it (NOT TESTED on a managed Mac).

- **[HER] A local signing certificate, before the first build:** `bash apps/desktop/scripts/make-signing-identity.sh`.
  macOS asks for **her login password** once, to trust the certificate for code signing in her own keychain (her password, not
  an admin one; NOT TESTED on a managed Mac, see G1). Without it the build stops: "no signing identity on this Mac. Run bash
  apps/desktop/scripts/make-signing-identity.sh once" (an ad hoc build would lose its privacy grants on every rebuild, and every
  start of the app would show the development-channel popup, because an ad hoc build cannot read the launch seal in the
  Keychain).
- **[AGENT] Build and install.** Step 10 without `--no-app` does it, or by hand:
  `bash apps/desktop/scripts/build-app.sh --release && bash apps/desktop/scripts/install.sh` (into `~/Applications`, no admin).
- **[HER] Open Talos** from `~/Applications`, unless it opened by itself: the app installer opens it at the end (READ,
  `apps/desktop/scripts/install.sh`). Before installing it prints "no relay is set in this Mac's Talos settings (not
  paired), so the wait for the relay's version is skipped": normal on a first install.

## F. The macOS prompts, and what to answer

The words are approximate (READ from the app and the scripts, NOT TESTED on her Mac); a managed Mac can hide or lock any of
these (G1).

| When                                                                              | What it says (about)                                                                                                       | Answer                                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `git`, `python3` or `swift` run with no Command Line Tools                        | "The ... command requires the command line developer tools. Would you like to install the tools now?"                      | **Not Now** if she has no admin; IT installs them                                                                      |
| make-signing-identity.sh (fallback build only)                                    | a password box: "You are making changes to your Certificate Trust Settings"                                                | her login password                                                                                                     |
| Corepack's first pnpm (step 6)                                                    | "Corepack is about to download ... Do you want to continue? [Y/n]" (in Terminal)                                           | `Y`                                                                                                                    |
| First start of `claude` in her folder                                             | "Do you trust the files in this folder?"                                                                                   | Yes (it is her folder)                                                                                                 |
| First start with the talos-app server                                             | Claude Code asks to approve the project MCP server `talos-app`                                                             | Approve                                                                                                                |
| Reinstalling while Talos runs (`apps/desktop/scripts/install.sh` asks it to quit) | "“Terminal” wants access to control “Talos”" (Automation; READ, not seen)                                                  | OK. With "Don't Allow" the install stops: "Talos did not quit; quit it from its menu and run this again"               |
| Every changed start                                                               | a Talos popup on the Mac: "Allow Talos's development channel?", buttons "I am using this for local development" and "Exit" | **I am using this for local development**, clicked with the mouse or trackpad (a scripted click is ignored on purpose) |
| Setup checklist, Permissions                                                      | "Talos would like to send you notifications"                                                                               | Allow                                                                                                                  |
| Setup checklist, Permissions, only when she presses Ask now                       | "Talos would like to access files in your Desktop / Documents / Downloads folder"                                          | Allow only the ones her agent needs                                                                                    |
| Setup checklist, Permissions                                                      | Full Disk Access, Accessibility, Screen Recording: System Settings opens; she switches Talos on there                      | Optional. Skip any her company forbids                                                                                 |
| The agent first scripts an app                                                    | "Talos wants access to control <app>" (Finder, System Events, Mail, Calendar, ...)                                         | Allow only for apps she wants the agent to use                                                                         |
| Start at login is turned on                                                       | a notification "Background Items Added" naming Talos                                                                       | leave it on (System Settings, General, Login Items)                                                                    |
| Microphone or camera, first use                                                   | "Talos would like to access the microphone / camera"                                                                       | Allow if she uses voice                                                                                                |

## G. Corporate-Mac unknowns, with a test for each

All NOT TESTED until someone runs them on her Mac. Each test is one command or one click; write down what happened.

1. **Device management (MDM) rules.** Test: step 11 (the prebuilt app installs and opens), step 12 then Start at login (a login item, or the
   LaunchAgent fallback in `~/Library/LaunchAgents`), and each Ask now in Permissions. Pass: each one either works or is
   greyed out with a "managed by your organization" note. Report which.
2. **The proxy and the relay.** Test: `curl -sS https://<her relay>/healthz` (expect a short OK body), then
   `talos-app doctor` once the bridge runs (expect no FAIL line). A certificate error means TLS inspection: ask IT for the
   root certificate and set `NODE_EXTRA_CA_CERTS` to its path.
3. **Managed Claude Code settings.** Test: `./start-talos.sh` in her folder once. Pass: Claude starts with the Talos mod and
   the development-channel warning. Fail: a message that a flag, plugin directory or MCP server is not allowed by policy.
   Also `cat "/Library/Application Support/ClaudeCode/managed-settings.json"` (it may not exist: that is good news).
4. **Endpoint security.** Test: run Talos for 24 hours with the agent started from the app. Pass: `bun`, `tmux` and
   Talos.app are still there and running; no security alert. Fail: any of them quarantined or killed.
5. **Her folder.** Test: step 4. An unstamped folder takes step D. A folder stamped `1.x` is already a Talos agent to
   `./install.sh`, so step D does not run for it: [AGENT] follows kit/UPGRADE.md by hand (the same three tools). A folder
   under Documents is moved first.
6. **Home-folder programs.** Test: after step C, `~/.local/bin/tmux -V` and `~/.bun/bin/bun --version` (prints 1.4.4 or
   newer). Fail: "operation not permitted" or the program is killed at start (a policy that blocks programs in the home
   folder).
7. **Keep-awake.** Test: leave the Mac plugged in and idle for an hour with Talos running, then send a message from her phone.
   Pass: the agent answers. A Mac that sleeps anyway is under a power policy.

## H. [OWNER] and [HER] Relay, bridge and phone

14. **[HER] Set up the bridge for her relay.** `apps/bridge/scripts/install.sh --agent-dir <her folder> --relay-url https://<her relay>`.
    Expect a last line starting `BRIDGE_PUBKEY=` (a public key: safe to send).
15. **[HER] Send that line to the owner.** **[OWNER]** pastes it into her relay's Railway variables and redeploys.
16. **[HER] Start the session** in the app; click through Claude's folder trust, the MCP approval and the channel popup
    (step F). **[AGENT]** runs `talos-app doctor`: no FAIL line.
17. **[HER] Pair her phone.** In Terminal, typed by her: `talos-app enroll --label phone`. Open the link in Safari on her
    iPhone, add it to the Home Screen, create a passkey, compare the four words, type `y`. Turn on notifications (iOS 18.4
    or newer). The phone uses this web app; the owner's TestFlight app only talks to the owner's relay.

## Appendix 1: does her Mac need the Command Line Tools if the app ships prebuilt?

Yes, in practice, even with the prebuilt app (step E). Swift is the only part of them the build needs, and the prebuilt app
does away with the build, but other parts are needed every day:

- **git** (`/usr/bin/git` is a stub that asks to install the tools): needed to clone the repo, for `talos-app update`
  (`git pull --ff-only`), and by the installer and `verify-install.sh`, which keep the agent folder in a git repository.
- **python3** (`/usr/bin/python3` is the same kind of stub): every kit hook, the installer, `upgrade.sh`, `settings-merge.py`
  and the memory tools run on it. And a thread session's permission hook runs only on a python3 **outside** the home folder
  and not Apple's stub (`WorkerHookPython.swift`, lines 1-13): on a Mac with no admin that means the Command Line Tools'
  own interpreter (or Xcode's), found on disk at `/Library/Developer/CommandLineTools/usr/bin/python3`.
- **Not needed from them:** `pnpm install` compiles nothing here. `better-sqlite3` 13.0.3 (used only by `apps/relay`) ships
  prebuilt binaries and sets `"gypfile": false`; `esbuild` comes as a prebuilt package (checked in `node_modules` on
  2026-11-13). `codesign`, `security`, `plutil` and `openssl` are part of macOS itself.
- **A stopgap with no admin** (TESTED in a throwaway home): micromamba can put git 2.56 and Python 3.12 under `~/.local`
  (`micromamba create -p ~/.local/talos-tools -c conda-forge --override-channels git python=3.12`, about 320 MB). That
  covers the main agent's hooks and git, but **not** thread sessions, whose hook refuses a python3 in the home folder.

So the ask to IT stays "the Xcode Command Line Tools"; with the prebuilt app any recent version will do, and Swift 6.2 or newer
matters only for the fallback build.

## Appendix 2: the tmux routes

Timebox 30 minutes. The first candidate worked, so the others were not tried.

| Route                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| micromamba (2.10.0) + conda-forge `tmux` 3.8 into `~/.local`             | **Works** (TESTED 2026-11-13, Apple Silicon, throwaway HOME, no admin): `tmux -V` printed `tmux 3.8`; `tmux -L test-<random> new-session -d` started a server, `ls` listed it, `kill-server` ended it, and `ls` afterwards said "no server running". The binary links only system libraries plus its own under `~/.local/talos-tmux/lib`; it carries no quarantine flag (downloaded with curl). The server socket is under `/private/tmp/tmux-<uid>/`, as for any tmux. Then the five lines the pre-flight prints were run verbatim in a second throwaway home, and a new login shell (`zsh -l`) found `~/.local/bin/tmux` through `~/.zprofile`, printed `tmux 3.8`, and started and killed a server the same way. |
| pixi                                                                     | not tried (the first route worked)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| nix, single-user                                                         | not tried; single-user nix on macOS needs a `/nix` volume, which needs admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| a relocatable tmux and libevent built once and unpacked under `~/.local` | not tried; it would need a maintained build and its own signing story                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Fallback when micromamba is blocked: "ask IT for tmux (or Homebrew)", or `./install.sh --no-tmux`.
