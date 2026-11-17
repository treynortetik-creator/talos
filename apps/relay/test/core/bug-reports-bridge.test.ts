// A bug report from the owner's own paired device reaches his own Mac: every report POST /api/bug-reports stores is also
// queued, durably, to this relay's own bridge as a `problem.item` (source 'web', no install), with its picture. Delivered at
// once when the Mac is online, else on its next hello; reports stored before this path existed are queued once at startup.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BugReportPost,
  createDeviceKey,
  type DeviceKey,
  newUlid,
  PROBLEMS_FEATURE,
  type ProblemT,
  sha256Hex,
  signOwnerFrame,
} from '@talos-app/protocol'
import { type FakeBridge, waitFor } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../bridge/src/log.ts'
import { ProblemService } from '../../../bridge/src/problems/service.ts'
import { backfillOwnReports, storeBugReport } from '../../src/core/bug-reports.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

const REPO = resolve(__dirname, '../../../..')
const CLI = join(REPO, 'apps/bridge/src/cli.ts')
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let relay: TestRelay | null = null
const bridges: FakeBridge[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  await relay?.stop()
  relay = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function world() {
  const r = await startTestRelay()
  relay = r
  const dev = await createDeviceKey()
  r.relay.services.db
    .prepare(
      'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
    )
    .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
  return { r, dev }
}

const headers = (deviceId: string) => ({
  'X-Test-Session': deviceId,
  Origin: ORIGIN,
  'X-Talos-CSRF': '1',
  'content-type': 'application/json',
})

const TEXT = 'The send button did nothing'
const signedPost = (dev: DeviceKey, extra: Record<string, unknown> = {}) =>
  signOwnerFrame(
    {
      v: 1,
      type: 'bug.report',
      device_id: dev.deviceId,
      id: newUlid(),
      ts: new Date().toISOString(),
      nonce: newUlid().toLowerCase(),
      report: {
        what_went_wrong: TEXT,
        expected: 'The message to go',
        versions: { app: '1.0.0', bridge: '1.0.0', relay: '1.0.0', claude_code: '2.0.0' },
        recent_errors: ['TypeError: x is not a function'],
        logs: 'line one\nline two',
        ...extra,
      },
      image_type: 'image/png',
      image_b64: PNG.toString('base64'),
    },
    dev.privateKey,
  )

const send = (r: TestRelay, body: unknown, deviceId: string) =>
  fetch(`${r.httpBase}/api/bug-reports`, { method: 'POST', headers: headers(deviceId), body: JSON.stringify(body) })

const connect = async (r: TestRelay, features: string[]) => {
  const b = await kit(r).bridge({ autoReply: false, verifyOwner: false, features }).connect()
  bridges.push(b)
  return b
}
const items = (b: FakeBridge) =>
  b.notified.filter((f) => f.type === 'problem.item') as unknown as Array<{ id: string; problem: ProblemT }>
const settle = () => new Promise((res) => setTimeout(res, 250))
const deliveryId = (r: TestRelay, id: string) =>
  (
    r.relay.services.db.prepare('select bridge_frame_id f from core_bug_reports where report_id = ?').get(id) as {
      f: string
    }
  ).f
const queuedAt = (r: TestRelay, id: string) =>
  (
    r.relay.services.db.prepare('select bridge_queued_at q from core_bug_reports where report_id = ?').get(id) as {
      q: number | null
    }
  ).q

describe('queued to the relay own bridge', () => {
  it('online with problems/1: the Mac gets the owner problem, id = report id, no install, the picture fetchable', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    const body = await signedPost(dev)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await mac.waitNotified('problem.item')
    const [item] = items(mac)
    const p = item?.problem as ProblemT
    expect(item?.id).toBe(deliveryId(r, body.id))
    expect(p).toMatchObject({ id: deliveryId(r, body.id), source: 'web', kind: 'owner', device: 'browser' })
    expect(p.install).toBeUndefined()
    expect(p.attached).toBeUndefined()
    expect(p.message).toContain(TEXT)
    expect(p.steps).toContain(TEXT)
    expect(p.steps).toContain('The message to go')
    const shot = p.screenshot
    expect(shot).toBeDefined()
    const got = await r.relay.services.media.get(shot?.media_id as string)
    expect(got && sha256Hex(got.bytes)).toBe(shot?.sha256)
    expect(Buffer.from(got?.bytes ?? []).equals(PNG)).toBe(true)
    expect(queuedAt(r, body.id)).not.toBeNull()
  })

  it('names the app that sent it and the screens visited; source stays web', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    const body = await signedPost(dev, { client: 'iphone_app', routes: ['thread', 'memory'] })
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await mac.waitNotified('problem.item')
    expect(items(mac)[0]?.problem).toMatchObject({ source: 'web', device: 'iphone_app', routes: ['thread', 'memory'] })
  })

  it('an older app (neither field): a browser, and its one screen when it sent one', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    expect((await send(r, await signedPost(dev, { screen: 'thread' }), dev.deviceId)).status).toBe(201)
    expect((await send(r, await signedPost(dev), dev.deviceId)).status).toBe(201)
    await waitFor(() => items(mac).length === 2)
    const ps = items(mac).map((i) => i.problem)
    expect(ps.find((p) => p.routes.length)).toMatchObject({ device: 'browser', routes: ['thread'] })
    expect(ps.find((p) => !p.routes.length)).toMatchObject({ device: 'browser', routes: [] })
  })

  it('offline: nothing is sent, then it is delivered once on the next hello with problems/1', async () => {
    const { r, dev } = await world()
    const body = await signedPost(dev)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await settle()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    await mac.waitNotified('problem.item')
    await settle()
    expect(items(mac)).toHaveLength(1)
    expect(items(mac)[0]?.id).toBe(deliveryId(r, body.id))
  })

  it('a Mac without problems/1 holds it; a hello with it delivers', async () => {
    const { r, dev } = await world()
    const old = await connect(r, [])
    const body = await signedPost(dev)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await settle()
    expect(items(old)).toEqual([])
    await old.close()
    const fresh = await connect(r, [PROBLEMS_FEATURE])
    await fresh.waitNotified('problem.item')
    expect(items(fresh)[0]?.id).toBe(deliveryId(r, body.id))
  })

  it('a failed queueing leaves the mark empty, and the backfill queues it', async () => {
    const { r, dev } = await world()
    const spy = vi.spyOn(r.runtime.hub, 'toBridge').mockRejectedValueOnce(new Error('disk'))
    const body = await signedPost(dev)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    expect(queuedAt(r, body.id)).toBeNull()
    spy.mockRestore()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    expect(await backfillOwnReports(r.relay.services)).toBe(1)
    await mac.waitNotified('problem.item')
    expect(queuedAt(r, body.id)).not.toBeNull()
  })
})

describe('the startup backfill', () => {
  it('queues a report stored before this path existed once; a second run sends nothing new', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    const body = BugReportPost.parse(await signedPost(dev))
    const s = r.relay.services
    // stored the old way: the files and the row, no route call, no queueing
    storeBugReport(
      { db: s.db, crypto: s.crypto, clock: s.clock, dataDir: s.env.DATA_DIR },
      body,
      PNG,
      s.clock.now() + 600_000,
    )
    expect(queuedAt(r, body.id)).toBeNull()
    await settle()
    expect(items(mac)).toEqual([])
    expect(await backfillOwnReports(s)).toBe(1)
    await mac.waitNotified('problem.item')
    expect(items(mac)[0]?.id).toBe(deliveryId(r, body.id))
    expect(queuedAt(r, body.id)).not.toBeNull()
    expect(await backfillOwnReports(s)).toBe(0)
    await settle()
    expect(items(mac)).toHaveLength(1)
  })

  it('skips a report whose files are gone, and goes on', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    const s = r.relay.services
    const deps = { db: s.db, crypto: s.crypto, clock: s.clock, dataDir: s.env.DATA_DIR }
    const gone = BugReportPost.parse(await signedPost(dev))
    const kept = BugReportPost.parse(await signedPost(dev))
    storeBugReport(deps, gone, PNG, s.clock.now() + 600_000)
    storeBugReport(deps, kept, PNG, s.clock.now() + 600_000)
    rmSync(join(r.dir, 'bug-reports', `${gone.id}.json.bin`))
    expect(await backfillOwnReports(s)).toBe(1)
    await mac.waitNotified('problem.item')
    expect(items(mac)[0]?.id).toBe(deliveryId(r, kept.id))
    expect(queuedAt(r, gone.id)).toBeNull()
  })
})

function cli(home: string, args: string[]) {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(TALOS_|CLAUDE_CODE_|CLAUDECODE$|CHRONOS_RUN$)/.test(k)) env[k] = v
  const out = spawnSync('bun', ['run', CLI, ...args], {
    cwd: join(REPO, 'apps/bridge'),
    env: { ...env, TALOS_APP_HOME: home, HOME: join(home, '..') },
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { code: out.status, out: out.stdout, err: out.stderr }
}

describe('end to end: the owner phone to his Mac', () => {
  it('lands in problems/open with the screenshot, and is not marked as another install', async () => {
    const { r, dev } = await world()
    const mac = await connect(r, [PROBLEMS_FEATURE])
    const body = await signedPost(dev)
    expect((await send(r, body, dev.deviceId)).status).toBe(201)
    await mac.waitNotified('problem.item')
    const item = items(mac)[0] as { problem: ProblemT }

    const root = mkdtempSync(join(tmpdir(), 'talos-own-report-e2e-'))
    dirs.push(root)
    const home = join(root, 'app')
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const notices: string[] = []
    const svc = new ProblemService({
      home,
      clock: { now: () => Date.now(), setTimeout: () => null, clearTimeout: () => undefined },
      log: createLogger(null, 'error', () => {}),
      timezone: () => 'UTC',
      bridgeVersion: '9.9.9',
      notice: async (t) => {
        notices.push(t)
      },
      fetchScreenshot: async (ref) => {
        const got = await r.relay.services.media.get(ref.media_id)
        if (!got || got.bytes.length !== ref.size || sha256Hex(got.bytes) !== ref.sha256)
          throw new Error('not verified')
        const path = join(root, `${ref.media_id}.png`)
        writeFileSync(path, got.bytes)
        return { path }
      },
    })
    expect(await svc.onItem(item.problem)).toBe('done')
    await waitFor(() => cli(home, ['errors', 'list']).out.includes(TEXT), 15_000, 'a problem filed')

    const list = cli(home, ['errors', 'list'])
    expect(list.code).toBe(0)
    expect(list.out).not.toContain('install:')
    expect(list.out).not.toContain('another install')
    expect(list.out).toContain(TEXT)
    const id = list.out
      .split('\n')
      .find((l) => l.includes(TEXT))
      ?.slice(0, 12) as string
    const show = cli(home, ['errors', 'show', id])
    expect(show.code).toBe(0)
    const shown = JSON.parse(show.out.slice(show.out.indexOf('{')))
    expect(shown.source).toBe('web')
    expect(shown.install).toBeUndefined()
    expect(shown.attached).toBeUndefined()
    expect(readFileSync(shown.screenshot_path).equals(PNG)).toBe(true)
    expect(notices.join(' ')).not.toContain('another install')
  })
})
