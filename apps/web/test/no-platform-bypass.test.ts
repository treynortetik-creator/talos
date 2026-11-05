// Builder rule 9 as a test (Biome has no per-file restricted-member rule): nothing outside lib/platform.ts may touch
// PushManager, navigator.share or window.open.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : []
  })
const BANNED = [
  /\bPushManager\b/,
  /\bpushManager\b/,
  /navigator\.share\b/,
  /\bwindow\.open\b/,
  /(?<![.\w])open\(\s*['"`]http/,
]

describe('platform adapter is the only door', () => {
  it('no source file outside lib/platform.ts uses push, share or window.open', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f)
      if (rel === join('lib', 'platform.ts')) continue
      const text = readFileSync(f, 'utf8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      for (const re of BANNED) if (re.test(text)) offenders.push(`${rel}: ${re}`)
    }
    expect(offenders).toEqual([])
  })
})
