// gate-reads: install.sh kit/* apps/chronos/* scripts/*
// The review's reproductions (~/cf-out/review.md) for the scheduler work, driven through the root ./install.sh on the Mac of stubs:
// B1 state that cannot be written never fails a new install after the scheduler was refused; B3 a Chronos that was working before a
// run is never unloaded by that run's failure; S1 a failed move keeps the previous record, so the next run repoints the hook; S2 a
// Chronos made by hand after a run that stopped before its Chronos was in place is left alone, while one Talos kept is finished.
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import {
  BUNDLED,
  cfgPath,
  expectAgentComplete,
  expectFinished,
  flagOff,
  flagOn,
  install,
  jobsOf,
  lcCalls,
  loaded,
  macSandbox,
  markerThere,
  plist,
  pyFails,
  recordPath,
  type SB,
} from './root-install-sched-harness.ts'

const talos = (sb: SB) => join(sb.home, '.config', 'talos')
const settings = (sb: SB) => readFileSync(join(sb.agent, '.claude', 'settings.json'), 'utf8')

describe('B1: state that cannot be written never fails a new install after the scheduler was refused', () => {
  const cases: [string, (sb: SB) => void][] = [
    [
      '~/.config cannot be written (mode 555)',
      (sb) => {
        mkdirSync(join(sb.home, '.config'))
        chmodSync(join(sb.home, '.config'), 0o555)
      },
    ],
    [
      'the state folder is a file, so nothing can be made in it',
      (sb) => {
        mkdirSync(join(sb.home, '.config'))
        writeFileSync(talos(sb), 'a file where the folder goes')
      },
    ],
    [
      "the kit's record (chronos-dir) is a folder",
      (sb) => {
        mkdirSync(join(talos(sb), 'chronos-dir'), { recursive: true })
        writeFileSync(join(talos(sb), 'chronos-dir', 'x'), '')
      },
    ],
    [
      'the log is a folder',
      (sb) => {
        mkdirSync(join(talos(sb), 'chronos-not-added.log'), { recursive: true })
        writeFileSync(join(talos(sb), 'chronos-not-added.log', 'x'), '')
      },
    ],
  ]
  for (const [name, setup] of cases)
    it(
      `${name}: exit 0, the agent complete`,
      () => {
        const sb = macSandbox()
        setup(sb)
        pyFails(sb, '*talos-jobs.py*register*') // a scheduler step that fails, so the soft path runs
        const r = install(sb)
        expect(r.code, r.out).toBe(0)
        expectAgentComplete(sb, r.out, false)
        expect(r.out).not.toMatch(/partial copy/)
      },
      scaled(400_000),
    )

  it(
    'the record of a Chronos that loaded cannot be written: still exit 0 (no scheduler fault at all)',
    () => {
      const sb = macSandbox()
      mkdirSync(join(talos(sb), 'chronos-dir'), { recursive: true })
      writeFileSync(join(talos(sb), 'chronos-dir', 'x'), '')
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expectAgentComplete(sb, r.out, false)
    },
    scaled(400_000),
  )
})

/** A second Talos clone: a folder with a kit/install.sh and a full copy of Chronos, so a record naming it is Talos's own. */
function otherClone(sb: SB) {
  const other = join(sb.root, 'other-clone')
  mkdirSync(join(other, 'kit'), { recursive: true })
  writeFileSync(join(other, 'kit', 'install.sh'), '')
  cpSync(BUNDLED, join(other, 'apps', 'chronos'), { recursive: true, filter: (p) => !p.includes('/tests') })
  return join(other, 'apps', 'chronos')
}

describe('B3: a Chronos that worked before this run is not unloaded by its failure', () => {
  it(
    'agent 1 healthy and loaded; a new agent whose hook cannot be registered: the scheduler stays loaded, plists byte-identical',
    () => {
      const sb = macSandbox()
      const first = install(sb)
      expect(first.code, first.out).toBe(0)
      expectFinished(sb, first.out, false)
      // the record names another Talos clone's Chronos (an older checkout of the same product): the second agent's run moves it here
      writeFileSync(recordPath(sb), `${otherClone(sb)}\n`)
      const before = ['tick', 'ui'].map((l) => readFileSync(plist(sb, l), 'utf8'))
      pyFails(sb, '*talos-jobs.py*hook-add*')
      const sb2 = { ...sb, agent: join(sb.home, 'talos-agent-2') }
      const r = install(sb2)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toMatch(/was not added/)
      expect(loaded(sb)).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
      expect(['tick', 'ui'].map((l) => readFileSync(plist(sb, l), 'utf8'))).toEqual(before)
    },
    scaled(500_000),
  )
})

describe('S1: a failed move keeps the previous record, so the next run repoints the session hook', () => {
  it(
    'move fails (launchctl), the rerun finishes, and the hook names this clone, not the old one',
    () => {
      const sb = macSandbox()
      expect(install(sb).code).toBe(0)
      const old = otherClone(sb)
      writeFileSync(recordPath(sb), `${old}\n`)
      const hookOf = (dir: string) => join(dir, 'hooks', 'chronos-session-start.py')
      // the agent's hook as an install from the old clone left it
      writeFileSync(join(sb.agent, '.claude', 'settings.json'), settings(sb).split(hookOf(BUNDLED)).join(hookOf(old)))
      flagOn(sb, 'fail-bootstrap-all')
      const failed = install(sb)
      expect(failed.code, failed.out).not.toBe(0)
      expect(readFileSync(recordPath(sb), 'utf8').trim()).toBe(old) // the previous record survives the failed move
      flagOff(sb, 'fail-bootstrap-all')
      const fixed = install(sb)
      expect(fixed.code, fixed.out).toBe(0)
      expect(settings(sb)).toContain(hookOf(BUNDLED))
      expect(settings(sb)).not.toContain(hookOf(old))
      expect(readFileSync(recordPath(sb), 'utf8').trim()).toBe(BUNDLED)
    },
    scaled(500_000),
  )
})
describe('S2: a Chronos made by hand after a run that stopped before its own was in place', () => {
  it(
    'is left alone (the config workspace is a folder that is not this agent and not stamped)',
    () => {
      const sb = macSandbox()
      // first run: Chronos's python is missing, so the run stops before config.json exists
      const first = install(sb, [], { CHRONOS_PYTHON: '/nonexistent/python3' })
      expect(first.code, first.out).toBe(0)
      expect(markerThere(sb)).toBe(true)
      // then the owner makes a Chronos by hand (a workspace of their own, a job of their own)
      const mine = join(sb.root, 'my-workspace')
      mkdirSync(mine)
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      const cfg = `{"workspace": "${mine}", "notify": ""}\n`
      writeFileSync(cfgPath(sb), cfg)
      writeFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), '[{"id": "mine", "enabled": true}]\n')
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expect(readFileSync(cfgPath(sb), 'utf8')).toBe(cfg)
      expect(jobsOf(sb).map((j) => j.id)).toEqual(['mine'])
      expect(loaded(sb)).toEqual([])
      expect(lcCalls(sb)).not.toMatch(/bootstrap/)
      expect(r.out).toMatch(/Chronos: +left alone/)
    },
    scaled(500_000),
  )

  it(
    'an agent folder that Talos kept (stamped) as the workspace is still finished: ours, the same workspace',
    () => {
      const sb = macSandbox()
      const first = install(sb, [], { CHRONOS_PYTHON: '/nonexistent/python3' })
      expect(first.code, first.out).toBe(0)
      expect(markerThere(sb)).toBe(true)
      // a config of Chronos's own making, whose workspace is another agent folder that Talos stamped
      const kept = join(sb.root, 'kept-agent')
      mkdirSync(kept)
      writeFileSync(join(kept, '.talos-version'), 'version=1\n')
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      writeFileSync(cfgPath(sb), `{"workspace": "${kept}", "notify": ""}\n`)
      const r = install(sb)
      expect(r.code, r.out).toBe(0)
      expect(markerThere(sb)).toBe(false)
      expect(loaded(sb)).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
      // and the plain case: the workspace is this very agent folder
      const sb2 = macSandbox()
      expect(install(sb2, [], { CHRONOS_PYTHON: '/nonexistent/python3' }).code).toBe(0)
      mkdirSync(join(sb2.home, '.config', 'chronos'), { recursive: true })
      writeFileSync(cfgPath(sb2), `{"workspace": "${sb2.agent}", "notify": ""}\n`)
      const r2 = install(sb2)
      expect(r2.code, r2.out).toBe(0)
      expect(markerThere(sb2)).toBe(false)
    },
    scaled(500_000),
  )
})

describe('F1: a Chronos that Talos finished once is never taken for hand-made', () => {
  it(
    'a takeover (--reinstall-chronos) over a hand-made Chronos finishes; a later move that fails once, then the plain rerun, finish too',
    () => {
      const sb = macSandbox()
      // a Chronos made by hand: the owner's workspace (not stamped), the owner's own job
      const mine = join(sb.root, 'my-workspace')
      mkdirSync(mine)
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      writeFileSync(cfgPath(sb), `{"workspace": "${mine}", "notify": ""}\n`)
      const owner = [{ id: 'mine', enabled: true, time: '09:00' }]
      writeFileSync(join(sb.home, '.config', 'chronos', 'jobs.json'), JSON.stringify(owner))
      const takeover = install(sb, ['--reinstall-chronos'])
      expect(takeover.code, takeover.out).toBe(0)
      expect(markerThere(sb)).toBe(false)
      expect(jobsOf(sb).some((j) => j.id.startsWith('talos-'))).toBe(true)
      // a newer clone: the move fails once (launchctl refuses) and writes the marker
      writeFileSync(recordPath(sb), `${otherClone(sb)}\n`)
      flagOn(sb, 'fail-bootstrap-all')
      const failed = install(sb)
      expect(failed.code, failed.out).not.toBe(0)
      expect(markerThere(sb)).toBe(true)
      // the fault gone: the plain rerun finishes it, it is not "left alone", and the owner's own job is untouched
      flagOff(sb, 'fail-bootstrap-all')
      const fixed = install(sb)
      expect(fixed.code, fixed.out).toBe(0)
      expect(fixed.out).not.toMatch(/left alone/)
      expect(markerThere(sb)).toBe(false)
      expect(loaded(sb)).toEqual(['io.github.chronos.tick', 'io.github.chronos.ui'])
      expect(jobsOf(sb).find((j) => j.id === 'mine')).toEqual(owner[0])
      expect(readFileSync(recordPath(sb), 'utf8').trim()).toBe(BUNDLED)
    },
    scaled(600_000),
  )
})
