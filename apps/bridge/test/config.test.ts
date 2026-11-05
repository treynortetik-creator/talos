import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Harness, pushConfigPatchPastRelay, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

const errFor = async (id: string) =>
  (await h.relay.expectFrame('error', (f) => f.ref === id, { direction: 'from_bridge' })).code
const onDisk = () => JSON.parse(readFileSync(join(h.home, 'config.json'), 'utf8'))

describe('config.patch and config.json', () => {
  test('the bridge sends config.sync with the Mac config after connecting', async () => {
    h = await startHarness()
    const sync = await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect(h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'config.sync')).toHaveLength(
      1,
    )
    expect(sync.config.agent.name).toBe('Talos')
    expect(sync.rev).toBe(sync.config.rev)
  })

  test('config.sync still carries the legacy mirror {telegram:off} on the wire, while config.json never stores or reads it (R1-1)', async () => {
    h = await startHarness()
    const sync = await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    expect((sync.config as Record<string, unknown>).mirror).toEqual({ telegram: 'off' })
    expect(onDisk()).not.toHaveProperty('mirror')
  })

  test('a patch touching the removed mirror setting is config_field_forbidden and changes nothing', async () => {
    h = await startHarness()
    const f = await pushConfigPatchPastRelay(h, 0, { mirror: { telegram: 'on' } })
    expect(await errFor(f.id)).toBe('config_field_forbidden')
    expect(onDisk()).not.toHaveProperty('mirror')
    expect(onDisk().rev).toBe(0)
  })

  test('other Mac-only or unknown fields are forbidden too', async () => {
    h = await startHarness()
    for (const patch of [{ version: 2 }, { rev: 99 }, { mirror: null }, { surprise: 1 }]) {
      const f = await pushConfigPatchPastRelay(h, 0, patch as Record<string, unknown>)
      expect(await errFor(f.id), JSON.stringify(patch)).toBe('config_field_forbidden')
    }
    expect(onDisk().rev).toBe(0)
  })

  test('work.label and work.ask_note are now allowed from the phone and written; the schema still bounds them', async () => {
    h = await startHarness()
    await h.app.sendConfigPatch(0, { work: { label: 'Office tools', ask_note: 'Check with IT first.' } })
    await h.relay.expectFrame('config.sync', (f) => f.config.work.label === 'Office tools', {
      direction: 'from_bridge',
    })
    expect(onDisk().work.ask_note).toBe('Check with IT first.')
    expect(onDisk().work.enabled).toEqual([]) // untouched siblings survive
    const bad = await h.app.sendConfigPatch(1, { work: { label: 'x'.repeat(41) } })
    expect(await errFor(bad.id)).toBe('bad_frame')
    expect(onDisk().work.label).toBe('Office tools')
  })

  test('an allowed patch merges, bumps rev, writes config.json atomically and emits config.sync', async () => {
    h = await startHarness()
    await h.app.sendConfigPatch(0, {
      agent: { name: 'Atlas' },
      quiet_window: { start: '22:00', end: '07:00' },
    })
    const sync = await h.relay.expectFrame('config.sync', (f) => f.config.agent.name === 'Atlas', {
      direction: 'from_bridge',
    })
    expect(sync.rev).toBe(1)
    expect(sync.config.quiet_window).toEqual({ start: '22:00', end: '07:00' })
    expect(sync.config.timezone).toBe('UTC')
    const d = onDisk()
    expect(d.rev).toBe(1)
    expect(d.agent.name).toBe('Atlas')
    expect(d.agent.voice).toBe('meridian') // untouched siblings survive the merge
    expect(h.bridge.ctx.config.config.agent.name).toBe('Atlas')
  })

  test('a null quiet_window patch turns an existing window off (audit D33)', async () => {
    h = await startHarness()
    await h.app.sendConfigPatch(0, { quiet_window: { start: '22:00', end: '07:00' } })
    await h.relay.expectFrame('config.sync', (f) => f.rev === 1, { direction: 'from_bridge' })
    const f = await h.app.sendConfigPatch(1, { quiet_window: null })
    const sync = await h.relay.expectFrame('config.sync', (s) => s.rev === 2, { direction: 'from_bridge' })
    expect(sync.config.quiet_window).toBeNull()
    expect(onDisk().rev).toBe(2)
    expect(h.relay.frames.some((r) => r.frame.type === 'error' && (r.frame as { ref?: string }).ref === f.id)).toBe(
      false,
    )
  })

  test('a stale base_rev is config_conflict; an invalid result is bad_frame; a bad structure is rejected', async () => {
    h = await startHarness()
    await h.app.sendConfigPatch(0, { agent: { name: 'One' } })
    await h.relay.expectFrame('config.sync', (f) => f.rev === 1, { direction: 'from_bridge' })
    const stale = await h.app.sendConfigPatch(0, { agent: { name: 'Two' } })
    expect(await errFor(stale.id)).toBe('config_conflict')
    const bad = await h.app.sendConfigPatch(1, { timezone: 'Not/AZone' })
    expect(await errFor(bad.id)).toBe('bad_frame')
    const noInbox = await h.app.sendConfigPatch(1, { default_thread: 'ghost' })
    expect(await errFor(noInbox.id)).toBe('bad_frame')
    expect(onDisk().agent.name).toBe('One')
  })

  test('threads can be patched (arrays replace), and work.enabled / work.thread are allowed', async () => {
    h = await startHarness()
    const cfg = onDisk()
    const threads = [
      ...cfg.threads,
      {
        id: 'ops',
        name: 'Ops',
        kind: 'fixed',
        order: 5,
        notify: 'all',
        voice_context: 'recent',
        archived: false,
        created_at: cfg.threads[0].created_at,
      },
    ]
    await h.app.sendConfigPatch(
      0,
      { threads, work: { enabled: ['github'], thread: 'ops' } },
      { stepup_token: h.relay.mintStepup('config:work') },
    )
    const sync = await h.relay.expectFrame('config.sync', (f) => f.config.threads.length === 3, {
      direction: 'from_bridge',
    })
    expect(sync.config.work.enabled).toEqual(['github'])
    expect(sync.config.work.thread).toBe('ops')
    expect(sync.config.work.label).toBe('Work systems')
  })

  test('a hand edit of config.json is picked up: rev is bumped and config.sync follows', async () => {
    h = await startHarness()
    const cfg = onDisk()
    await h.relay.expectFrame('config.sync', () => true, { direction: 'from_bridge' })
    const before = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'config.sync').length
    writeFileSync(join(h.home, 'config.json'), JSON.stringify({ ...cfg, owner: { display_name: 'Edited' } }))
    await h.bridge.poll()
    await waitFor(
      () =>
        h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'config.sync').length > before,
    )
    const last = h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.frame.type === 'config.sync').at(-1)
      ?.frame as { config: { owner: { display_name: string }; rev: number } }
    expect(last.config.owner.display_name).toBe('Edited')
    expect(last.config.rev).toBe(1)
    expect(onDisk().rev).toBe(1)
  })

  test('a half-written or invalid config.json is ignored: the last good config stays', async () => {
    h = await startHarness()
    writeFileSync(join(h.home, 'config.json'), '{ "version": 1, ')
    await h.bridge.poll()
    expect(h.bridge.ctx.config.config.agent.name).toBe('Talos')
  })
})
