# Changelog

## 1.1.1-cli - 2026-10-05

Re-cut for the public launch: one clean history, the timeline guard, and a Chronos pin that exists on GitHub.

### Added

- **`hooks/timeline-guard.py` (PreToolUse on Write, Edit, MultiEdit).** Refuses a wiki write that puts a malformed entry
  below a note's append-only separator, with the offending line, the reason and the one-line format in the refusal.
  It imports the lint's own rules (`wiki-lint.py` gained `timeline_findings` and `new_timeline_violations`; the lint's
  output is unchanged) and judges only NEW lines, so old violations never block unrelated edits. Fails open; kill
  switch `timeline-guard.off`. `scripts/test-timeline-guard.sh` (57 checks, also run by `test-hooks.sh`). The lint no
  longer warns that a `<slug>-timeline-archive` note is over 40 entries. The entry format with correct and incorrect
  examples is now in `wiki/README.md`, `SEED-WIKI.md` and the transcript-ingest skill.

### Changed

- **Chronos pin: `bc44d31`** (Chronos 0.2.1, republished as a fresh public repository). The earlier pin
  pointed at a commit that no longer exists on GitHub, so a fresh install's pinned clone failed. Same Chronos
  version, same code; only the commit id changed. The pin is `CHRONOS_PINNED_REF` at the top of `install.sh`.

### Fixed

- **`scripts/claude-md-lint.sh` no longer fails the shipped placeholder `CLAUDE.md`.** The placeholder
  ("# Setup is not finished.") carries a red-circle line with no `[R-nn]` key, so running the lint in a fresh
  checkout failed. The lint now says it is the setup placeholder and exits 0 (`verify-install.sh` already skipped
  it); a self-test covers it. Its `--help` also stopped printing a few lines of the script body.
- **`scripts/self-test.sh` no longer fails inside an installed agent folder** (the README FAQ, UPGRADE.md and
  `upgrade.sh`'s own gate all run it there). Two checks only make sense in the kit clone: the `docs/` screenshot
  (`docs/` is deliberately not copied into an agent folder) and the privacy scan (which would read the user's own
  notes and the absolute paths the installer writes into `.claude/settings.json`). Both now run in the clone only.
- `scripts/test-install.sh` no longer fails under the stock macOS Python 3.9: the python3.14 discovery check
  wraps a real Python 3.10+ if the machine has one and skips with a message if not.

## 1.1.0-cli - 2026-10-01

The whole agent setup modelled on a long-running reference agent: a hot-file config with a ledger and a lint, memory search, enforcement hooks,
a status line, and a two-way Telegram channel. Everything new that has a dependency is **opt-in**.

### Fixed

- **`claude mcp list` (HTTP 409 trap) is gone from the docs.** Its health check starts every MCP server, including
  the Telegram plugin's, which is a second poller and breaks the live channel. The docs say `/mcp` inside a
  session, and a self-test fails on the bare command.
- The pre-tool guard no longer refuses BOOTSTRAP's own `cp .env.example .env`.
- `install.sh --agent-dir` with a nonexistent parent folder is an error, not the filesystem root.
- `uninstall.sh` clears Chronos's `notify` when it pointed into the deleted `~/.config/talos`, and finds the
  agent folder from what the installer recorded.
- **Hooks fail open.** Every hook command exits 0 if its script file is gone (`python3 <missing>` exits 2, which
  blocks every prompt or every Bash call). `upgrade.sh` now diffs every `hooks/*` command, not two hard-coded
  names, and flags a registration whose script no longer exists as `STALE`. `UPGRADE.md` says to remove the
  registration before deleting the file, and drops a false sentence about the old behaviour.
- A Chronos already configured with a different workspace is warned about (scheduled runs would not load this
  agent's config or guard); `--set-chronos-workspace` repoints it; `verify-install.sh` notes a mismatch.
- `.upgradeignore`: an unanchored `memory/` swallowed `scripts/memory/`; protective patterns may now be anchored
  with a leading slash, and `talos-*` skills and agents are code.
- Doc contradictions: BOOTSTRAP vs START-HERE pointers and step numbers, the `cp -n` wording, the
  `.talos-version` fields, test counts, the Chronos path in MORNING-BRIEF, employer-flavoured framing in SEED-WIKI.
- Tests set `PYTHONDONTWRITEBYTECODE` and no longer copy `scripts/fixtures/` into agent folders.

### Added

- **The hot-file config.** `templates/CLAUDE.md.tmpl` is rewritten as one trigger line per rule, keyed `[R-nn]`,
  about 2,200 words; `templates/rules-ledger.md.tmpl` holds the reason for each key; `scripts/claude-md-lint.sh`
  enforces a word cap, keyed red lines and a ledger entry per key, and lists expired observations. The promotion
  pipeline is now: strikes 1-2 stay in `.learnings/`; strike 3 is one trigger line + a ledger entry + a
  graduation-log row, after a yes. `session-start` warns when `memory/STATE.md` passes 30,000 characters.
- **Memory search (opt-in).** `scripts/recall.py` (stdlib, hybrid, `--expand`, `--batch`, `--json`, honest status
  line and zero-result diagnosis) and `scripts/memory/` (sqlite-vec + fastembed, apsw, a pinned model cache, an
  incremental indexer with a lock and a memory guard). `./install.sh --with-memory-search`,
  `scripts/memory/setup.sh`, `uninstall.sh --remove-memory-search`, a `talos-memory-index` Chronos job, a
  detached refresh at session start, and the `talos-memory-recall` skill.
- **Enforcement hooks.** `claim-gate.py`, `append-only-guard.py`, `timeline-guard.py`, `agent-log.py`, `channel-debt.py`, and
  `statusline.py` (no jq), with per-agent state outside the agent folder and kill switches (including Chronos's
  Control Room folder).
- **Telegram, two ways.** `setup/telegram.md`, `scripts/talos-chat.sh`, an opt-in reply mirror, and
  `notify/telegram.sh` with the token off argv, `--file`, and a word-cap warning.
- **Optional extras.** `./install.sh --with-vault DIR` (a private vault, validated before anything is written) and
  `hooks/check-vault.py` (asks before a term from the user's own `_guard-terms.txt` is written outside the vault);
  `--global-pointer` (one marked block in `~/.claude/CLAUDE.md`, removed exactly by uninstall); the
  `talos-state-sweep` job and `scripts/state-sweep.py`; `scripts/tts.sh` (macOS `say`, or Kokoro with `--with-voice`),
  `scripts/stt.sh` (whisper.cpp) and `scripts/voice/setup.sh`; `scripts/md2html.py` (a self-contained, escaped,
  light/dark page with an optional audio player); `scripts/yt-fetch.py`; `hooks/hands-free.py`; the
  `talos-meeting-prep`, `talos-transcript-ingest` and `talos-agora` skills and the `qa-gate` agent.
- Tests: `test-hooks.sh`, `test-recall.sh`, `test-notify.sh`, `test-privacy.sh`, `test-extras.sh`.

### Changed

- **Chronos pin: 0.2.1.** Jobs may carry a `model` (the lint and snapshot jobs pin `sonnet`;
  shipped jobs never pin Haiku). Docs cover triggers, the usage meter and the Control Room.
- **`talos-memory-index` is a plain command job**, not a Claude run: it runs `scripts/memory/refresh-index.sh`
  directly, so the daily index refresh spends no plan usage. It needs Chronos 0.2.1; `talos-jobs.py register`
  skips it with a message on an older Chronos. `talos-jobs.py validate` understands command jobs.
- **Quieter installer.** Chronos's own installer output is one labelled line (`chronos: ...`) instead of a
  mid-run block with "created an empty jobs.json". With `--no-load` the installer prints how to start the
  scheduler and the web UI by hand (it used to print a UI address that nothing served).
- **Python 3.10+ for memory search**: the README, `setup/memory-search.md` and the installer's error say the one
  command to run (`brew install uv`, or the official uv installer; Homebrew `python@3.12` as the alternative).
- **Protected folders**: with `--allow-protected-folder` (or `--no-chronos`) the installer now WARNS that every
  Claude Code auto-update triggers a macOS "would like to access files in your Desktop folder" prompt that
  silently blocks background runs; the README says to keep the agent in a folder like `~/agent`.
- `uninstall.sh` no longer says the agent folder "was not touched" when it removed the Chronos hook line from
  `.claude/settings.json`; it names that one edit.
- README: a Chronos dashboard screenshot on the first screen (`docs/`, not copied into agent folders) and a
  "What it looks like day to day" section with a synthetic morning brief.
- The README no longer says "no pip": the core is stdlib-only and every dependency is an opt-in flag.

## 1.0.0-cli - 2026-10-01

First public release: Talos ported from the Claude desktop app to the Claude Code command line, and bundled
with [Chronos](https://github.com/treynortetik-creator/chronos).

### Changed (desktop app to CLI)

- **Install:** `install.sh` / `uninstall.sh` replace the double-click-a-zip, open-in-the-app flow. The installer
  copies the kit into an agent folder (never runs the agent from the clone), writes `.claude/settings.json` and a
  `.talos-version` stamp, and refuses non-empty, cloud-synced and (with Chronos on) macOS-protected folders.
- **Scheduling:** the desktop scheduled-tasks feature and its "leave a note, run it in the live session" job
  mailbox are gone (`hooks/job-inbox.py`, `.agent-state/`, the in-session poller, `scripts/test-scheduled-task.sh`).
  Scheduled work is now **Chronos jobs**: `jobs/jobs.json` plus a `prompt.md` and a locked `guard.md` per job,
  in Chronos's format. Three jobs ship, all disabled: morning brief, weekly wiki check, weekly snapshot.
- **Headless discipline:** every job runs its steps in the foreground (a `claude -p` run kills background work
  when it exits), and every shipped `guard.md` says so. The test suite fails if one stops.
- **The morning brief** no longer splits into a scheduled task that drops a note and a sub-agent that writes the
  brief in a live session. The job does the work itself and delivers the report through a pluggable `notify`
  command (Telegram Bot API over `curl`, or a macOS banner).
- **Session hook:** `CHRONOS_RUN=1` (set by Chronos in headless runs) suppresses the wiki-lint, ledger and
  commit nudges. Each one stamps itself as "asked", so a headless run that saw one would have used up the
  weekly reminder with nobody there to answer. Regression test added.
- **Connectors:** desktop-app connector instructions replaced by `/mcp` inside a session. The kit still
  installs none.
- **Docs rewritten for the CLI:** README, START-HERE, BOOTSTRAP, MORNING-BRIEF, `setup/scheduling.md`, UNINSTALL,
  UPGRADE (with a section for installs from the desktop-app era).

### Added

- `scripts/talos-jobs.py` (register / unregister / list / enable / disable / validate jobs, add or remove the
  Chronos SessionStart hook), `scripts/test-jobs.sh`, `scripts/test-install.sh` (fake HOME, launchctl tripwire,
  stub and optional real Chronos), `notify/` wrappers, a "Scheduled runs" section in the config template.
- A "Security model" section in the README, including an honest statement that the prompt-injection
  follow-rate test is incomplete.

### Kept

The memory and wiki structure, setup interview, seed and deep dive, continuity and pre-tool hooks, wiki linter,
quote checker, upgrade and uninstall procedures, and the self-test suite (updated for the CLI).

### Removed

Everything specific to the internal distribution of the earlier builds: release tooling, review and build logs,
organisation-specific framing and examples.
