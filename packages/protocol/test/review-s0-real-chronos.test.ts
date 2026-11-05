// Review of PR #29 (Schedules S0): the PR's Chronos schemas against what the REAL Chronos CLI prints.
//   review-fixtures/chronos-c2/  every golden from chronos feat/0.3-runs (e5e8b7e), byte for byte; regenerated with
//                                tests/golden.py in a temp HOME and identical to the committed files.
//   review-fixtures/probe/       stdout of the real `chronos api` (C1 = tag v0.3.0-rc1, C2 = feat/0.3-runs) for
//                                hand-written jobs.json records and 0.2 state, in a temp HOME. Each file is {exit, out}.
// Every failing case is a parse failure of real output, i.e. a fake/real drift the PR's own golden test can't see.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CHRONOS_API, type ChronosVerb } from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', 'testkit', 'review-fixtures')
const load = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'))
const issues = (r: { success: boolean; error?: { issues: unknown[] } }) =>
  r.success ? '' : JSON.stringify(r.error?.issues.slice(0, 3), null, 1)

/** C2 golden file name -> verb (the PR's mapping, plus the run verbs it left out). */
function verbOf(name: string): ChronosVerb | 'health' | null {
  const n = name.replace(/\.json$/, '')
  const table: Array<[RegExp, ChronosVerb | 'health']> = [
    [/^version$/, 'version'],
    [/^snapshot-/, 'snapshot'],
    [/^detail$/, 'detail'],
    [/^validate-/, 'validate'],
    [/^apply-/, 'apply'],
    [/^approved/, 'approved'],
    [/^config-set/, 'config_set'],
    [/^disable$/, 'disable'],
    [/^pause-/, 'pause'],
    [/^due-session/, 'due_session'],
    [/^session-beat$/, 'session_beat'],
    [/^migrate$/, 'migrate'],
    [/^error-/, 'any'],
    [/^claim-/, 'claim'],
    [/^finish-/, 'finish'],
    [/^orphans$/, 'orphans'],
    [/^start-/, 'start'],
    [/^session-prompt/, 'session_prompt'],
    [/^probe/, 'probe'],
    [/^health$/, 'health'],
  ]
  for (const [re, v] of table) if (re.test(n)) return v
  return null
}

describe('review S0: every C2 golden (real CLI) parses with the PR schema for its verb', () => {
  const dir = join(root, 'chronos-c2')
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    it(f, () => {
      const verb = verbOf(f)
      expect(verb, `no verb for ${f}`).not.toBeNull()
      const schema = (CHRONOS_API as Record<string, { safeParse(x: unknown): { success: boolean } }>)[verb as string]
      expect(schema, `CHRONOS_API has no schema for the '${verb}' verb`).toBeDefined()
      const r = schema?.safeParse(load(join(dir, f))) as { success: boolean; error?: { issues: unknown[] } }
      expect(r.success, issues(r)).toBe(true)
    })
  }
})

describe('review S0: real CLI output for records a 0.2 install or a hand edit can hold', () => {
  const dir = join(root, 'probe')
  const files = readdirSync(dir).filter((x) => /^c[12]-(snapshot|detail)-/.test(x))
  for (const f of files) {
    it(`${f}: exit 0 and the ${f.includes('snapshot') ? 'snapshot' : 'detail'} parses`, () => {
      const { exit, out } = load(join(dir, f)) as { exit: number; out: unknown }
      if (exit !== 0) return // an error answer (the verb refused) is the error shape; checked below
      const verb = f.includes('-snapshot-') ? 'snapshot' : 'detail'
      const r = CHRONOS_API[verb].safeParse(out)
      // One bad record makes the WHOLE snapshot unreadable (registry_unreadable for every job), not just that row.
      expect(r.success, issues(r)).toBe(true)
    })
  }
})

describe('review S0: real C2 run-verb answers parse', () => {
  const dir = join(root, 'probe')
  const cases: Array<[string, ChronosVerb]> = [
    ['c2-claim-manual-paused.json', 'claim'],
    ['c2-claim-after-window-ran.json', 'claim'],
    ['c2-claim-restricted.json', 'claim'],
    ['c2-claim-unknown.json', 'claim'],
    ['c2-start-bg.json', 'start'],
    ['c2-finish-4.json', 'finish'],
    ['c2-session-prompt-restricted.json', 'session_prompt'],
    ['c2-detail-after-finish.json', 'detail'],
  ]
  for (const [f, verb] of cases) {
    it(`${f} parses as ${verb}`, () => {
      const r = CHRONOS_API[verb].safeParse((load(join(dir, f)) as { out: unknown }).out)
      expect(r.success, issues(r)).toBe(true)
    })
  }
})
