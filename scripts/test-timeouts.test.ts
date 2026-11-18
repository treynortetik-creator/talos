// A file-level vi.setConfig replaces vitest.config.ts's budget, which is x TALOS_TEST_TIME_FACTOR (scripts/gate.sh). A flat
// number there ignores the machine's factor: gate-push.test.ts (60 s), gate.test.ts and gate-fast.test.ts (30 s) timed out on a
// loaded Mac at factor 3 (red at 94710fe, refused pushes 11-17). Every such budget scales: scaled(…) from the testkit, or x F.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './size-report.ts'

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...testFiles(p))
    else if (e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

/** The value of each testTimeout / hookTimeout in a vi.setConfig call that does not scale with the time factor. */
function flatBudgets(text: string): string[] {
  const out: string[] = []
  for (const call of text.matchAll(/vi\.setConfig\(\{([^}]*)\}\)/g))
    for (const m of (call[1] ?? '').matchAll(/(testTimeout|hookTimeout):\s*([^,]+)/g)) {
      const v = (m[2] ?? '').trim()
      if (!/scaled\(|\bF\b|timeFactor\(/.test(v)) out.push(`${m[1]}: ${v}`)
    }
  return out
}

/** Each vi.setConfig call that raises testTimeout but leaves hooks at vitest.config's 10 s: an afterAll that removes every test's
 * repos then has a tenth of the test's budget (ci-local-runner-jobs and -status-2, red at 7262879 on a loaded Mac). */
function unpairedBudgets(text: string): string[] {
  return [...text.matchAll(/vi\.setConfig\(\{([^}]*)\}\)/g)]
    .map((call) => call[1] ?? '')
    .filter((body) => /testTimeout:/.test(body) && !/hookTimeout:/.test(body))
    .map((body) => body.trim())
}

describe('test budgets scale with the time factor', () => {
  it('flatBudgets finds a flat number and passes a scaled one', () => {
    expect(flatBudgets('vi.setConfig({ testTimeout: 30_000 })')).toEqual(['testTimeout: 30_000'])
    expect(flatBudgets('vi.setConfig({ testTimeout: scaled(30_000), hookTimeout: 9000 })')).toEqual([
      'hookTimeout: 9000',
    ])
    expect(flatBudgets('vi.setConfig({ testTimeout: 60_000 * F })')).toEqual([])
  })

  it('no test under scripts/ sets a flat file-level budget', () => {
    const self = join(ROOT, 'scripts', 'test-timeouts.test.ts') // its own examples above are flat on purpose
    const flat = testFiles(join(ROOT, 'scripts'))
      .filter((f) => f !== self)
      .flatMap((f) => flatBudgets(readFileSync(f, 'utf8')).map((b) => `${relative(ROOT, f)} (${b})`))
    expect(flat, 'wrap the value in scaled(…) from packages/testkit/src/time-factor.ts').toEqual([])
  })

  it('unpairedBudgets finds a testTimeout with no hookTimeout', () => {
    expect(unpairedBudgets('vi.setConfig({ testTimeout: scaled(60_000) })')).toEqual(['testTimeout: scaled(60_000)'])
    expect(unpairedBudgets('vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })')).toEqual([])
  })

  it('no test under scripts/ raises testTimeout without hookTimeout', () => {
    const self = join(ROOT, 'scripts', 'test-timeouts.test.ts')
    const unpaired = testFiles(join(ROOT, 'scripts'))
      .filter((f) => f !== self)
      .flatMap((f) => unpairedBudgets(readFileSync(f, 'utf8')).map((b) => `${relative(ROOT, f)} (${b})`))
    expect(unpaired, 'set hookTimeout to the same scaled budget: the hooks clean up after every test').toEqual([])
  })
})
