// The start of a test's tmux socket names: one per heavy slot, never the owner's `talos` server.
import { afterEach, describe, expect, it } from 'vitest'
import { tmuxTestPrefix } from '../src/tmux-prefix.ts'

const before = process.env.TALOS_TEST_TMUX_PREFIX
afterEach(() => {
  if (before === undefined) delete process.env.TALOS_TEST_TMUX_PREFIX
  else process.env.TALOS_TEST_TMUX_PREFIX = before
})

describe('tmuxTestPrefix', () => {
  it('is the slot prefix scripts/heavy-lock.sh sets, else talos-test', () => {
    delete process.env.TALOS_TEST_TMUX_PREFIX
    expect(tmuxTestPrefix()).toBe('talos-test')
    process.env.TALOS_TEST_TMUX_PREFIX = 'talos-test-s2'
    expect(tmuxTestPrefix()).toBe('talos-test-s2')
  })

  it('is never the owner’s server, `default`, or anything that is not a plain socket name', () => {
    for (const bad of ['talos', 'default', '', 'has space', 'a/b', '../x', 'x'.repeat(41)]) {
      process.env.TALOS_TEST_TMUX_PREFIX = bad
      expect(tmuxTestPrefix(), bad).toBe('talos-test')
    }
  })
})
