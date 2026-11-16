// Bug hunt 2026-11-10 #5: a post into an archived thread "succeeded" and vanished (the app leaves archived threads out of
// the list and the badges). The agent's posting tools now refuse it and name the default thread; a background job whose
// result thread is archived posts to the default thread, and the live bridge pauses that job once, with a notice.
import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eventually, type Harness, startHarness } from '../helpers.ts'
import { draft, longTimeouts, type SchedHarness, sleep, startSched } from '../schedules/harness.ts'

longTimeouts()

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s().catch(() => {})
})

const archive = (h: Harness, id: string, archived = true) =>
  h.bridge.ctx.config.update((c) => ({
    ...c,
    threads: c.threads.map((t) => (t.id === id ? { ...t, archived } : t)),
  }))
const PROJ = {
  id: 'projb',
  name: 'Proj B',
  icon: '📁',
  kind: 'fixed',
  order: 2,
  notify: 'all',
  voice_context: 'recent',
  archived: false,
  created_at: '2026-10-28T00:00:00.000Z',
}
type Cfg = NonNullable<NonNullable<Parameters<typeof startHarness>[0]>['config']>
const withProj =
  (archived = false): Cfg =>
  (c) => ({ ...c, threads: [...c.threads, { ...PROJ, archived } as (typeof c.threads)[number]] })
const repliesIn = (h: Harness, thread: string) =>
  h.relay.rec.of('reply', 'from_bridge').filter((f) => f.message.thread_id === thread)
const text = (r: { content: Array<{ text?: string }> }) => r.content[0]?.text ?? ''

describe('bug hunt #5: the agent posts into an archived thread', () => {
  test('reply and attach are refused with the thread and the default thread named; nothing is stored or sent; reading still works', async () => {
    const h = await startHarness({ config: withProj() })
    stops.push(() => h.stop())
    const def = h.bridge.ctx.config.config.default_thread
    const id = PROJ.id
    expect((await h.bridge.callTool('reply', { thread_id: id, text: 'before the archive' })).isError).toBeFalsy()
    archive(h, id)
    const before = repliesIn(h, id).length

    const r = await h.bridge.callTool('reply', { thread_id: id, text: 'late-reply' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain(`Thread "${id}" is archived`)
    expect(text(r)).toContain('Nothing was posted')
    expect(text(r)).toContain(`Post it to "${def}" instead`)
    // the alias takes the same path
    expect((await h.bridge.callTool('reply', { chat_id: id, text: 'late-reply' })).isError).toBe(true)

    const file = join(h.home, 'note.txt')
    writeFileSync(file, 'hello')
    const a = await h.bridge.callTool('attach', { thread_id: id, path: file })
    expect(a.isError).toBe(true)
    expect(text(a)).toContain('is archived')

    await sleep(150)
    expect(repliesIn(h, id).length).toBe(before)
    const stored = h.bridge.ctx.store.page({ thread_id: id, limit: 50 }).messages.map((m) => m.text)
    expect(stored).toEqual(['before the archive'])

    // the history of an archived thread can still be read
    const read = await h.bridge.callTool('read_thread', { thread_id: id })
    expect(read.isError).toBeFalsy()
    expect(text(read)).toContain('before the archive')

    // the agent does what the error says: the default thread takes it
    const ok = await h.bridge.callTool('reply', { thread_id: def, text: `late-reply (about ${id})` })
    expect(ok.isError).toBeFalsy()
    // and once the owner unarchives the thread, posting there works again
    archive(h, id, false)
    expect((await h.bridge.callTool('reply', { thread_id: id, text: 'back' })).isError).toBeFalsy()
  })

  test('an archived default thread (a hand edit) is never named as the place to post instead', async () => {
    const h = await startHarness()
    stops.push(() => h.stop())
    const def = h.bridge.ctx.config.config.default_thread
    archive(h, def)
    const r = await h.bridge.callTool('reply', { thread_id: def, text: 'x' })
    expect(r.isError).toBe(true)
    expect(text(r)).toContain('Ask the owner to unarchive it')
    expect(text(r)).not.toContain('instead')
  })
})

describe('bug hunt #5: a background job whose result thread is archived', () => {
  const sidecarWith = (home: string, thread: string) =>
    writeFileSync(
      join(home, 'schedules-meta.json'),
      JSON.stringify({
        adapter: 'chronos',
        jobs: { 'bg-job': { thread_id: thread } },
        offers: {},
        inflight: {},
        runs: {},
        notified: {},
      }),
    )

  test('the headless run posts to the default thread, not the archived one, and list_threads does not mark the archived one', async () => {
    const live = await startSched({ jobs: [draft({ id: 'bg-job', name: 'Background', runner: 'headless' })] })
    const def = live.bridge.ctx.config.config.default_thread
    const id = PROJ.id
    const home = live.home
    await live.stop()
    stops.push(async () => live.box.dispose())
    sidecarWith(home, id)
    const hl = await startHarness({
      home,
      config: withProj(true),
      startBridge: false,
      env: { CHRONOS_JOB: 'bg-job', PATH: process.env.PATH ?? '/usr/bin:/bin' },
      bridge: { headless: true },
    })
    stops.push(() => hl.stop())
    expect(hl.bridge.ctx.config.thread(id)?.archived).toBe(true)
    expect(hl.bridge.ctx.schedules?.headlessJobThread()).toBeNull()
    const list = JSON.parse(text(await hl.bridge.callTool('list_threads', {}))) as {
      default_thread: string
      threads: Array<{ id: string; name: string }>
    }
    expect(list.default_thread).toBe(def)
    expect(list.threads.some((t) => t.name.includes("this job's thread"))).toBe(false)
    // the run's own reply to the archived thread is refused like anyone else's
    expect((await hl.bridge.callTool('reply', { thread_id: id, text: 'result' })).isError).toBe(true)
  })

  test('the live bridge pauses the job once and says why in the default thread; a job the owner resumes anyway stays resumed', async () => {
    const h: SchedHarness = await startSched({
      jobs: [draft({ id: 'bg-job', name: 'Background', runner: 'headless' }), draft()],
      config: withProj(),
    })
    stops.push(() => h.stop())
    const svc = h.bridge.ctx.schedules
    const def = h.bridge.ctx.config.config.default_thread
    const id = PROJ.id
    const name = PROJ.name
    expect(svc?.sidecar.setThread('bg-job', id)).toBe(true)
    expect(svc?.sidecar.setThread('daily-digest', id)).toBe(true) // a session job: the live path already falls back
    const paused = async (job: string) => (await svc?.refresh(true))?.schedules.find((s) => s.id === job)?.paused
    expect(await paused('bg-job')).toBe(false)

    archive(h, id)
    await svc?.refresh(true)
    await eventually(async () => expect(await paused('bg-job')).toBe(true))
    expect(await paused('daily-digest')).toBe(false)
    const notices = () =>
      repliesIn(h, def)
        .filter((f) => f.message.author === 'system' && (f.message.text ?? '').includes('is archived'))
        .map((f) => f.message.text)
    await eventually(() => expect(notices().length).toBe(1))
    expect(notices()).toEqual([
      `Scheduled job "Background" posts its results to "${name}", which is archived, so it is paused. Unarchive the thread or give the job another thread in Schedules, then resume it. If you resume it as it is, its results go to "${h.bridge.ctx.config.thread(def)?.name}".`,
    ])
    expect(repliesIn(h, id)).toEqual([])

    // the owner resumes it without changing anything: that is their call, and it is not paused or announced again
    const markAt = () => svc?.sidecar.all.notified[`archived-thread|bg-job|${id}`] as number
    const first = markAt()
    h.box.api(['pause'], { scope: { id: 'bg-job' }, paused: false })
    await h.advance(60_000) // ordinary refreshes with the job resumed: it is not paused or announced again
    expect(await paused('bg-job')).toBe(false)
    // A day later (past the mark's 24 h renewal). Every refresh in between finds the mark and does nothing, so the clock jumps
    // and the refresh below is the one that renews it. Stepping the 26 h through a live bridge took ~2,300 ping round trips.
    h.clock.set(h.clock.now() + 26 * 3600_000)
    await svc?.refresh(true)
    expect(await paused('bg-job')).toBe(false)
    expect(notices().length).toBe(1)
    // the mark is renewed while the thread stays archived, so the sidecar's 8-day prune cannot bring the pause back
    expect(markAt()).toBeGreaterThan(first)
  })
})
