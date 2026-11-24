// The extra lock's check runs again right before the session starts, and Talos writes its protected files as a new file each time
// (so a hard link made earlier goes stale at the next write). Temp folders only; a link made between the first check and the
// start is made by the test itself (the launch hands back the re-check; nothing here races a clock).
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExampleConfig } from '@talos-app/testkit'
import { writeFileAtomic } from '../src/fsutil.ts'
import { withGuardsSettings } from '../src/guards/install.ts'
import { mainLaunchArgs } from '../src/guards/main-launch.ts'
import { osSandboxPreflight, osSandboxRecheck, osSandboxSettings } from '../src/guards/os-sandbox.ts'
import { mainArgsWithGuards } from '../src/supervisor/worker-policy.ts'
import { recordedWrite } from '../src/tripwire.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (prefix = 'ttoc-') => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
  dirs.push(d)
  return d
}
function makeHome(on: boolean) {
  const home = tmp('ttoc-home-')
  const cfg = { ...loadExampleConfig('default'), ...(on ? { os_sandbox: true } : {}) }
  writeFileSync(join(home, 'config.json'), JSON.stringify(cfg), { mode: 0o600 })
  writeFileSync(join(home, 'devices.json'), '{}', { mode: 0o600 })
  return home
}
/** The second name a later, unsandboxed process makes for a protected file. */
const addLink = (home: string, name = 'devices.json') => linkSync(join(home, name), join(tmp('ttoc-else-'), 'extra'))

describe('the re-check at the last moment', () => {
  test('osSandboxRecheck: clear while every protected file has one name, the preflight line once one has two', () => {
    const home = makeHome(true)
    const recheck = osSandboxRecheck(home)
    expect(recheck()).toBeNull()
    addLink(home)
    const line = recheck()
    expect(line).toContain('devices.json')
    expect(line).toBe(osSandboxPreflight(home) as string)
  })

  test('Main: a link made after the launch args are built and before the start is refused with the same line', () => {
    const home = makeHome(true)
    const r = mainLaunchArgs(['--x'], home, { cwd: tmp('ttoc-folder-') })
    expect(r.refusal).toBeUndefined()
    expect(r.recheck).toBeDefined()
    expect(r.recheck?.()).toBeNull()
    addLink(home, 'config.json')
    expect(r.recheck?.()).toContain('has another name')
    expect(mainLaunchArgs(['--x'], home, { cwd: tmp('ttoc-folder-') }).refusal).toBe(r.recheck?.() as string)
  })

  test('Main: no re-check when the switch is off, or when the owner’s own --settings means no sandbox is applied', () => {
    expect(mainLaunchArgs(['--x'], makeHome(false), { cwd: tmp('ttoc-folder-') }).recheck).toBeUndefined()
    expect(
      mainLaunchArgs(['--settings', 'mine.json'], makeHome(true), { cwd: tmp('ttoc-folder-') }).recheck,
    ).toBeUndefined()
  })

  test('the supervisor’s and the CLI’s Main arguments hand the re-check on', () => {
    const home = makeHome(true)
    const folder = tmp('ttoc-folder-')
    const a = mainArgsWithGuards(['--x'], home, folder)
    const b = withGuardsSettings(['--x'], home, folder)
    addLink(home)
    expect(a.start.beforeStart?.()).toContain('has another name')
    expect(b.recheck?.()).toContain('has another name')
    expect(mainArgsWithGuards(['--x'], makeHome(false), folder).start).toEqual({})
  })
})

describe('a protected file is written as a new file each time', () => {
  test('writeFileAtomic: an older link keeps the old content and the old inode; the new file keeps its mode', () => {
    const home = tmp('ttoc-w-')
    const path = join(home, 'devices.json')
    writeFileSync(path, 'old', { mode: 0o600 })
    const other = join(tmp('ttoc-else-'), 'link')
    linkSync(path, other)
    const before = statSync(path).ino
    writeFileAtomic(path, 'new', 0o600)
    expect(readFileSync(other, 'utf8')).toBe('old')
    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).ino).not.toBe(before)
    expect(statSync(path).nlink).toBe(1)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('writeFileAtomic over a symlink replaces the link; the file it pointed at is untouched', () => {
    const home = tmp('ttoc-w-')
    const target = join(tmp('ttoc-else-'), 'target')
    writeFileSync(target, 'theirs')
    const path = join(home, 'devices.json')
    symlinkSync(target, path)
    writeFileAtomic(path, 'new', 0o600)
    expect(readFileSync(target, 'utf8')).toBe('theirs')
    expect(statSync(path).isFile()).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('new')
  })

  test('the tripwire’s writing marker (tripwire.writing): written as a new file, an older link goes stale', () => {
    const home = tmp('ttoc-trip-')
    const marker = join(home, 'tripwire.writing')
    writeFileSync(marker, 'old', { mode: 0o600 })
    const other = join(tmp('ttoc-else-'), 'link')
    linkSync(marker, other)
    const before = statSync(marker).ino
    let during: { content: string; ino: number; mode: number } | null = null
    recordedWrite(join(home, 'config.json'), 'config', () => {
      const st = statSync(marker)
      during = { content: readFileSync(marker, 'utf8'), ino: st.ino, mode: st.mode & 0o777 }
    })
    const seen = during as unknown as { content: string; ino: number; mode: number }
    expect(seen.content).not.toBe('old')
    expect(seen.ino).not.toBe(before)
    expect(seen.mode).toBe(0o600)
    expect(readFileSync(other, 'utf8')).toBe('old')
  })

  test('the tripwire’s marker is 0600 even where an older one was looser', () => {
    const home = tmp('ttoc-trip-')
    const marker = join(home, 'tripwire.writing')
    writeFileSync(marker, 'old')
    chmodSync(marker, 0o644)
    let mode = 0
    recordedWrite(join(home, 'config.json'), 'config', () => {
      mode = statSync(marker).mode & 0o777
    })
    expect(mode).toBe(0o600)
  })
})

describe('every path the settings emit is a real path (a symlinked parent of the home and the folder, as /tmp is on a Mac)', () => {
  /** Every string in `v`, anywhere. */
  const strings = (v: unknown): string[] =>
    typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
  /** `p` as the disk spells it: its deepest existing folder resolved, the rest as given. */
  const real = (p: string): string => {
    const rest: string[] = []
    let d = p
    for (;;) {
      try {
        return join(realpathSync(d), ...rest.reverse())
      } catch {
        rest.push(d.slice(d.lastIndexOf('/') + 1))
        d = d.slice(0, d.lastIndexOf('/')) || '/'
      }
    }
  }
  const was = process.env.TMPDIR
  afterEach(() => {
    if (was === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = was
  })

  test('denyWrite, denyRead, the folder entries, cache env, git config and the excludes path', () => {
    const base = tmp('ttoc-real-')
    const link = join(base, 'via')
    symlinkSync(base, link) // the symlinked parent of everything below
    const homeReal = join(base, 'home')
    const folderReal = join(base, 'folder')
    const tmpReal = join(base, 'tmpdir')
    for (const d of [homeReal, folderReal, tmpReal, join(folderReal, '.claude')]) mkdirSync(d)
    writeFileSync(join(homeReal, 'devices.json'), '{}')
    mkdirSync(join(base, 'user'))
    process.env.TMPDIR = `${link}/tmpdir`
    const p = osSandboxSettings({
      talosHome: `${link}/home`,
      userHome: `${link}/user`,
      folder: `${link}/folder`,
      platform: 'linux',
    })
    const all = strings(p).filter((x) => x.startsWith('/'))
    expect(all.length).toBeGreaterThan(30)
    for (const x of all) expect(x, x).toBe(real(x))
  })
})
