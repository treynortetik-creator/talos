// A Keychain tool call that never ends (a locked keychain whose unlock prompt nobody answers) must not hang the caller: it is
// killed after the limit and answers code -1, which every caller reads as "the Keychain did not do it".
import { describe, expect, test } from 'bun:test'
import { KEYCHAIN_SPAWN_TIMEOUT_MS, keychainSpawnWithin } from '../../src/apps/keychain.ts'

describe('a Keychain tool call that hangs', () => {
  test('is killed after the limit and answers -1, without waiting for it', async () => {
    const started = Date.now()
    const r = await keychainSpawnWithin(200)(['/bin/sleep', '30'])
    expect(r.code).toBe(-1)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test('says it timed out, drops what it printed so far, and leaves no process behind', async () => {
    const marker = `31.${Math.floor(Math.random() * 1e6)}`
    const r = await keychainSpawnWithin(200)(['/bin/sh', '-c', `echo partial; exec /bin/sleep ${marker}`])
    expect(r).toEqual({ code: -1, stdout: '', timedOut: true })
    const left = Bun.spawnSync(['/usr/bin/pgrep', '-f', `sleep ${marker}`])
    expect(left.stdout.toString().trim()).toBe('')
  })

  test('one that ends in time keeps its own code and output', async () => {
    const r = await keychainSpawnWithin(5_000)(['/bin/sh', '-c', 'echo listed; exit 3'])
    expect(r).toEqual({ code: 3, stdout: 'listed\n' })
  })

  test('a call reads stdin as before, so the value never reaches argv', async () => {
    const r = await keychainSpawnWithin(5_000)(['/bin/cat'], 'add-generic-password -w v1.x\n')
    expect(r).toEqual({ code: 0, stdout: 'add-generic-password -w v1.x\n' })
  })

  test('the real limit is a few seconds, not none', () => {
    expect(KEYCHAIN_SPAWN_TIMEOUT_MS).toBeGreaterThan(0)
    expect(KEYCHAIN_SPAWN_TIMEOUT_MS).toBeLessThanOrEqual(15_000)
  })
})
