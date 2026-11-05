// A CI slot binds its own Playwright port for the web specs; a run by hand on that port makes the slot's browser job fail
// (a builder ran PW_PORT=4873, slot 1's port). apps/web/playwright.config.ts refuses those ports unless ci-local.sh marked the run.
// The slot ports come from ci-local.sh itself, so the first test reads them from there.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ciSlotPorts, webPreviewPort } from '../apps/web/test/helpers/pw-port'
import { cleanEnv } from './ci-test-env'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'ci-local.sh')
const web = join(here, '..', 'apps', 'web')

function slotPortsFromScript(n: number, extra: Record<string, string> = {}): number[] {
  const code = `. "${script}"\nfor i in $(seq 1 ${n}); do ci_slot_env $i; echo $SLOT_PW_PORT; done`
  const r = spawnSync('bash', ['-c', code], { env: { ...cleanEnv(), ...extra }, encoding: 'utf8' })
  return r.stdout.trim().split('\n').map(Number)
}

describe('the web specs refuse a CI slot port outside a slot run', () => {
  it('knows every port ci-local.sh gives a slot, with room for more slots than the default', () => {
    const fromScript = slotPortsFromScript(6)
    expect(fromScript).toEqual([4873, 4883, 4893, 4903, 4913, 4923])
    expect(ciSlotPorts({})).toEqual(fromScript)
    expect(ciSlotPorts({ CI_SLOTS: '8' })).toEqual(slotPortsFromScript(8, { CI_SLOTS: '8' }))
    // TALOS_CI_PW_PORT moves the base in both places
    expect(ciSlotPorts({ TALOS_CI_PW_PORT: '5000' }).slice(0, 3)).toEqual(
      slotPortsFromScript(3, { TALOS_CI_PW_PORT: '5000' }),
    )
  })

  it('refuses each slot port in a plain run, and names the port and the way out', () => {
    for (const p of ciSlotPorts({})) {
      expect(() => webPreviewPort({ PW_PORT: String(p) })).toThrow(
        new RegExp(`PW_PORT=${p} .*CI slots.*TALOS_CI_SLOT_RUN`),
      )
    }
    expect(() => webPreviewPort({ PW_PORT: '5010', TALOS_CI_PW_PORT: '5000' })).toThrow(/PW_PORT=5010/)
  })

  it('allows the default, other ports, and any port in a slot run', () => {
    expect(webPreviewPort({})).toBe(4173)
    expect(webPreviewPort({ PW_PORT: '46010' })).toBe(46010)
    expect(webPreviewPort({ PW_PORT: '4874' })).toBe(4874) // between two slot ports: nobody binds it
    expect(webPreviewPort({ PW_PORT: '4873', TALOS_CI_PW_PORT: '5000' })).toBe(4873) // the base moved away from it
    for (const p of ciSlotPorts({})) expect(webPreviewPort({ PW_PORT: String(p), TALOS_CI_SLOT_RUN: '1' })).toBe(p)
  })

  // The real config, loaded by Playwright itself. `--list` loads the config and the specs and binds nothing.
  const list = (env: Record<string, string>) => {
    const e = cleanEnv()
    delete e.PW_PORT
    delete e.TALOS_CI_SLOT_RUN
    delete e.TALOS_CI_PW_PORT
    delete e.CI_SLOTS
    return spawnSync('pnpm', ['exec', 'playwright', 'test', '--list', '--project=desktop'], {
      cwd: web,
      env: { ...e, ...env },
      encoding: 'utf8',
    })
  }
  it('playwright.config.ts: a plain run on slot 1’s port stops at load; the same port in a marked run, and other ports, load', () => {
    const plain = list({ PW_PORT: '4873' })
    expect(plain.status).not.toBe(0)
    expect(`${plain.stdout}${plain.stderr}`).toContain('PW_PORT=4873 is one of the ports the CI slots use')
    for (const env of [{ PW_PORT: '4873', TALOS_CI_SLOT_RUN: '1' }, { PW_PORT: '46123' }, {}]) {
      const ok = list(env)
      expect(ok.status, `${JSON.stringify(env)}: ${ok.stdout}${ok.stderr}`).toBe(0)
    }
  }, 120_000)
})
