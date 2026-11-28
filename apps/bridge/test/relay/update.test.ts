// `talos-app relay update`: one redeploy, then watch the relay's /healthz until it is on the new release.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cli, connectProject, ENV_ID, FAKE_PROJECT_TOKEN, RELAY_SERVICE_ID, useWorldCleanup, world } from './helpers.ts'

useWorldCleanup()

describe('relay update', () => {
  test('not connected: says how to connect, and the Railway way, and asks Railway nothing', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.all).toContain('talos-app relay connect')
    expect(r.all).toContain('Railway updates an image relay within a few hours; to update now, redeploy it in Railway')
    expect(w.railway.calls).toHaveLength(0)
  })
  test('a relay that deploys from main is refused: no request at all', async () => {
    const w = world({ relayRelease: undefined })
    await connectProject(w)
    w.railway.calls.length = 0
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.err).toContain("your relay deploys from main; it isn't updated from releases")
    expect(w.railway.redeploys()).toHaveLength(0)
    expect(w.railway.calls).toHaveLength(0)
  })
  test('already on the latest release (or newer): says so, sends nothing', async () => {
    for (const release of ['0.1.8', '0.2.0']) {
      const w = world({ relayRelease: release })
      await connectProject(w)
      const r = await cli(w, ['relay', 'update'])
      expect(r.code, release).toBe(0)
      expect(r.out, release).toContain(release === '0.1.8' ? 'already on 0.1.8' : 'already on 0.2.0')
      expect(w.railway.redeploys(), release).toHaveLength(0)
    }
  })
  test('behind: exactly one mutation with the right ids and header, then it watches until the release moves', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    w.railway.onRedeploy = () => {
      w.relay.moveTo = '0.1.8'
      w.relay.after = 2
    }
    const r = await cli(w, ['relay', 'update'])
    expect(r.code, r.all).toBe(0)
    const sent = w.railway.redeploys()
    expect(sent).toHaveLength(1)
    expect(sent[0]?.variables).toEqual({ serviceId: RELAY_SERVICE_ID, environmentId: ENV_ID })
    expect(sent[0]?.projectHeader).toBe(FAKE_PROJECT_TOKEN)
    expect(sent[0]?.authHeader).toBeUndefined()
    expect(r.out).toContain('redeploying')
    expect(r.out).toContain('relay is on 0.1.8')
    expect(r.sleeps.length).toBeGreaterThan(0)
    for (const ms of r.sleeps) expect(ms).toBe(10_000)
    expect(r.all).not.toContain(FAKE_PROJECT_TOKEN)
    expect(r.out).not.toContain(RELAY_SERVICE_ID)
  })
  test('a relay that never moves: gives up after ten minutes of ten-second looks, in plain words', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.err).toContain("didn't update")
    expect(r.err).toContain('10 minutes')
    expect(r.sleeps).toHaveLength(60)
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('a Railway error is one plain line, never the token or the body', async () => {
    const w = world({ relayRelease: '0.1.6', railway: { redeployError: 'Not Authorized' } })
    await connectProject(w)
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('Project-Access-Token')
    expect(r.err).toMatch(/refused|new token/)
    expect(r.all).not.toContain(FAKE_PROJECT_TOKEN)
    const down = world({ relayRelease: '0.1.6', railway: { redeployStatus: 502 } })
    await connectProject(down)
    const d = await cli(down, ['relay', 'update'])
    expect(d.code).toBe(1)
    expect(d.err).toContain("Railway isn't answering")
    expect(d.err).not.toContain('nope')
  })
  test('hostile text in a Railway error is cut and stripped of control characters', async () => {
    const w = world({
      relayRelease: '0.1.6',
      railway: { redeployError: `${FAKE_PROJECT_TOKEN} \u001b[31mboom\u0007 ${'x'.repeat(500)}` },
    })
    await connectProject(w)
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.err).not.toContain('\u001b')
    expect(r.err).not.toContain('\u0007')
    expect(r.err.length).toBeLessThan(600)
    expect(r.all).not.toContain(FAKE_PROJECT_TOKEN)
  })
  test('the token missing from the key store: a plain line asking to connect again', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    w.secrets.data.clear()
    w.railway.calls.length = 0
    const r = await cli(w, ['relay', 'update'])
    expect(r.code).toBe(1)
    expect(r.err).toContain('talos-app relay connect')
    expect(w.railway.calls).toHaveLength(0)
  })
  test('the releases list cannot be had: says so and sends nothing', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const r = await cli(w, ['relay', 'update'], { feedUrl: 'http://127.0.0.1:9/x' })
    expect(r.code).toBe(1)
    expect(w.railway.redeploys()).toHaveLength(0)
  })
  test('the attempt is recorded for status, with no id or token', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    w.railway.onRedeploy = () => {
      w.relay.moveTo = '0.1.8'
    }
    await cli(w, ['relay', 'update'])
    const s = await cli(w, ['relay', 'status'])
    expect(s.out).toMatch(/last attempt: .*0\.1\.8/)
    expect(s.out).not.toContain(RELAY_SERVICE_ID)
    expect(existsSync(join(w.home, 'relay-auto.json'))).toBe(true)
    expect(readFileSync(join(w.home, 'relay-auto.json'), 'utf8')).not.toContain(FAKE_PROJECT_TOKEN)
    void writeFileSync
  })
})
