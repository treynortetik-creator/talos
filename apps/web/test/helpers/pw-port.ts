// The port the web specs' preview server takes (apps/web/playwright.config.ts). A CI slot binds its own fixed port, so a run by hand
// must not pick one: it would hold the port when the slot's browser job starts, and that job fails. The slot ports and the marker
// come from scripts/ci-local.sh (the three CI_PW_PORT_* lines and the exported TALOS_CI_SLOT_RUN), read here, not copied.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_PORT = 4173
const CI_SCRIPT = fileURLToPath(new URL('../../../../scripts/ci-local.sh', import.meta.url))

function fromScript(name: string): number {
  const m = readFileSync(CI_SCRIPT, 'utf8').match(new RegExp(`^${name}=(\\d+)$`, 'm'))
  if (!m) throw new Error(`scripts/ci-local.sh has no ${name}= line; apps/web/test/helpers/pw-port.ts reads it`)
  return Number(m[1])
}

/** Every port a CI slot may bind for the web specs: the base (TALOS_CI_PW_PORT moves it) plus the step, for as many slots as the
 *  runners are sized for, or CI_SLOTS if that is more. */
export function ciSlotPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const base = Number(env.TALOS_CI_PW_PORT) || fromScript('CI_PW_PORT_BASE')
  const slots = Math.max(fromScript('CI_PW_PORT_SLOTS'), Number(env.CI_SLOTS) || 0)
  return Array.from({ length: slots }, (_, i) => base + i * fromScript('CI_PW_PORT_STEP'))
}

/** PW_PORT, or 4173. Throws for a CI slot port unless ci-local.sh set TALOS_CI_SLOT_RUN. */
export function webPreviewPort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.PW_PORT ?? DEFAULT_PORT)
  if (env.TALOS_CI_SLOT_RUN !== '1' && ciSlotPorts(env).includes(port)) {
    const list = ciSlotPorts(env).join(', ')
    throw new Error(
      `PW_PORT=${port} is one of the ports the CI slots use for their browser job (${list}). A run by hand holding it makes ` +
        'that job fail. Leave PW_PORT unset (4173) or choose a port outside that list. scripts/ci-local.sh sets ' +
        'TALOS_CI_SLOT_RUN=1 for its own runs; see TALOS_CI_PW_PORT in docs/CI-LOCAL.md.',
    )
  }
  return port
}
