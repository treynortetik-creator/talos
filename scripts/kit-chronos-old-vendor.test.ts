// gate-reads: kit/* scripts/*
// kit/install.sh says the Chronos clone an older install made (~/.local/share/talos/chronos) "is no longer used". A kit with no
// apps/chronos beside it (inside an agent folder, or a plugin release) can be using exactly that clone, recorded in
// ~/.config/talos/chronos-dir: then it must not say so.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t as scaled } from '../packages/testkit/src/time-factor.ts'
import { BUNDLED, cfgPath, kitRun, macSandbox, recordPath } from './root-install-sched-harness.ts'

function withOldClone() {
  const sb = macSandbox()
  const vendor = join(sb.home, '.local', 'share', 'talos', 'chronos')
  mkdirSync(join(sb.home, '.local', 'share', 'talos'), { recursive: true })
  cpSync(BUNDLED, vendor, { recursive: true, filter: (p) => !p.includes('/tests') })
  mkdirSync(join(sb.home, '.config', 'talos'), { recursive: true })
  writeFileSync(recordPath(sb), `${vendor}\n`)
  mkdirSync(join(sb.home, '.config', 'chronos'), { recursive: true })
  writeFileSync(cfgPath(sb), `{"workspace": "${sb.agent}", "notify": ""}\n`)
  return { sb, vendor }
}
const NO_BUNDLED = { TALOS_CHRONOS_BUNDLED: '/nonexistent/clone/apps/chronos' }

describe('the older Chronos clone', () => {
  it(
    'is not called unused when it is the Chronos in use (a kit with no apps/chronos beside it, the record names the clone)',
    () => {
      const { sb, vendor } = withOldClone()
      expect(kitRun(sb, ['--agent-dir', sb.agent, '--no-chronos']).code).toBe(0)
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--add-to-existing', '--no-load'], NO_BUNDLED)
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`Chronos from this clone: ${vendor}`)
      expect(r.out).not.toContain('is no longer used')
    },
    scaled(300_000),
  )

  it(
    'is still called unused when the bundled Chronos is the one in use',
    () => {
      const { sb, vendor } = withOldClone()
      writeFileSync(recordPath(sb), `${BUNDLED}\n`)
      expect(kitRun(sb, ['--agent-dir', sb.agent, '--no-chronos']).code).toBe(0)
      const r = kitRun(sb, ['--agent-dir', sb.agent, '--add-to-existing', '--no-load'])
      expect(r.code, r.out).toBe(0)
      expect(r.out).toContain(`${vendor}, is no longer used`)
    },
    scaled(300_000),
  )
})
