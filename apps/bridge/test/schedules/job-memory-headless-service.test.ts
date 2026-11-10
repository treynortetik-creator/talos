// Job memory for background jobs, end to end: the real bridge, the real Chronos CLI and run script, a stand-in `claude`, an injected
// clock. Packs follow the memory switch, a run's notepad and result come back through its receipt, and the approval card is plain
// about who gets what (including a Chronos that is too old).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import {
  CHRONOS_SRC,
  ChronosBox,
  draft,
  longTimeouts,
  MON_0700_EDT,
  type SchedHarness,
  startSched,
  TZ,
  tempHome,
} from './harness.ts'

longTimeouts()

let h = undefined as unknown as SchedHarness
const cleanup: string[] = []
afterEach(async () => {
  await h?.stop()
  h = undefined as unknown as SchedHarness
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true })
})

const EPOCH = {
  bg: 'aaaaaaaa-0000-4000-8000-000000000001',
  ro: 'aaaaaaaa-0000-4000-8000-000000000002',
  sess: 'aaaaaaaa-0000-4000-8000-000000000003',
}
const BG = draft({ id: 'bg-job', name: 'Background', runner: 'headless', permissions: 'full' })
const RO = draft({
  id: 'ro-job',
  name: 'Read only',
  runner: 'headless',
  permissions: 'restricted',
  allowed_tools: ['Read'],
})
const SESS = draft({ id: 'sess-job', name: 'Session' })

function homeWithMemory(ids: Array<keyof typeof EPOCH> = ['bg', 'ro', 'sess']) {
  const home = tempHome('talos-job-memory-headless-svc-')
  cleanup.push(home)
  mkdirSync(home, { recursive: true })
  const jobs: Record<string, unknown> = {}
  for (const k of ids) jobs[`${k}-job`] = { thread_id: null, memory: true, epoch: EPOCH[k] }
  writeFileSync(
    join(home, 'schedules-meta.json'),
    JSON.stringify({ adapter: 'chronos', jobs, offers: {}, inflight: {}, runs: {}, notified: {}, ingested: {} }),
  )
  return home
}
const packFile = (id: string) => join(h.home, 'job-memory', `${id}.pack.json`)
const packOf = (id: string) => JSON.parse(readFileSync(packFile(id), 'utf8')) as Record<string, unknown>

/** A Chronos checkout that does not know the memory feature (what an owner who has not updated yet has). */
function oldChronos() {
  const dir = mkdtempSync(join(tmpdir(), 'talos-old-chronos-'))
  cleanup.push(dir)
  cpSync(CHRONOS_SRC, dir, { recursive: true })
  const lib = join(dir, 'lib', 'chronoslib.py')
  writeFileSync(lib, readFileSync(lib, 'utf8').replace('["times", "meta", "memory"]', '["times", "meta"]'))
  return dir
}

async function proposeCard(change: Record<string, unknown>): Promise<CardT> {
  const f = await h.app.patchSchedule(change, 'general')
  await h.app.expectFrame('ack', (a) => a.ref === f.id, { direction: 'in' })
  const cc = await h.app.expectFrame(
    'card.create',
    (c) => c.card.kind === 'schedule' && (c.card.payload as { client_ref?: string } | undefined)?.client_ref === f.id,
    { direction: 'in' },
  )
  return cc.card as CardT
}
const etagOf = (id: string) =>
  h.box.api<{ schedules: Array<{ id: string; etag: string }> }>(['snapshot']).schedules.find((j) => j.id === id)
    ?.etag as string

function spyClaude(box: ChronosBox, notepad: string) {
  const bin = join(box.dir, 'claude-spy.sh')
  writeFileSync(
    bin,
    `#!/bin/bash\n[ -n "\${CHRONOS_MEMORY_OUT:-}" ] && printf '%s' '${notepad}' > "$CHRONOS_MEMORY_OUT"\nexec "${join(box.src, 'tests', 'fake-claude.sh')}" "$@"\n`,
  )
  chmodSync(bin, 0o755)
  box.mergeConfig({ claude_bin: bin })
}

describe('packs follow the memory switch', () => {
  test('a background job gets a pack with notes, a restricted one results only, a session job none; Chronos is pointed at the folder', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG, RO, SESS], home: homeWithMemory() })
    await h.bridge.ctx.schedules?.refresh()
    expect(packOf('bg-job')).toMatchObject({ job: 'bg-job', notepad: true, epoch: EPOCH.bg })
    expect(packOf('ro-job')).toMatchObject({ job: 'ro-job', notepad: false, epoch: EPOCH.ro })
    expect(existsSync(packFile('sess-job'))).toBe(false)
    const cfg = JSON.parse(readFileSync(h.box.configFile, 'utf8')) as { memory_dir?: string }
    expect(cfg.memory_dir).toBe(join(h.home, 'job-memory'))
  })

  test('a job with memory off has no pack', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG, RO, SESS], home: homeWithMemory(['ro']) })
    await h.bridge.ctx.schedules?.refresh()
    expect(existsSync(packFile('bg-job'))).toBe(false)
    expect(existsSync(packFile('ro-job'))).toBe(true)
  })

  test('a Chronos without the memory feature: no pack, and Chronos is not pointed at anything', async () => {
    const box = new ChronosBox(MON_0700_EDT, TZ, oldChronos())
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    for (const j of [BG, RO]) box.create(j)
    h = await startSched({ now: MON_0700_EDT, box, home: homeWithMemory(['bg', 'ro']) })
    await h.bridge.ctx.schedules?.refresh()
    expect(existsSync(packFile('bg-job'))).toBe(false)
    expect(existsSync(packFile('ro-job'))).toBe(false)
    expect(readFileSync(box.configFile, 'utf8')).not.toContain('memory_dir')
  })
})

describe('a run comes back through its receipt', () => {
  test('the notepad and the result are kept, the pack is rewritten with them, and refreshing again keeps nothing twice', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG], home: homeWithMemory(['bg']), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    spyClaude(h.box, 'cursor=42')
    const run = h.box.runScript('bg-job', '2026-10-05', { FAKE_LOG: join(h.box.dir, 'fake.log') })
    expect(run.status).toBe(0)
    await h.bridge.ctx.schedules?.refresh()
    const mem = JSON.parse(readFileSync(join(h.home, 'job-memory', 'bg-job.json'), 'utf8')) as {
      notepad: string
      results: unknown[]
    }
    expect(mem.notepad).toBe('cursor=42')
    expect(mem.results).toHaveLength(1)
    expect(packOf('bg-job').text as string).toContain('cursor=42')
    await h.bridge.ctx.schedules?.refresh()
    const again = JSON.parse(readFileSync(join(h.home, 'job-memory', 'bg-job.json'), 'utf8')) as { results: unknown[] }
    expect(again.results).toHaveLength(1)
  })

  test('a run that started before the job text was edited is not kept', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG], home: homeWithMemory(['bg']), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    spyClaude(h.box, 'stale notes')
    h.box.runScript('bg-job', '2026-10-05', { FAKE_LOG: join(h.box.dir, 'fake.log') })
    // the owner edits the job (a card would wipe; an outside edit changes the text hash)
    h.box.editPromptOutside('bg-job', 'A different job now.\n')
    await h.bridge.ctx.schedules?.refresh(true) // (true: forget the snapshot the last refresh cached)
    const f = join(h.home, 'job-memory', 'bg-job.json')
    expect(existsSync(f) ? readFileSync(f, 'utf8') : '').not.toContain('stale notes')
  })
})

describe('Chronos is pointed at the folder, and kept pointed there', () => {
  test('a memory_dir that was set elsewhere in the meantime is put back on the next sync', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG], home: homeWithMemory(['bg']), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    const dir = () => (JSON.parse(readFileSync(h.box.configFile, 'utf8')) as { memory_dir?: string }).memory_dir
    expect(dir()).toBe(join(h.home, 'job-memory'))
    const elsewhere = join(h.box.dir, 'elsewhere')
    mkdirSync(elsewhere)
    h.box.api(['config', 'set', 'memory_dir', elsewhere]) // what an agent with shell access could do
    expect(dir()).toBe(elsewhere)
    await h.bridge.ctx.schedules?.refresh()
    expect(dir()).toBe(join(h.home, 'job-memory'))
  })
})

describe('many runs while the bridge was down', () => {
  test('a run Chronos no longer lists among its newest 20 is still taken in, by its id', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG], home: homeWithMemory(['bg']), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    spyClaude(h.box, 'cursor=77')
    expect(h.box.runScript('bg-job', '2026-10-05', { FAKE_LOG: join(h.box.dir, 'fake.log') }).status).toBe(0)
    // 25 later runs (the bridge was down for days of a job that fires several times a day)
    const rows = Array.from({ length: 25 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0')
      return JSON.stringify({
        job: 'bg-job',
        ds: `2026-10-08T09${n}`,
        run_id: `r_${'1'.repeat(24)}${n}`,
        start_ts: 1_790_000_000 + i,
        started_at: '2026-10-08T09:00:00-04:00',
        status: 'ok',
        ok: true,
        runner: 'headless',
        trigger_kind: 'clock',
        duration_s: 1,
      })
    })
    appendFileSync(join(h.box.home, '.chronos', 'runs.jsonl'), `${rows.join('\n')}\n`)
    await h.bridge.ctx.schedules?.refresh()
    const mem = JSON.parse(readFileSync(join(h.home, 'job-memory', 'bg-job.json'), 'utf8')) as { notepad: string }
    expect(mem.notepad).toBe('cursor=77')
  })
})

describe('the approval card is plain about it', () => {
  test('switching memory on for an unattended full-permission job says so', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG, RO] })
    const card = await proposeCard({ op: 'update', id: 'bg-job', base_etag: etagOf('bg-job'), set: { memory: true } })
    expect(card.risk).toBe('high')
    expect(card.body ?? '').toMatch(/unattended[^\n]*full permissions/i)
    expect(card.body ?? '').not.toContain('newer Chronos')
  })

  test('for a restricted job it says it reads results and cannot keep notes, and does not claim full permissions', async () => {
    h = await startSched({ now: MON_0700_EDT, jobs: [BG, RO] })
    const card = await proposeCard({ op: 'update', id: 'ro-job', base_etag: etagOf('ro-job'), set: { memory: true } })
    expect(card.body ?? '').toMatch(/can't keep notes/)
    expect(card.body ?? '').not.toMatch(/full permissions/i)
  })

  test("with a Chronos that is too old, the card says it needs a newer Chronos; a session job's card never does", async () => {
    const box = new ChronosBox(MON_0700_EDT, TZ, oldChronos())
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    for (const j of [BG, SESS]) box.create(j)
    h = await startSched({ now: MON_0700_EDT, box })
    const bg = await proposeCard({ op: 'update', id: 'bg-job', base_etag: etagOf('bg-job'), set: { memory: true } })
    expect(bg.body ?? '').toContain('newer Chronos')
    const sess = await proposeCard({
      op: 'update',
      id: 'sess-job',
      base_etag: etagOf('sess-job'),
      set: { memory: true },
    })
    expect(sess.body ?? '').not.toContain('newer Chronos')
  })
})

describe('a command job', () => {
  const CMD = 'printf cursor=43 > "$TALOS_MEMORY_NOTEPAD_OUT"; echo hello-from-command'
  function commandBox() {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: false })
    box.handWrite({
      id: 'cmd-job',
      name: 'Command',
      time: '07:30',
      prompt: '',
      extra: { kind: 'command', command: CMD },
    })
    return box
  }
  const homeFor = () => {
    const home = homeWithMemory([])
    const f = join(home, 'schedules-meta.json')
    const side = JSON.parse(readFileSync(f, 'utf8'))
    side.jobs['cmd-job'] = { thread_id: null, memory: true, epoch: 'aaaaaaaa-0000-4000-8000-000000000009' }
    writeFileSync(f, JSON.stringify(side))
    return home
  }

  test('gets a pack with the notepad and the results as text, bound to its kind and command', async () => {
    const box = commandBox()
    h = await startSched({ now: MON_0700_EDT, box, home: homeFor(), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    const p = packOf('cmd-job')
    expect(p).toMatchObject({
      job: 'cmd-job',
      notepad: true,
      notepad_text: '',
      epoch: 'aaaaaaaa-0000-4000-8000-000000000009',
    })
    expect(p.prompt_sha256).toBe(box.api<{ sha256: string }>(['memory-binding', 'cmd-job']).sha256)
  })

  test('an edit to anything but the command (the model, say) does not wipe it', async () => {
    const box = commandBox()
    h = await startSched({ now: MON_0700_EDT, box, home: homeFor(), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    expect(box.runScript('cmd-job', '2026-10-05').status).toBe(0)
    await h.bridge.ctx.schedules?.refresh()
    const file = join(h.home, 'job-memory', 'cmd-job.json')
    const before = readFileSync(file, 'utf8')
    expect(before).toContain('cursor=43')
    const epoch = packOf('cmd-job').epoch
    const jobs = join(box.home, '.config', 'chronos', 'jobs.json')
    const list = JSON.parse(readFileSync(jobs, 'utf8')) as Array<Record<string, unknown>>
    writeFileSync(jobs, JSON.stringify(list.map((j) => ({ ...j, model: 'sonnet', description: 'edited' }))))
    await h.bridge.ctx.schedules?.refresh(true)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(packOf('cmd-job').epoch).toBe(epoch)
  })

  test('a run keeps its notepad and its last output line, and the next pack carries them', async () => {
    const box = commandBox()
    h = await startSched({ now: MON_0700_EDT, box, home: homeFor(), scheduleWatch: false })
    await h.bridge.ctx.schedules?.refresh()
    const run = box.runScript('cmd-job', '2026-10-05')
    expect(run.status).toBe(0)
    await h.bridge.ctx.schedules?.refresh()
    const mem = JSON.parse(readFileSync(join(h.home, 'job-memory', 'cmd-job.json'), 'utf8')) as {
      notepad: string
      results: Array<{ summary: string; ok: boolean }>
    }
    expect(mem.notepad).toBe('cursor=43')
    expect(mem.results[0]).toMatchObject({ ok: true, summary: 'exit 0: hello-from-command' })
    expect(packOf('cmd-job').notepad_text).toBe('cursor=43')
    expect(existsSync(join(h.home, 'job-memory', 'run'))).toBe(true)
    expect(readdirSync(join(h.home, 'job-memory', 'run'))).toEqual([])
  })
})
