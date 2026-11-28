// What apps/bridge/test/preload.ts does for bun tests, for a vitest suite that spawns the real bridge (the contract suites, and the
// relay's heartbeat end to end): a bridge child must not inherit the session the tests run in, find the owner's real Chronos, or run the
// owner's real `claude`. Imported by vitest.contract.config.ts (setupFiles) and by heartbeat-bridge-e2e.test.ts.
//
// Every Talos app and session variable goes (on 2026-11-15 a kit test run from inside a thread session sent real cards to the owner's
// phone because the session's app folder and worker proof were still in the environment).
for (const key of Object.keys(process.env)) if (key.startsWith('TALOS_APP_')) delete process.env[key]
for (const key of ['TALOS_SESSION_ROLE', 'TALOS_AGENT_DIR', 'TALOS_HOME', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ATTENDED'])
  delete process.env[key]

// No test bridge finds the owner's real Chronos (2026-11-03: a test closed the live morning brief). A test that wants a scheduler
// passes TALOS_APP_CHRONOS_BIN to a Chronos under its own TALOS_TEST_ROOT.
process.env.TALOS_APP_CHRONOS_AUTODISCOVER = 'off'

// No test bridge runs the owner's real `claude` (doctor does): a quiet fake is first on PATH.
import { afterAll } from 'vitest'
import { installFakeClaude } from '../test/fake-claude.ts'

const restorePath = installFakeClaude()
afterAll(restorePath)
