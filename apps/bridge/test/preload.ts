// Loaded before every bridge test (bunfig.toml). A test bridge, in process or spawned, must never find the owner's real
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

// And no bridge test starts the plain explanation of permission cards on whatever `claude` it finds; the explainer's own
// tests give it a fake CLI by path.
process.env.TALOS_EXPLAINER = 'off'

// Nor the owner's Claude folder: the hub reads each thread session's transcript from `<CLAUDE_CONFIG_DIR>/projects`, and the
// fake relay lists thread-sessions/1, so without this a test would look in the real ~/.claude/projects.
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'talos-test-claude-'))
