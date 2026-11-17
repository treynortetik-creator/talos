// The relay redeploys (and every phone and bridge socket drops) only when something the image is built from changes
// (railway.json build.watchPatterns; Pantheon 2026-11-15: 82 deploys in a day, each one a visible "disconnected"). The risk
// of a watch list is the opposite: a file the Dockerfile copies that no pattern covers, so a real relay change never ships.
// This test reads the Dockerfile's build-context COPY sources and requires a pattern for each.
// gate-reads: railway.json apps/relay/Dockerfile
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const patterns: string[] = JSON.parse(readFileSync(join(ROOT, 'railway.json'), 'utf8')).build.watchPatterns
const dockerfile = readFileSync(join(ROOT, 'apps/relay/Dockerfile'), 'utf8')

/** Sources of every `COPY` that reads the build context (not `--from=` another stage). */
function copySources(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*COPY\s+(.*)$/.exec(line)
    if (!m || /--from=/.test(m[1] as string)) continue
    const words = (m[1] as string).split(/\s+/).filter((w) => w && !w.startsWith('--'))
    out.push(...words.slice(0, -1).map((w) => w.replace(/^\.\//, '').replace(/\/+$/, '')))
  }
  return out
}

/** A source is covered by `/x/**` when it is x or under it, and by `/f` when it is exactly f. */
function covered(src: string): boolean {
  return patterns.some((p) => {
    const anchored = p.replace(/^\//, '')
    if (anchored.endsWith('/**')) {
      const dir = anchored.slice(0, -3)
      return src === dir || src.startsWith(`${dir}/`)
    }
    return src === anchored
  })
}

describe('railway.json watchPatterns', () => {
  it('cover every file and folder the relay image is built from', () => {
    const srcs = copySources(dockerfile)
    expect(srcs.length).toBeGreaterThan(5)
    expect(srcs.filter((s) => !covered(s))).toEqual([])
  })
  it('cover the build config itself, and leave out what the relay never ships (the bridge, the kit, docs)', () => {
    for (const f of ['apps/relay/Dockerfile', 'railway.json', '.dockerignore']) expect(covered(f), f).toBe(true)
    for (const f of [
      'apps/bridge/src/bridge.ts',
      'kit/hooks/memory-reflex.py',
      'docs/deploy-railway.md',
      'CHANGELOG.md',
    ])
      expect(covered(f), f).toBe(false)
  })
})
