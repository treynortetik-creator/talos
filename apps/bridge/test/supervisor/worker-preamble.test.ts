// The preamble a thread session starts with, against the Mac's (WorkerSupport.swift): the default text word for word, read
// from the Swift source itself, and WORKER.md by the Mac's reading rules.
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultPreamble, PREAMBLE_MAX, workerPreamble } from '../../src/supervisor/worker-preamble.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const agent = (worker?: string | Uint8Array) => {
  const d = mkdtempSync(join(tmpdir(), 'talos-preamble-'))
  dirs.push(d)
  mkdirSync(join(d, 'threads', 'trip'), { recursive: true })
  if (worker !== undefined) writeFileSync(join(d, 'threads', 'trip', 'WORKER.md'), worker)
  return d
}

/** The Swift multi-line literal in `func preamble`, as Swift reads it: indentation stripped, `\` line ends joined. */
function swiftDefault(id: string): string {
  const src = readFileSync(
    join(import.meta.dir, '../../../desktop/Sources/TalosSupervisor/WorkerSupport.swift'),
    'utf8',
  )
  const fn = src.slice(src.indexOf('func preamble('))
  const body = fn.slice(fn.indexOf('return """\n') + 'return """\n'.length)
  const lines = body.slice(0, body.indexOf('"""')).split('\n')
  const indent = (lines.at(-1) ?? '').length // the closing delimiter's indentation
  const text = lines
    .slice(0, -1)
    .map((l) => l.slice(indent))
    .join('\n')
    .replace(/\\\n/g, '')
  return text.replaceAll('\\(id)', id)
}

describe('the preamble', () => {
  it('with no WORKER.md: the Mac’s default text, word for word', () => {
    expect(swiftDefault('trip')).toContain('You are the dedicated session for the Talos thread "trip".')
    expect(defaultPreamble('trip')).toBe(swiftDefault('trip'))
    expect(workerPreamble(agent(), 'trip')).toBe(swiftDefault('trip'))
  })
  it('names the thread’s live state file, not the old thread file', () => {
    const t = defaultPreamble('trip')
    expect(t).toContain(
      'Keep threads/trip.state.md current the same turn an owner ask, a decision, a landing or a hold changes (under 8,000 characters; history goes elsewhere), and read it first after a restart or compaction.',
    )
    expect(t).not.toContain('threads/trip.md')
    expect(swiftDefault('trip')).toContain('threads/trip.state.md current')
  })
  it('the thread’s WORKER.md as written, newlines and all', () => {
    expect(workerPreamble(agent('Work on the trip.\nBe brief.\n'), 'trip')).toBe('Work on the trip.\nBe brief.\n')
  })
  it('one that holds only whitespace (Foundation’s set, U+0085 and no-break space included) is none', () => {
    const blank = ` \n\t${String.fromCharCode(0x85, 0xa0, 0x2028)}\r\n`
    expect(workerPreamble(agent(blank), 'trip')).toBe(defaultPreamble('trip'))
  })
  it('a leading UTF-8 BOM is dropped, as String(data:encoding:.utf8) drops it; a BOM alone is none', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf])
    const hello = new Uint8Array([...bom, ...new TextEncoder().encode('hello')])
    expect(workerPreamble(agent(hello), 'trip')).toBe('hello')
    expect(workerPreamble(agent(bom), 'trip')).toBe(defaultPreamble('trip'))
  })
  it('one that is not UTF-8, or is not a file, is none', () => {
    expect(workerPreamble(agent(new Uint8Array([0x68, 0xff, 0x69])), 'trip')).toBe(defaultPreamble('trip'))
    const d = agent()
    mkdirSync(join(d, 'threads', 'trip', 'WORKER.md'))
    expect(workerPreamble(d, 'trip')).toBe(defaultPreamble('trip'))
  })
  it('a long one is cut to its first 8000 characters as Swift counts them (a combining accent is one with its letter)', () => {
    const e = 'é' // é, two UTF-16 units, one character
    const out = workerPreamble(agent(e.repeat(PREAMBLE_MAX + 50)), 'trip')
    expect(out).toBe(e.repeat(PREAMBLE_MAX))
    const flags = '🇫🇷'.repeat(PREAMBLE_MAX + 1)
    expect(workerPreamble(agent(flags), 'trip')).toBe('🇫🇷'.repeat(PREAMBLE_MAX))
  })
})
