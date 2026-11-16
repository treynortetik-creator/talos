// The reviewer eval's scorer (evals/reviewer/README.md): deterministic, no model as judge. A case expects one or more findings;
// a finding meets an expected one when it is in the expected file (and line range, when one is given), at most one step below
// the expected severity (the case's severity is the right one by the prompt's bar; one step below still found the bug), and
// its summary and failure scenario match every `must` group (each group a list of regular expressions, any one of which may
// match). A case is a hit when every expected finding is met (`expect_mode: all`, the default) or at least one is (`any`: a
// change that hid several real bugs). A miss whose closest finding is in the right file is reported as "near", for a person.

export type Severity = 'high' | 'medium' | 'low'
export const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 }

export type Expected = {
  /** The file the defect is in; a list when it can be told in any of them (the call, or what it calls). */
  file: string | string[]
  /** Inclusive line range the finding's line must fall in (with LINE_SLACK either side). */
  lines?: [number, number]
  severity: Severity
  /** Every group must match; within a group, any one pattern (case-insensitive) is enough. */
  must: string[][]
  /** What the finding is, in a sentence: for the person reading a miss. */
  note?: string
}
export type Decoy = { file?: string; must: string[][] }
export type Case = {
  id: string
  title: string
  base: string
  buggy: string
  fix: string
  expect: Expected[]
  /** `all` (default): every expected finding must be met; `any`: one is a hit, each one met counts toward finding recall. */
  expect_mode?: 'all' | 'any'
  decoys?: Decoy[]
}
export type Finding = {
  id?: string
  severity?: string
  category?: string
  file?: string
  line?: number
  summary?: string
  failure_scenario?: string
  verdict?: string
}
export type Review = { reviewed?: unknown; findings?: Finding[]; not_checked?: unknown }

export const LINE_SLACK = 10

const norm = (p: string) => p.replace(/^\.\//, '').replace(/^\/+/, '')
const sameFile = (got: string | undefined, want: string | string[]) => {
  if (!got) return false
  const g = norm(got)
  return (Array.isArray(want) ? want : [want]).some((x) => {
    const w = norm(x)
    return g === w || g.endsWith(`/${w}`) || w.endsWith(`/${g}`)
  })
}
const textOf = (f: Finding) => `${f.summary ?? ''}\n${f.failure_scenario ?? ''}`
const groupsMatch = (groups: string[][], text: string) =>
  groups.every((g) => g.some((re) => new RegExp(re, 'i').test(text)))
const rank = (s: string | undefined) => SEVERITY_RANK[(s ?? '').toLowerCase() as Severity] ?? 0

/** Does finding `f` meet expected finding `e`? */
export function meets(f: Finding, e: Expected): boolean {
  if (!sameFile(f.file, e.file)) return false
  if (e.lines && typeof f.line === 'number') {
    if (f.line < e.lines[0] - LINE_SLACK || f.line > e.lines[1] + LINE_SLACK) return false
  }
  if (rank(f.severity) === 0 || rank(f.severity) < SEVERITY_RANK[e.severity] - 1) return false
  return groupsMatch(e.must, textOf(f))
}

export type CaseScore = {
  id: string
  hit: boolean
  /** For each expected finding, the id (or index) of the finding that met it, or null. */
  matched: Array<string | null>
  /** The same, from the review's first TOP findings only (in the order given): what a reader sees first. */
  hitAtTop: boolean
  /** On a miss: the closest finding (the right file), for a person to look at. */
  near: Finding | null
  /** Of the expected findings met: at exactly the expected severity, above it, and (one step) below it. */
  severityExact: number
  severityOver: number
  severityUnder: number
  findings: number
  /** Findings that met no expected finding. */
  unmatched: number
  /** Of the first TOP findings, how many met an expected finding. */
  topMatched: number
  topCount: number
  decoysFlagged: number
}

/** How many findings a reader is assumed to read: hit@TOP and precision@TOP. */
export const TOP = 5

function match(c: Case, findings: Finding[]): { matched: Array<string | null>; used: Set<number> } {
  const used = new Set<number>()
  const matched: Array<string | null> = []
  for (const e of c.expect) {
    // a finding meets at most one expected finding: a case with several real bugs needs several findings
    const i = findings.findIndex((f, k) => !used.has(k) && meets(f, e))
    if (i === -1) {
      matched.push(null)
      continue
    }
    used.add(i)
    matched.push(findings[i]?.id ?? String(i))
  }
  return { matched, used }
}
const isHit = (c: Case, matched: Array<string | null>) =>
  c.expect_mode === 'any' ? matched.some((m) => m !== null) : matched.every((m) => m !== null)

export function scoreCase(c: Case, review: Review): CaseScore {
  const findings = Array.isArray(review.findings) ? review.findings : []
  const { matched, used } = match(c, findings)
  const top = findings.slice(0, TOP)
  const atTop = match(c, top)
  let severityExact = 0
  let severityOver = 0
  let severityUnder = 0
  c.expect.forEach((e, k) => {
    const id = matched[k]
    if (id === null || id === undefined) return
    const f = findings.find((x, i) => (x.id ?? String(i)) === id)
    const d = rank(f?.severity) - SEVERITY_RANK[e.severity]
    if (d === 0) severityExact++
    else if (d > 0) severityOver++
    else severityUnder++
  })
  const hit = isHit(c, matched)
  const near = hit ? null : (findings.find((f) => c.expect.some((e) => sameFile(f.file, e.file))) ?? null)
  const decoysFlagged = (c.decoys ?? []).filter((d) =>
    findings.some((f) => (!d.file || sameFile(f.file, d.file)) && groupsMatch(d.must, textOf(f))),
  ).length
  return {
    id: c.id,
    hit,
    matched,
    hitAtTop: isHit(c, atTop.matched),
    near,
    severityExact,
    severityOver,
    severityUnder,
    findings: findings.length,
    unmatched: findings.length - used.size,
    topMatched: atTop.used.size,
    topCount: top.length,
    decoysFlagged,
  }
}

export type RunScore = {
  cases: number
  hits: number
  recall: number
  /** Expected findings met over expected findings, across every case (a case with several real bugs counts each). */
  findingRecall: number
  /** Cases hit from the first TOP findings only. */
  hitAtTop: number
  /** Of the first TOP findings of every case, the share that met an expected finding. */
  precisionAtTop: number
  /** Of the expected findings met: the share at exactly the expected severity, above it and below it. */
  severityAgreement: number
  severityOverShare: number
  severityUnderShare: number
  findingsPerCase: number
  unmatchedPerCase: number
  decoysFlagged: number
  perCase: CaseScore[]
}

export function scoreRun(scores: CaseScore[]): RunScore {
  const n = scores.length
  const met = scores.reduce((a, s) => a + s.matched.filter((m) => m !== null).length, 0)
  const expected = scores.reduce((a, s) => a + s.matched.length, 0)
  const sum = (
    k:
      | 'findings'
      | 'unmatched'
      | 'decoysFlagged'
      | 'severityExact'
      | 'severityOver'
      | 'severityUnder'
      | 'topMatched'
      | 'topCount',
  ) => scores.reduce((a, s) => a + s[k], 0)
  return {
    cases: n,
    hits: scores.filter((s) => s.hit).length,
    recall: n ? scores.filter((s) => s.hit).length / n : 0,
    findingRecall: expected ? met / expected : 0,
    hitAtTop: scores.filter((s) => s.hitAtTop).length,
    precisionAtTop: sum('topCount') ? sum('topMatched') / sum('topCount') : 0,
    severityAgreement: met ? sum('severityExact') / met : 0,
    severityOverShare: met ? sum('severityOver') / met : 0,
    severityUnderShare: met ? sum('severityUnder') / met : 0,
    findingsPerCase: n ? sum('findings') / n : 0,
    unmatchedPerCase: n ? sum('unmatched') / n : 0,
    decoysFlagged: sum('decoysFlagged'),
    perCase: scores,
  }
}

/**
 * The review's JSON object from the reviewer's final text: the whole text when it is JSON, else the first balanced `{...}`
 * that parses and has a `findings` array (a reviewer that wraps its answer in a fence or a sentence is still read).
 */
export function parseReview(text: string): Review | null {
  const t = text.trim()
  try {
    const v = JSON.parse(t) as Review
    if (v && typeof v === 'object') return v
  } catch {
    // not JSON as a whole
  }
  for (let start = t.indexOf('{'); start !== -1; start = t.indexOf('{', start + 1)) {
    let depth = 0
    let inStr = false
    for (let i = start; i < t.length; i++) {
      const ch = t[i]
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          const v = JSON.parse(t.slice(start, i + 1)) as Review
          if (v && Array.isArray(v.findings)) return v
        } catch {
          // not this one
        }
        break
      }
    }
  }
  return null
}

/** Checks a case file's shape; returns the problems (none = a case the runner can use). */
export function caseProblems(c: unknown): string[] {
  const out: string[] = []
  const x = c as Partial<Case> | null
  if (!x || typeof x !== 'object') return ['not an object']
  for (const k of ['id', 'title', 'base', 'buggy', 'fix'] as const)
    if (typeof x[k] !== 'string' || x[k] === '') out.push(`no ${k}`)
  if (!Array.isArray(x.expect) || x.expect.length === 0) out.push('no expect')
  if (x.expect_mode !== undefined && x.expect_mode !== 'all' && x.expect_mode !== 'any')
    out.push('expect_mode is not all or any')
  for (const [i, e] of (x.expect ?? []).entries()) {
    const files = Array.isArray(e?.file) ? e.file : [e?.file]
    if (!files.length || !files.every((f) => typeof f === 'string' && f !== '' && f !== 'FILL IN'))
      out.push(`expect[${i}]: no file`)
    if (!(e?.severity in SEVERITY_RANK)) out.push(`expect[${i}]: severity is not high, medium or low`)
    if (!Array.isArray(e?.must) || e.must.length === 0 || !e.must.every((g) => Array.isArray(g) && g.length > 0))
      out.push(`expect[${i}]: must is not a list of non-empty pattern lists`)
    for (const g of e?.must ?? [])
      for (const re of g)
        try {
          new RegExp(re, 'i')
        } catch {
          out.push(`expect[${i}]: bad pattern ${re}`)
        }
  }
  return out
}
