// A thread's own session reports done through main's bridge (worker-scope.ts). The notepad must travel the same way, cut to the
// same size, and the answer "recorded..." must still settle the run's claim.
import { describe, expect, test } from 'bun:test'
import { workerScheduleTool } from '../../src/schedules/worker-scope.ts'

function deps(answer: string) {
  const seen: Array<Record<string, unknown>> = []
  const settled: string[][] = []
  const d = {
    schedules: {
      toolRunDone: async (a: Record<string, unknown>) => {
        seen.push(a)
        return { ok: true, text: answer }
      },
    },
    store: {
      route: () => ({ thread_id: 'inbox', notification: { meta: { kind: 'schedule_run' } } }),
      claimedBy: () => 'worker:inbox',
      settleClaims: (ids: string[]) => settled.push(ids),
    },
    thread: 'inbox',
    now: () => 0,
    kv: { get: () => undefined, set: () => {} },
  }
  return { d: d as never, seen, settled }
}

describe('schedule_run_done from a thread session', () => {
  test('passes the notepad on, and a run whose answer starts with "recorded" is settled', async () => {
    const { d, seen, settled } = deps('recorded. Notepad saved.')
    const r = await workerScheduleTool(d, 'schedule_run_done', {
      run_id: 'r_x',
      ok: true,
      summary: 'Done.',
      notepad: 'my notes',
    })
    expect(r.ok).toBe(true)
    expect(seen[0]?.notepad).toBe('my notes')
    expect(settled).toEqual([['r_x']])
  })

  test('no notepad means none is passed (the saved one stays as it was)', async () => {
    const { d, seen } = deps('recorded')
    await workerScheduleTool(d, 'schedule_run_done', { run_id: 'r_x', ok: true, summary: 'Done.' })
    expect('notepad' in (seen[0] ?? {})).toBe(false)
  })

  test('a notepad that is not text is refused, not passed on', async () => {
    const { d, seen } = deps('recorded')
    const r = await workerScheduleTool(d, 'schedule_run_done', {
      run_id: 'r_x',
      ok: true,
      summary: 'Done.',
      notepad: 5,
    })
    expect(r.ok).toBe(false)
    expect(seen.length).toBe(0)
  })
})
