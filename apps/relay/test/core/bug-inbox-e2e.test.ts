// End to end, two real relays: a beta install's relay (BUG_WEBHOOK_SECRET + BUG_TEAM_INBOX_URL) takes a signed report
// from her paired device and sends it, picture and all, to the team relay's bug inbox (BUG_INBOX_SECRETS); the team relay
// hands it to its Mac as a problem.item; the bridge's real ProblemService files it in a fake Talos home; the real
// `talos-app errors list` and `errors show` (bun, the bridge CLI) print it as hers. The only stand-in is the Mac's media
// download, which reads the team relay's media store and checks the sha256 as the bridge does.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createDeviceKey,
  newUlid,
  PROBLEMS_FEATURE,
  PROBLEMS_INSTALL_FEATURE,
  type ProblemT,
  sha256Hex,
  signOwnerFrame,
} from '@talos-app/protocol'
import type { FakeBridge } from '@talos-app/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../bridge/src/log.ts'
import { ProblemService } from '../../../bridge/src/problems/service.ts'
import { ORIGIN, startTestRelay, type TestRelay } from './harness.ts'
import { kit } from './helpers.ts'

vi.setConfig({ testTimeout: 60_000 })

const REPO = resolve(__dirname, '../../../..')
const CLI = join(REPO, 'apps/bridge/src/cli.ts')
const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const relays: TestRelay[] = []
const bridges: FakeBridge[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.close()
  for (const r of relays.splice(0).reverse()) await r.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** `talos-app <args>` as the owner runs it on the Mac, against the fake home only. */
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

describe("a beta user reports a bug; it lands in the owner's errors list", () => {
  it("from her phone to her relay, to the team inbox, to the owner's Mac, marked as hers", async () => {
    // the team relay (the owner's): the inbox knows her install as beta1
    const team = await startTestRelay({ env: { BUG_INBOX_SECRETS: `beta1=${SECRET}` } })
    relays.push(team)
    const mac = await kit(team)
      .bridge({ autoReply: false, verifyOwner: false, features: [PROBLEMS_FEATURE, PROBLEMS_INSTALL_FEATURE] })
      .connect()
    bridges.push(mac)
    // her relay: pointed at the team inbox at deploy, with the same secret
    const hers = await startTestRelay({
      env: { BUG_WEBHOOK_SECRET: SECRET, BUG_TEAM_INBOX_URL: `${team.httpBase}/api/bug-inbox` },
    })
    relays.push(hers)
    const dev = await createDeviceKey()
    hers.relay.services.db
      .prepare(
        'insert into auth_devices (id, name, pubkey_jwk, binding, pinned, revoked, created_at) values (?, ?, ?, ?, 1, 0, ?)',
      )
      .run(dev.deviceId, 'phone', JSON.stringify(dev.publicJwk), 'b', Date.now())
    const h = {
      'X-Test-Session': dev.deviceId,
      Origin: ORIGIN,
      'X-Talos-CSRF': '1',
      'content-type': 'application/json',
    }

    // her Report screen says where it goes
    const dest = await fetch(`${hers.httpBase}/api/bug-reports/destination`, { headers: h })
    expect(await dest.json()).toEqual({ to: 'team' })

    // she taps Send (the reporter signs the report with her device key); she did not tick the last messages
    const post = await signOwnerFrame(
      {
        v: 1,
        type: 'bug.report',
        device_id: dev.deviceId,
        id: newUlid(),
        ts: new Date().toISOString(),
        nonce: newUlid().toLowerCase(),
        report: {
          what_went_wrong: 'Tapping Send on a photo does nothing',
          expected: 'The photo to go to the thread',
          versions: { app: '1.4.0', bridge: '1.4.0', relay: '1.4.0', claude_code: '2.1.310' },
          thread_id: 'general',
          screen: 'thread',
          recent_errors: ['TypeError: cannot read properties of undefined'],
          logs: 'info bridge up\nwarn upload slow',
        },
        image_type: 'image/png',
        image_b64: PNG.toString('base64'),
      },
      dev.privateKey,
    )
    const sent = await fetch(`${hers.httpBase}/api/bug-reports`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify(post),
    })
    expect(sent.status).toBe(201)

    // the team relay hands the owner's Mac one problem.item
    await mac.waitNotified('problem.item', 1, 10_000)
    const item = mac.notified.find((f) => f.type === 'problem.item') as unknown as { problem: ProblemT }
    expect(item.problem).toMatchObject({ source: 'install', install: 'beta1' })

    // the owner's bridge files it, in a fake Talos home, with the picture beside it
    const root = mkdtempSync(join(tmpdir(), 'talos-inbox-e2e-'))
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
        const got = await team.relay.services.media.get(ref.media_id)
        if (!got || got.bytes.length !== ref.size || sha256Hex(got.bytes) !== ref.sha256)
          throw new Error('not verified')
        const path = join(root, `${ref.media_id}.png`)
        writeFileSync(path, got.bytes)
        return { path }
      },
    })
    expect(await svc.onItem(item.problem)).toBe('done')
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain('from another install (beta1)')

    // what the owner reads
    const list = cli(home, ['errors', 'list'])
    expect(list.err).toBe('')
    expect(list.code).toBe(0)
    const line = list.out.split('\n').find((l) => l.includes('install:beta1')) as string
    expect(line).toMatch(
      /^[0-9a-f]{12} {2}open {4}x1 {2}install:beta1 from another install {2}last \S+ \(local \S+\) {2}bug report: Tapping Send on a photo does nothing$/,
    )
    console.log(`errors list (real run, fake home):\n${list.out}`)

    const show = cli(home, ['errors', 'show', line.slice(0, 12)])
    expect(show.code).toBe(0)
    const shown = JSON.parse(show.out.slice(show.out.indexOf('{')))
    expect(shown).toMatchObject({
      trust: 'external',
      source: 'install',
      install: 'beta1',
      versions_seen: [{ app: '1.4.0', bridge: '1.4.0', relay: '1.4.0' }],
      attached: {
        what_went_wrong: 'Tapping Send on a photo does nothing',
        expected: 'The photo to go to the thread',
        errors: ['TypeError: cannot read properties of undefined'],
        logs: 'info bridge up\nwarn upload slow',
        thread_id: 'general',
        screen: 'thread',
      },
    })
    expect(shown.attached.messages).toBeUndefined()
    expect(existsSync(shown.screenshot_path)).toBe(true)
    expect(readFileSync(shown.screenshot_path).equals(PNG)).toBe(true)
    expect(show.out).not.toContain(dev.deviceId)
  })
})
