// The relay redeploys (and every phone and bridge socket drops) only when something the image is built from changes: the
// service's watch paths, set in the Railway dashboard from the list in docs/deploy-railway.md (82 deploys in a day on
// 2026-11-15 before there was one, each a visible "disconnected"). The risk of a watch list is the opposite: a file the
// Dockerfile copies that no pattern covers, so a real relay change never ships. This test reads the documented list (the
// ```watch-paths block) and the Dockerfile's build-context COPY sources, and requires a pattern for each.
// gate-reads: docs/deploy-railway.md apps/relay/Dockerfile
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '../../..')
const doc = readFileSync(join(ROOT, 'docs/deploy-railway.md'), 'utf8')
const blocks = [...doc.matchAll(/^```watch-paths\n([\s\S]*?)^```$/gm)]
const patterns: string[] = (blocks[0]?.[1] ?? '')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
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

describe('the watch paths in docs/deploy-railway.md', () => {
  it('are one fenced block of absolute patterns', () => {
    expect(blocks).toHaveLength(1)
    expect(patterns.length).toBeGreaterThan(5)
    for (const p of patterns) expect(p, p).toMatch(/^\/\S+$/)
  })
  it('cover every file and folder the relay image is built from', () => {
    const srcs = copySources(dockerfile)
    expect(srcs.length).toBeGreaterThan(5)
    expect(srcs.filter((s) => !covered(s))).toEqual([])
  })
  it('cover the Dockerfile and .dockerignore, and leave out what the relay never ships (the bridge, the kit, docs)', () => {
    for (const f of ['apps/relay/Dockerfile', '.dockerignore']) expect(covered(f), f).toBe(true)
    for (const f of [
      'apps/bridge/src/bridge.ts',
      'kit/hooks/memory-reflex.py',
      'docs/deploy-railway.md',
      'CHANGELOG.md',
    ])
      expect(covered(f), f).toBe(false)
  })
})
