# The Mac app (Talos.app)

A small menu-bar app for your Mac. It is optional: everything in [`SETUP.md`](SETUP.md) works without it. What it adds:

- **It runs your agent for you.** Talos starts `claude` inside a tmux session, presses Enter on the development-channel
  dialog (every start, when the screen is exactly the warning for the one channel Talos adds, `server:talos-app`), and starts it again (resuming the conversation) if it crashes. Without tmux the agent still runs, but it stops
  when you quit Talos.
- **A menu-bar icon that tells you the truth**: the session, the bridge and the relay each report separately.
- **Windows**: the Talos web app in its own window, the agent's terminal, and a quick-compose panel you can open from any
  app with a hotkey (default Control-Option-Space).
- **Notifications** with fixed text only ("New reply in General"), never message content.
- **A desktop companion** (off until you turn it on): a small figure that shows when the agent is working or needs you. When idle it breathes, blinks, fidgets and takes short walks along its line, and nine times a day, spread across the whole 24 hours (quiet hours included, at least 40 minutes apart), it goes on a longer round; "Rounds and little moments" in settings turns the fidgets, walks and Rounds off; the breathing, blinks, ember, direct reactions, dozing off and waking stay.

It is built from source on your Mac. There is no download.

## What you need

- A Mac on macOS 14 or newer, with the Swift command line tools (`xcode-select --install`). You do not need Xcode.
- The bridge installed and working: [`SETUP.md`](SETUP.md) steps 1 to 4. Use the bridge from this same checkout.
- `claude` (Claude Code) on your PATH.
- Optional but recommended: `tmux` 3.2 or newer (`brew install tmux`), so the agent keeps running when you quit or update
  Talos.

## Build and install

From the repository folder:

```bash
apps/desktop/scripts/make-signing-identity.sh   # once: a free local certificate (one password prompt)
apps/desktop/scripts/build-app.sh               # builds apps/desktop/.build/app/Talos.app
apps/desktop/scripts/install.sh                 # copies it to ~/Applications and opens it
```

- The certificate matters because macOS ties its privacy grants (Desktop folder, microphone, and so on) to how an app is
  signed. An unsigned (ad hoc) build looks like a new app after every rebuild, so macOS asks again each time. Without a
  certificate `build-app.sh` stops before building and says how to make one; `TALOS_SIGN_ID=-` builds ad hoc on purpose
  (tests and CI). Set `TALOS_SIGN_ID` to use a different identity; with `TALOS_REQUIRE_SIGN_ID=1` only that one is used.
- `build-app.sh` ends by verifying the signature and running the app's self-test; if either fails, so does the script.
  `--release` builds the optimised version.
- `install.sh` installs for you only (it refuses `/Applications`, `/System` and the other system folders). It replaces an
  existing Talos, and refuses to touch any other app called `Talos.app`. If Talos is running it asks it to quit first (a
  tmux agent keeps running) and reopens the new copy. `--dest <folder>` picks another folder, `--no-open` and `--no-quit`
  do what they say.
- On a paired Mac, `install.sh` first waits (up to 10 minutes, checking every 15 seconds) until the relay serves the same
  build or a newer one, so the web app never shows "Talos on your phone or Mac is newer than this app" because the Mac got
  ahead of a relay deploy. It reads the relay address from the Mac's own Talos settings and never prints it. If the relay is
  still behind, can't be reached or answers oddly, it stops with one line and installs nothing; run it again later, or pass
  `--no-relay-wait` to install anyway. A relay on another branch than the build stops at once (waiting would not help);
  a relay whose version is not a commit (a tag or a package version) can't be compared, so the install goes ahead and says
  so. `--rollback` never waits.

### The prebuilt app

A Mac that should not build Talos installs a prebuilt one instead: Developer ID signed with the hardened runtime, notarized by
Apple and stapled.

```bash
# on the publishing Mac (env: TALOS_RELEASE_SIGN_ID, ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID; see the script's header)
apps/desktop/scripts/release-app.sh                       # universal (Apple Silicon and Intel); --arch arm64; --no-notarize to try
# on the other Mac, from its own clone
apps/desktop/scripts/install.sh --from-release <https URL or path> --sha256 <sha256> --team <team id>
```

- `release-app.sh` writes the zip, its `.sha256` and a manifest (version, git sha, sha256, architectures, team id). The app
  carries no clone path. With no clone recorded, the app fetches one itself: the public repository at the tag for its own version
  (`mac-v<version>`, not main) into `~/Library/Application Support/app.talos.desktop/talos` (outside the folders macOS protects).
  First, if `xcode-select -p` fails (no Command Line Tools), it asks macOS to install them (`xcode-select --install`), shows "One quick Apple install first: click Install when macOS asks (about 5 minutes)", and polls until they are there (30 minutes at most; closing Apple's window is a failure with Try again); no git or python3 runs before that. The code is pinned by the signed app: release-app.sh makes the release's own source tarball (`talos-source-mac-v<version>.tar.gz`, from the public commit the tag names, checked against the public tag; `TALOS_PUBLIC_COMMIT`), stamps its sha256 and that commit into Info.plist (`TalosSourceSHA256`, `TalosSourceCommit`), and release-publish.sh uploads it as a release asset. First setup downloads that asset over https and checks its sha256 before unpacking (no git needed). A build with a commit stamp but no tarball hash clones with git instead, requiring the tag and HEAD to be the stamped commit; a build with no stamp (a development build) will not fetch code by itself. After the hash check the unpacked copy is made a git checkout of the stamped commit (`git init`, `fetch --depth 1 origin <commit>`, `reset`) and must show no difference and no extra file against that commit (`git status --porcelain --ignored` empty), so the git updater can move it; the updater also refuses a folder whose `git rev-parse --show-toplevel` is not itself. A recorded clone that was never accepted (an `install.sh` run by hand, or an install from before this) is not silently skipped: Talos shows "Allow Talos to update itself?" (a small panel that never takes focus, with Allow updates and Not now) at the next launch, or within 15 seconds if it is running, and the update window and the menu bar item "Allow updates..." offer the same button while an update waits. Allow updates is a real click (no key, no Accessibility press) and remembers exactly the folder shown, only if the record still names it and it passes the checks; the app's own first-setup clone counts as accepted without a click only when that very run cloned or downloaded and verified it (never a folder that was already there), it is the app's fixed-place clone, named by the app's own record, and passes the same checks. A relaunch asks again: nothing about the question is remembered on disk, only the answer in the Keychain. Not now hides it until the next release or launch. release-publish.sh refuses a release whose app carries TalosSourceSHA256 unless the matching source tarball is in the folder. It installs
  Claude Code only when missing, with Anthropic's installer script: the exact pinned copy shipped inside the signed app (`Contents/Resources/claude-install.sh`, fetched and sha256-checked at build time; nothing is downloaded at install time, and a copy whose checksum differs is not run), checks
  the prerequisites with that clone's own `install.sh --dry-run`, installs the packages with `pnpm install --frozen-lockfile` or,
  when there is no pnpm, the app's own bundled bun (`bun install --frozen-lockfile --ignore-scripts`, also what the updater uses, which installs what `pnpm-lock.yaml` pins;
  `TALOS_JS_RUNTIME=bun` tells the clone's installer to ask for neither node nor pnpm), and records the clone last in
  `~/Library/Application Support/app.talos.desktop/checkout`. The onboarding card shows each step and a Retry. It never deletes a
  folder it did not make. A release app carries bun and tmux in `Contents/Helpers` (pinned and sha256-checked in
  `apps/desktop/scripts/bundle-tools.sh`, signed with the app's identity, licences in `Contents/Resources/licenses` and
  `THIRD_PARTY_NOTICES.md`); they sit last on the PATH Main and the workers get, so a Mac's own copies win. `install.sh` writes the
  same record (and the old `Application Support/Talos/checkout`, which the app still reads when the new one is missing). A clone the app made is accepted by the app; any other recorded clone is
  asked about as below. Any program
  of the owner's can write that file, so the app uses it for Create, Adopt and Choose only when the clone is outside the Talos
  home, the agent folder, every thread folder, the temp folders and the app's support folder, has no link in its path, and is
  owned by the owner and writable by no one else; and only after the owner says yes to that exact path on a card (the yes is kept
  in the Keychain, and a different path asks again). Like the launch seal and the screen list, that yes stops accidents, not a
  deliberate program running as you ([bridge.md](bridge.md), the known gap under the screen helper's allowed list).
- The hardened build takes `Resources/entitlements-release.plist`: Apple Events, microphone (kept for the agent's own use; the web page never gets the microphone or camera: the window's media-capture delegate always refuses, since voice input was archived, [archived/voice.md](archived/voice.md)), camera, Contacts and Photos, the
  resources a local build already has. Without them the hardened runtime refuses them with no prompt.
- `install.sh --from-release` installs nothing unless, in this order, the sha256 matches, the zip holds only `Talos.app`, the
  signature verifies (`--strict --deep`), Gatekeeper accepts it as notarized Developer ID, and the signer is a Developer ID
  Application certificate of the given team through Apple's certificates (exit 9 otherwise). The team comes from `--team` or
  `TALOS_RELEASE_TEAM`, never from the app. The last three checks run again on the staged copy, after the relay wait. The tools
  are called by full path.
- What an IT reviewer can rely on: after all of those checks pass, and only then, `install.sh` removes macOS's download flag
  (`com.apple.quarantine`, which a browser puts on the zip and which spreads to every file unpacked from it) from the installed
  copy in `~/Applications/Talos.app`, and prints one line: "checked: sha256 matches, notarized by Apple, signed by team X;
  removed the download flag". It never removes it from the zip that was given, from a local build (`--app`), or when any check
  failed or `--sha256` or `--team` was missing. Why: with the flag left on, macOS asks "downloaded from the Internet... Open?" and
  runs the app from a read-only temporary copy (App Translocation), where updates cannot be put in place and start at login
  points at the wrong path. Gatekeeper's own verdict is still asked first (`spctl`), so removing the flag skips no Apple check.
  If the flag cannot be removed, a warning says so with the command to run. Tested by
  `apps/desktop/scripts/release-install-test.sh` ("the download flag" cases).
- Node is needed only to compare the relay's version with the app's. A Mac with no relay set (not paired yet, as on a first
  install) skips that step with one line and needs no Node; a Mac with a relay but no Node installs anyway and says the relay's
  version was not checked. Tested by `apps/desktop/scripts/relay-wait-test.sh`.
- Any install refuses an app signed by another identity than the installed Talos (exit 10), because macOS keeps Screen
  Recording and Accessibility tied to the old signature. `--new-identity` installs it and prints how to grant them again. An
  installed ad hoc build is replaced without the flag. `--rollback` to a kept copy signed by another identity is refused the
  same way.
- After a signer change the new app cannot read the old signer's Keychain items (the launch seal's key, the screen helper's
  allowed-apps record). It keeps its own beside them, under a name for its signer, and leaves the old ones alone; so the
  development-channel card is answered once, and the allowed apps are chosen again once.

### Automatic updates

A Talos installed from a release updates itself from the public repo's releases. Mac settings → General → "Update Talos
automatically" (`desktop.json` `auto_update`) turns it on or off. It is on for a new install. A `desktop.json` written before the
setting existed has no `auto_update` key and reads as off, so a Mac that is kept up to date another way stays that way until its
owner switches it on.

- On launch (a minute after) and about every hour (60 minutes, moved by up to 10 either way, drawn for each check) it fetches `latest.json` and `latest.json.sig` from the feed (`update_feed_url`,
  default `https://github.com/treynortetik-creator/talos/releases/latest/download/`; https only). The feed is only an address:
  the manifest names its signer's `kid` and must be signed (ECDSA P-256, raw low-S signature) by a release key the app trusts:
  the list pinned in the app (`RELEASE_KEYS` in `packages/protocol/src/release-manifest.ts`, `ReleaseTrust.keys` in
  `ReleaseManifest.swift`), then Developer ID and notarization. Until the real key is pinned (the placeholder is an empty list),
  the updater installs nothing and logs `no_release_key`.
- Rotation: a manifest that verifies under a key trusted now may carry `keys: {add, retire}`. The app keeps the result in
  `$TALOS_APP_HOME/auto-update/keys.json` (0600), never lets the list go empty, and refuses a retired kid from then on.
- **Losing the release key:** it lives only in the publishing Mac's Secure Enclave and cannot be backed up; if that Mac is lost,
  each Mac with Talos needs one install by hand of a build that pins a new key.
- Only a newer version installs (`x.y.z`, compared as numbers). An app older than the release's `min_app_version` is told to
  install by hand.
- The zip is downloaded into `$TALOS_APP_HOME/auto-update/`, its size and sha256 must be the manifest's, and then
  `install.sh --from-release <zip> --sha256 <sha> --team <team> --check-only` runs every check of an install (codesign,
  Gatekeeper, the team) and stops. The bridge checkout (the clone the app uses) must have no changes of its own, and the
  release's commit (`git_sha`, a commit of the PUBLIC repo) is fetched into it now; nothing moves yet. All the slow work
  happens here, while the sessions may be busy.
- Then it waits for a quiet moment: Main and every thread session quiet (no turn, nothing asking you, nothing typed in a box, no key
  in an attached terminal for 2 minutes), and no background work under any of their panes (a shell that claude started, a
  command still running, or anything else that is not claude or one of its MCP servers). Quiet must hold for two looks 30 seconds
  apart. After 2 hours of waiting it gives up until the next check.
- The default thread gets "Talos will update to 1.5.0 in 2 minutes; send anything to postpone." A message from you in those 2
  minutes (status.json `last_owner_at` changes) or a session getting busy postpones it by 30 minutes, with one line saying so.
- `auto-update-apply.sh --prepare` (a copy) moves the checkout to the release's commit (`git checkout --detach`,
  `pnpm install --frozen-lockfile`). Then quiet is checked again, two looks in a row with no message from you; anything else puts
  the checkout back (`--restore`) and postpones. Then `--swap`, in a session of its own, runs that commit's
  `install.sh --from-release --no-relay-wait`, which checks the zip again, quits Talos, swaps it (keeping the old copy for
  `--rollback`) and opens the new one. Restart on update and the guard refresh do the rest.
- An app running from a translocated copy (a path under `AppTranslocation`, because it still carried the download flag) never
  updates: it fetches nothing and says once in the default thread "Talos is running from a temporary copy; move it to
  Applications and reopen it, then updates can install." (`AutoUpdaterTests.aTranslocatedAppRefusesToUpdateAndSaysSoOnce`).
- Right before the swap the running app must pass the same health check itself (Main running, the bridge live on the relay);
  if it does not, the checkout goes back and the update waits for the next window, with nothing said.
- The health gate: the swap then waits, in its own session, up to 5 minutes for the NEW app's own report that it came up healthy
  (`$TALOS_APP_HOME/auto-update/healthy-<version>.json`, which only the app of that version writes). Healthy there means Main
  running under the new app, and the live bridge on the relay running the release's commit (`status.json` `bridge_commit`),
  started after the swap, as a process under that Main. A Main that tmux kept running across the swap still runs the old bridge,
  so the new app restarts it onto the release first (the menu's own cold restart, when nobody is typing). No report in time,
  whether the new app never started, hangs or never got ready: the new app is stopped (TERM, then KILL, only the process running
  from `Talos.app`'s own executable), `install.sh --rollback` puts the previous app back, the code folder goes back to the previous
  commit, and the previous app opens and posts "Talos 1.5.0 didn't start properly, so it went back to 1.4.0. The update is paused
  for a week." If the rollback itself fails, the line says so and the kept copy stays as `.Talos.app.previous`. Only after the
  report does the new app post "Talos updated to ...".
- `$TALOS_APP_HOME/auto-update/skipped.json` holds the versions the health gate rolled back and when; each is skipped for 7 days
  and then tried once more (a newer version is tried at once). Delete the file to try again sooner.
- The relay is not waited for. A newer bridge talks to an older relay through the features each side lists in its hello and
  `ready` (`packages/protocol/src/features-cap.ts`): a feature the relay does not list yet is left out or refused plainly. Until
  the relay deploys, the web app may show its "newer than this app" note.
- Anything that fails before the swap leaves the app and the checkout as they were; a failure after the checkout moved puts it
  back. The default thread gets one line: "Talos updated to 1.5.0. The relay updates separately." or "Talos couldn't update to
  1.5.0: <why>. It's still on 1.4.0." A failure is said once per version and reason, and that version is not tried again for a
  day. A swap that has not said how it ended after 30 minutes is stopped (its process, known by pid and start time), the
  checkout goes back and the line is posted. Every step is a row in the Mac app's log (`auto_update ...`).
- **Check for Updates.** The Talos menu (under About) and the menu bar menu have "Check for Updates...", which runs the check now
  and opens a small window (`UpdateWindow`) that shows the updater's live step (`UpdateStatus`): checking, downloading, up to date,
  waiting for the relay (both builds, and what to do), waiting for a quiet moment (and why), getting ready, restarting the agent,
  done, or the failure in one line with the log's path. While the code folder waits for the owner's OK the window says "Allow Talos to update itself?" with an Allow updates button. Once a release is downloaded and verified the item reads "Update to x..."
  with a dot and a banner says so once (a panel that never takes focus and can never become key); "Update now" runs the same
  prepare, swap and health gate, skipping only the 2-hour wait and the 2-minute notice: while a turn is running or the owner is typing
  it stays waiting ("Waiting for your agent to finish its turn") and NOTHING moves (the code folder stays on the old commit under the
  old app); then the same 2 quiet looks in a row, then the prepare and the swap together (a turn that starts meanwhile puts the folder
  back and it waits again); after 2 hours of waiting it gives up with nothing moved.
  It is not a default button, has no key equivalent and needs a real click (the Needs-you popup's check), so a stray Return does
  nothing. "Later" keeps it pending. Only the owner's click on Check for Updates retries a release that failed today; a request
  file runs the check the timer would, backoff included. "Check again" clears a failure and looks again. `$TALOS_APP_HOME/auto-update/check-now.json`
  (`{"v":1,"action":"check","ts":"<ISO time>"}`, written by `talos-app update`) means "check now": the app claims it by renaming it,
  reads it only if it is a small regular file of the owner's own with a fresh `ts`, runs one check and removes it; a stale,
  future-dated, oversized or malformed file is ignored and removed. The 30-second look is how soon it is seen. The relay's build
  is read from its `/healthz`; it is called behind only when its commit is in the clone and an ancestor of the release's.
- Main's launch always carries `--dangerously-load-development-channels server:talos-app` (`MainChannelFlag`, added to the launch
  and never to the saved command), so a command saved or imported without it still gets pushed messages after an update. The launch
  fingerprint, parts and seal are computed over the flags as launched; an install confirmed over its saved flags before this is
  sealed again once over the launched ones (audit row `channels_flag_reseal`), only when its old seal verifies.
- `install.sh` keeps a clone that is already recorded (and passes the recorded-clone rules: a real path with no link, owned by the
  user and not writable by others, not in the Talos home, the agent folder, a thread's own folder, the support folder or a temp folder) when it runs from another checkout, and says which it kept;
  `--use-this-clone` switches. The updater never writes the recorded clone at all.
- Turning the switch off stops a check or a waiting update at the next look (30 seconds), putting the checkout back if it had
  moved; a swap already started finishes.

Publishing (on the owner's Mac, by hand, gh signed in as the owner): `release-app.sh` (its manifest records `source_sha`, the
private commit it was built from), then the public snapshot (`scripts/publish-public.sh`, from main's head or from `origin/green` when that commit is on main with six local-ci successes; its commit carries the trailer
`Talos-Source: <private sha>`) and its tag, then `release-sign-manifest.sh --tag <tag>` (latest.json's `git_sha` is the public
commit, taken from the tag as git fetches it and signed only when that commit's trailer names the build's `source_sha` and its
tree equals a fresh local export of that private commit, so a tag moved to someone else's commit is refused; signed by
`apps/desktop/scripts/release-key.swift sign` with the Secure Enclave key file in `TALOS_RELEASE_KEY`, made once by
`release-key.swift create --out ~/.config/talos/release-key/<kid>.se`, outside the repo and every backup), then
`release-publish.sh <tag>` (`--dry-run` first). It refuses unless gh is the owner's account, the public tag is at latest.json's
commit, that commit's `Talos-Source` is the build's `source_sha`, and that private commit has all six local-ci statuses green; it
runs the personal-data check over the generated notes and prints `release <version>: ok` or `FAILED: <why>`.

### Going back one version

Each install that replaces a Talos keeps the copy it replaced, hidden beside the app as `~/Applications/.Talos.app.previous`.
One copy is kept, and only if it still passes `codesign --verify`. To put it back:

```bash
apps/desktop/scripts/install.sh --rollback
```

- It quits a running Talos, swaps the kept copy into `Talos.app` and reopens it, the same way an install does (`--dest`,
  `--no-open` and `--no-quit` work here too). It prints which version, build and commit (`build-app.sh` stamps the git sha) is now installed and which is kept.
- The version you rolled back from becomes the kept copy, so running `--rollback` again goes forward to it.
- It changes only the two bundles. Your login item, `~/.config/talos`, your settings and the agent's tmux session are left alone.
- It refuses, and changes nothing, when no previous version is kept (exit 3), or when the kept copy is a link, is not Talos
  or no longer verifies. The message says which. A first install keeps nothing, so there is nothing to go back to until
  the second.
- If an install or rollback is stopped between its two renames it puts the old copy back as it exits. If it is killed
  outright (power loss, `kill -9`), `Talos.app` can be missing until you run `install.sh` again, with or without
  `--rollback`: it puts the copy back before doing anything else.
- With the local signing certificate, the copy you go back to is signed the same way, so macOS keeps its privacy grants.
  Ad hoc builds are asked again, as after any rebuild.
- This goes back the app only. `talos-app rollback` ([SETUP.md](SETUP.md), "Going back") puts the checkout and the bridge back.

## First run

1. Open Talos. With no settings yet it shows the **Set up Talos** checklist: green rows for what is installed, one line of
   fix for the rest. Nothing blocks. Menu, **Setup checklist** reopens it.
2. **Agent folder**, the first row: type or Browse to a folder, then press one of three.
   - **Create** runs this clone's `install.sh` for a new Talos agent (the folder must be new or empty, or already a Talos
     agent, which is left as it is; it refuses a folder that is not empty and not a Talos agent, and a cloud-synced one; it
     never deletes). If it stops part-way it says so and
     leaves the folder for you to move aside.
   - **Adopt** connects a Claude Code folder you already use. A card shows what would change; **Connect** changes only the
     folder's `.mcp.json` (your other servers stay) and, if you have MCP apps, their hooks in `.claude/settings.local.json`.
     CLAUDE.md, `memory/`, `wiki/` and your skills are never touched. Invalid JSON changes nothing, and a `talos-app` entry
     that runs another clone is replaced only if you say so. A kit 1.x folder also gets a card offering to show what
     `kit/scripts/upgrade.sh --into <folder> --dry-run` would change.
   - **Choose** uses a Talos agent folder you already have. It refuses a folder that is gone, unreadable, a link, part of the
     agent folder Talos already uses, or not connected to this Talos yet (use Adopt, which asks before it points a folder wired to another clone or home at this one). A file, or an empty box, is refused too.

   On first setup each one saves your folder, flags and environment in `~/Library/Application Support/Talos/desktop.json`
   (mode 0600: closed to other users of this Mac, not to programs running as you) as its last step, then starts the session unless Claude is not signed in. After setup they change
   only the folder, which applies the next time the agent starts. Adopt runs `talos-app adopt` through the
   same small terminal Sign in uses, because it only runs in a real terminal. Create, Adopt and Choose need the whole clone Talos
   was built from (install.sh, the bridge and the Talos mod); if it has moved or is partial, the row says so. A different
   agent folder starts without the old folder's session id and first-start confirmation.

   Your own launch command still works: **Session**, paste the whole `claude ...` line (including your existing flags) and
   press Import; it saves and starts the session. **Find a running session** reads the folder, flags and session id of a
   session that is already running in Terminal; it cannot read environment variables, so Import the command first if
   yours sets any.

   **Permission mode**: at the top of **Session**, one choice: Auto (recommended), Ask me or Bypass all. Picking one
   replaces the permission flag in your saved launch command (`--permission-mode auto`, `--permission-mode default`,
   `--dangerously-skip-permissions`; never two) and restarts the agent for you, a cold start: Talos stops the old claude process
   and starts it again with the saved command and the same conversation, and you confirm the development-channel dialog once.
   While a turn is running it asks first. A command with no permission flag shows Auto (Claude Code's own default since 2.1.283);
   an imported command with `--dangerously-skip-permissions` shows Bypass all; any other combination (plan, accept edits, two
   flags that disagree) shows "Custom (from your launch command)" and is left alone until you choose a mode. Under Bypass all
   no permission cards reach your phone. Any saved launch command the running agent does not have yet (a choice saved
   without restarting, an edit in the launch box, an import) shows **Restart to apply**, one button that restarts the same way.
   The agent can change the mode when you ask it to (`permission_mode`, docs/bridge.md); the Mac does it only while **Lock
   Talos settings** is off, and a change toward more freedom (Auto or Bypass all) after text from outside reached the agent
   waits for your Allow on a card. A switch by the agent to Bypass all always posts a visible line to your phone ("Your agent switched itself to Bypass all", with the way back; the Mac cannot know you asked, so it says what happened and how to undo it), and the Mac's startup popup for the changed launch is titled "Start with Bypass all?" (the phone card for that dialog still uses the shared wording; naming the mode there needs a protocol change).
3. **Permissions**: press each **Ask now** and approve; add Talos to Full Disk Access, Accessibility and Screen Recording
   if you want the agent to use them.
4. **Sign in**: menu, **Sign in...** pairs the Talos window with your relay as another device. It runs
   `talos-app enroll --label "Mac app"`, shows four words, and you type `y` in the small terminal pane when they match
   (the same check as [`SETUP.md`](SETUP.md) step 5).
5. Quit the Terminal session, then Start session in Talos. The pane shows the development-channel warning;
   Talos presses Enter for you, every time, when it is exactly the warning for the one channel Talos adds, `server:talos-app`. Anything
   else stays on screen and the menu says Talos needs you, and the warning comes up as a **Needs-you popup on the Mac**: "Allow Talos's development channel?" with the screen's own two buttons,
   "I am using this for local development" and "Exit". When the start came from your phone, from a recovery or from a crash restart (you are probably away), the phone gets one plain line per start ("Main is waiting at your Mac: answer the Talos popup there"); a start you make yourself at the Mac gets none. Main's own bridge cannot run while Main sits on this warning (it is Main's child), so no card can be posted
   from it; the answer is at the Mac. Your real click on the first button is your confirmation (a press sent by a script or by
   Accessibility does nothing, and so does a click another program posts, such as cliclick or a computer-use tool: the popup takes
   only a click that comes from the mouse or trackpad itself, so a click through Screen Sharing, Universal Control, Sidecar, Voice or
   Switch Control, or a tool that remaps mouse buttons may do nothing either); "Exit"
   presses Exit and leaves Main stopped until you start it again. An Enter you press in the pane lets that one start through, but is not
   remembered (anyone with tmux can press one), so the next changed start asks again. If the Mac cannot carry the channels whole (a very
   long list) the card offers Exit only. The popup names any channel Talos did not add, and, when it is your start command that changed (another program,
   flag, environment variable or folder), says which piece (never a value): the first start after a change waits for your click
   once, and the next starts are automatic again. When a bridge does run (a warning that comes back after Enter), the same
   warning is also a card on your default thread. Answering the card from your phone starts this launch once, like an Enter in
   the pane: the next start of the same changed launch asks again. Only a click at the Mac remembers it.

   **The seal.** The launch you confirmed is stored in `desktop.json` (`confirmed_launch`) together with a MAC
   (`confirmed_launch_mac`) made with a 32-byte key kept in your Keychain (service `com.talos.app.launch-seal`, this Mac
   only, never read with a prompt), so a program that only writes the file cannot make an edited launch look confirmed. A missing
   key, a missing or wrong MAC or a Keychain that cannot be read all count as "not confirmed": the warning waits for your click
   on the Mac popup, and the click seals it again. The key survives an update of the app when the update is signed with the same certificate (check
   it with `apps/desktop/scripts/keychain-survival-probe.sh`); a build that cannot read the existing item (signed another way, ad hoc) never
   re-seals, so every start of that build shows the popup, which is safe and costs a click.

   **What the seal does not stop.** It stops accidental and casual auto-accepts of a changed launch: an edited confirmed launch
   in `desktop.json` is not trusted. `desktop.json` is writable by anything running as you. Only the confirmed launch is sealed;
   the other settings, `talos_app_command` and `relay_url` among them, take effect at the app's next launch. It does not stop an agent running as you with access to tmux, which can press Enter on Main's dialog itself; agent guards
   do not block tmux. Nor does it stop a program running as you that sets out to forge it: Apple's `security` tool can overwrite the
   key's value with one that program knows, with no prompt and without changing who may read it, and the program can then seal a
   changed launch itself. The Keychain this app can use (the file-based one) cannot tell that overwrite apart; the protected one
   needs a build signed by an Apple developer team (or the key kept by a helper running as root). The popup's click check stops
   posted clicks, not a program that moves the pointer onto the button so your own click lands there. The one development channel the app ever answers is still `server:talos-app`.

   **After an update that brings the seal** the first start asks once (the card): an unsealed `confirmed_launch` cannot be told
   from one a program wrote, so it is cleared once (`launch_trust` in `desktop.json` records that the step ran, version 2 with the SHA-256
   fingerprint; set it back to 0 to run it again). **To get the old behaviour back**, turn **Press Enter for me** off in the Mac settings (`auto_confirm_restart`
   false): Talos then never presses the key by itself, and the card and the pane are both yours to answer.

While the same agent is still running in Terminal, Talos refuses to start a second one ("another session holds the
channels"), so a chat channel does not lose its connection by accident.

### The rest of the setup screen (no Terminal needed)

- **Tools.** claude, bun and tmux are found by absolute path through your login shell's environment (never a bare name) and
  shown with their version and path. A missing one has a button: claude and bun open their official install pages; tmux runs
  `brew install tmux` as you (never an administrator) when Homebrew is installed, else opens brew.sh.
- **Sign in to Claude.** Runs `claude auth login` in a terminal of its own (the CLI opens your browser; if it cannot, or the
  page shows a code instead of redirecting back, the step shows **Open sign-in page**, **Copy link** and a box to paste the
  code into, which is typed into that terminal). It asks `claude auth status --json` every 2 seconds for up to 5 minutes.
  Already signed in shows as done. A failure says why with **Try again**, and the way out: open Terminal and run
  `claude auth login`. **Cancel**, the time limit and quitting Talos end the login and everything it started. Closing and
  reopening the setup window finds the same sign-in; a second one never starts. This signs in Claude Code, not Talos (that is
  **Sign this device in**, below). Talos shows only official claude.ai, claude.com and anthropic.com https links, never logs
  the link's query or the code, and never keeps the code.
- **Start your agent.** The development-channel warning is answered in the Talos popup. This step says "done" only when
  Main's Talos bridge is live (`status.json`, written by a process of Main's group). If it never comes up, the line shows
  the reason from Claude Code's MCP log for the `talos-app` server. A trust, connector or sign-in question from Claude says to
  look at the Terminal pane; only the development-channel warning is answered in the Talos popup.
- **Rules for your agent.** One box of plain sentences, empty by default (for example a rule to keep patient details out
  of anything the agent writes). Saved as `<agent folder>/.claude/rules/owner-rules.md`, which Claude Code reads at the
  start of a session, so it applies the next time the agent starts. It is a file of its own beside the kit's
  `talos-defaults.md`: an update never replaces it, and Talos only ever changes a file it wrote (it carries a first line
  saying so). Empty text removes that file.
- **Tool prompts as approval cards.** A new install (`talos-app init`) turns `permission_relay` on; the agent folder's
  `.mcp.json` is written with bun's absolute path. An install you already have is not changed. To turn the cards off:
  Settings, Health, "Tool prompts as approval cards" (or `permission_relay: false` in `~/.config/talos/app/config.json`),
  then restart the agent.

## What the menu bar shows

| Icon                 | Means                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| Talos's head         | The session is up, the bridge is connected and the relay answers        |
| Head with pulse arcs | The agent is working                                                    |
| Head with a dot      | Something needs you: a dialog in the pane, or a card waiting in the app |
| Head with a slash    | The session, the bridge or the relay is down                            |
| Faint head           | The session is up but the bridge or relay cannot be confirmed           |

The icon is Talos's helmeted head, drawn in one colour so macOS tints it for light and dark menu bars.

The first lines of the menu spell it out: `Session: busy`, `Bridge: ...`, `Relay: reachable`, `Needs you: N`.

The Bridge line is read from `$TALOS_APP_HOME/status.json`, which the live bridge rewrites every 15 seconds and whenever
its connection changes (see [`bridge.md`](bridge.md), "status.json"). It says healthy only if the file is under 45 seconds
old, the process in it is still running, it is the live bridge, and it is connected to the relay. **A bridge that was
already running before you updated never wrote that file: restart the agent once** (Quit and stop the agent, Start session)
and the Bridge line leaves "unknown". `talos-app status` and `talos-app status --json` show the same facts from a terminal.

## Everyday use

| I want to...                                                   | Do this                                                                                                          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Open the app in a window                                       | Menu, **Show Talos**. Closing the window only hides it.                                                          |
| Read Help                                                      | Menu, **Talos Help** (or Help, Talos Help at the top of the screen). It opens the Help page in the Talos window. |
| See or type into the agent                                     | Menu, **Terminals…**. It is the real session; closing the window does not stop the agent.                        |
| See the agent or a thread's session in the Talos window        | Sidebar, **Terminal** (Mac app only), then the tabs across the top (below). Leaving it ends only the view.       |
| Send a quick message from any app                              | The compose hotkey, type or dictate, Command-Return. Esc closes without sending. Change it in Hotkeys.           |
| See a thread's own session, or answer a question it stopped on | Menu, **Terminals…**, then pick the thread in the sidebar (below).                                               |
| Stop or restart the agent                                      | Menu, **Stop session** / **Restart session**. **Quit and stop the agent** also ends the session.                 |
| Start Talos when I log in                                      | Settings, General. Off by default.                                                                               |
| Turn the companion on                                          | Settings, **Talos on screen**, or the menu.                                                                      |
| Update Talos                                                   | Build again and run `install.sh`; a tmux agent keeps running through it.                                         |
| Go back to running it in Terminal                              | Menu, **Copy Terminal command**, then **Quit and stop the agent**, then paste the command in Terminal.           |

## How a new reply reaches you

With the companion on, a new reply in a thread comes from him, not from a macOS banner:

- His bubble shows the thread name in capitals with "new reply" ("WORK · new reply"), the first line of the reply (cut with "…"), and two buttons. **Open**, or a click on the bubble, takes you to that thread. **Later** puts it away; the reply stays in Talos.
- It stays until you press Open or Later, or for 30 seconds. A pointer on him or on the bubble holds it, and a new reply restarts the clock.
- Several replies at once make one bubble, such as "3 new replies: Work, OC Test…". Open then goes to Home, which shows them all.
- **What is on screen.** The first line is asked of the Talos page when the reply lands, shown in his bubble, cleared when the bubble goes, never put in a notification and never stored. The bubble is a window on your screen like any other: a screenshot, a screen share or a mirrored display can show it. The app asks macOS to leave it out of captures, but does not rely on that and does not promise it. If the text of a reply must never be seen, turn him off or snooze him.
- **While you work in the Talos window**, the page decides. A reply it would have shown as its own jump banner (another thread than the one on screen, a thread that notifies, a fresh reply; a card page counts as its thread) is held for him instead. He is told what is held, takes each one into his bubble, and tells the page which ones he showed, so you get one delivery, not two. A reply that lands while its thread is mid-turn waits for the turn to end, so the first line is the real one. He ignores the 60 second pause the plain bubble has. A drag does not lose it: it shows when you drop him.
- **A reply is never lost.** Every reply the page holds ends as exactly one of: his bubble, a macOS banner he posted, or the page's own jump banner. When he stops (snoozed, hidden, off, a call, quiet hours, the setting off, something that needs you, no feed, or the app quits), the page shows one jump banner, the newest, for what it still holds. If Talos is not in front when he stops, he posts the macOS banner for what he had taken instead. In quiet hours he posts no banner, and the page keeps the reply for its own banner. A reply held longer than 15 minutes (a very long turn) is posted as a macOS banner. A reload of the page forgets what it held (the unread count stays). A browser, the phone and an app with no companion see no change.
- **When Talos is in the background**, the page's banner comes as a macOS banner, as before, and he takes it only when he can say it: on screen, awake, not in quiet hours, no call, a live feed, and not showing something that needs you. A reply in a thread whose turn is running keeps its banner (his Done waits for that turn). A reply in the thread on screen gets nothing only while Talos is the window in front; a window that is merely visible does not count as read.
- Quiet hours (Settings, quiet window) hold his bubble back and add no banner. They never change how he looks or moves: he idles, reacts to clicks and drags and walks as he does by day. Only Reduce Motion, Low Power, a running mic, Mini mode and a hidden panel hold his animation still. The app does not read macOS Focus, so Focus silences the macOS banner but not his bubble, as with every other bubble of his; turn him off or snooze him to silence it.
- Settings, Companion: **Mini Talos delivers thread replies** (on by default). Off gives the short one-line "New reply in <thread>" bubble and the page's own banners. **Also show reply banners** (off by default) also posts the macOS banner when Talos is in the background; it does nothing while you are working in the Talos window.

## The Terminals window: Main and every thread session

**Terminals…** (menu bar item, or Window → Terminals…; it has no key, because ⌘K is Search in the Talos window) is one window. The **Sessions** tab has a sidebar listing Main and
every thread session, each with a state badge: Working, Idle, Parked, Stopping, Failed or Needs you (Main shows Live, Starting,
Stopping or Not started). Click an entry, or press ⌘1 to ⌘9 while the window is in front, and the terminal beside the list
switches to that tmux session. The list follows the sessions live. Switching ends only our own viewer: every session keeps
running. The tab appears with the tmux host; with the owned-pty fallback the window shows Main's screen as before.

- **Live, idle, working or starting:** the terminal is that session's real pane.
- **Needs you:** the pane is waiting on a Claude Code prompt (such as "trust this folder"). Answer it in the terminal; Talos
  types into a dialog only for a tap on a card (folder trust, MCP consent: Up or Down and Enter, see OPTION-C "Needs-you prompts"),
  never otherwise. The thread also got one plain line saying so, unless the bridge made a card for it.
- **Parked or not started:** nothing is running, so a **Resume** (or **Start**) button stands in for the terminal. It asks the
  session to start, resuming the same conversation.
- **Failed:** the error in words, no terminal.

## The Terminal screen: a tab for every session

Sidebar, **Terminal** (Mac app only; a browser or the phone app has no shell and `/terminal` goes Home). Across the top is a strip
of tabs: **Main**, then every thread that has its own session, each with a state dot and a word: working, live, parked, needs you,
failed (also starting, stopping, not started). The picked tab is underlined; the raw Claude CLI terminal is below it. The list is
the same one the Terminals window shows, so the two always agree.

- **Switch:** click a tab, use the arrow keys, Home and End on the strip, or press **Ctrl+1 to Ctrl+9** (Main is 1). On this screen
  those chords pick tabs instead of opening thread 1 to 9. A number with no tab does nothing. This holds after you click into the
  terminal too: the Mac takes Ctrl+1 to Ctrl+9 before the terminal does and tells the page, so no control byte (Ctrl+3 is ESC, Ctrl+8 is
  DEL) reaches the session. The chord is the physical key (digit row or keypad, Caps Lock on or off, any keyboard layout); Ctrl+Shift+digit is another chord and goes to the terminal. After the switch the new terminal has the keyboard, so typing and the next Ctrl+digit work. Every other key goes to the terminal untouched. The tab you picked last is
  remembered for that window.
- **Switching is safe:** the Mac re-points only its own `tmux attach` at `=agent` or `=t-<thread>` on Talos's tmux server. No key is
  sent, and no session is detached or killed. The page names only "main" or a thread id; the session name is worked out on the Mac
  from the id (`WorkerSpec.tmuxName`) and an id that is not in the list attaches nothing.
- **Parked or not started:** a Resume (or Start) button stands in for the terminal. It asks the thread's worker to start through the
  same request as the Terminals window, only for a thread that is parked or off right now, and shows the Mac's answer.
- **Failed:** the error in words, no terminal. **Needs you:** the terminal shows the prompt; answer it there.
- The terminal needs room for 80 columns by 24 rows. Click inside it before typing: the page never moves your typing into it.
- **Older Mac app or older page:** no list is sent, and the screen is the single Main terminal it was before.

**Choose… for a thread's folder.** The Folder box in a thread's own-session settings has a Choose… button. In the Talos window it sends `pick_folder`
(a request id and, optionally, where to start); the Mac shows an `NSOpenPanel` (folders only, one folder, nothing created; the page cannot change
that) and answers `folder_picked` with the absolute path or `null` for Cancel. Only one panel is up at a time, and a signed-out page gets none. The page
then saves the path through the same owner-signed thread patch as a typed one; the bridge checks it. The Mac app lists `TalosFeatures/pick-folder` in its
user agent, so a page never asks an older app that would drop the message; the page then uses its in-app folder browser instead.

The messages behind it are in `packages/protocol/src/native.ts`: `terminal_view` carries `session`, the page sends `terminal_resume`,
the page sends `terminal_leave` when the screen is closed (a null room only means "no terminal to show right now", so the list keeps
following the sessions), and the Mac sends `terminal_sessions`, `terminal_resume_result` and `terminal_select` (a tab it switched itself). The page lists `terminal-tabs/1` in `ready`; the Mac sends the
list only to a signed-in page that says so.

The **Thread sessions** tab is still there for the one case below.

- **Needs attention because it stopped at a question only this Mac can answer** (a session from before a prompt was kept for
  you, or one nobody answered for 15 minutes): nothing is waiting in a pane. The tab shows what the dialog said and a button,
  **Open claude in this folder**, which starts a plain `claude` in the thread's folder in the tab. You read the dialog and
  answer it yourself. Closing the window ends that claude. Then open the thread's settings in the app and press **Restart**:
  that resumes the same conversation. (A message alone does not start it; while the thread shows Needs attention, main
  answers. **Start fresh** begins a new conversation.)

## The Terminal pane: your own shell beside a thread

Beside a thread, the Terminal pane is your own login shell, started in that thread's folder when the thread has its own
session, and in the agent folder otherwise. It is not the agent's terminal: it runs on its own pty, with your environment and nothing of a Claude Code or Talos
session in it. `+` opens another tab; closing the pane ends its shells, hiding it does not. It exists only in the Mac app, and
nothing reaches it over the relay. The pane shows once the web app reserves its slot. The contract with the web app, and what
is tested, is in [`docs/TERMINAL-PANE.md`](TERMINAL-PANE.md).

## When something is wrong

- **"Blocked: another session holds the channels".** The agent is still running somewhere else (Terminal). Stop that one
  first.
- **The menu says the Bridge is "unknown".** The bridge has not written `status.json` yet. Restart the agent so it runs this
  version of the bridge.
- **The Bridge shows down, but the agent is running.** Run `talos-app status` and `talos-app doctor` in a terminal;
  `talos-app logs` shows the bridge log.
- **Sign in cannot find `talos-app`.** Run `apps/bridge/scripts/install.sh` again (it puts `talos-app` on your PATH), or
  type the command in Settings, Window, for example `bun run <repo>/apps/bridge/src/cli.ts`. Talos also finds the bridge
  folder from the agent folder's `.mcp.json`.
- **The agent restarted itself.** That is the crash restart working. The log says why: `~/Library/Logs/Talos/supervisor.log`
  (event names and ids, no text).
  A restart that cannot launch yet (another session holds the channels, `claude` is not found, the agent folder is not there) is
  tried again with the same waits, five tries in all and outside the crash loop's count (log: `restart_not_possible`). If it still cannot, the
  Mac ends at Blocked or "couldn't start" and posts one line to your default thread (`restart_gave_up`). A start you make
  yourself ends at once with its reason, as before.
  An agent that ends by itself with exit code 0 (an `/exit`, a self-update) is started again too, after the shortest wait, but is
  not counted as a crash: it never becomes a crash loop and never brings the restore below. It has a cap of its own, the same on
  Linux: more than ten such exits in an hour leave it stopped (log: `clean_exit_loop`), with one line on your phone ("Main keeps
  exiting cleanly"), and nothing is restored. To keep Main off, use Stop, not `/exit`. With auto-restart off no exit restarts it. After three automatic Enters on crash restarts in an hour, the next restart still happens and its
  warning waits for you on the popup.
  A session nobody has typed in has no saved conversation yet (Claude Code writes
  `~/.claude/projects/<folder>/<id>.jsonl` after the first message or an `/exit`), and `--resume` of it would be refused. Such a
  start uses `--session-id` with the same id instead (log: `session_not_saved`). The file is looked for in Main's own
  `CLAUDE_CONFIG_DIR` (else `~/.claude`), under the folder's own name first and then under any name. The first time the file is
  seen (at a start, while Main runs, or as it exits) its id is written to `session.conversation_seen` in `desktop.json`. A
  session with that mark whose file is not found later (deleted, another config folder) had a conversation and lost it: it is
  resumed, and stops with "can't be resumed", never quietly empty under the same id. Two errors are mended, once
  per session: "Session ID ... is already in use" (the session is saved after all: the next try resumes it, log
  `session_in_use_resume`), and a resume refused for a file that holds only an `/exit` (nothing to resume: a new conversation is
  started and the old id goes to `previous_ids`, log `session_empty_new_id`). A real conversation whose resume fails still stops
  Main with "can't be resumed". With auto-restart off no mending restart is made.
- **"Talos couldn't start: its settings file (desktop.json) can't be read".** `~/Library/Application Support/Talos/desktop.json`
  is there, but it is not valid JSON or holds a value of the wrong kind (a number where text belongs, say). Talos starts nothing
  and saves no setting while that is so, and posts one line to your default thread when the app opens (if `talos-app` is on your PATH): a session that was already running in tmux keeps running, unwatched, and Settings changes
  are refused with the same line. Fix the file, or move it out of the folder to set up again, then quit and reopen Talos. A
  value this version does not know (a setting from a newer version) is not this: that one setting falls back and the rest loads.
- **You reopened Talos and Main is "starting", with the popup up.** Main was still on the development-channels warning when the
  app went away. The app does not press Enter on a session it re-attached to (an earlier copy may already have): click the
  popup, or press Enter in the pane.
- **The menu says Talos put back the last good setup.** The agent crash-looped, or the bridge stayed down for five minutes
  (counted while the Mac is awake, after the bridge was up in this start); the line names the files it wrote and the date of
  the version. It happens by itself once, then waits for ten healthy minutes. If the restore failed, nothing was restarted: run
  `talos-app restore-last-good --list` in a terminal. Restoring by hand stays in the Mac menu and Terminal; the phone can
  only restart the agent. The same line is posted to your default thread on the phone, also when the restore failed (not when it
  changed nothing, and not when your `talos-app` can't be found).
- **A phone restart is ignored while you have stopped the agent at the Mac** (the menu says so): your Stop wins. A Stop pressed
  while a restore runs also wins: the restore finishes, the menu says so, and nothing restarts. The app acts on one phone
  request per two minutes (only a restart the phone asked for counts; menu, crash and restore restarts do not); one that comes
  sooner is ignored and the menu says so, but not while the menu says Talos needs you at the Mac. A request dated before the app
  launched is deleted and not acted on, so your Stop, or "Start the agent when Talos opens" off, still holds after you quit and
  reopen the app. The phone is not told what the Mac did with its Restart tap: it says "sent to your Mac" and that the app
  decides (nothing happens if the app is not running). A restore cut off by quitting the app tells nobody, because the quit ends
  the process. After a phone restart or an automatic restore, if Claude Code stops at the dev-channel warning
  and Talos did not press Enter (the screen was not exactly the expected warning), the app posts "Main is waiting at your Mac: answer the Talos popup there" to your default thread, once per start (not for a start you make yourself at the Mac).
- **Main is stopped only for a warning that stays; it counts as up when its bridge is live.** After the Enter the app sends (its own, the
  tap on the card or the click on the Mac popup), the warning must be gone: once it has left a screen the app could read, and the screen
  shows something else, Main is running (audit `auto_confirm_ok`; an Enter at the pane counts at once). The channels notice is not
  waited for: Claude Code 2.1.322 prints none on a resumed start, even with its MCP server connected. Main is stopped ("The restart
  wasn't confirmed in time", audit `auto_confirm_no_notice`) only when the warning is still on screen 15 seconds (`noticeWait`) after
  the Enter and nobody is left to answer it. When it was the app's own Enter that did not take, the warning is offered to you
  (the Mac popup, and "Main is waiting at your Mac" on the phone when you are probably away) and Main waits there for your
  click, however long; the stop comes only if the warning is still up 15 seconds after your own click or tap. A blank screen, another dialog or a screen that cannot be read is never that stop: Main stays starting and the "start is
  taking too long" warning comes at two minutes. "Gone" is read by shape (Claude's input box up, no dialog at the bottom of the screen), so a resumed conversation that quotes the warning's words is not mistaken for it. A start that never showed the warning is running once the input box is up and 15 seconds have passed; a live bridge alone is not enough (it is up before the warning is drawn).
- **Main running without its bridge.** Within 60 seconds (`bridgeWait`) of the warning being answered, the bridge (the talos-app MCP
  server, Main's child) must have written a live `status.json` (stamped after this start, by a process of Main's group). If not, Needs you says "Main is running but
  its Talos bridge didn't start", with the last line of Claude Code's log for that server when it can be read
  (`~/Library/Caches/claude-cli-nodejs/<agent folder>/mcp-logs-talos-app/`). A damaged `config.json` in the Talos home (not valid
  JSON, so the bridge refuses to start) is named as the reason first, since that log often says only that the connection closed.
  Main is not stopped. The line clears when the bridge goes live.
- **Main's bridge live but off the relay.** Once the bridge has been seen live, `status.json` saying `relay.connected: false` for 3
  minutes (the contract's `relay_down_s`) is Needs you: "Talos bridge is running but can't reach the relay", with the last close code
  when there is one. The bridge's reconnect backoff tops out at a minute, so a relay restart or a short drop never gets that far. It
  clears when the bridge connects again; nothing is restarted.
- **Main not picking up messages.** `status.json`'s `unseen_oldest_at` (an owner message Main was told about, with no bridge tool call
  since) 5 minutes old (`unseen_s`), with Main's pane silent for 2 minutes (`unseen_quiet_s`) and nothing printed since that message, is
  Needs you: "Main isn't picking up messages". A Main that read the message prints it and its turn, so a message that needed no
  answer does not count. Told once per message; once told it stays until Main makes a bridge tool call (a turn at the pane with no
  tool leaves it up). Never a restart. Both waits run on the awake clock, so sleep never counts. Neither needs a default thread:
  the line and its banner are on this Mac.
- **The phone line when config.json is broken.** The phone lines (crash loop, a restart that gave up, Main exiting cleanly) go
  through `talos-app post` to the default thread. With no `talos-app`, no thread in `config.json` (damaged, or none named), or a
  post that was refused, the Mac posts the line itself: a system row signed with the bridge key (`$TALOS_APP_HOME/bridge.key`, the
  file the bridge signs with) to the relay named in `bridge.env`, in the `desktop.json` notify thread, else `inbox`. It has no
  command line, so an agent cannot post a row that looks like the app's.
- **Main's environment** is your login shell's plus `desktop.json` `env` (its `PATH` wins; if the login shell cannot be read in 5
  seconds the app's own environment stands in, with `desktop.json` on top, and the log says `login_env_unreadable`). A thread
  session's identity (`TALOS_APP_WORKER_THREAD`, `TALOS_SESSION_ROLE`, `TALOS_APP_WORKER_NONCE`) and Claude Code's session variables
  never reach Main, from any source; nor do a worker's no-channel state dirs or `ENABLE_CLAUDEAI_MCP_SERVERS` (unless `desktop.json` sets them). `install.sh` relaunches the app without them and says so when it was run from a thread session.
  Under tmux it reaches Main only through a launch file (0600, under `$TALOS_APP_HOME/launch`, deleted as soon as it runs):
  tmux runs `/usr/bin/env -i /bin/sh <file>`, so no value is in a tmux argument or the tmux server's environment.
- **A thread session's environment** is built the same way at each start: your login shell's plus `desktop.json` `env` as it is
  then (its `PATH` wins), then the session's own identity and no-channel settings. The app reads the login shell in the background
  (never while it is opening), keeps the last read that worked and reads it again when that is 15 minutes old. A read that fails
  keeps the last good one; with none yet, the app's own environment stands in with `desktop.json` on top. Either way the log says
  `workers login_env_unreadable` with where `PATH` came from (`last_good`, `desktop.json` or `app`), and the read is tried again
  after 30 seconds, then at longer gaps up to 5 minutes. A start waits only for the first read after the app opens (12 seconds
  at most); later retries never hold one. While no read has worked and `claude` is not on the `PATH` in use, a thread
  session is not started: the start is held (the log says `worker_start_held`) and goes ahead once the login shell answers; after
  two minutes the message goes to Main as it does when every session slot is busy. If a Finder-opened app keeps saying
  `path_from=app`, pin `PATH` in `desktop.json` `env`.
- **`.mcp.json` names bun by its absolute path** (no `PATH` is written: the session keeps its own, with `~/.local/bin` and `/opt/homebrew/bin`; the server runs `src/server.ts` directly), written by `install-mcp`, adopt and
  setup, because Claude Code starts the server with the session's PATH, and Main can start with a bare one. `talos-app doctor`
  warns about a bare `bun` and says to run `talos-app install-mcp --agent-dir <dir>`. A `PATH` you put in the entry is kept; the one an earlier Talos wrote is removed on the next `install-mcp`.
- **Main's warning shows only the Talos popup,** centred on the screen. The terminal is not opened beside it (other dialogs still open it).
- **macOS asks for the Desktop folder again.** The app was signed differently from last time. Use the local signing
  certificate above, or grant it again.
- **A bug report.** `talos-app report --out report.txt` bundles doctor, status and the log with keys, tokens and your home
  folder removed. Read it first.

## Files

| Where                                              | What                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `~/Applications/Talos.app`                         | The app (by default)                                      |
| `~/Applications/.Talos.app.previous`               | The version the last install replaced (`--rollback`)      |
| `~/Library/Application Support/Talos/desktop.json` | Your session settings (0600)                              |
| `~/Library/Logs/Talos/supervisor.log`              | What the supervisor did: event names and ids only         |
| `$TALOS_APP_HOME/status.json`                      | The bridge's health, written by the bridge, read by Talos |

## Tests

`apps/desktop/scripts/test.sh` runs the Swift suites; `apps/desktop/scripts/ci.sh` is what CI runs. Tests that starve the process-wide dispatch pool would fail the suites running beside them, so
`scripts/test.sh` skips them and `apps/desktop/scripts/starvation-tests.sh` runs them alone (CI runs it after the main run). The by-hand list for
things a test cannot check (the real dialog, a real crash, real Spaces and displays) is
the manual desktop smoke list.
