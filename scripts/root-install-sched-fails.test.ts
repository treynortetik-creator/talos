// gate-reads: install.sh kit/* apps/chronos/* scripts/*
// A scheduler (Chronos) that cannot be added must never fail a NEW install: the agent is complete, one plain line says the
// scheduler was not added, a marker says why, and a rerun finishes it. One test per fault, driven through the root ./install.sh on
// a Mac made of stubs (root-install-sched-harness.ts): first run, the same run again with the fault still there (loud, nothing
// changed), the run with the fault gone (finishes), and one more (nothing to change).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import {
  cpFails,
  cpOk,
  expectAgentComplete,
  expectFinished,
  expectNotAdded,
  flagOff,
  flagOn,
  install,
  macSandbox,
  markerThere,
  pyFails,
  pyOk,
  type SB,
  snapshot,
  which,
} from './root-install-sched-harness.ts'

type Fault = {
  name: string
  reason: string
  logHas: RegExp
  extra?: string[]
  on: (sb: SB) => Record<string, string> | undefined
  off: (sb: SB) => void
  third?: boolean // the "nothing to change" run (a flag that asks for something every time cannot have one)
}
const FAULTS: Fault[] = [
  {
    name: 'Chronos missing from the clone',
    reason: 'missing',
    logHas: /no Chronos at/,
    on: (sb) => {
      mkdirSync(join(sb.root, 'noclone'))
      return { TALOS_CHRONOS_BUNDLED: join(sb.root, 'noclone') }
    },
    off: () => {},
  },
  {
    name: "Chronos's python missing",
    reason: 'python',
    logHas: /python3 not found/,
    on: () => ({ CHRONOS_PYTHON: '/nonexistent/python3' }),
    off: () => {},
  },
  {
    name: "Chronos's python older than 3.9",
    reason: 'python',
    logHas: /Python 3\.9 or newer/,
    on: (sb) => {
      const old = join(sb.root, 'python38.sh')
      writeFileSync(old, `#!/bin/sh\ncase " $* " in *version_info*) exit 1 ;; esac\nexec "${which('python3')}" "$@"\n`)
      chmodSync(old, 0o755)
      return { CHRONOS_PYTHON: old }
    },
    off: () => {},
  },
  {
    name: 'plutil refuses a plist',
    reason: 'plist',
    logHas: /plist step/,
    on: (sb) => {
      writeFileSync(join(sb.bin, 'plutil'), '#!/bin/sh\necho "plutil: injected failure" >&2\nexit 1\n')
      return undefined
    },
    off: (sb) => writeFileSync(join(sb.bin, 'plutil'), '#!/bin/sh\nexit 0\n'),
  },
  {
    name: 'launchctl refuses to load the tick',
    reason: 'launchctl',
    logHas: /Bootstrap failed/,
    on: (sb) => {
      flagOn(sb, 'fail-bootstrap-tick')
      return undefined
    },
    off: (sb) => flagOff(sb, 'fail-bootstrap-tick'),
  },
  {
    name: 'launchctl refuses to load the ui only (the tick, loaded before it, is unloaded again)',
    reason: 'launchctl',
    logHas: /Bootstrap failed/,
    on: (sb) => {
      flagOn(sb, 'fail-bootstrap-ui')
      return undefined
    },
    off: (sb) => flagOff(sb, 'fail-bootstrap-ui'),
  },
  {
    name: 'bootstrap says ok but launchctl print says the tick is not loaded',
    reason: 'not-loaded',
    logHas: /does not list it as loaded/,
    on: (sb) => {
      flagOn(sb, 'print-lies')
      return undefined
    },
    off: (sb) => flagOff(sb, 'print-lies'),
  },
  {
    name: 'registering the jobs fails',
    reason: 'jobs',
    logHas: /injected failure/,
    on: (sb) => {
      pyFails(sb, '*talos-jobs.py*register*')
      return undefined
    },
    off: pyOk,
  },
  {
    name: 'turning a zero-cost job on fails (what this run registered is taken out, so the rerun turns it on)',
    reason: 'jobs',
    logHas: /injected failure/,
    on: (sb) => {
      pyFails(sb, '*talos-jobs.py*enable*')
      return undefined
    },
    off: pyOk,
  },
  {
    name: 'registering the session hook fails',
    reason: 'hook',
    logHas: /injected failure/,
    on: (sb) => {
      pyFails(sb, '*talos-jobs.py*hook-add*')
      return undefined
    },
    off: pyOk,
  },
  {
    name: 'the delivery step fails',
    reason: 'delivery',
    logHas: /injected failure/,
    extra: ['--notify', 'macos'],
    third: false,
    on: (sb) => {
      cpFails(sb, '*notify/macos.sh*')
      return undefined
    },
    off: cpOk,
  },
]

describe('root install.sh: a scheduler that cannot be added never fails a new install', () => {
  for (const f of FAULTS)
    it(
      f.name,
      () => {
        const sb = macSandbox()
        const env = f.on(sb)
        const extra = f.extra ?? []
        const r1 = install(sb, ['--with-voice', ...extra], env)
        expect(r1.code, r1.out).toBe(0)
        expectAgentComplete(sb, r1.out)
        expectNotAdded(sb, f.reason, r1.out)
        expect(readFileSync(join(sb.home, '.config', 'talos', 'chronos-not-added.log'), 'utf8')).toMatch(f.logHas)
        // the same run again with the fault still there: loud, the marker stays, the agent is not touched
        const before = snapshot(sb.agent)
        const r2 = install(sb, extra, env)
        expect(r2.code, r2.out).not.toBe(0)
        expect(markerThere(sb), r2.out).toBe(true)
        expect(snapshot(sb.agent)).toEqual(before)
        // the fault gone: the run finishes the scheduler
        f.off(sb)
        const r3 = install(sb, extra)
        expect(r3.code, r3.out).toBe(0)
        expectFinished(sb, r3.out)
        expectAgentComplete(sb, r3.out)
        if (f.third !== false) {
          const r4 = install(sb, extra)
          expect(r4.code, r4.out).toBe(0)
          expect(r4.out).toContain('Nothing to change')
        }
      },
      scaled(400_000),
    )

  it(
    'a run killed with kill -9 in the middle of the Chronos installer is finished by the next run',
    () => {
      const sb = macSandbox()
      flagOn(sb, 'kill-on-bootstrap')
      const r1 = install(sb)
      expect(r1.code, r1.out).toBeNull() // killed by the signal
      // recognised as Talos's own and not finished: the marker first, then the record
      expect(JSON.parse(readFileSync(join(sb.home, '.config', 'talos', 'chronos-not-added.json'), 'utf8')).reason).toBe(
        'unfinished',
      )
      expect(readFileSync(join(sb.home, '.config', 'talos', 'chronos-dir'), 'utf8').trim()).toBe(
        join(__dirname, '..', 'apps', 'chronos'),
      )
      expect(existsSync(join(sb.home, '.config', 'chronos', 'config.json'))).toBe(true)
      // the next run (nothing wrong any more): it is finished, never called hand-made
      flagOff(sb, 'kill-on-bootstrap')
      // the agent folder was copied by the killed run; what the killed run did not reach, the rerun does
      const r2 = install(sb)
      expect(r2.code, r2.out).toBe(0)
      expect(r2.out).not.toMatch(/set up by hand/)
      expectFinished(sb, r2.out, false)
      expectAgentComplete(sb, r2.out, false)
    },
    scaled(400_000),
  )
})
