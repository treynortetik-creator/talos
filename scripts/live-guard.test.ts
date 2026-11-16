// Runs scripts/live-guard-test.sh (the live bridge checkout guard, .githooks/live-guard.sh) as part of the scripts suite.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { expect, test } from 'vitest'

test('the live-checkout guard: a marked clone is put back and refused; worktrees and unmarked clones untouched', () => {
  const r = spawnSync('bash', [join(__dirname, 'live-guard-test.sh')], { encoding: 'utf8', timeout: 60_000 })
  expect(r.stdout).toContain('live-guard: all passed')
  expect(r.status).toBe(0)
})
