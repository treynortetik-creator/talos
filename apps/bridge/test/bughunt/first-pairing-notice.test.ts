// Bug hunt 2026-11-10 #15: the first device pairing on a fresh install posted a security notice about a removal that
// never happened ("A device was removed: '(unknown)' ((file))"). The tripwire's first baseline is taken before
// devices.json exists, and the "(file)" key that stands for a missing file was read as a device id.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceKey } from '@talos-app/protocol'
import { paths } from '../../src/config.ts'
import { DeviceStore } from '../../src/devices.ts'
import { Tripwire } from '../../src/tripwire.ts'

let home = ''
afterEach(() => rmSync(home, { recursive: true, force: true }))

function fresh() {
  home = mkdtempSync(join(tmpdir(), 'tw-first-'))
  const p = paths(home)
  writeFileSync(p.configJson, `${JSON.stringify({ version: 1, rev: 1, trust_mode: false })}\n`)
  const alerts: string[] = []
  const wire = new Tripwire({ home, now: () => 1_000_000, alert: async (s) => void alerts.push(s) })
  return { p, alerts, wire }
}
const pin = async (file: string, name: string) => {
  const k = await createDeviceKey()
  new DeviceStore(file).pin({ id: k.deviceId, name, pubkey_jwk: k.publicJwk }, '2026-01-02T00:00:00Z')
  return k.deviceId
}

describe('bug hunt #15: the first pairing on a fresh install', () => {
  test('one notice, "added", naming the phone; no removal is announced and "(file)" is never shown as a device', async () => {
    const s = fresh()
    expect(existsSync(s.p.devicesJson)).toBe(false)
    await s.wire.check() // the baseline of a home with no devices.json yet
    expect(s.alerts).toEqual([])
    const id = await pin(s.p.devicesJson, 'sandbox-phone')
    await s.wire.check()
    expect(s.alerts).toEqual([
      `A device was added: 'sandbox-phone' (${id}). If that wasn't you, revoke it in Settings → Devices.`,
    ])
    expect(s.alerts.join('\n')).not.toContain('(file)')
    expect(s.alerts.join('\n')).not.toContain('removed')
  })

  test('devices.json going from unreadable to readable announces the devices in it, and no removal', async () => {
    const s = fresh()
    writeFileSync(s.p.devicesJson, '{ not json')
    await s.wire.check()
    rmSync(s.p.devicesJson)
    const id = await pin(s.p.devicesJson, 'Phone')
    await s.wire.check()
    const about = s.alerts.filter((a) => a.startsWith('A device'))
    expect(about).toEqual([`A device was added: 'Phone' (${id}). If that wasn't you, revoke it in Settings → Devices.`])
  })

  test('the second pairing after that is announced once as well, and a revoke still names the device', async () => {
    const s = fresh()
    await s.wire.check()
    const first = await pin(s.p.devicesJson, 'Phone')
    await s.wire.check()
    const second = await pin(s.p.devicesJson, 'Tablet')
    await s.wire.check()
    new DeviceStore(s.p.devicesJson).revoke(first, '2026-01-03T00:00:00Z')
    await s.wire.check()
    expect(s.alerts).toEqual([
      `A device was added: 'Phone' (${first}). If that wasn't you, revoke it in Settings → Devices.`,
      `A device was added: 'Tablet' (${second}). If that wasn't you, revoke it in Settings → Devices.`,
      `A device was revoked: 'Phone' (${first}).`,
    ])
  })
})
