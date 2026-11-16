// The preload scrubs the session's Talos and Claude variables and marks the run as a test, so a bridge test that spawns a hook
// cannot reach a live bridge (2026-11-15: a kit test run from a thread session sent real cards to the owner's phone).
import { expect, test } from 'bun:test'
import { runTmp } from './run-tmp.ts'

test('the session variables are gone and the run is marked with its temp folder', () => {
  for (const key of [
    'TALOS_APP_HOME',
    'TALOS_APP_WORKER_THREAD',
    'TALOS_APP_WORKER_NONCE',
    'TALOS_SESSION_ROLE',
    'CLAUDE_PID',
  ]) {
    expect(process.env[key]).toBeUndefined()
  }
  expect(process.env.TALOS_TEST_SANDBOX).toBe(runTmp)
})
