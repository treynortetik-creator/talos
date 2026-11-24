// gate-reads: kit/* scripts/*
// A record that equals the bundled Chronos path when that folder is ABSENT does not make the Chronos on this Mac Talos's own: there
// is nothing at that path to have been set up. The kit leaves an existing Chronos alone (as for any record it cannot vouch for)
// instead of going on to a folder that is not there.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { cfgPath, kitRun, macSandbox, markerThere, recordPath } from './root-install-sched-harness.ts'

describe('a record equal to an absent bundled path', () => {
  it(
    "is not Talos's own: the existing Chronos is left alone, config and record untouched, no marker",
    () => {
      const sb = macSandbox()
      const absent = '/nonexistent/clone/apps/chronos'
      expect(kitRun(sb, ['--agent-dir', sb.agent, '--no-chronos']).code).toBe(0)
      mkdirSync(join(sb.home, '.config', 'talos'), { recursive: true })
      writeFileSync(recordPath(sb), `${absent}\n`)
      mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
      const mine = '{"workspace": "/home/alex/mine", "notify": ""}\n'
      writeFileSync(cfgPath(sb), mine)
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--add-to-existing'], { TALOS_CHRONOS_BUNDLED: absent })
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain('left alone')
      expect(readFileSync(cfgPath(sb), 'utf8')).toBe(mine)
      expect(readFileSync(recordPath(sb), 'utf8')).toBe(`${absent}\n`)
      expect(markerThere(sb)).toBe(false)
    },
    scaled(300_000),
  )
})
