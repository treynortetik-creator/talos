// gate-reads: install.sh kit/* apps/chronos/* scripts/*
// What stays loud when the scheduler fails, and what must not matter: an explicit ask exits with Chronos's own code; a Chronos made
// by hand is left alone (no marker, no record); a real copy failure is still a partial copy; a broken bun or node is not Chronos's
// problem. Driven on the Mac of stubs in root-install-sched-harness.ts.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import {
  BUNDLED,
  cfgPath,
  expectAgentComplete,
  flagOn,
  install,
  kitRun,
  lcCalls,
  loaded,
  macSandbox,
  markerPath,
  markerThere,
  put,
  recordPath,
  snapshot,
  which,
} from './root-install-sched-harness.ts'

describe('a scheduler fault: explicit asks stay loud', () => {
  it(
    "--reinstall-chronos on a new install: Chronos's own exit code, the previous record is back, no marker is left",
    () => {
      const sb = macSandbox()
      flagOn(sb, 'fail-bootstrap-tick')
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--reinstall-chronos'])
      expect(r.code, r.out).toBe(14)
      expect(r.out).toContain("Chronos's installer failed (exit 14)")
      expect(existsSync(recordPath(sb))).toBe(false)
      expect(markerThere(sb)).toBe(false)
      expect(loaded(sb)).toEqual([])
      // the root installer says what it always said for a failed kit: it is not turned into success
      const sb2 = macSandbox()
      flagOn(sb2, 'fail-bootstrap-tick')
      const r2 = install(sb2, ['--reinstall-chronos'])
      expect(r2.code, r2.out).not.toBe(0)
    },
    scaled(300_000),
  )

  it(
    "--chronos-path DIR with Chronos's python missing: exit 10, and the record that was there is restored",
    () => {
      const sb = macSandbox()
      mkdirSync(join(sb.home, '.config', 'talos'), { recursive: true })
      writeFileSync(recordPath(sb), '/elsewhere/chronos\n')
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--chronos-path', BUNDLED], {
        CHRONOS_PYTHON: '/nonexistent/python3',
      })
      expect(r.code, r.out).toBe(10)
      expect(readFileSync(recordPath(sb), 'utf8')).toBe('/elsewhere/chronos\n')
      expect(markerThere(sb)).toBe(false)
    },
    scaled(300_000),
  )

  it(
    "--add-to-existing (the run that adds Chronos later) is loud with Chronos's code, and the marker says why",
    () => {
      const sb = macSandbox()
      const first = install(sb, ['--no-chronos'])
      expect(first.code, first.out).toBe(0)
      flagOn(sb, 'fail-bootstrap-all')
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--add-to-existing'])
      expect(r.code, r.out).toBe(14)
      expect(JSON.parse(readFileSync(markerPath(sb), 'utf8')).reason).toBe('launchctl')
      expect(loaded(sb)).toEqual([])
    },
    scaled(300_000),
  )

  it(
    'a bad flag combination is still exit 2, and a dry run with a fault writes nothing',
    () => {
      const sb = macSandbox()
      flagOn(sb, 'fail-bootstrap-all')
      expect(kitRun(sb, ['--agent-dir', sb.agent, '--notify', 'bogus']).code).toBe(2)
      const before = snapshot(sb.home)
      const dry = install(sb, ['--dry-run'])
      expect(dry.code, dry.out).toBe(0)
      expect(snapshot(sb.home)).toEqual(before)
      expect(markerThere(sb)).toBe(false)
      expect(lcCalls(sb)).toBe('')
    },
    scaled(300_000),
  )
})

describe('a scheduler fault: what must stay as it is', () => {
  it(
    'a Chronos made by hand is left alone: config untouched, no marker, no record, launchctl never called',
    () => {
      const sb = macSandbox()
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      const mine = '{"workspace": "/home/alex/mine", "notify": ""}\n'
      writeFileSync(cfgPath(sb), mine)
      flagOn(sb, 'fail-bootstrap-all') // would fail if anything tried to load
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(cfgPath(sb), 'utf8')).toBe(mine)
      expect(markerThere(sb)).toBe(false)
      expect(existsSync(recordPath(sb))).toBe(false)
      expect(lcCalls(sb)).toBe('')
      expect(r.out).toMatch(/Chronos: +left alone/)
    },
    scaled(300_000),
  )

  it(
    'a real copy failure (a killed tar) still says partial copy',
    () => {
      const sb = macSandbox()
      writeFileSync(join(sb.root, 'fail-tar'), '')
      const r = install(sb)
      expect(r.code, r.out).toBe(1)
      expect(r.out).toContain('partial copy')
    },
    scaled(300_000),
  )

  it(
    'a bun that fails the MCP server step fails the install there, not in Chronos; with bun fixed the next run finishes',
    () => {
      const sb = macSandbox()
      const bun = which('bun') as string
      // answers --version and a one-line script (the pre-flight asks both) and runs nothing else: the talos-app server cannot start
      put(sb, 'bun', `case "$*" in *--version*|*talos-bun-ok*) exec "${bun}" "$@" ;; esac\nexit 1`)
      const r1 = install(sb)
      expect(r1.code, r1.out).not.toBe(0)
      expect(r1.out).toMatch(/5\/7/)
      // Chronos itself was not affected: loaded, no marker
      expect(loaded(sb)).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
      expect(markerThere(sb)).toBe(false)
      rmSync(join(sb.bin, 'bun'))
      symlinkSync(bun, join(sb.bin, 'bun'))
      const r2 = install(sb)
      expect(r2.code, r2.out).toBe(0)
      expectAgentComplete(sb, r2.out, false)
    },
    scaled(400_000),
  )

  it(
    "a broken bun or node does not matter to Chronos's own installer",
    () => {
      const sb = macSandbox()
      for (const t of ['bun', 'node']) put(sb, t, 'exit 1')
      const c = spawnSync('bash', [join(BUNDLED, 'install.sh'), '--no-load', '--quiet'], {
        encoding: 'utf8',
        env: { PATH: sb.bin, HOME: sb.home, CHRONOS_TEST_MODE: '1' },
      })
      expect(c.status, `${c.stdout}${c.stderr}`).toBe(0)
      expect(existsSync(cfgPath(sb))).toBe(true)
    },
    scaled(300_000),
  )
})
