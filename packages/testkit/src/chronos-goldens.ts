import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** Vendored real Chronos 0.3 `api` outputs (see the README there). */
export const CHRONOS_GOLDEN_DIR = join(here, '..', 'fixtures', 'chronos-0.3')

/** One golden by file name without `.json` (`snapshot-three-jobs`, `detail`, `due-session-midnight`, ...). */
export function loadChronosGolden(name: string): unknown {
  return JSON.parse(readFileSync(join(CHRONOS_GOLDEN_DIR, `${name}.json`), 'utf8'))
}

export function listChronosGoldens(): string[] {
  return readdirSync(CHRONOS_GOLDEN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}
