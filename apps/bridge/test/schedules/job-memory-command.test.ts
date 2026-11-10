// Job memory for a command job (docs/SCHEDULES.md "Job memory"): a script, not an agent. The pack carries the notepad and the
// results as plain text for Chronos to put in the run's scratch folder; what comes back is the notepad file the command wrote,
// read from that folder and nowhere else. The result is the command's last output line with its exit status.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindingOf, JobMemory } from '../../src/schedules/job-memory.ts'
import {
  buildPack,
  ingestReceipts,
  PACK_MAX_BYTES,
  type RunResult,
  summaryOf,
  syncPacks,
} from '../../src/schedules/job-memory-headless.ts'
import { Sidecar } from '../../src/schedules/sidecar.ts'
import { tempHome } from '../helpers.ts'

const homes: string[] = []
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true })
})

/** What a command job is bound to: its content hash string (the bridge never sees the command text). */
const BOUND = `sha256:${'c'.repeat(64)}`
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const rid = (n: number) => `r_${'0'.repeat(24)}${String(n).padStart(2, '0')}`

function rig() {
  const home = tempHome('talos-job-memory-command-')
  homes.push(home)
  const sidecar = new Sidecar(home, () => true)
  const mem = new JobMemory(
    home,
    () => true,
    (id) => sidecar.bumpEpoch(id),
  )
  const dir = join(home, 'job-memory')
  const scratch = (id: string, n: number) => join(dir, 'run', `${id}.${rid(n)}`)
  const receipt = (id: string, n: number) => {
    mkdirSync(join(dir, 'receipts'), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, 'receipts', `${id}.${rid(n)}.json`),
      JSON.stringify({
        v: 1,
        job: id,
        run_id: rid(n),
        epoch: sidecar.memoryEpoch(id),
        prompt_sha256: sha(BOUND),
        notepad: true,
      }),
    )
  }
  const written = (id: string, n: number, text: string) => {
    mkdirSync(scratch(id, n), { recursive: true, mode: 0o700 })
    writeFileSync(join(scratch(id, n), 'notepad.new'), text)
  }
  const runs = new Map<string, RunResult>()
  const ingest = (id: string) =>
    ingestReceipts(
      { mem, sidecar, now: () => 1_000, shaOf: () => sha(BOUND), runOf: async (j, r) => runs.get(`${j}.${r}`) ?? null },
      id,
      { command: true },
    )
  return { home, dir, mem, sidecar, scratch, receipt, written, runs, ingest }
}

describe('the command pack', () => {
  test('carries the notepad and the results as plain text, and the wrapped text for a script that pipes into a model', () => {
    const p = JSON.parse(
      buildPack({
        id: 'job-c',
        sha: sha(BOUND),
        epoch: 'e-1',
        data: { notepad: 'cursor=41', truncated: false, results: [{ ds: '2026-11-01', ok: true, summary: 'Posted.' }] },
        kind: 'command',
      }),
    )
    expect(p).toMatchObject({ job: 'job-c', prompt_sha256: sha(BOUND), notepad: true, notepad_text: 'cursor=41' })
    expect(p.results_text).toBe('2026-11-01 ok: Posted.')
    expect(p.text).toContain('<<<EXTERNAL_UNTRUSTED_CONTENT')
  })

  test('stays within 8 KB for the worst case', () => {
    const data = {
      notepad: 'line\n'.repeat(1000),
      truncated: true,
      results: [1, 2, 3].map((n) => ({ ds: `2026-11-0${n}`, ok: true, summary: '\u{1F600}'.repeat(280) })),
    }
    expect(
      Buffer.byteLength(buildPack({ id: 'job-c', sha: sha(BOUND), epoch: 'e-1', data, kind: 'command' })),
    ).toBeLessThanOrEqual(PACK_MAX_BYTES)
  })

  test('is kept in step like any other pack', () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    expect(
      syncPacks({ mem: r.mem, sidecar: r.sidecar, jobs: [{ id: 'job-c', sha: sha(BOUND), kind: 'command' }] }).written,
    ).toEqual(['job-c'])
    const p = JSON.parse(readFileSync(join(r.dir, 'job-c.pack.json'), 'utf8'))
    expect(p.notepad_text).toBe('')
  })
})

describe('ingest of a command run', () => {
  test("keeps the notepad from the run's scratch folder, the result as its last line with the exit status, and removes the folder", async () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    r.receipt('job-c', 1)
    r.written('job-c', 1, 'cursor=42')
    r.runs.set(`job-c.${rid(1)}`, {
      status: 'ok',
      trigger: 'clock',
      ds: '2026-11-01',
      report: 'one\ntwo\nlast line\n\n',
    })
    expect(await r.ingest('job-c')).toBe(1)
    const m = r.mem.read('job-c', bindingOf(BOUND, r.sidecar.memoryEpoch('job-c') as string))
    expect(m?.notepad).toBe('cursor=42')
    expect(m?.results[0]).toEqual({ ds: '2026-11-01', ok: true, summary: 'exit 0: last line' })
    expect(existsSync(r.scratch('job-c', 1))).toBe(false)
  })

  test('a failed command is kept as failed', async () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    r.receipt('job-c', 1)
    r.runs.set(`job-c.${rid(1)}`, { status: 'failed', trigger: 'clock', ds: '2026-11-01', report: null })
    await r.ingest('job-c')
    const m = r.mem.read('job-c', bindingOf(BOUND, r.sidecar.memoryEpoch('job-c') as string))
    expect(m?.results[0]).toMatchObject({ ok: false })
    expect(m?.results[0]?.summary).toContain('failed')
  })

  test('only the scratch folder is read: an out file for the same run is ignored, and a link in the folder is not followed', async () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    r.receipt('job-c', 1)
    mkdirSync(join(r.dir, 'out'), { recursive: true })
    writeFileSync(join(r.dir, 'out', `job-c.${rid(1)}.txt`), 'from out')
    const secret = join(r.home, 'secret.txt')
    writeFileSync(secret, 'API_KEY=abc')
    mkdirSync(r.scratch('job-c', 1), { recursive: true })
    symlinkSync(secret, join(r.scratch('job-c', 1), 'notepad.new'))
    r.runs.set(`job-c.${rid(1)}`, { status: 'ok', trigger: 'clock', ds: '2026-11-01', report: 'x' })
    await r.ingest('job-c')
    const m = r.mem.read('job-c', bindingOf(BOUND, r.sidecar.memoryEpoch('job-c') as string))
    expect(m?.notepad).toBe('')
    expect(readFileSync(secret, 'utf8')).toBe('API_KEY=abc')
  })

  test('another epoch: memory untouched and the folder is removed', async () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    r.mem.save('job-c', bindingOf(BOUND, r.sidecar.memoryEpoch('job-c') as string), { notepad: 'mine' })
    const before = readFileSync(join(r.dir, 'job-c.json'), 'utf8')
    mkdirSync(join(r.dir, 'receipts'), { recursive: true })
    writeFileSync(
      join(r.dir, 'receipts', `job-c.${rid(1)}.json`),
      JSON.stringify({ v: 1, job: 'job-c', run_id: rid(1), epoch: 'older', prompt_sha256: sha(BOUND), notepad: true }),
    )
    r.written('job-c', 1, 'late')
    r.runs.set(`job-c.${rid(1)}`, { status: 'ok', trigger: 'clock', ds: '2026-11-01', report: 'x' })
    await r.ingest('job-c')
    expect(readFileSync(join(r.dir, 'job-c.json'), 'utf8')).toBe(before)
    expect(existsSync(r.scratch('job-c', 1))).toBe(false)
  })

  test("a wipe removes the job's scratch folders too, and nobody else's", () => {
    const r = rig()
    r.sidecar.setMemory('job-c', true)
    r.written('job-c', 1, 'x')
    r.written('job-d', 1, 'y')
    r.mem.wipe('job-c')
    expect(existsSync(r.scratch('job-c', 1))).toBe(false)
    expect(existsSync(r.scratch('job-d', 1))).toBe(true)
  })

  test('the summary of a command is its last non-empty line', () => {
    expect(summaryOf('ok', 'a\nb\n\n', true)).toBe('exit 0: b')
    expect(summaryOf('ok', '', true)).toBe('exit 0')
    expect(summaryOf('timed_out', null, true)).toContain('timed_out')
  })
})
