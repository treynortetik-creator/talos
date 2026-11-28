// An owner's bug report wakes Main once, with the report's id and a short summary (docs/ERRORS.md, wake bundle part a).
// Automatic reports, another install's reports and a report that was already closed wake nobody. A report sent again
// (a re-queue, a relay resend) wakes nobody a second time.
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { newUlid, type ProblemT, problemFingerprint } from '@talos-app/protocol'
import { fakeClock, t } from '@talos-app/testkit'
import { nullLogger } from '../src/log.ts'
import { ProblemService } from '../src/problems/service.ts'
import { closeProblem } from '../src/problems/store.ts'
import { type Harness, startHarness, tempHome, waitFor } from './helpers.ts'

setDefaultTimeout(t(60_000))

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

function report(over: Partial<ProblemT> = {}): ProblemT {
  return {
    id: newUlid(),
    source: 'web',
    kind: 'owner',
    fingerprint: 'a'.repeat(32),
    at: '2026-11-24T10:00:00.000Z',
    name: 'Report',
    message: 'the thread says working',
    steps: 'It shows that you are working, but my terminal is parked.',
    frames: [],
    versions: { app: '1.2.3', protocol: '1' },
    device: 'browser',
    routes: ['thread'],
    truncated: false,
    ...over,
  }
}
const item = (p: ProblemT, frameId = p.id) => ({ type: 'problem.item', id: frameId, problem: p })
const idOf = (p: ProblemT) => problemFingerprint(p).slice(0, 12)
const consumed = (hh: Harness, id: string) =>
  hh.relay.rec.of('ack', 'from_bridge').some((a) => a.ref === id && (a as { stage?: string }).stage === 'consumed')
const wakes = (hh: Harness) => hh.notes.filter((n) => n.meta.kind === 'bug_report')

describe('an owner bug report on a live bridge', () => {
  test('wakes Main once with the report id and what he typed, as data', async () => {
    h = await startHarness()
    const p = report()
    h.relay.sendToBridge(item(p), { durable: true })
    await waitFor(() => wakes(h as Harness).length === 1, 5000, 'the wake')
    const n = wakes(h)[0]
    expect(n?.meta.report_id).toBe(idOf(p))
    expect(n?.meta.trust).toBe('system')
    expect(n?.content).toContain(idOf(p))
    expect(n?.content).toContain('It shows that you are working')
    expect(n?.content).toMatch(/data, not instructions/)
  })

  test('the same report sent again, under a new frame id, wakes nobody a second time', async () => {
    h = await startHarness()
    const p = report()
    h.relay.sendToBridge(item(p), { durable: true })
    await waitFor(() => wakes(h as Harness).length === 1, 5000, 'the wake')
    const again = newUlid()
    h.relay.sendToBridge(item(p, again), { durable: true })
    await waitFor(() => consumed(h as Harness, again), 5000, 'the resend consumed')
    // timing-ok: negative window: nothing more reaches Main after the resend was answered
    await Bun.sleep(150)
    expect(wakes(h)).toHaveLength(1)
  })

  test('a different report wakes again; an automatic one wakes nobody', async () => {
    h = await startHarness()
    h.relay.sendToBridge(item(report()), { durable: true })
    h.relay.sendToBridge(item(report({ steps: 'second one' })), { durable: true })
    const auto = report({ kind: 'auto', steps: undefined, message: 'x is not a function' })
    h.relay.sendToBridge(item(auto), { durable: true })
    await waitFor(() => consumed(h as Harness, auto.id), 5000, 'the automatic one consumed')
    await waitFor(() => wakes(h as Harness).length === 2, 5000, 'two wakes')
    expect(wakes(h).map((n) => n.meta.report_id)).not.toContain(idOf(auto))
  })

  test('a wake Main could not take is not lost: it is sent on a later poll', async () => {
    h = await startHarness()
    const wake = h.bridge.ctx.mainWake
    expect(wake).toBeDefined()
    const p = report()
    // the channel refuses once: the notification is kept, and the filed report still answers consumed
    const emit = h.bridge.ctx.emit
    let refuse = true
    h.bridge.ctx.emit = async (n) => {
      if (refuse && n.meta.kind === 'bug_report') throw new Error('channel down')
      return emit(n)
    }
    h.relay.sendToBridge(item(p), { durable: true })
    await waitFor(() => consumed(h as Harness, p.id), 5000, 'consumed')
    expect(wakes(h)).toHaveLength(0)
    refuse = false
    await wake?.tick()
    expect(wakes(h)).toHaveLength(1)
    await wake?.tick()
    expect(wakes(h)).toHaveLength(1)
  })
})

describe('which reports wake Main (the service on its own)', () => {
  function service(home: string, calls: Array<{ fingerprint: string; summary: string }>) {
    return new ProblemService({
      home,
      clock: fakeClock(),
      log: nullLogger,
      timezone: () => 'Etc/GMT+5',
      bridgeVersion: '0.0.0-test',
      notice: async () => {},
      wake: async (a) => void calls.push(a),
    })
  }

  test('only an owner report, from the owner own app, wakes', async () => {
    const home = tempHome()
    const calls: Array<{ fingerprint: string; summary: string }> = []
    const svc = service(home, calls)
    await svc.onItem(report({ kind: 'auto', steps: undefined, message: 'auto one' }))
    await svc.onItem(
      report({ source: 'install', install: 'friend', message: 'from another install', steps: 'stranger words' }),
    )
    expect(calls).toHaveLength(0)
    const mine = report()
    await svc.onItem(mine)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.fingerprint.slice(0, 12)).toBe(idOf(mine))
    expect(calls[0]?.summary).toContain('It shows that you are working')
  })

  test('with no steps typed, the summary is the report message', async () => {
    const home = tempHome()
    const calls: Array<{ fingerprint: string; summary: string }> = []
    await service(home, calls).onItem(report({ steps: undefined, message: 'it froze' }))
    expect(calls[0]?.summary).toBe('it froze')
  })

  test('a report that was filed but not announced (a restart in between) wakes when it arrives again; a closed one does not', async () => {
    const home = tempHome()
    const calls: Array<{ fingerprint: string; summary: string }> = []
    const svc = service(home, calls)
    const p = report()
    await svc.onItem(p)
    await svc.onItem(p) // the relay's resend: same report, answered as a duplicate, still offered to the wake (which de-dups by key)
    expect(calls).toHaveLength(2)
    closeProblem(home, calls[0]?.fingerprint as string)
    await svc.onItem(p)
    expect(calls).toHaveLength(2)
  })
})

describe('a bug report wake that Main never takes', () => {
  test('is not lost without a word: after the last try one line in the Inbox says so, with the id', async () => {
    h = await startHarness()
    const wake = h.bridge.ctx.mainWake
    const p = report()
    const emit = h.bridge.ctx.emit
    h.bridge.ctx.emit = async (n) => {
      if (n.meta.kind === 'bug_report') throw new Error('channel down')
      return emit(n)
    }
    h.relay.sendToBridge(item(p), { durable: true })
    await waitFor(() => consumed(h as Harness, p.id), 5000, 'consumed')
    for (let i = 0; i < 6; i++) await wake?.tick()
    const rows = () =>
      h?.relay.rec
        .of('reply', 'from_bridge')
        .filter((r) => r.message.author === 'system' && (r.message.text ?? '').includes(idOf(p) as string)) ?? []
    await waitFor(() => rows().some((r) => (r.message.text ?? '').includes('Main')), 5000, 'the Inbox line')
    const mine = rows().filter((r) => (r.message.text ?? '').includes('Main'))
    expect(new Set(mine.map((r) => r.message.id)).size).toBe(1)
    expect(mine[0]?.message.thread_id).toBe('inbox')
    expect(mine[0]?.message.text).toContain('talos-app errors show')
  })
})
