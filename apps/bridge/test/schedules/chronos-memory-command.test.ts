// Chronos "memory" feature for a command job: the run gets a per-run scratch folder (mode 0700) with notepad.txt, results.txt and
// memory.wrapped.txt, and TALOS_MEMORY_DIR / TALOS_MEMORY_NOTEPAD_OUT in its environment. It never gets the pack file itself. The
// command's own text is what the pack is bound to (the job's content hash). These run the REAL run script in a temp HOME.
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChronosBox, MON_0700_EDT } from './chronos-box.ts'

const boxes: ChronosBox[] = []
afterEach(() => {
  for (const b of boxes.splice(0)) b.dispose()
})

const DS = '2026-10-05'
const EPOCH = '3f2b8c1e-aaaa-4bbb-8ccc-0123456789ab'
const TEXT =
  '--- memory (this job only) ---\nLast results, newest first:\n- 2026-10-04 ok: Posted.\nNotepad:\ncursor=41'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function rig() {
  const box = new ChronosBox(MON_0700_EDT)
  boxes.push(box)
  const mem = join(box.dir, 'mem')
  mkdirSync(mem, { recursive: true, mode: 0o700 })
  box.mergeConfig({ memory_dir: mem })
  const seen = join(box.dir, 'seen.txt')
  const cmd = [
    'printf "%s|%s\\n" "$TALOS_MEMORY_DIR" "$TALOS_MEMORY_NOTEPAD_OUT" > "$SEEN"',
    '[ -n "$TALOS_MEMORY_DIR" ] && cat "$TALOS_MEMORY_DIR/notepad.txt" >> "$SEEN"',
    '[ -n "$TALOS_MEMORY_NOTEPAD_OUT" ] && printf cursor=42 > "$TALOS_MEMORY_NOTEPAD_OUT"',
    'echo last line',
  ].join('; ')
  box.handWrite({ id: 'job-c', name: 'Job C', time: '07:30', prompt: '', extra: { kind: 'command', command: cmd } })
  /** What a pack for this job is bound to: the kind and the command only (`chronos api memory-binding`). */
  const binding = () => box.api<{ sha256: string }>(['memory-binding', 'job-c']).sha256
  const pack = (o: { bound?: string; extra?: Record<string, unknown> } = {}) =>
    writeFileSync(
      join(mem, 'job-c.pack.json'),
      JSON.stringify({
        v: 1,
        job: 'job-c',
        prompt_sha256: o.bound ?? binding(),
        epoch: EPOCH,
        notepad: true,
        text: TEXT,
        notepad_text: 'cursor=41',
        results_text: '2026-10-04 ok: Posted.',
        ...o.extra,
      }),
    )
  const edit = (patch: Record<string, unknown>) => {
    const file = join(box.home, '.config', 'chronos', 'jobs.json')
    const jobs = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    writeFileSync(file, JSON.stringify(jobs.map((j) => (j.id === 'job-c' ? { ...j, ...patch } : j))))
  }
  const run = () => box.runScript('job-c', DS, { SEEN: seen })
  return { box, mem, seen, pack, run, edit, binding, cmd }
}

describe('a command job with a matching pack', () => {
  test('gets a private scratch folder with the notepad, the results and the wrapped text, and the two variables', () => {
    const r = rig()
    r.pack()
    expect(r.run().status).toBe(0)
    const [first, ...rest] = readFileSync(r.seen, 'utf8').split('\n')
    const [dir, out] = (first ?? '').split('|')
    expect(dir).toMatch(/\/mem\/run\/job-c\.r_[0-9A-Z]{26}$/)
    expect(out).toBe(`${dir}/notepad.new`)
    expect(rest.join('\n')).toContain('cursor=41')
    expect(lstatSync(dir as string).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir as string).sort()).toEqual([
      'memory.wrapped.txt',
      'notepad.new',
      'notepad.txt',
      'results.txt',
    ])
    expect(readFileSync(`${dir}/results.txt`, 'utf8').trim()).toBe('2026-10-04 ok: Posted.')
    expect(readFileSync(`${dir}/memory.wrapped.txt`, 'utf8')).toContain(TEXT)
    expect(readFileSync(`${dir}/notepad.new`, 'utf8')).toBe('cursor=42')
    for (const f of readdirSync(dir as string)) expect(lstatSync(`${dir}/${f}`).mode & 0o777).toBe(0o600)
  })

  test('never gets the pack file or the memory folder itself', () => {
    const r = rig()
    r.pack()
    r.run()
    const first = readFileSync(r.seen, 'utf8').split('\n')[0] ?? ''
    expect(first).not.toContain('pack.json')
    expect(first.split('|')[0]).not.toBe(r.mem)
  })

  test('leaves a receipt that says a notepad was offered', () => {
    const r = rig()
    r.pack()
    r.run()
    const names = readdirSync(join(r.mem, 'receipts'))
    expect(names).toHaveLength(1)
    const rec = JSON.parse(readFileSync(join(r.mem, 'receipts', names[0] as string), 'utf8'))
    expect(rec).toMatchObject({ job: 'job-c', epoch: EPOCH, notepad: true })
  })
})

describe('a command job without one', () => {
  test('a pack bound to other command text is skipped: no variables, no scratch folder, no receipt', () => {
    const r = rig()
    r.pack({ bound: sha('older command') })
    expect(r.run().status).toBe(0)
    expect(readFileSync(r.seen, 'utf8').split('\n')[0]).toBe('|')
    expect(existsSync(join(r.mem, 'run'))).toBe(false)
    expect(existsSync(join(r.mem, 'receipts'))).toBe(false)
  })

  test('no pack at all: the command runs as it always did', () => {
    const r = rig()
    expect(r.run().status).toBe(0)
    expect(readFileSync(r.seen, 'utf8').split('\n')[0]).toBe('|')
  })

  test('a pack with no notepad_text is skipped (it is not a command pack)', () => {
    const r = rig()
    r.pack({ extra: { notepad_text: undefined } })
    r.run()
    expect(readFileSync(r.seen, 'utf8').split('\n')[0]).toBe('|')
  })
})

describe('what a command pack is bound to', () => {
  test('the kind and the command: a change of anything else about the job leaves it valid', () => {
    const r = rig()
    r.pack()
    r.edit({ notify: 'always', description: 'now with a description', meta: { anything: 1 } })
    r.run()
    expect((readFileSync(r.seen, 'utf8').split('\n')[0] ?? '').split('|')[0]).toMatch(/\/mem\/run\/job-c\./)
  })

  test('a different command makes it stale: no folder, no variables', () => {
    const r = rig()
    r.pack()
    const bound = r.binding()
    r.edit({ command: `${r.cmd}; true` })
    r.run()
    expect(readFileSync(r.seen, 'utf8').split('\n')[0]).toBe('|')
    expect(r.binding()).not.toBe(bound)
  })

  test('for an agent job the binding is the hash of its prompt.md', () => {
    const r = rig()
    r.box.handWrite({ id: 'job-a', name: 'Job A', time: '07:30', prompt: 'Check the inbox.\n' })
    expect(r.box.api<{ sha256: string }>(['memory-binding', 'job-a']).sha256).toBe(sha('Check the inbox.\n'))
  })
})
