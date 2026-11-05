// W1: no test may run install.sh in a way that can rewrite the developer's real `talos-app` command.
// install.sh puts the wrapper next to bun when no --bin-dir is given, which on a developer Mac is the real command
// (it was repointed at a throwaway home on 2026-11-01). Every test that runs the script must pass a temp --bin-dir,
// or put a fake bun in a temp folder first (install-path.test.ts does, via fakeBunDir).
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = import.meta.dir

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'fixtures' && e.name !== 'node_modules') out.push(...testFiles(full))
    } else if (e.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

const SAFE = /--bin-dir|fakeBunDir|'--bin-dir'/

/** Lines where a test file points at install.sh to run it (not comments). */
export function installSpawnSites(src: string): number[] {
  const lines = src.split('\n')
  const hits: number[] = []
  lines.forEach((l, i) => {
    if (/^\s*(\/\/|\*)/.test(l) || (/^\s*(export\s+)?const\s+\w+\s*=/.test(l) && !/spawn/.test(l))) return
    if (
      /scripts['"],\s*'install\.sh'|scripts\/install\.sh|['"]bash['"],\s*INSTALL|\bINSTALL\b.*\bspawn|spawn.*\bINSTALL\b/.test(
        l,
      )
    )
      hits.push(i)
    else if (/^\s*INSTALL,?\s*$/.test(l)) hits.push(i)
  })
  return hits
}

/** A site is safe when a --bin-dir (or a fake bun dir) appears in the spawn that follows it, or in the helper it lives in. */
export function unsafeSites(src: string): number[] {
  const lines = src.split('\n')
  return installSpawnSites(src).filter((i) => {
    const window = lines.slice(Math.max(0, i - 6), i + 40).join('\n')
    return !SAFE.test(window)
  })
}

describe('install.sh tests stay inside their temp folders (W1)', () => {
  test('the sites are found at all (the scan itself is not blind)', () => {
    const total = testFiles(TEST_DIR)
      .filter((f) => !f.endsWith('install-sandbox.test.ts'))
      .reduce((n, f) => n + installSpawnSites(readFileSync(f, 'utf8')).length, 0)
    expect(total).toBeGreaterThanOrEqual(4)
  })

  test('every test that runs install.sh passes a throwaway --bin-dir or a fake bun folder', () => {
    const bad: string[] = []
    for (const f of testFiles(TEST_DIR)) {
      if (f.endsWith('install-sandbox.test.ts')) continue
      const src = readFileSync(f, 'utf8')
      for (const i of unsafeSites(src)) bad.push(`${f.slice(TEST_DIR.length + 1)}:${i + 1}`)
    }
    expect(bad).toEqual([])
  })

  test('the scan rejects the shape that caused W1 (real PATH, no --bin-dir)', () => {
    const old = [
      "const p = Bun.spawn(['bash', join(BRIDGE_DIR, 'scripts', 'install.sh'), '--agent-dir', a, '--home', h], {",
      "  env: { PATH: process.env.PATH ?? '', HOME: h },",
      '})',
      ...Array(45).fill('// filler'),
    ].join('\n')
    expect(unsafeSites(old)).toEqual([0])
    expect(unsafeSites(old.replace("'--home', h]", "'--home', h, '--bin-dir', b]"))).toEqual([])
  })
})
