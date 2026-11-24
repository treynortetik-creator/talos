// The extra lock's last-good record (guards/os-sandbox-record.ts): it is trusted only as a plain file in a real folder (a pipe, a link or a
// folder in its place is no record and is never opened), it is never written through a link, and the bridge's own good readings and writes of
// config.json keep it. Temp folders only.
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'
import { mainLaunchArgs } from '../src/guards/main-launch.ts'
import { readOsSandboxSwitch, SWITCH_RECORD } from '../src/guards/os-sandbox.ts'
import { lastKnownSwitch, rememberSwitch } from '../src/guards/os-sandbox-record.ts'
import { osSandboxForStart } from '../src/supervisor/plan-wiring.ts'
import { mainArgsWithGuards } from '../src/supervisor/worker-policy.ts'

const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../../../examples/config.default.json'), 'utf8'))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'talos-osbx-rec-')))
  dirs.push(d)
  return d
}
const rec = (h: string) => join(h, SWITCH_RECORD)
const folder = (h: string) => join(h, 'config-history')
const fifo = (p: string) => expect(spawnSync('mkfifo', [p]).status).toBe(0)

describe('reading the record', () => {
  test('a plain file in a real folder says on; "off", junk and a too-big file say off', () => {
    const h = tmp()
    mkdirSync(folder(h))
    writeFileSync(rec(h), 'on\n')
    expect(lastKnownSwitch(h)).toBe(true)
    for (const bytes of ['off\n', 'junk', `on${' '.repeat(64)}`]) {
      writeFileSync(rec(h), bytes)
      expect(lastKnownSwitch(h), bytes).toBe(false)
    }
  })
  test('a named pipe in its place is not opened: the start does not hang, and the answer is off', () => {
    const h = tmp()
    mkdirSync(folder(h))
    fifo(rec(h))
    writeFileSync(join(h, 'config.json'), '{ nope')
    expect(readOsSandboxSwitch(h)).toBe(false)
  })
  test('a symlink, a folder, or a second name for the record is no record, even when what it reaches says on', () => {
    const h = tmp()
    mkdirSync(folder(h))
    const elsewhere = join(tmp(), 'says-on')
    writeFileSync(elsewhere, 'on\n')
    symlinkSync(elsewhere, rec(h))
    expect(lastKnownSwitch(h)).toBe(false)
    rmSync(rec(h))
    mkdirSync(rec(h))
    expect(lastKnownSwitch(h)).toBe(false)
    rmSync(rec(h), { recursive: true })
    writeFileSync(rec(h), 'on\n')
    linkSync(rec(h), join(h, 'second-name'))
    expect(lastKnownSwitch(h)).toBe(false)
  })
  test('config-history as a link to a real folder with an "on" record in it is no record', () => {
    const h = tmp()
    const real = join(tmp(), 'real')
    mkdirSync(real)
    writeFileSync(join(real, 'os-sandbox-last'), 'on\n')
    symlinkSync(real, folder(h))
    expect(lastKnownSwitch(h)).toBe(false)
    writeFileSync(join(h, 'config.json'), '{ nope')
    expect(readOsSandboxSwitch(h)).toBe(false)
  })
  test('config-history as a file is no record', () => {
    const h = tmp()
    writeFileSync(folder(h), 'on\n')
    expect(lastKnownSwitch(h)).toBe(false)
  })
})

describe('writing the record', () => {
  test('a linked folder is never written through, and an on that could not be kept is reported', () => {
    const h = tmp()
    const real = join(tmp(), 'real')
    mkdirSync(real)
    symlinkSync(real, folder(h))
    writeFileSync(join(h, 'config.json'), '{"os_sandbox": true}')
    let failed = 0
    expect(readOsSandboxSwitch(h, undefined, undefined, () => failed++)).toBe(true)
    expect(failed).toBe(1)
    expect(existsSync(join(real, 'os-sandbox-last'))).toBe(false)
    expect(readlinkSync(folder(h))).toBe(real)
  })
  test('a file where the folder belongs is left alone and reported', () => {
    const h = tmp()
    writeFileSync(folder(h), 'mine')
    expect(rememberSwitch(h, true)).toBe('failed')
    expect(readFileSync(folder(h), 'utf8')).toBe('mine')
  })
  test('a pipe, a folder or a symlink in the record’s place is removed (that entry only) and a plain record written', () => {
    for (const make of [
      (p: string) => fifo(p),
      (p: string) => mkdirSync(join(p, 'inner'), { recursive: true }),
      (p: string) => symlinkSync(join(tmp(), 'target'), p),
    ]) {
      const h = tmp()
      mkdirSync(folder(h))
      writeFileSync(join(folder(h), 'sibling'), 'stays')
      const target = join(tmp(), 'kept')
      writeFileSync(target, 'untouched')
      make(rec(h))
      expect(rememberSwitch(h, true)).toBe('ok')
      expect(lstatSync(rec(h)).isFile()).toBe(true)
      expect(readFileSync(rec(h), 'utf8')).toBe('on\n')
      expect(readFileSync(join(folder(h), 'sibling'), 'utf8')).toBe('stays')
      expect(readFileSync(target, 'utf8')).toBe('untouched')
    }
  })
  test('a home that is not there is not made', () => {
    const gone = join(tmp(), 'never-made')
    expect(rememberSwitch(gone, true)).toBe('ok')
    expect(existsSync(gone)).toBe(false)
  })
})

describe('the bridge’s own good reading of config.json keeps the lock', () => {
  const setup = (os: boolean) => {
    const dir = tmp()
    const path = join(dir, 'config.json')
    writeFileSync(path, JSON.stringify({ ...defaults, os_sandbox: os }))
    return { dir, path }
  }
  test('load: switched on, then damaged before any start: still on', () => {
    const { dir, path } = setup(true)
    new ConfigFile(path).load()
    writeFileSync(path, '{ nope')
    expect(readOsSandboxSwitch(dir)).toBe(true)
  })
  test('write (the owner switching it on through the bridge): kept, and kept off again when switched off', () => {
    const { dir, path } = setup(false)
    const f = new ConfigFile(path)
    f.load()
    f.update((c) => ({ ...c, os_sandbox: true }))
    const written = readFileSync(path, 'utf8')
    writeFileSync(path, '{ nope')
    expect(readOsSandboxSwitch(dir)).toBe(true)
    writeFileSync(path, written)
    f.update((c) => ({ ...c, os_sandbox: false }))
    writeFileSync(path, '')
    expect(readOsSandboxSwitch(dir)).toBe(false)
  })
  test('reloadIfChanged: an edit that switches it on is kept', () => {
    const { dir, path } = setup(false)
    const f = new ConfigFile(path)
    f.load()
    writeFileSync(path, JSON.stringify({ ...defaults, os_sandbox: true, rev: 99 }))
    const later = new Date(Date.now() + 5000)
    utimesSync(path, later, later)
    expect(f.reloadIfChanged()).toBe(true)
    writeFileSync(path, '{ nope')
    expect(readOsSandboxSwitch(dir)).toBe(true)
  })
  test('an on that cannot be kept is said in the log', () => {
    const { dir, path } = setup(true)
    writeFileSync(folder(dir), 'in the way')
    const warned: string[] = []
    new ConfigFile(path, { log: { warn: (m: string) => warned.push(m) } as never }).load()
    expect(warned.some((m) => /extra lock/.test(m))).toBe(true)
  })
  test('a switch that was never on writes no record and makes no folder', () => {
    const { dir, path } = setup(false)
    new ConfigFile(path).load()
    expect(existsSync(folder(dir))).toBe(false)
  })
})

describe('an on that could not be kept is audited, on every path that reads the switch', () => {
  const broken = () => {
    const h = tmp()
    writeFileSync(join(h, 'config.json'), '{"os_sandbox": true}')
    writeFileSync(folder(h), 'in the way')
    return h
  }
  test('Main’s launch carries the fact, and the supervisor audits it', () => {
    const h = broken()
    const folderOf = tmp()
    const r = mainLaunchArgs(['--x'], h, { cwd: folderOf })
    expect(r.notRecorded).toBe(true)
    const audit: string[] = []
    mainArgsWithGuards(['--x'], h, folderOf, { audit: (e) => audit.push(e), tell: () => {} })
    expect(audit).toContain('os_sandbox_record_failed')
  })
  test('a thread start audits it too', () => {
    const said: string[] = []
    expect(osSandboxForStart(broken(), (e) => said.push(e))).toBe(true)
    expect(said).toEqual(['os_sandbox_record_failed'])
  })
})
