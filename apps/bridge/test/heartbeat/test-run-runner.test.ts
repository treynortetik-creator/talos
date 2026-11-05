// The runner's TEST mode (HB5b; docs/HEARTBEAT.md "In the app"): a dry run that reads no store, looks back a window, runs the
// sources for real, and says what each one found. Real bridge context, real processes, fake sources (small scripts).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fakeClock } from '@talos-app/testkit'
import type { RunnerDeps } from '../../src/heartbeat/runner.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { cmd, config, item, type Kit, kit, MON_1000_UTC, ok, printing, script, tmpDir } from './kit.ts'

let h: Harness
let clock: ReturnType<typeof fakeClock>
let dir: string
let k: Kit
const start = async (over: Partial<RunnerDeps> = {}) => {
  clock = fakeClock(MON_1000_UTC)
  h = await startHarness({ clock, config: (c) => ({ ...c, timezone: 'UTC', quiet_window: null }) })
  k = kit(h, clock, over)
}
beforeEach(() => {
  dir = tmpDir()
})
afterEach(async () => {
  await h?.stop()
})
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** Every heartbeat and sidecar file under the home, with its bytes and mode: "nothing was written" means this is equal before and after. */
function tree(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of readdirSync(join(root, rel)).sort()) {
    const p = join(rel, name)
    const st = statSync(join(root, p))
    if (st.isDirectory()) Object.assign(out, tree(root, p))
    else if (/heartbeat|schedules-meta/.test(p) && st.isFile())
      out[p] = `${st.mode}:${readFileSync(join(root, p), 'utf8')}`
  }
  return out
}

describe('a test run', () => {
  test('writes nothing: the whole home is byte-identical, even with a live store beside it; nothing is posted, woken or noted', async () => {
    const wakes: string[] = []
    await start({
      wake: async () => {
        wakes.push('x')
        return { delivered: true }
      },
    })
    await k.run(config([cmd('news', printing(dir, 'l', ok([item('a')])))])) // a real live run, so a store exists
    const before = tree(h.home)
    const rows = k.rows().length
    const src = printing(dir, 't', ok([item('b', { level: 'act' }), item('c')]))
    const out = await k.run(config([cmd('news', src)]), { test: { windowH: 24 } })
    expect(out.test?.would_wake.map((l) => l.title)).toEqual(['Item b'])
    expect(tree(h.home)).toEqual(before)
    expect(k.rows().length).toBe(rows)
    expect(wakes).toEqual([])
    expect(h.notes).toEqual([])
  })

  test('reads no saved store: a source is asked for the WINDOW (since = now - window, dry true), not for the saved cursor', async () => {
    await start()
    // a saved store with a cursor for this source id would normally be handed to the source
    await k.run(config([cmd('news', printing(dir, 'l', ok([], { page: 7 })))]))
    expect(k.store().sources.news.cursor).toEqual({ page: 7 })
    await k.run(config([cmd('news', printing(dir, 't', ok([])))]), { test: { windowH: 8 } })
    const req = JSON.parse(readFileSync(join(dir, 't.stdin'), 'utf8'))
    expect(req.dry).toBe(true)
    expect(req.cursor).toBeNull()
    expect(req.since).toBe(new Date(Date.parse(MON_1000_UTC) - 8 * 3600_000).toISOString())
  })

  test('counts per source: read, act, fyi, held by the work gate, dropped (muted and silent); item words only for what would be offered', async () => {
    await start()
    const items = [
      item('a1', { level: 'act' }),
      item('f1'),
      item('f2'),
      item('s1', { level: 'silent' }),
      item('m1'), // muted below
      item('w1', { class: 'work' }), // the gate is off
    ]
    const cfg = config([cmd('news', printing(dir, 'c', ok(items)))], {
      mutes: [{ source: 'news', key: 'm1', until: '2099-01-01T00:00:00.000Z' }],
    })
    const out = await k.run(cfg, { test: { windowH: 24 } })
    expect(out.test?.sources).toEqual([{ id: 'news', read: 6, act: 1, fyi: 2, held: 1, dropped: 2 }])
    expect(out.test?.would_post.map((l) => l.title)).toEqual(['Item f1', 'Item f2'])
    expect(out.test?.held).toBe(1)
    expect(JSON.stringify(out.test)).not.toContain('Item w1')
    expect(JSON.stringify(out.test)).not.toContain('Item m1')
  })

  test('a source that hangs is killed within run_timeout_s, with everything it started', async () => {
    await start({ secondMs: 60 })
    const pidFile = join(dir, 'child.pid')
    const hang = script(dir, 'hang', `sleep 60 &\necho $! > '${pidFile}'\nwait`)
    // the source's own limit (60 s = 3.6 s here) is longer than the run's (30 s = 1.8 s): the RUN limit is what stops it
    const cfg = config([cmd('slow', hang, { timeout_s: 60 })], { run_timeout_s: 30 })
    const t0 = Date.now()
    const out = await k.run(cfg, { test: { windowH: 24 } })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(out.result.sources[0]).toMatchObject({ id: 'slow', ok: false })
    expect(out.result.sources[0]?.error).toContain('time limit')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(pid).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 200))
    expect(alive(pid)).toBe(false)
  })

  test('the built-in sources are given a cursor meaning "from the window start", not the baseline answer', async () => {
    await start()
    const { testCursor } = await import('../../src/heartbeat/run-parts.ts')
    const since = '2026-10-05T02:00:00.000Z'
    const base = { id: 'x1', enabled: true, timeout_s: 5 } as const
    expect(testCursor({ ...base, kind: 'github', args: { repos: [] } } as never, since)).toEqual({ since })
    expect(testCursor({ ...base, kind: 'schedule-failures', args: {} } as never, since)).toEqual({
      at: Date.parse(since),
    })
    expect(testCursor({ ...base, kind: 'inbox', args: {} } as never, since)).toEqual({ seen: [] })
    expect(testCursor({ ...base, kind: 'command', args: { argv: ['/bin/true'] } } as never, since)).toBeNull()
  })

  test('each source is reported as it answers (before the run ends), with its real result', async () => {
    await start()
    const seen: Array<{ id: string; ok: boolean; items: number }> = []
    const cfg = config([
      cmd('fast', printing(dir, 'f', ok([item('a'), item('b', { level: 'act' })]))),
      cmd('bad', printing(dir, 'b', '{"nope":1}')),
    ])
    await k.run(cfg, {
      test: { windowH: 24, onSource: (o) => seen.push({ id: o.id, ok: o.ok, items: o.items.length }) },
    })
    expect(seen.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'bad', ok: false, items: 0 },
      { id: 'fast', ok: true, items: 2 },
    ])
  })

  test('on a fresh home it creates no file at all', async () => {
    await start()
    const before = tree(h.home)
    await k.run(config([cmd('news', printing(dir, 'f', ok([item('a')])))]), { test: { windowH: 24 } })
    expect(tree(h.home)).toEqual(before)
    expect(existsSync(join(h.home, 'heartbeat'))).toBe(false)
    expect(Object.keys(tree(h.home))).toEqual([])
  })
})
