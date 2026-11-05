import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfigT, JwkP256T } from '@talos-app/protocol'

const here = dirname(fileURLToPath(import.meta.url))
const protocolDir = join(here, '..', '..', 'protocol')
const repoRoot = join(here, '..', '..', '..')

/** All frame fixtures keyed by file name without `.json` (`hello.app`, `hello.bridge`, `card.create`, ...). */
export function loadFrameFixtures(): Record<string, Record<string, unknown>> {
  const dir = join(protocolDir, 'fixtures', 'frames')
  const out: Record<string, Record<string, unknown>> = {}
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(dir, f), 'utf8'))
  }
  return out
}

export function loadFrameFixture(name: string): Record<string, unknown> {
  const f = loadFrameFixtures()[name]
  if (!f) throw new Error(`no frame fixture named ${name}`)
  return structuredClone(f)
}

/** Config examples shipped in /examples. */
export function loadExampleConfig(name: 'default' | 'five-threads' = 'default'): AgentConfigT {
  return JSON.parse(readFileSync(join(repoRoot, 'examples', `config.${name}.json`), 'utf8'))
}

/** The committed TEST device key that signed the owner-frame fixtures. Never a real key. */
export function loadTestDeviceKey(): { deviceId: string; publicJwk: JwkP256T; privateJwk: JsonWebKey } {
  return JSON.parse(readFileSync(join(protocolDir, 'fixtures', 'test-device-key.json'), 'utf8'))
}
