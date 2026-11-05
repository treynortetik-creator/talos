/* biome-ignore-all lint/suspicious/noExplicitAny: frames are untyped JSON */
// The frames the real memory service produced over a synthetic notes folder (`bun run capture:memory`), for the node tests.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Step } from './replay.ts'

export { macFrom } from './replay.ts'
export type { Step }

const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/testkit/fixtures/captured/memory')
export const scenario = (name: string): Step[] => JSON.parse(readFileSync(join(dir, name), 'utf8')).frames
