// doctor: the `relay release` row points at `relay connect` or `relay update`; a `relay connect` row only when connected.
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { cli, connectProject, useWorldCleanup, type World, world } from './helpers.ts'

useWorldCleanup()

type Row = { name: string; level: string; detail: string }
const rows = async (w: World): Promise<Row[]> => {
  const r = await cli(w, ['doctor', '--json', '--agent-dir', join(w.home, 'none')])
  return (JSON.parse(r.out) as { checks: Row[] }).checks
}

describe('doctor: relay release and relay connect', () => {
  test('not connected: the behind row says how to connect (and still the Railway way); no relay connect row', async () => {
    const w = world({ relayRelease: '0.1.6' })
    const r = await rows(w)
    const row = r.find((x) => x.name === 'relay release')
    expect(row?.level).toBe('warn')
    expect(row?.detail).toContain('talos-app relay connect')
    expect(row?.detail).toContain('to update now, redeploy it in Railway')
    expect(r.some((x) => x.name === 'relay connect')).toBe(false)
  })
  test('connected: the behind row says talos-app relay update; the connect row is ok and names the kind and auto', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const r = await rows(w)
    const row = r.find((x) => x.name === 'relay release')
    expect(row?.detail).toContain('talos-app relay update')
    expect(row?.detail).not.toContain('talos-app relay connect')
    expect(r.find((x) => x.name === 'relay connect')).toMatchObject({
      level: 'ok',
      detail: 'connected (project token), auto-update on',
    })
    await cli(w, ['relay', 'auto', 'off'])
    expect((await rows(w)).find((x) => x.name === 'relay connect')?.detail).toBe(
      'connected (project token), auto-update off',
    )
  })
  test('connected but the token is gone from the key store: a warning that says what to do', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    w.secrets.data.clear()
    const row = (await rows(w)).find((x) => x.name === 'relay connect')
    expect(row?.level).toBe('warn')
    expect(row?.detail).toContain('talos-app relay connect')
  })
  test('set up by the app: named, and no key store is asked about', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await cli(w, ['relay', 'status']) // creates nothing
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(w.home, 'relay-connect.json'),
      JSON.stringify({
        v: 1,
        via: 'app',
        project_id: 'p-0123456789',
        environment_id: 'e-0123456789',
        service_id: 's-0123456789',
        auto_update: true,
      }),
    )
    const r = await rows(w)
    expect(r.find((x) => x.name === 'relay connect')).toMatchObject({
      level: 'ok',
      detail: 'connected (set up by the Talos app), auto-update on',
    })
    expect(r.find((x) => x.name === 'relay release')?.detail).toContain('talos-app relay update')
  })
})
