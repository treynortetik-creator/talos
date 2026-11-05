import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const FIXTURE_DIR = join(here, '..', 'fixtures', 'frames')
export const EXAMPLES_DIR = join(here, '..', '..', '..', 'examples')

export function loadFixtures(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const f of readdirSync(FIXTURE_DIR).filter((x) => x.endsWith('.json'))) {
    out[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8'))
  }
  return out
}

export function loadTestKey() {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, '..', 'test-device-key.json'), 'utf8')) as {
    deviceId: string
    publicJwk: import('../src/index.ts').JwkP256T
    privateJwk: JsonWebKey
  }
}

export function loadExample(name: 'default' | 'five-threads') {
  return JSON.parse(readFileSync(join(EXAMPLES_DIR, `config.${name}.json`), 'utf8'))
}
