// The owner's ask through supervisor-control (cli.ts claimControl): exactly the words `talos-app supervise` writes, from a small
// regular file, taken once; anything else is removed unread, audited, and never acted on (Fable R1-2 on the Linux restart port).
import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONTROL_WORDS, claimControl } from '../../src/supervisor/cli.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'talos-control-'))
  dirs.push(d)
  const audit: Array<[string, Record<string, string> | undefined]> = []
  return {
    d,
    path: join(d, 'supervisor-control'),
    audit,
    take: (p: string) => claimControl(p, (e, f) => audit.push([e, f])),
  }
}

describe('supervisor-control (cli.ts claimControl)', () => {
  it('each word talos-app supervise writes is taken once, with or without its newline', () => {
    for (const w of CONTROL_WORDS) {
      const x = setup()
      writeFileSync(x.path, `${w}\n`)
      expect(x.take(x.path)).toBe(w)
      expect(x.take(x.path)).toBeNull()
      writeFileSync(x.path, w)
      expect(x.take(x.path)).toBe(w)
      expect(readdirSync(x.d)).toEqual([])
    }
  })
  it('anything else is removed unread and never acted on: other words, two lines, spaces, a capital, a big file', () => {
    for (const text of [
      'restart\n',
      'start\nstop\n',
      ' start\n',
      'start \n',
      'START\n',
      'start\r\n',
      `start${'\n'.repeat(80)}`,
      '',
    ]) {
      const x = setup()
      writeFileSync(x.path, text)
      expect(x.take(x.path), JSON.stringify(text)).toBeNull()
      expect(readdirSync(x.d)).toEqual([])
      expect(x.audit.map(([e]) => e)).toEqual(['control_refused'])
    }
  })
  it('a link (to a file holding "start"), a FIFO or a folder: never read, removed, the link’s target untouched', () => {
    const x = setup()
    const target = join(x.d, 'elsewhere')
    writeFileSync(target, 'start\n')
    symlinkSync(target, x.path)
    expect(x.take(x.path)).toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('start\n')
    expect(existsSync(x.path)).toBe(false)
    expect(spawnSync('mkfifo', [x.path]).status).toBe(0)
    expect(x.take(x.path)).toBeNull() // no reader blocks on it
    mkdirSync(x.path)
    writeFileSync(join(x.path, 'start'), 'start\n')
    expect(x.take(x.path)).toBeNull()
    expect(readdirSync(x.d)).toEqual(['elsewhere'])
    expect(x.audit.filter(([e]) => e === 'control_refused')).toHaveLength(3)
  })
  it('a rename that fails for another reason than no file is audited, once until it changes (Fable R1-4)', () => {
    const x = setup()
    writeFileSync(x.path, 'stop\n')
    chmodSync(x.d, 0o500) // the folder cannot be written: the rename fails with EACCES
    try {
      expect(x.take(x.path)).toBeNull()
      expect(x.take(x.path)).toBeNull()
      expect(x.take(x.path)).toBeNull()
    } finally {
      chmodSync(x.d, 0o700)
    }
    expect(x.audit).toEqual([['control_unreadable', { error: 'EACCES' }]])
    // taken once it can be: the word, and the next failure is said again
    expect(x.take(x.path)).toBe('stop')
  })
  it('the aside name is not guessable: a folder put at the old <path>.<pid> name does not stop a take', () => {
    const x = setup()
    mkdirSync(`${x.path}.${process.pid}`)
    writeFileSync(join(`${x.path}.${process.pid}`, 'x'), '')
    writeFileSync(x.path, 'stop\n')
    expect(x.take(x.path)).toBe('stop')
  })
  it('no file: nothing, and nothing audited', () => {
    const x = setup()
    expect(x.take(x.path)).toBeNull()
    expect(x.audit).toEqual([])
  })
})
