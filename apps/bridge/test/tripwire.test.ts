import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDeviceKey } from '@talos-app/protocol'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { DeviceStore } from '../src/devices.ts'
import { writeJsonAtomic } from '../src/fsutil.ts'
import { recordedWrite, securityState, Tripwire } from '../src/tripwire.ts'

let home = ''
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function setup() {
  home = mkdtempSync('/tmp/tw')
  const p = paths(home)
  writeFileSync(p.configJson, `${JSON.stringify({ version: 1, rev: 1, trust_mode: false })}\n`)
  const store = new DeviceStore(p.devicesJson)
  const key = await createDeviceKey()
  const id = key.deviceId
  store.pin({ id, name: 'Phone', pubkey_jwk: key.publicJwk }, '2026-01-01T00:00:00Z')
  const alerts: string[] = []
  const wire = new Tripwire({ home, now: () => 1_000_000, alert: async (s) => void alerts.push(s) })
  return { p, store, id, alerts, wire }
}

describe('tripwire', () => {
  test('an outside edit to devices.json raises an alert, once', async () => {
    const s = await setup()
    await s.wire.check() // first sight: records the baseline, says nothing
    expect(s.alerts).toEqual([])
    const f = JSON.parse(readFileSync(s.p.devicesJson, 'utf8'))
    f.devices[0].revoked_at = undefined
    f.devices.push({ id: 'd_bbbbbbbbbbbbbbbbbbbb', name: 'Planted', pubkey_jwk: f.devices[0].pubkey_jwk })
    writeFileSync(s.p.devicesJson, JSON.stringify(f))
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('devices.json')
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
  })

  test('talos-app devices revoke through the CLI raises a notice naming the device, not the key', async () => {
    const s = await setup()
    await s.wire.check()
    const io = {
      isTerminal: true,
      out: () => {},
      err: () => {},
      prompt: async () => '',
      sleep: async () => {},
      now: () => Date.now(),
    }
    // the relay is unreachable, so the command ends 1 after the local write; the local write is what is under test
    await runCli(['devices', 'revoke', s.id], io, { TALOS_APP_HOME: home, TALOS_APP_RELAY_URL: 'http://127.0.0.1:9' })
    expect(JSON.parse(readFileSync(s.p.devicesJson, 'utf8')).devices[0].revoked_at).toBeDefined()
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain("'Phone'")
    expect(s.alerts[0]).toContain(s.id)
    expect(s.alerts[0]).toContain('revoked')
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
  })

  test('a change to a security field of config.json alerts; an unrelated field does not', async () => {
    const s = await setup()
    await s.wire.check()
    writeFileSync(s.p.configJson, `${JSON.stringify({ version: 1, rev: 2, trust_mode: false })}\n`)
    await s.wire.check()
    expect(s.alerts).toEqual([])
    writeFileSync(s.p.configJson, `${JSON.stringify({ version: 1, rev: 3, trust_mode: true })}\n`)
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('config.json')
  })

  test('a pin made in-process by a script outside the bridge raises a notice with label and id, never the key', async () => {
    const s = await setup()
    await s.wire.check()
    const k = await createDeviceKey()
    // what an agent could do with a bun script that imports the store: the write is recorded, the notice still comes
    new DeviceStore(s.p.devicesJson).pin(
      { id: k.deviceId, name: 'Tablet', pubkey_jwk: k.publicJwk },
      '2026-01-02T00:00:00Z',
    )
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('A device was added')
    expect(s.alerts[0]).toContain("'Tablet'")
    expect(s.alerts[0]).toContain(k.deviceId)
    expect(s.alerts[0]).toContain('revoke it in Settings')
    expect(s.alerts[0]).not.toContain(String(k.publicJwk.x))
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
  })

  test('a normal enroll pin (the store call the bridge makes) also raises the notice', async () => {
    const s = await setup()
    await s.wire.check()
    const k = await createDeviceKey()
    s.store.pin({ id: k.deviceId, name: 'Tablet', pubkey_jwk: k.publicJwk }, '2026-01-02T00:00:00Z')
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain("'Tablet'")
  })

  test('a recorded key change for an existing id raises a notice', async () => {
    const s = await setup()
    await s.wire.check()
    const k = await createDeviceKey()
    s.store.pin({ id: s.id, name: 'Phone', pubkey_jwk: k.publicJwk }, '2026-01-02T00:00:00Z')
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('key')
    expect(s.alerts[0]).toContain("'Phone'")
  })

  test('a config.json change through recordedWrite raises nothing', async () => {
    const s = await setup()
    await s.wire.check()
    recordedWrite(s.p.configJson, 'config', () =>
      writeJsonAtomic(s.p.configJson, { version: 1, rev: 2, trust_mode: true }, 0o600),
    )
    await s.wire.check()
    expect(s.alerts).toEqual([])
  })
})

/** Plants a device by hand: an edit from outside the app. */
function plant(p: ReturnType<typeof paths>) {
  const f = JSON.parse(readFileSync(p.devicesJson, 'utf8'))
  f.devices.push({ id: 'd_bbbbbbbbbbbbbbbbbbbb', name: 'Planted', pubkey_jwk: f.devices[0].pubkey_jwk })
  writeFileSync(p.devicesJson, JSON.stringify(f))
}

describe('tripwire cannot be silenced from outside', () => {
  test('a tripwire.writing marker dated in the future does not hide a change', async () => {
    const s = await setup()
    await s.wire.check()
    writeFileSync(join(home, 'tripwire.writing'), String(1_000_000 + 10 * 365 * 86_400_000))
    plant(s.p)
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('devices.json')
  })

  test('a marker older than 30 seconds does not hide a change; a fresh one does', async () => {
    const s = await setup()
    await s.wire.check()
    writeFileSync(join(home, 'tripwire.writing'), String(1_000_000 - 31_000))
    plant(s.p)
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    const t = await setup()
    await t.wire.check()
    writeFileSync(join(home, 'tripwire.writing'), String(1_000_000 - 5_000))
    plant(t.p)
    await t.wire.check()
    expect(t.alerts).toEqual([]) // an app write in flight: wait for it
  })

  test('a marker that is still there on the next check does not hide a change forever', async () => {
    const s = await setup()
    await s.wire.check()
    plant(s.p)
    writeFileSync(join(home, 'tripwire.writing'), String(1_000_000 - 1_000))
    await s.wire.check()
    expect(s.alerts).toEqual([])
    writeFileSync(join(home, 'tripwire.writing'), String(1_000_000)) // kept fresh by hand
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
  })

  for (const [name, reset] of [
    ['deleted', () => rmSync(join(home, 'tripwire.json'))],
    ['emptied to {}', () => writeFileSync(join(home, 'tripwire.json'), '{}')],
    ['not JSON', () => writeFileSync(join(home, 'tripwire.json'), 'garbage')],
    [
      'missing one key',
      () => {
        const b = JSON.parse(readFileSync(join(home, 'tripwire.json'), 'utf8'))
        delete b.devices
        writeFileSync(join(home, 'tripwire.json'), JSON.stringify(b))
      },
    ],
  ] as const) {
    test(`baseline ${name} after it existed raises an alert, not a quiet new baseline`, async () => {
      const s = await setup()
      await s.wire.check()
      reset()
      plant(s.p) // the point of wiping the baseline
      await s.wire.check()
      expect(s.alerts.join('\n')).toContain('tripwire state was reset outside the app')
      expect(s.alerts.join('\n')).toContain('devices.json') // and the change itself is still reported
      const n = s.alerts.length
      await s.wire.check()
      expect(s.alerts).toHaveLength(n) // once
    })
  }

  test('a baseline rewritten to match an unrecorded change is caught (held in memory for the run)', async () => {
    const s = await setup()
    await s.wire.check()
    plant(s.p)
    const now = securityState(home, 'devices')
    // what an agent would do next: make the baseline agree with the planted file
    const b = JSON.parse(readFileSync(join(home, 'tripwire.json'), 'utf8'))
    writeJsonAtomic(join(home, 'tripwire.json'), { ...b, devices: { h: now.h, hist: [], fields: now.fields } }, 0o600)
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('devices.json')
  })

  test('a baseline value rewritten with no file change is caught', async () => {
    const s = await setup()
    await s.wire.check()
    const b = JSON.parse(readFileSync(join(home, 'tripwire.json'), 'utf8'))
    writeJsonAtomic(join(home, 'tripwire.json'), { ...b, config: { h: 'f'.repeat(64), hist: [], fields: {} } }, 0o600)
    await s.wire.check()
    expect(s.alerts.join('\n')).toContain('tripwire state was reset outside the app')
  })

  test('the alert names the changed top-level fields and never their values', async () => {
    const s = await setup()
    await s.wire.check()
    writeFileSync(
      s.p.configJson,
      `${JSON.stringify({ version: 1, rev: 3, trust_mode: true, mirror: { chat: 'SECRET-CHAT-77' } })}\n`,
    )
    await s.wire.check()
    expect(s.alerts).toHaveLength(1)
    expect(s.alerts[0]).toContain('trust_mode')
    expect(s.alerts[0]).toContain('mirror')
    expect(s.alerts[0]).not.toContain('SECRET-CHAT-77')
    expect(s.alerts[0]).not.toContain('true')
  })
})
