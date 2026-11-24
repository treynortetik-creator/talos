// gate-reads: install.sh kit/* apps/chronos/* scripts/*
// The marker (~/.config/talos/chronos-not-added.json) counts as PRESENT when anything is at its path: a bad or empty file, a file
// nobody can read, a folder, a link, a dangling link. A write never follows a link and leaves no temp file; a marker that cannot be
// removed is said in one line and never turns "not added" into "installed".
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import {
  expectFinished,
  expectNotAdded,
  flagOff,
  flagOn,
  install,
  KIT,
  macSandbox,
  markerPath,
  markerThere,
  type SB,
  stateDir,
} from './root-install-sched-harness.ts'

// a first run that could not add the scheduler, so the marker is there and the agent exists
function failedFirstRun(sb: SB) {
  flagOn(sb, 'fail-bootstrap-all')
  const r = install(sb)
  expect(r.code, r.out).toBe(0)
  expectNotAdded(sb, 'launchctl', r.out)
}
const VARIANTS: [string, (sb: SB) => void][] = [
  ['garbage JSON', (sb) => writeFileSync(markerPath(sb), '{"v":1,"reason":')],
  ['an empty file', (sb) => writeFileSync(markerPath(sb), '')],
  [
    'a file nobody can read (mode 000)',
    (sb) => {
      writeFileSync(markerPath(sb), '{}')
      chmodSync(markerPath(sb), 0)
    },
  ],
  ['an empty folder', (sb) => mkdirSync(markerPath(sb))],
  ['a dangling link', (sb) => symlinkSync(join(sb.root, 'nowhere'), markerPath(sb))],
]

describe('the marker counts as present whatever is at its path', () => {
  for (const [name, damage] of VARIANTS)
    it(
      `${name}: the closing line says not added, and the next run finishes the scheduler`,
      () => {
        const sb = macSandbox()
        failedFirstRun(sb)
        rmMarker(sb)
        damage(sb)
        expect(markerThere(sb)).toBe(true)
        flagOff(sb, 'fail-bootstrap-all')
        const r = install(sb)
        expect(r.code, r.out).toBe(0)
        expectFinished(sb, r.out)
      },
      scaled(300_000),
    )

  it(
    'a marker that cannot be removed: one plain line, the install carries on, and nothing says "installed"',
    () => {
      const sb = macSandbox()
      failedFirstRun(sb)
      rmMarker(sb)
      mkdirSync(markerPath(sb))
      writeFileSync(join(markerPath(sb), 'keep'), 'x') // a folder with something in it: it cannot be replaced or removed
      flagOff(sb, 'fail-bootstrap-all')
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toMatch(/could not remove .*chronos-not-added\.json/)
      expect(r.out).not.toMatch(/Chronos: +installed/)
      expect(r.out).toMatch(/Chronos: +not added/)
    },
    scaled(300_000),
  )

  it(
    'a link at the marker path is replaced, never written through',
    () => {
      const sb = macSandbox()
      mkdirSync(stateDir(sb), { recursive: true })
      const victim = join(sb.root, 'victim.txt')
      const victimDir = join(sb.root, 'victim-dir')
      mkdirSync(victimDir)
      writeFileSync(victim, 'mine')
      symlinkSync(victim, markerPath(sb))
      flagOn(sb, 'fail-bootstrap-all')
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(victim, 'utf8')).toBe('mine')
      expectNotAdded(sb, 'launchctl', r.out)
      // a link to a folder: the marker is a file beside it, the folder stays empty
      const sb2 = macSandbox()
      mkdirSync(stateDir(sb2), { recursive: true })
      const d2 = join(sb2.root, 'folder')
      mkdirSync(d2)
      symlinkSync(d2, markerPath(sb2))
      flagOn(sb2, 'fail-bootstrap-all')
      const r2 = install(sb2)
      expect(r2.code, r2.out).toBe(0)
      expect(readdirSync(d2)).toEqual([])
      expectNotAdded(sb2, 'launchctl', r2.out)
    },
    scaled(300_000),
  )

  it('a marker that cannot be written says so in one line, returns 0 and leaves no temp file', () => {
    const sb = macSandbox()
    writeFileSync(join(sb.root, 'afile'), '') // a regular file where the folder would be
    const script = `. "${join(KIT, 'scripts', 'install-chronos-marker.sh')}"; say() { printf '%s\\n' "$*"; }; chronos_marker_write python; echo "rc=$?"`
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { PATH: sb.bin, HOME: sb.home, XDG_CONFIG_HOME: join(sb.root, 'afile') },
    })
    expect(r.stdout).toMatch(/could not record that the scheduler is not added/)
    expect(r.stdout).toContain('rc=0')
    expect(readdirSync(sb.root).filter((n) => n.includes('chronos-not-added'))).toEqual([])
  })
})

function rmMarker(sb: SB) {
  spawnSync('rm', ['-rf', markerPath(sb)])
  expect(existsSync(markerPath(sb))).toBe(false)
}
