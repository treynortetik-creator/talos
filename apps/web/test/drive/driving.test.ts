// WP-V3: the driving toggle (V4.1): one signed config.patch, one retry on config_conflict, then a plain message.

import { DRIVING_DEFAULT_MS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { setDriving } from '../../src/features/drive/driving.ts'
import { TalosClientError } from '../../src/lib/client.ts'
import { createFakeClient } from '../../src/lib/fakeClient.ts'

const NOW = Date.parse('2026-10-28T16:00:00.000Z')

describe('setDriving', () => {
  it('on: patches driving_until to now + 2 h; off patches null', async () => {
    const c = createFakeClient({ now: () => NOW })
    expect(await setDriving(c, true, { now: NOW, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(c.store.getState().config?.voice_notes.driving_until).toBe(new Date(NOW + DRIVING_DEFAULT_MS).toISOString())
    expect(await setDriving(c, false, { now: NOW, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(c.store.getState().config?.voice_notes.driving_until).toBeNull()
    const patches = c.sent.filter((f) => f.type === 'config.patch')
    expect(patches).toHaveLength(2)
    expect(patches[1]?.patch).toEqual({ voice_notes: { driving_until: null } })
  })

  it('config_conflict once: retries once and succeeds', async () => {
    const c = createFakeClient({ now: () => NOW })
    c.failNextPatchWith('config_conflict')
    expect(await setDriving(c, true, { now: NOW, retryDelayMs: 0 })).toEqual({ ok: true })
    expect(c.sent.filter((f) => f.type === 'config.patch')).toHaveLength(1)
  })

  it('config_conflict twice: says so in plain words, no third try', async () => {
    const c = createFakeClient({ now: () => NOW })
    let calls = 0
    c.patchConfig = async () => {
      calls++
      throw new TalosClientError('config_conflict')
    }
    expect(await setDriving(c, true, { now: NOW, retryDelayMs: 0 })).toEqual({
      ok: false,
      message: "Couldn't change driving mode. Try again.",
    })
    expect(calls).toBe(2)
  })

  it('any other error is not retried', async () => {
    const c = createFakeClient({ now: () => NOW })
    c.failNextPatchWith('mac_offline')
    const r = await setDriving(c, true, { now: NOW, retryDelayMs: 0 })
    expect(r.ok).toBe(false)
  })
})
