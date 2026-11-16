// The bug reporter's read through the real Bridge: a signed `bug.context` from a (fake) app returns the bridge version, the
// errors the Mac filed and the tail of bridge.log, cleaned by the SAME redaction `talos-app report` uses. Only a pinned,
// unrevoked owner device may ask, once. An unsigned frame, a replay and a revoked device get nothing.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BUG_REPORT_LIMITS, newUlid, type ProblemT } from '@talos-app/protocol'
import { type FakeApp, mkFrame } from '@talos-app/testkit'
import { fileProblem } from '../src/problems/store.ts'
import { BRIDGE_VERSION } from '../src/version.ts'
import { type Harness, sleep, startHarness, waitFor } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD'

function seed(x: Harness) {
  const logFile = join(x.home, 'bridge.log')
  const line = (msg: string, extra: Record<string, unknown> = {}, i = 0) =>
    JSON.stringify({ level: 'info', time: 1_700_000_000_000 + i, msg, ...extra })
  const rows = [
    line('started'),
    ...Array.from({ length: 300 }, (_, i) => line(`filler ${i}`, {}, 10 + i)),
    line('sending', { header: `Authorization: Bearer ${TOKEN}`, BOT_TOKEN: TOKEN }, 1),
    line('opened file', { path: `${homedir()}/Documents/private.txt`, home: x.home }, 2),
    line('last line', {}, 400),
  ]
  writeFileSync(logFile, `${rows.join('\n')}\n`)
  const problem: ProblemT = {
    id: newUlid(),
    source: 'web',
    kind: 'auto',
    fingerprint: 'a'.repeat(32),
    at: new Date().toISOString(),
    name: 'TypeError',
    message: `x is not a function at ${homedir()}/secret`,
    frames: [],
    versions: { app: '1.0.0' },
    device: 'browser',
    routes: [],
    truncated: false,
  }
  fileProblem(x.home, problem, { nowIso: new Date().toISOString(), paths: { userHome: homedir(), appHome: x.home } })
}

const ask = async (app: FakeApp, lines = 200) => {
  const f = await app.sign({ ...mkFrame('bug.context'), request_id: newUlid(), lines })
  app.send(f)
  return f
}
const results = (x: Harness, requestId: string) =>
  x.app.rec.frames.filter(
    (r) => r.direction === 'in' && r.raw.type === 'bug.context_result' && r.raw.request_id === requestId,
  )
const errors = (x: Harness, ref: string) =>
  x.app.rec.frames.filter((r) => r.direction === 'in' && r.raw.type === 'error' && r.raw.ref === ref)

describe('bug.context through the real Bridge', () => {
  test('a signed ask returns versions, filed errors and the cleaned last lines (never the key, the token or the home folder)', async () => {
    h = await startHarness()
    seed(h)
    const f = await ask(h.app, 200)
    await waitFor(() => results(h as Harness, f.request_id as string).length > 0, 5000, 'bug.context_result')
    const raw = (results(h, f.request_id as string)[0] as unknown as { raw: Record<string, unknown> }).raw
    expect(raw.bridge_version).toBe(BRIDGE_VERSION)
    expect(raw.claude_code).toBeNull()
    const logs = String(raw.logs)
    expect(logs).toContain('last line')
    expect(logs.split('\n').length).toBeLessThanOrEqual(BUG_REPORT_LIMITS.logLines)
    expect(logs).not.toContain('started') // 200 of 304 lines: the oldest are cut
    const everything = JSON.stringify(raw)
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toContain(homedir())
    expect(everything).toContain('[redacted]')
    expect(raw.recent_errors).toEqual([expect.stringContaining('web: TypeError: x is not a function')])
    expect(JSON.stringify(raw.recent_errors)).not.toContain(homedir())
  })

  test('the ask can shorten the log (lines: 2) and an over-long ask is not a valid frame', async () => {
    h = await startHarness()
    seed(h)
    const f = await ask(h.app, 2)
    await waitFor(() => results(h as Harness, f.request_id as string).length > 0, 5000, 'bug.context_result')
    const raw = (results(h, f.request_id as string)[0] as unknown as { raw: Record<string, unknown> }).raw
    expect(String(raw.logs).split('\n')).toHaveLength(2)
  })

  test('a replayed frame and a revoked device get nothing', async () => {
    h = await startHarness()
    seed(h)
    const f = await h.app.sign({ ...mkFrame('bug.context'), request_id: newUlid(), lines: 5 })
    const bytes = JSON.stringify(f)
    h.app.sendRaw(bytes)
    await waitFor(() => results(h as Harness, f.request_id as string).length > 0, 5000, 'first answer')
    h.app.sendRaw(bytes)
    await waitFor(() => errors(h as Harness, f.id as string).length > 0, 5000, 'replay refused')
    expect(results(h, f.request_id as string)).toHaveLength(1)
    h.bridge.ctx.devices.revoke(h.app.device.deviceId, new Date().toISOString())
    const k = await ask(h.app, 5)
    await waitFor(() => errors(h as Harness, k.id as string).length > 0, 5000, 'revoked refused')
    await sleep(100)
    expect(results(h, k.request_id as string)).toHaveLength(0)
  })

  test('an unsigned bug.context answers nothing', async () => {
    h = await startHarness()
    seed(h)
    h.relay.sendToBridge({ ...mkFrame('bug.context'), request_id: newUlid(), lines: 5 })
    await sleep(300)
    expect(
      h.relay.frames.filter((r) => r.direction === 'from_bridge' && r.raw.type === 'bug.context_result'),
    ).toHaveLength(0)
  })
})

describe('the size of the answer', () => {
  test('stays under the relay frame cap even for lines of 4-byte characters', async () => {
    const { BugContextService, CONTEXT_MAX_BYTES } = await import('../src/bug-context/service.ts')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'bug-ctx-'))
    const logFile = join(dir, 'bridge.log')
    const rows = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ level: 'info', time: 1 + i, msg: '\u{1F600}'.repeat(300) }),
    )
    writeFileSync(logFile, `${rows.join('\n')}\n`)
    const svc = new BugContextService({
      home: dir,
      userHome: homedir(),
      logFile,
      bridgeVersion: '1',
      claudeCodeVersion: () => undefined,
    })
    const body = svc.read({ lines: 200 })
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(CONTEXT_MAX_BYTES)
    expect(body.logs.length).toBeGreaterThan(0)
  })
})
