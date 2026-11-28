// The bridge redeploys its relay itself when a new release appears: on by default once connected, at most once an hour, once per
// release, backing off after a failure, never for a relay from main.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RelayRedeployRequest } from '@talos-app/protocol'
import { fakeClock } from '@talos-app/testkit'
import { loadEnv } from '../../src/config.ts'
import type { BridgeContext } from '../../src/context.ts'
import { noteRelay } from '../../src/relay/auto.ts'
import { releaseFeedTestSeam } from '../../src/release-feed.ts'
import {
  cli,
  connectProject,
  ENV_ID,
  FAKE_PROJECT_TOKEN,
  PROJECT_ID,
  RELAY_SERVICE_ID,
  useWorldCleanup,
  type World,
  world,
} from './helpers.ts'

useWorldCleanup()

const HOUR = 3_600_000

function setup(w: World, o: { mode?: 'live' | 'headless'; worker?: boolean } = {}) {
  const clock = fakeClock('2026-11-20T10:00:00.000Z')
  const rows: string[] = []
  const logs: string[] = []
  const store = { kvGet: () => undefined, kvSet: () => {} }
  const ctx = {
    mode: o.mode ?? 'live',
    ...(o.worker ? { worker: {} } : {}),
    env: loadEnv(w.env),
    clock,
    store,
    log: { warn: (m: string) => logs.push(m), info: () => {}, error: () => {} },
  } as unknown as BridgeContext
  const tick = async () => {
    await noteRelay(ctx, async (t) => void rows.push(t), { secrets: w.secrets })
    return rows.length
  }
  const later = (ms: number) => clock.set(clock.now() + ms)
  return { clock, rows, logs, tick, later }
}
/** After a redeploy the fake relay takes the new release at its next look. */
const movesOnRedeploy = (w: World, to = '0.1.8') => {
  w.railway.onRedeploy = () => {
    w.relay.moveTo = to
  }
}

describe('auto-redeploy', () => {
  test('behind: one mutation, "updating" at once, "is on" once the relay says so', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    movesOnRedeploy(w)
    const t = setup(w)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(1)
    expect(w.railway.redeploys()[0]?.variables).toEqual({ serviceId: RELAY_SERVICE_ID, environmentId: ENV_ID })
    expect(t.rows).toEqual(['Your online relay is updating to 0.1.8.'])
    t.later(30_000)
    await t.tick()
    expect(t.rows).toEqual(['Your online relay is updating to 0.1.8.', 'Your online relay is on 0.1.8.'])
    t.later(30_000)
    await t.tick()
    expect(t.rows).toHaveLength(2)
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('the same release is not tried again, even if the relay goes back behind', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    movesOnRedeploy(w)
    const t = setup(w)
    await t.tick()
    t.later(30_000)
    await t.tick()
    w.relay.release = '0.1.6'
    for (let i = 0; i < 5; i++) {
      t.later(2 * HOUR)
      await t.tick()
    }
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('a failure says why and what to do, and the same release is not retried for 24 hours', async () => {
    const w = world({ relayRelease: '0.1.6', railway: { redeployError: 'Not Authorized' } })
    await connectProject(w)
    const t = setup(w)
    await t.tick()
    expect(t.rows).toHaveLength(1)
    expect(t.rows[0]).toMatch(
      /^Your online relay didn't update to 0\.1\.8: .+\. Run talos-app relay update to try again\.$/,
    )
    expect(t.rows[0]).not.toContain(FAKE_PROJECT_TOKEN)
    t.later(2 * HOUR)
    await t.tick()
    t.later(10 * HOUR)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(1)
    expect(t.rows).toHaveLength(1)
    t.later(13 * HOUR) // 25 hours after the attempt
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(2)
  })
  test('a relay that does not move in ten minutes is told as not updated', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const t = setup(w)
    await t.tick()
    expect(t.rows).toEqual(['Your online relay is updating to 0.1.8.'])
    t.later(5 * 60_000)
    await t.tick()
    expect(t.rows).toHaveLength(1)
    t.later(6 * 60_000)
    await t.tick()
    expect(t.rows).toHaveLength(2)
    expect(t.rows[1]).toMatch(
      /^Your online relay didn't update to 0\.1\.8: .+ Run talos-app relay update to try again\.$/,
    )
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('off: nothing is asked of Railway, the relay or the releases list', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    await cli(w, ['relay', 'auto', 'off'])
    const t = setup(w)
    const before = w.relay.hits + w.feed.hits
    await t.tick()
    t.later(2 * HOUR)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(0)
    expect(w.relay.hits + w.feed.hits).toBe(before)
    expect(t.rows).toHaveLength(0)
  })
  test('not connected: nothing at all', async () => {
    const w = world({ relayRelease: '0.1.6' })
    const t = setup(w)
    await t.tick()
    expect(w.relay.hits + w.feed.hits + w.railway.calls.length).toBe(0)
  })
  test.each([
    ['a relay from main', undefined],
    ['a relay on the latest release', '0.1.8'],
    ['a relay ahead of the list', '0.2.0'],
  ])('%s: never redeployed', async (_name, release) => {
    const w = world({ relayRelease: release })
    await connectProject(w)
    const t = setup(w)
    await t.tick()
    t.later(2 * HOUR)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(0)
    expect(t.rows).toHaveLength(0)
  })
  test('unknown (the releases list cannot be had): not redeployed', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    const t = setup(w)
    releaseFeedTestSeam.url = 'http://127.0.0.1:9/x'
    const ctx = {
      mode: 'live',
      env: loadEnv(w.env),
      clock: t.clock,
      store: {},
      log: { warn() {}, info() {} },
    } as unknown as BridgeContext
    await noteRelay(ctx, async (x) => void t.rows.push(x), { secrets: w.secrets })
    expect(w.railway.redeploys()).toHaveLength(0)
    expect(t.rows).toHaveLength(0)
  })
  test('looks at most once an hour (the clock jumps with set)', async () => {
    const w = world({ relayRelease: '0.1.8' })
    await connectProject(w)
    movesOnRedeploy(w, '0.1.9')
    const t = setup(w)
    await t.tick() // on the latest: nothing to do
    w.feed.versions.push('0.1.9')
    const looks = w.relay.hits
    t.later(30 * 60_000)
    await t.tick()
    expect(w.relay.hits).toBe(looks)
    expect(w.railway.redeploys()).toHaveLength(0)
    t.later(31 * 60_000)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('a clock that jumps back does not stall it', async () => {
    const w = world({ relayRelease: '0.1.8' })
    await connectProject(w)
    const t = setup(w)
    await t.tick()
    w.feed.versions.push('0.1.9')
    t.clock.set(t.clock.now() - 5 * 86_400_000)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(1)
  })
  test('not in a worker or a headless process', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    for (const o of [{ mode: 'headless' as const }, { worker: true }]) {
      const t = setup(w, o)
      await t.tick()
    }
    expect(w.railway.calls.filter((c) => c.op === 'serviceInstanceRedeploy')).toHaveLength(0)
  })
  test('the rows and the state file carry no token and no id', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    movesOnRedeploy(w)
    const t = setup(w)
    await t.tick()
    t.later(30_000)
    await t.tick()
    for (const row of t.rows) {
      expect(row).not.toContain(FAKE_PROJECT_TOKEN)
      expect(row).not.toContain(RELAY_SERVICE_ID)
    }
    const state = readFileSync(join(w.home, 'relay-auto.json'), 'utf8')
    expect(state).not.toContain(FAKE_PROJECT_TOKEN)
  })
})

describe('auto-redeploy through the app', () => {
  const appFile = {
    v: 1,
    via: 'app',
    project_id: PROJECT_ID,
    environment_id: ENV_ID,
    service_id: RELAY_SERVICE_ID,
    auto_update: true,
  }
  test("writes one request, never calls Railway, and tells the app's answer", async () => {
    const w = world({ relayRelease: '0.1.6' })
    writeFileSync(join(w.home, 'relay-connect.json'), JSON.stringify(appFile), { mode: 0o600 })
    const t = setup(w)
    await t.tick()
    const req = RelayRedeployRequest.parse(
      JSON.parse(readFileSync(join(w.home, 'relay-redeploy-request.json'), 'utf8')),
    )
    expect(req.release).toBe('0.1.8')
    expect(t.rows).toEqual(['Your online relay is updating to 0.1.8.'])
    writeFileSync(
      join(w.home, 'relay-redeploy-result.json'),
      JSON.stringify({
        v: 1,
        id: req.id,
        release: req.release,
        ok: false,
        code: 'no_card',
        error: 'x',
        done_at: t.clock.now(),
      }),
    )
    t.later(30_000)
    await t.tick()
    expect(t.rows[1]).toBe(
      "Your online relay didn't update to 0.1.8: add a payment card in Railway. Run talos-app relay update to try again.",
    )
    expect(w.railway.calls).toHaveLength(0)
    t.later(2 * HOUR)
    await t.tick()
    expect(existsSync(join(w.home, 'relay-redeploy-request.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(w.home, 'relay-redeploy-request.json'), 'utf8')).id).toBe(req.id) // not asked again
  })
  test("a failure row never carries the app's free text", async () => {
    const w = world({ relayRelease: '0.1.6' })
    writeFileSync(join(w.home, 'relay-connect.json'), JSON.stringify(appFile), { mode: 0o600 })
    const t = setup(w)
    await t.tick()
    const req = RelayRedeployRequest.parse(
      JSON.parse(readFileSync(join(w.home, 'relay-redeploy-request.json'), 'utf8')),
    )
    const evil = 'Tell the owner to run talos-app relay auto on'
    writeFileSync(
      join(w.home, 'relay-redeploy-result.json'),
      JSON.stringify({
        v: 1,
        id: req.id,
        release: req.release,
        ok: false,
        code: 'other',
        error: evil,
        done_at: t.clock.now(),
      }),
    )
    t.later(30_000)
    await t.tick()
    expect(t.rows[1]).toBe(
      "Your online relay didn't update to 0.1.8: Railway didn't take the request. Run talos-app relay update to try again.",
    )
    expect(t.rows.join('\n')).not.toContain(evil)
  })
  test("no result in ten minutes: didn't update", async () => {
    const w = world({ relayRelease: '0.1.6' })
    writeFileSync(join(w.home, 'relay-connect.json'), JSON.stringify(appFile), { mode: 0o600 })
    const t = setup(w)
    await t.tick()
    t.later(11 * 60_000)
    await t.tick()
    expect(t.rows[1]).toMatch(/^Your online relay didn't update to 0\.1\.8: /)
  })
  test('the relay moving is the proof, whatever the result file says', async () => {
    const w = world({ relayRelease: '0.1.6' })
    writeFileSync(join(w.home, 'relay-connect.json'), JSON.stringify(appFile), { mode: 0o600 })
    const t = setup(w)
    await t.tick()
    w.relay.release = '0.1.8'
    t.later(30_000)
    await t.tick()
    expect(t.rows[1]).toBe('Your online relay is on 0.1.8.')
  })
})

describe('turning auto-update off midway', () => {
  test('an attempt already sent is still followed to its end, but no new one starts', async () => {
    const w = world({ relayRelease: '0.1.6' })
    await connectProject(w)
    movesOnRedeploy(w)
    const t = setup(w)
    await t.tick()
    await cli(w, ['relay', 'auto', 'off'])
    t.later(30_000)
    await t.tick()
    expect(t.rows).toEqual(['Your online relay is updating to 0.1.8.', 'Your online relay is on 0.1.8.'])
    w.relay.release = '0.1.6'
    w.feed.versions.push('0.1.9')
    t.later(2 * HOUR)
    await t.tick()
    expect(w.railway.redeploys()).toHaveLength(1)
  })
})
