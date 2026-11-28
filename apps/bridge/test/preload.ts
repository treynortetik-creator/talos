// Loaded before every bridge test (bunfig.toml). First of all, every temp folder of this run goes in one that the run removes.
import { runTmp } from './run-tmp.ts'

// No bridge test may inherit the session it runs in: on 2026-11-15 a kit test run from inside a thread session sent real cards
// to the owner's phone, because the session's app folder and worker proof were still in the environment. Every Talos app and
// session variable goes, and TALOS_TEST_SANDBOX (this run's temp folder) tells the kit hooks they may reach no hub outside it.
for (const key of Object.keys(process.env)) if (key.startsWith('TALOS_APP_')) delete process.env[key]
for (const key of ['TALOS_SESSION_ROLE', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ATTENDED']) delete process.env[key]
process.env.TALOS_TEST_SANDBOX = runTmp

// The bridge's own SQLite files sync only at a checkpoint in tests (synchronous = NORMAL with WAL, src/sqlite-test-seam.ts): the
// tests check behaviour, not the disk, and on an encrypted btrfs temp folder the per-commit syncs made SQLite-heavy tests take
// minutes. A test whose point is durability puts the product's value back (durableSqlite in sqlite-durable.ts).
import { SQLITE_TEST } from '../src/sqlite-test-seam.ts'

SQLITE_TEST.synchronous = 'NORMAL'

// Every sentence that names the owner's computer is the Mac's in tests (platform.ts ownerHost), whatever machine runs them: the
// Mac's sentences are pinned byte for byte, and a test of the Linux or Windows words sets the seam and puts it back.
import { OWNER_HOST_TEST } from '../src/platform.ts'

OWNER_HOST_TEST.host = 'mac'

// A test bridge, in process or spawned, must never find the owner's real
// Chronos and touch its live runs: on 2026-11-03 a test's bridge closed the live morning brief as session_ended.
// Tests that want a scheduler pass TALOS_APP_CHRONOS_BIN to a fake one, which still works.
process.env.TALOS_APP_CHRONOS_AUTODISCOVER = 'off'

// Likewise no bridge test may run the owner's real `claude` (doctor does); a quiet fake is first on PATH unless a test swaps it.
import { installFakeClaude } from './fake-claude.ts'

installFakeClaude()

// A thread's inbox lives in ~/.talos-inbox. No test may touch the real one: every bridge test gets its own throw-away root
// (loadEnv reads TALOS_INBOX_ROOT from the process too), and a test that checks the inbox sets its own.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.TALOS_INBOX_ROOT = join(mkdtempSync(join(tmpdir(), 'talos-test-inbox-')), '.talos-inbox')

// Nor does a test bridge read the launch of the Claude session a developer runs the tests from (claude-env.ts
// talosChannelState): it says 'unknown' unless a test sets this, or hands the walk a fake process tree.
process.env.TALOS_TEST_CHANNEL = 'unknown'

// And no bridge test starts the plain explanation of permission cards on whatever `claude` it finds; the explainer's own
// tests give it a fake CLI by path.
process.env.TALOS_EXPLAINER = 'off'

// Nor the owner's Claude folder: the hub reads each thread session's transcript from `<CLAUDE_CONFIG_DIR>/projects`, and the
// fake relay lists thread-sessions/1, so without this a test would look in the real ~/.claude/projects.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'talos-test-claude-'))

// Nothing a run makes in $TMPDIR outlives it: these two folders, and every folder made through temp-dirs.ts (tempHome, the
// apps tests' tmp, ChronosBox) that is still there after the last test file.
import { afterAll } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { removeTestTempDirs } from './temp-dirs.ts'

const runFolders = [dirname(process.env.TALOS_INBOX_ROOT), process.env.CLAUDE_CONFIG_DIR]
afterAll(() => {
  removeTestTempDirs()
  for (const dir of runFolders) rmSync(dir, { recursive: true, force: true })
})

// The real clock is ONE object for the whole process (src/clock.ts), and a single-process `bun test` shares it across every file.
// On 2026-11-27 a test set `ctx.clock.now = () => real() + 20_000` on it and never put it back: every later file's bridge then read
// supervisor heartbeats 20 s stale, and 241 tests failed far from the cause. It is frozen here, so a test that tries to change it
// throws at that line; a test that needs other time passes its own clock (startHarness({ clock })). The check after each test
// names any change that got past the freeze.
import { afterEach } from 'bun:test'
import { realClock } from '../src/clock.ts'

const REAL_CLOCK = { now: realClock.now, setTimeout: realClock.setTimeout, clearTimeout: realClock.clearTimeout }
Object.freeze(realClock)
afterEach(() => {
  const changed = (Object.keys(REAL_CLOCK) as (keyof typeof REAL_CLOCK)[]).filter((k) => realClock[k] !== REAL_CLOCK[k])
  if (changed.length > 0)
    throw new Error(
      `this test changed realClock.${changed.join(', realClock.')}: pass a clock of its own (startHarness({ clock })) instead`,
    )
})
