// The timing lint (scripts/timing-lint.ts): a literal wait, or a test whose waits outrun its timeout, fails the gate on new and
// changed lines. Written red first; the "past fixes" block replays the text those commits fixed (the part before the fix).
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { lintChanged, lintSource } from './timing-lint.ts'

/** "rule:line" for each hit of `text` as the file `file`. */
const hits = (file: string, text: string, opts: { strict?: boolean } = {}) =>
  lintSource(file, text, opts).map((h) => `${h.rule}:${h.line}`)
const rules = (file: string, text: string, opts: { strict?: boolean } = {}) =>
  lintSource(file, text, opts).map((h) => h.rule)

const BUN = "import { test } from 'bun:test'\nimport { t, waitFor } from '@talos-app/testkit'\n"
const VIT =
  "import { it, vi, expect } from 'vitest'\nimport { t as scaled } from '../packages/testkit/src/time-factor.ts'\n"
const PW = "import { test, expect } from '@playwright/test'\n"

describe('(a) a literal wait or timeout that is not scaled', () => {
  it("bun's third argument", () => {
    expect(rules('apps/bridge/test/a.test.ts', `${BUN}test('x', async () => {}, 30000)\n`)).toEqual(['unscaled'])
    expect(rules('apps/bridge/test/a.test.ts', `${BUN}test('x', async () => {}, t(30000))\n`)).toEqual([])
    expect(rules('apps/bridge/test/a.test.ts', `${BUN}test('x', async () => {}, 30_000 * F)\n`)).toEqual([])
  })

  it('setDefaultTimeout and test.setTimeout', () => {
    expect(rules('apps/bridge/test/a.test.ts', `${BUN}setDefaultTimeout(20_000)\n`)).toEqual(['unscaled'])
    expect(rules('apps/bridge/test/a.test.ts', `${BUN}setDefaultTimeout(t(20_000))\n`)).toEqual([])
    expect(rules('e2e/tests/a.spec.ts', `${PW}test.setTimeout(120_000)\n`)).toEqual(['unscaled'])
  })

  it("vitest's setConfig, it(name, fn, n) and { timeout: n }", () => {
    expect(
      rules('scripts/a.test.ts', `${VIT}vi.setConfig({ testTimeout: 60_000, hookTimeout: scaled(60_000) })\n`),
    ).toEqual(['unscaled'])
    expect(
      rules('scripts/a.test.ts', `${VIT}vi.setConfig({ testTimeout: scaled(60_000), hookTimeout: scaled(60_000) })\n`),
    ).toEqual([])
    expect(rules('scripts/a.test.ts', `${VIT}it('x', () => {}, 45_000)\n`)).toEqual(['unscaled'])
    expect(rules('scripts/a.test.ts', `${VIT}it('x', () => {}, scaled(45_000))\n`)).toEqual([])
    expect(rules('scripts/a.test.ts', `${VIT}it('x', () => {}, { timeout: 45_000 })\n`)).toEqual(['unscaled'])
    expect(rules('scripts/a.test.ts', `${VIT}it('x', () => {}, { timeout: scaled(45_000) })\n`)).toEqual([])
  })

  it("the testkit's waitFor is not flagged (it multiplies by waitScale itself); vi.waitFor and testing-library's are", () => {
    const f = 'apps/bridge/test/a.test.ts'
    const body = (imp: string, c: string) => `${imp}test('x', async () => {\n  ${c}\n}, t(60000))\n`
    expect(rules(f, body(BUN, "await waitFor(() => ok(), 3000, 'ok')"))).toEqual([])
    expect(rules(f, body(BUN, 'await vi.waitFor(() => ok(), 3000)'))).toEqual(['unscaled'])
    expect(rules(f, body(BUN, 'await vi.waitFor(() => ok(), { timeout: 3000 })'))).toEqual(['unscaled'])
    expect(rules(f, body(BUN, 'await vi.waitFor(() => ok(), t(3000))'))).toEqual([])
    const rtl = "import { waitFor } from '@testing-library/react'\nimport { t } from '@talos-app/testkit'\n"
    expect(rules('apps/web/test/a.test.tsx', body(rtl, 'await waitFor(() => ok(), { timeout: 3000 })'))).toEqual([
      'unscaled',
    ])
    expect(rules('apps/web/test/a.test.tsx', body(rtl, 'await waitFor(() => ok(), { timeout: t(3000) })'))).toEqual([])
  })

  it("the bridge's eventually(check, ms) is not scaled by anything: its literal is flagged", () => {
    expect(
      rules('apps/bridge/test/a.test.ts', `${BUN}test('x', async () => {\n  await eventually(() => ok(), 3000)\n})\n`),
    ).toEqual(['unscaled'])
  })

  it('a named constant defined from t() passes, one defined from a literal does not', () => {
    const f = 'apps/bridge/test/a.test.ts'
    expect(
      rules(f, `${BUN}const WAIT = t(6000)\ntest('x', async () => {\n  await sleep(WAIT)\n}, t(40000))\n`),
    ).toEqual([])
    expect(rules(f, `${BUN}const WAIT = 6000\ntest('x', async () => {\n  await sleep(WAIT)\n}, t(40000))\n`)).toEqual([
      'unscaled',
    ])
  })

  it('a promise sleep', () => {
    const f = 'apps/bridge/test/a.test.ts'
    expect(rules(f, `${BUN}test('x', async () => {\n  await new Promise((r) => setTimeout(r, 1500))\n})\n`)).toEqual([
      'unscaled',
    ])
    expect(rules(f, `${BUN}test('x', async () => {\n  await new Promise((r) => setTimeout(r, t(1500)))\n})\n`)).toEqual(
      [],
    )
    expect(rules(f, `${BUN}test('x', async () => {\n  await sleep(1500)\n})\n`)).toEqual(['unscaled'])
    expect(rules(f, `${BUN}test('x', async () => {\n  await Bun.sleep(t(1500))\n})\n`)).toEqual([])
  })

  it('a sleep of 50 ms or less (a yield) passes', () => {
    expect(
      rules(
        'apps/bridge/test/a.test.ts',
        `${BUN}test('x', async () => {\n  await new Promise((r) => setTimeout(r, 50))\n  await sleep(10)\n})\n`,
      ),
    ).toEqual([])
  })

  it("Playwright's { timeout }, waitForTimeout and expect.poll", () => {
    const f = 'apps/web/test/a.spec.ts'
    const body = (s: string) => `${PW}test('x', async ({ page }) => {\n  ${s}\n})\n`
    expect(rules(f, body('await expect(page.getByText("a")).toBeVisible({ timeout: 10_000 })'))).toEqual(['unscaled'])
    expect(rules(f, body('await expect(page.getByText("a")).toBeVisible({ timeout: t(10_000) })'))).toEqual([])
    expect(rules(f, body('await page.waitForTimeout(1500)'))).toEqual(['unscaled'])
    expect(rules(f, body('await page.waitForTimeout(t(1500))'))).toEqual([])
    expect(rules(f, body('await expect.poll(() => n(), { timeout: 8000 }).toBe(1)'))).toEqual(['unscaled'])
    expect(rules(f, body('await expect.poll(() => n(), { timeout: t(8000) }).toBe(1)'))).toEqual([])
  })

  it('a speed budget: a fixed limit on a measured time, not a ratio of two times', () => {
    const f = 'scripts/a.test.ts'
    expect(rules(f, `${VIT}it('x', () => {\n  expect(elapsed).toBeLessThan(150)\n})\n`)).toEqual(['speed'])
    expect(rules(f, `${VIT}it('x', () => {\n  expect(elapsed).toBeLessThan(scaled(150))\n})\n`)).toEqual([])
    expect(rules(f, `${VIT}it('x', () => {\n  expect(elapsed).toBeLessThan(base * 3)\n})\n`)).toEqual([])
    expect(rules(f, `${VIT}it('x', () => {\n  expect(items.length).toBeLessThan(150)\n})\n`)).toEqual([])
  })

  it('a shell or python budget in a kit test', () => {
    const f = 'kit/scripts/test-x.sh'
    expect(rules(f, 'assert dt < 1, "took"\n')).toEqual(['speed'])
    expect(rules(f, 'assert dt < 1 * F, "took"\n')).toEqual([])
    expect(rules(f, 'if dt >= 0.5:\n  slow.append(1)\n')).toEqual(['speed'])
    expect(rules(f, 'if dt >= 0.5 * F:\n  slow.append(1)\n')).toEqual([])
  })

  it('// timing-ok: <reason> on the line or the line before passes; an empty reason is a hit', () => {
    const f = 'apps/bridge/test/a.test.ts'
    const t1 = (c: string) => `${BUN}test('x', async () => {\n  ${c}\n  await sleep(1500)\n})\n`
    expect(rules(f, t1('// timing-ok: the product waits this long, not the machine'))).toEqual([])
    expect(
      rules(f, `${BUN}test('x', async () => {\n  await sleep(1500) // timing-ok: a negative window\n})\n`),
    ).toEqual([])
    expect(rules(f, t1('// timing-ok:'))).toEqual(['empty-reason', 'unscaled'])
    expect(rules(f, t1('// timing-ok:   '))).toEqual(['empty-reason', 'unscaled'])
    expect(rules(f, t1('// no excuse here'))).toEqual(['unscaled'])
  })

  it('a wait inside a string or a comment is not a wait', () => {
    expect(
      rules('scripts/a.test.ts', `${VIT}it('waitFor(x, 5000) setTimeout(r, 9000)', () => {\n  // sleep(9000)\n})\n`),
    ).toEqual([])
  })
})

describe('(b) a test whose waits outrun its timeout', () => {
  const f = 'apps/bridge/test/a.test.ts'
  const three = (third: string) =>
    `${BUN}test('x', async () => {\n  await waitFor(() => a(), t(4000), 'a')\n  await waitFor(() => b(), t(4000), 'b')\n}${third})\n`

  it("exceeds the runner's default (bun 5 s)", () => {
    expect(rules(f, three(''))).toEqual(['exceeds'])
    expect(lintSource(f, three(''))[0]?.hint).toContain('raise the test')
  })

  it("passes when the test's own timeout is above the sum", () => {
    expect(rules(f, three(', t(40000)'))).toEqual([])
    expect(rules(f, `${BUN}setDefaultTimeout(t(40_000))\n${three('').slice(BUN.length)}`)).toEqual([])
  })

  it("exceeds a test's own timeout too", () => {
    expect(rules(f, three(', t(7000)'))).toEqual(['exceeds'])
  })

  it('waitFor counts at waitScale (3) x its timeout; with no timeout, its default 3 s; eventually its default 10 s', () => {
    const one = (c: string) => `${BUN}test('x', async () => {\n  ${c}\n})\n`
    expect(rules(f, one('await waitFor(() => a(), t(1000), "a")'))).toEqual([]) // 3 s
    expect(rules(f, one('await waitFor(() => a(), t(2000), "a")'))).toEqual(['exceeds']) // 6 s
    expect(rules(f, one('await waitFor(() => a())'))).toEqual(['exceeds']) // 9 s
    expect(rules(f, one('await eventually(() => a())'))).toEqual(['exceeds']) // 10 s
    expect(rules(f, one('await eventually(() => a(), t(4000))'))).toEqual([]) // not scaled by waitScale
  })

  it('waits a test makes within the timeout pass', () => {
    const ok = `${BUN}test('x', async () => {\n  await waitFor(() => a(), t(1000), 'a')\n  await sleep(t(1000))\n})\n`
    expect(rules(f, ok)).toEqual([])
  })

  it('vitest: the project default is 30 s; poll deadlines and sleeps count', () => {
    const v = (n: number) =>
      `${VIT}it('x', async () => {\n  const end = Date.now() + scaled(${n})\n  await sleep(scaled(${n}))\n})\n`
    expect(rules('scripts/a.test.ts', v(10_000))).toEqual([])
    expect(rules('scripts/a.test.ts', v(20_000))).toEqual(['exceeds'])
  })

  it('a wait in a loop, a branch or Promise.all is not provable: "cannot prove", only with --strict', () => {
    const loop = `${BUN}test('x', async () => {\n  await sleep(t(2000))\n  for (let i = 0; i < 3; i++) {\n    await waitFor(() => a(i), t(4000), 'a')\n  }\n})\n`
    expect(rules(f, loop)).toEqual([])
    expect(rules(f, loop, { strict: true })).toEqual(['cannot-prove'])
    const par = `${BUN}test('x', async () => {\n  await Promise.all([waitFor(() => a(), t(4000), 'a'), waitFor(() => b(), t(4000), 'b')])\n})\n`
    expect(rules(f, par)).toEqual([])
  })
})

describe('(c) a long fake-clock advance (a warning)', () => {
  const f = 'apps/relay/test/a.test.ts'
  const adv = (s: string) => `import { it } from 'vitest'\nconst DAY = 86_400_000\nit('x', () => {\n  ${s}\n})\n`
  it('warns on more than about an hour, and points at jump() and set()', () => {
    const r = lintSource(f, adv('h.fake.clock.advance(89 * DAY)'))
    expect(r.map((h) => `${h.rule}:${h.warn}`)).toEqual(['long-advance:true'])
    expect(r[0]?.hint).toContain('jump(')
    expect(rules(f, adv('vi.advanceTimersByTime(2 * 60 * 60 * 1000)'))).toEqual(['long-advance'])
  })
  it('passes a short advance, a jump, a set and a replay', () => {
    expect(rules(f, adv('clock.advance(30_000)'))).toEqual([])
    expect(rules(f, adv('clock.jump(89 * DAY)'))).toEqual([])
    expect(rules(f, adv('clock.set(89 * DAY)'))).toEqual([])
    expect(rules(f, adv('clock.advance(89 * DAY, { replay: true })'))).toEqual([])
  })
})

describe('past fixes: the text before each one is flagged', () => {
  it('94710fee: gate-push.test.ts, a flat 60 s setConfig (red at the time: refused pushes)', () => {
    const before =
      "import { afterAll, describe, expect, it, vi } from 'vitest'\nconst repoRoot = join(here, '..')\nvi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })\n"
    expect(hits('scripts/gate-push.test.ts', before)).toEqual(['unscaled:3'])
  })

  it('bf7be8a1: scripts/ tests on flat 30-120 s budgets', () => {
    for (const n of ['30_000', '60_000', '120_000'])
      expect(
        rules('scripts/gate.test.ts', `import { vi } from 'vitest'\nvi.setConfig({ testTimeout: ${n} })\n`),
      ).toEqual(['unscaled'])
  })

  it('63666f0e: undo-delivery.test.ts, waits of 4 s and 8 s in one test under the runner 5 s', () => {
    const before = `${BUN}test('a bridge that stops while the message waits gets it again on restart', async () => {
  const { hh, main } = await setup()
  await waitFor(() => gates.length === 1, 4000, 'the snapshot to be held')
  await hh.bridge.stop()
  await waitFor(() => notes.some((x) => x.meta.message_id === id), 8000, 'the replayed message')
})
`
    expect(rules('apps/bridge/test/undo-delivery.test.ts', before).sort()).toEqual(['exceeds'])
  })

  it('ace76cd5: peer/link.test.ts, three 6 s waits under the 5 s limit', () => {
    const before = `${BUN}describe('one paste', () => {
  test('one paste links both directions', async () => {
    await waitFor(() => b.peerNotes().length === 1, 6000, 'A to B')
    await waitFor(() => a.peerNotes().length === 1, 6000, 'B to A')
    await waitFor(() => rowsOf(a).includes('Linked with work'), 6000, 'rows')
  })
})
`
    const r = rules('apps/bridge/test/peer/link.test.ts', before)
    expect(r).toContain('exceeds')
    // the shape that landed (three t(6000) waits, a default of t(40_000)): waitFor runs at waitScale x its timeout, so 3 x 18 s = 54 s
    const landed = before.replace(/6000/g, 't(6000)').replace(/\n {2}\}\)\n\}\)/, '\n  }, t(40_000))\n})')
    const r2 = lintSource('apps/bridge/test/peer/link.test.ts', landed)
    expect(r2.map((h) => h.rule)).toEqual(['exceeds'])
    expect(r2[0]?.hint).toContain('above 54000 ms')
    expect(rules('apps/bridge/test/peer/link.test.ts', landed.replace('t(40_000)', 't(90_000)'))).toEqual([])
  })

  it('5e2234aa: the memory reflex 150 ms median, and 486299bf: the 0.5 s pathological-input limit', () => {
    const reflex = 'check("speed", srt[len(srt) // 2] < 150 and srt[-1] < 600)\n'
    expect(rules('kit/scripts/test-memory-reflex.sh', reflex)).toEqual(['speed'])
    const rules2 = 'assert dt < 1, "took %.2fs" % dt\n            if dt >= 0.5:\n                slow.append(1)\n'
    expect(rules('kit/scripts/test-action-rules.sh', rules2)).toEqual(['speed', 'speed'])
  })

  it('7d1846cf: a relay test advanced the fake clock by 89 days (24 h of timers, 5.4 s, 5 s keep-alive)', () => {
    expect(
      rules(
        'apps/relay/test/auth/csrf-session.test.ts',
        "const DAY = 86_400_000\nit('x', () => {\n  h.fake.clock.advance(89 * DAY)\n})\n",
      ),
    ).toEqual(['long-advance'])
  })
})

describe('--changed only flags added or changed lines', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const put = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }

  it('an old literal wait blocks nobody; a new one, and a test whose body gained a wait, do', () => {
    const root = mkdtempSync(join(tmpdir(), 'timing-lint-'))
    dirs.push(root)
    git(root, 'init', '-q', '-b', 'main')
    const old = `${BUN}test('old', async () => {\n  await sleep(3000)\n})\n`
    put(root, 'apps/bridge/test/old.test.ts', old)
    const tight = `${BUN}test('tight', async () => {\n  await sleep(t(2500))\n  await sleep(t(2000))\n})\n`
    put(root, 'apps/bridge/test/tight.test.ts', tight)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    const base = git(root, 'rev-parse', 'HEAD')
    // nothing changed: nothing flagged, though old.test.ts has a hit
    expect(lintChanged(root, base, {}).map((h) => h.file)).toEqual([])
    // add a new unscaled wait to old.test.ts (a second test), a wait to tight.test.ts's body, and a new file
    put(root, 'apps/bridge/test/old.test.ts', `${old}test('new', async () => {\n  await sleep(4000)\n})\n`)
    put(
      root,
      'apps/bridge/test/tight.test.ts',
      tight.replace('  await sleep(t(2000))\n', '  await sleep(t(2000))\n  await sleep(t(1000))\n'),
    )
    put(root, 'apps/bridge/test/fresh.test.ts', `${BUN}test('f', async () => {\n  await sleep(2000)\n})\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'change')
    const got = lintChanged(root, base, {}).map((h) => `${h.file}:${h.line}:${h.rule}`)
    expect(got.sort()).toEqual([
      'apps/bridge/test/fresh.test.ts:4:unscaled',
      'apps/bridge/test/old.test.ts:7:unscaled',
      'apps/bridge/test/tight.test.ts:3:exceeds',
    ])
  })

  it('non-test files and files outside the scanned folders are not read', () => {
    const root = mkdtempSync(join(tmpdir(), 'timing-lint-'))
    dirs.push(root)
    git(root, 'init', '-q', '-b', 'main')
    put(root, 'README.md', 'x\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    const base = git(root, 'rev-parse', 'HEAD')
    put(root, 'apps/bridge/src/x.ts', 'await sleep(5000)\n')
    put(root, 'docs/a.test.ts', 'await sleep(5000)\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'src')
    expect(lintChanged(root, base, {})).toEqual([])
  })
})

describe('what counts as a wait', () => {
  const f = 'apps/bridge/test/a.test.ts'
  const body = (c: string, imp = BUN) => `${imp}test('x', async () => {\n  ${c}\n}, t(60000))\n`

  it('.sleep( on an object is not a sleep (a simulated Mac sleep); Bun.sleep and a bare sleep are', () => {
    expect(rules(f, body('fake.sleep(6 * 3600_000)'))).toEqual([])
    expect(rules(f, body('await r.sleep(1500)'))).toEqual([])
    expect(rules(f, body('await Bun.sleep(1500)'))).toEqual(['unscaled'])
    expect(rules(f, body('await sleep(1500)'))).toEqual(['unscaled'])
  })

  it("a `timeout:` key counts only in a wait or test call's arguments, not in any object literal", () => {
    expect(rules(f, body("const rule = { type: 'command', timeout: 3600 }"))).toEqual([])
    expect(rules(f, body('spawn(cmd, { timeout: 5000 })'))).toEqual([])
    const pw = (c: string) => `${PW}test('x', async ({ page }) => {\n  ${c}\n})\n`
    expect(rules('apps/web/test/a.spec.ts', pw('await expect(a).toBeVisible({ timeout: 10_000 })'))).toEqual([
      'unscaled',
    ])
    expect(rules('apps/web/test/a.spec.ts', pw('await page.goto(url, { timeout: 10_000 })'))).toEqual(['unscaled'])
  })

  it('a speed budget only inside expect(...) or an assert, not in plain logic', () => {
    const v = (c: string) => `${VIT}it('x', () => {\n  ${c}\n})\n`
    expect(rules('scripts/a.test.ts', v('if (Date.now() - start < 500) retry()'))).toEqual([])
    expect(rules('scripts/a.test.ts', v('expect(Date.now() - start < 500).toBe(true)'))).toEqual(['speed'])
  })

  it('wait(n) helpers and setTimeout from node:timers/promises are sleeps', () => {
    expect(rules('apps/web/test/a.test.tsx', `${VIT}it('x', async () => {\n  await wait(1500)\n})\n`)).toEqual([
      'unscaled',
    ])
    const tp = "import { setTimeout } from 'node:timers/promises'\n"
    expect(rules('apps/bridge/test/a.test.ts', body('await setTimeout(1500)', tp + BUN))).toEqual(['unscaled'])
    expect(rules('apps/bridge/test/a.test.ts', body('await setTimeout(t(1500))', tp + BUN))).toEqual([])
  })

  it("expect.poll's { timeout } adds to the sum (clio-graph: 15 s + 30 s against 30 s); describe.configure sets the limit", () => {
    const pw = (c: string, pre = '') => `${PW}${pre}test('x', async ({ page }) => {\n  ${c}\n})\n`
    const two =
      'await expect(a).toHaveCount(1, { timeout: 15_000 })\n  await expect.poll(() => n(), { timeout: 30_000 }).toBe(1)'
    expect(rules('apps/web/test/a.spec.ts', pw(two)).filter((r) => r === 'exceeds')).toEqual(['exceeds'])
    const cfg = 'test.describe.configure({ timeout: 90_000 })\n'
    expect(rules('apps/web/test/a.spec.ts', pw(two, cfg)).filter((r) => r === 'exceeds')).toEqual([])
  })
})

describe('--changed: renames and changes away from the use site', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const git = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd, encoding: 'utf8' }).trim()
  const put = (root: string, rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  /** A repo with `files` committed; returns its root and the base sha. */
  const repo = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'timing-lint-'))
    dirs.push(root)
    git(root, 'init', '-q', '-b', 'main')
    for (const [k, v] of Object.entries(files)) put(root, k, v)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    return { root, base: git(root, 'rev-parse', 'HEAD') }
  }
  const commit = (root: string) => {
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'change')
  }
  const flagged = (root: string, base: string) =>
    lintChanged(root, base, {}).map((h) => `${h.file}:${h.line}:${h.rule}`)

  const old = `${BUN}test('old', async () => {\n  await sleep(1500)\n  await sleep(1500)\n})\n`

  it('a renamed file keeps its old hits; a rename that adds a literal fails on that line only', () => {
    const { root, base } = repo({ 'apps/bridge/test/a.test.ts': old })
    git(root, 'mv', 'apps/bridge/test/a.test.ts', 'apps/bridge/test/b.test.ts')
    commit(root)
    expect(flagged(root, base)).toEqual([])
    const r2 = repo({ 'apps/bridge/test/a.test.ts': old })
    git(r2.root, 'mv', 'apps/bridge/test/a.test.ts', 'apps/bridge/test/b.test.ts')
    put(r2.root, 'apps/bridge/test/b.test.ts', old.replace('\n})\n', '\n  await sleep(100)\n})\n'))
    commit(r2.root)
    expect(flagged(r2.root, r2.base)).toEqual(['apps/bridge/test/b.test.ts:6:unscaled'])
  })

  it('changing a constant to a literal fails every use, though the use lines did not change', () => {
    const src = (def: string) =>
      `${BUN}const WAIT_MS = ${def}\ntest('a', async () => {\n  await sleep(WAIT_MS)\n}, t(30_000))\ntest('b', async () => {\n  await sleep(WAIT_MS)\n}, t(30_000))\n`
    const { root, base } = repo({ 'apps/bridge/test/c.test.ts': src('t(6000)') })
    put(root, 'apps/bridge/test/c.test.ts', src('6000'))
    commit(root)
    expect(flagged(root, base)).toEqual([
      'apps/bridge/test/c.test.ts:5:unscaled',
      'apps/bridge/test/c.test.ts:8:unscaled',
    ])
  })

  it('lowering setDefaultTimeout under the sum fails every test under it', () => {
    const src = (n: string) =>
      `${BUN}setDefaultTimeout(${n})\ntest('a', async () => {\n  await sleep(t(4000))\n  await sleep(t(4000))\n})\ntest('b', async () => {\n  await sleep(t(2000))\n})\n`
    const { root, base } = repo({ 'apps/bridge/test/d.test.ts': src('t(40_000)') })
    put(root, 'apps/bridge/test/d.test.ts', src('t(5_000)'))
    commit(root)
    expect(flagged(root, base)).toEqual(['apps/bridge/test/d.test.ts:4:exceeds'])
  })
})
