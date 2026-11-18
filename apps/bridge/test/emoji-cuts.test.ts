// Text that is cut to a limit before it goes into a frame must never end on half an emoji: a lone surrogate is not valid JSON
// text. Each case puts an emoji across the limit.
import { describe, expect, test } from 'bun:test'
import { toolRunDoneQueued } from '../src/schedules/service-tools.ts'
import { workerScheduleTool } from '../src/schedules/worker-scope.ts'
import { ScreenConsent } from '../src/screen-consent.ts'
import { cardResult } from '../src/tools/card.ts'
import { UndoCards } from '../src/undo/card.ts'

const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const across = (limit: number) => `${'n'.repeat(limit - 1)}\u{1F600}tail` // the emoji's two units straddle the limit

describe('a result or report cut at its limit', () => {
  test('card_result text (500)', async () => {
    const sent: Array<{ result?: { text: string } }> = []
    const ctx = {
      ledger: {
        get: () => ({ actor: 'agent', state: 'resolved', thread_id: 'general', resolution: { action: 'primary' } }),
        finish: () => true,
      },
      clock: { now: () => 0 },
      transport: { sendDurable: async (f: never) => void sent.push(f) },
      worker: false,
      seen: { take: () => [] },
      store: { touchThread: () => {}, db: {} },
    }
    const r = await cardResult.handler(ctx as never, { card_id: 'c_x', ok: true, text: across(500) } as never)
    if (r.isError) throw new Error(JSON.stringify(r))
    const text = sent[0]?.result?.text
    expect(text).toBeDefined()
    expect(lone.test(text as string)).toBe(false)
    expect((text as string).length).toBeLessThanOrEqual(500)
  })

  for (const [name, make] of [
    ['undo card end (500)', () => UndoCards.prototype],
    ['screen consent end (500)', () => ScreenConsent.prototype],
  ] as const) {
    test(name, async () => {
      const sent: Array<{ result?: { text: string } }> = []
      const self = {
        ctx: {
          ledger: { finish: () => true },
          clock: { now: () => 0 },
          transport: { sendDurable: async (f: never) => void sent.push(f) },
          log: { warn: () => {} },
        },
      }
      const end = (make() as unknown as { end: (...a: unknown[]) => Promise<void> }).end
      if (name.startsWith('undo')) await end.call(self, 'c_x', false, across(500))
      else await end.call(self, { id: 'c_x' }, false, across(500))
      const text = sent[0]?.result?.text as string
      expect(lone.test(text)).toBe(false)
      expect(text.length).toBeLessThanOrEqual(500)
    })
  }

  test('schedule_run_done from a thread session: summary (280) and report (64 KiB)', async () => {
    const seen: Array<{ summary: string; report?: string }> = []
    const d = {
      schedules: {
        toolRunDone: async (a: never) => {
          seen.push(a)
          return { ok: true, text: 'recorded' }
        },
      },
      store: {
        route: () => ({ thread_id: 'inbox', notification: { meta: { kind: 'schedule_run' } } }),
        claimedBy: () => 'worker:inbox',
        settleClaims: () => {},
      },
      thread: 'inbox',
      now: () => 0,
      kv: { get: () => undefined, set: () => {} },
    }
    await workerScheduleTool(d as never, 'schedule_run_done', {
      run_id: 'r_x',
      ok: true,
      summary: across(280),
      report: across(64 * 1024),
    })
    const a = seen[0] as { summary: string; report: string }
    expect(lone.test(a.summary)).toBe(false)
    expect(a.summary.length).toBeLessThanOrEqual(280)
    expect(lone.test(a.report)).toBe(false)
    expect(a.report.length).toBeLessThanOrEqual(64 * 1024)
  })

  test('toolRunDone on the main bridge: report (64 KiB), the late note (280) and the note summary (280)', async () => {
    const finished: Array<{ report: string }> = []
    const notes: Array<{ late_note?: string; summary?: string }> = []
    const self = new Proxy(
      {
        enqueue: (fn: () => Promise<unknown>) => fn(),
        ensure: async () => ({
          state: 'ready',
          adapter: { finish: async (_: string, a: never) => (finished.push(a), { ok: true }) },
        }),
        sidecar: new Proxy(
          {
            jobOfRun: () => ({ id: 'j', ds: 'd' }),
            note: () => undefined,
            setNote: (_: string, n: never) => void notes.push(n),
          } as Record<string, unknown>,
          { get: (t, k) => (k in t ? t[k as string] : () => undefined) },
        ),
        now: () => 0,
        iso: () => '2026-10-05T00:00:00.000Z',
        wakeRuns: new Set(),
        heartbeatRunEnded: () => false,
        jobMemory: {},
        lastGood: undefined,
        markAll: () => false,
      } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => undefined) },
    )
    const a = { runId: 'r_x', ok: true, summary: across(280), report: across(64 * 1024) }
    await toolRunDoneQueued.call(self as never, a, () => {})
    expect(lone.test(finished[0]?.report ?? '')).toBe(false)
    expect((finished[0]?.report ?? '').length).toBeLessThanOrEqual(64 * 1024)
    const withSummary = notes.find((n) => n.summary !== undefined)
    if (withSummary) expect(lone.test(withSummary.summary as string)).toBe(false)
  })
})
