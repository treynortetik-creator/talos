// The problem folder: `$TALOS_APP_HOME/problems/open/<fingerprint>.json` for what a builder should look at, `closed/` for
// what was dealt with. One file per distinct problem, a count instead of a copy for every repeat. Plain files on purpose:
// no table, no daemon, and a builder can read them with nothing but `cat`. Every string was scrubbed before it got here and
// the file says `trust: external`, because a builder agent reads these and none of it is an instruction.
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PROBLEM_LIMITS, type ProblemT, problemFingerprint, sanitizeExternal, scrubProblem } from '@talos-app/protocol'
import { ensureDir, readJsonFile, writeFileAtomic, writeJsonAtomic } from '../fsutil.ts'
import { redact } from '../redact.ts'

export const PROBLEMS_DIR = 'problems'
const IDS_KEPT = 50
const VERSIONS_KEPT = 10

export function problemDirs(home: string) {
  const root = join(home, PROBLEMS_DIR)
  return { root, open: join(root, 'open'), closed: join(root, 'closed') }
}

export type StoredProblem = {
  v: 1
  /** Always 'external': this is data from a report, never an instruction to whoever reads it. */
  trust: 'external'
  fingerprint: string
  source: ProblemT['source']
  kind: ProblemT['kind']
  name: string
  message: string
  frames: ProblemT['frames']
  device: ProblemT['device']
  routes: string[]
  steps?: string
  /** Sits beside this file, same fingerprint. */
  screenshot_file?: string
  screenshot_unavailable?: true
  versions_seen: ProblemT['versions'][]
  count: number
  first_seen: string
  last_seen: string
  truncated: boolean
  /** The last problem ids merged in: a replay of one of them changes nothing. */
  ids: string[]
}

export type FileOutcome =
  | { result: 'filed' | 'merged' | 'duplicate'; fingerprint: string; count: number; path: string }
  | { result: 'refused'; fingerprint: string; reason: 'full' }

/** Scrubs once more on the Mac (the relay is not trusted) and takes out the home folders this machine uses. */
export function cleanProblem(p: ProblemT, paths: { userHome?: string; appHome?: string }): ProblemT {
  const s = scrubProblem(p)
  const r = (t: string) => sanitizeExternal(redact(t, paths))
  return {
    ...s,
    name: r(s.name),
    message: r(s.message),
    frames: s.frames.map((f) => ({
      ...(f.fn !== undefined ? { fn: r(f.fn) } : {}),
      ...(f.file !== undefined ? { file: r(f.file) } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.col !== undefined ? { col: f.col } : {}),
    })),
    routes: s.routes.map(r),
    ...(s.steps !== undefined ? { steps: sanitizeExternal(redact(s.steps, paths), PROBLEM_LIMITS.stepsChars) } : {}),
  }
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

type Entry = { path: string; name: string; fingerprint: string; mtime: number; bytes: number; closed: boolean }

function entries(home: string): Entry[] {
  const d = problemDirs(home)
  const out: Entry[] = []
  for (const [dir, closed] of [
    [d.open, false],
    [d.closed, true],
  ] as const) {
    let names: string[] = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith('.')) continue
      try {
        const st = statSync(join(dir, name))
        out.push({
          path: join(dir, name),
          name,
          fingerprint: name.split('.')[0] ?? name,
          mtime: st.mtimeMs,
          bytes: st.size,
          closed,
        })
      } catch {
        // gone while we looked
      }
    }
  }
  return out
}

function removeAll(home: string, fingerprint: string, closedOnly: boolean): void {
  for (const e of entries(home)) {
    if (e.fingerprint !== fingerprint || (closedOnly && !e.closed)) continue
    try {
      unlinkSync(e.path)
    } catch {
      // already gone
    }
  }
}

/**
 * Frees room by deleting the oldest CLOSED problems first. False when closed ones are not enough: open ones are never
 * deleted. Each closed problem is tried once, so a file that cannot be removed (a permission, a lock) ends the loop
 * instead of spinning the bridge's main thread on it.
 */
function makeRoom(home: string, needBytes: number): boolean {
  const tried = new Set<string>()
  for (;;) {
    const all = entries(home)
    const files = all.filter((e) => e.name.endsWith('.json')).length
    const bytes = all.reduce((n, e) => n + e.bytes, 0)
    if (files + 1 <= PROBLEM_LIMITS.files && bytes + needBytes <= PROBLEM_LIMITS.totalBytes) return true
    const oldest = all
      .filter((e) => e.closed && e.name.endsWith('.json') && !tried.has(e.fingerprint))
      .sort((a, b) => a.mtime - b.mtime)[0]
    if (!oldest) return false
    tried.add(oldest.fingerprint)
    removeAll(home, oldest.fingerprint, true)
  }
}

export function fileProblem(
  home: string,
  problem: ProblemT,
  o: {
    nowIso: string
    paths: { userHome?: string; appHome?: string }
    screenshot?: { bytes: Uint8Array } | 'unavailable'
  },
): FileOutcome {
  const clean = cleanProblem(problem, o.paths)
  // The sender's fingerprint is a hint at best. Identity is what the content hashes to, computed here.
  const fingerprint = problemFingerprint(clean)
  // When it happened, not when it reached the Mac: a report held for days must not read as new. A time that is not a
  // time, or lies ahead of this machine's clock, reads as now.
  const at = Date.parse(clean.at)
  const seenAt = Number.isFinite(at) && at <= Date.parse(o.nowIso) ? new Date(at).toISOString() : o.nowIso
  const d = problemDirs(home)
  ensureDir(d.root)
  ensureDir(d.open)
  ensureDir(d.closed)
  const path = join(d.open, `${fingerprint}.json`)
  const existing = readJsonFile<StoredProblem>(path)
  if (existing && existing.v === 1) {
    if (existing.ids.includes(clean.id)) return { result: 'duplicate', fingerprint, count: existing.count, path }
    const seen = existing.versions_seen
    const sameVersion = seen.some((v) => JSON.stringify(v) === JSON.stringify(clean.versions))
    const next: StoredProblem = {
      ...existing,
      count: existing.count + 1,
      first_seen: [seenAt, existing.first_seen].sort()[0] as string,
      last_seen: [seenAt, existing.last_seen].sort()[1] as string,
      ids: [...existing.ids, clean.id].slice(-IDS_KEPT),
      versions_seen: sameVersion ? seen : [...seen, clean.versions].slice(-VERSIONS_KEPT),
      truncated: existing.truncated || clean.truncated,
    }
    writeJsonAtomic(path, next)
    return { result: 'merged', fingerprint, count: next.count, path }
  }
  const shot = o.screenshot
  const shotBytes = shot && shot !== 'unavailable' ? shot.bytes.length : 0
  // An owner report is never refused for room: the app already told them it was sent, and the relay has dropped its copy.
  // It makes what room it can (closed problems go first) and is filed either way.
  if (!makeRoom(home, shotBytes + 4096) && clean.kind !== 'owner')
    return { result: 'refused', fingerprint, reason: 'full' }
  const rec: StoredProblem = {
    v: 1,
    trust: 'external',
    fingerprint,
    source: clean.source,
    kind: clean.kind,
    name: clean.name,
    message: clean.message,
    frames: clean.frames,
    device: clean.device,
    routes: clean.routes,
    ...(clean.steps !== undefined ? { steps: clean.steps } : {}),
    versions_seen: [clean.versions],
    count: 1,
    first_seen: seenAt,
    last_seen: seenAt,
    truncated: clean.truncated,
    ids: [clean.id],
  }
  if (shot === 'unavailable') rec.screenshot_unavailable = true
  else if (shot) {
    const ext = EXT[clean.screenshot?.mime ?? ''] ?? 'img'
    const file = `${fingerprint}.${ext}`
    // The picture goes first: a report that names a file must never be on disk without it.
    writeFileAtomic(join(d.open, file), shot.bytes)
    rec.screenshot_file = file
  }
  writeJsonAtomic(path, rec)
  return { result: 'filed', fingerprint, count: 1, path }
}

export type ListedProblem = { fingerprint: string; closed: boolean; problem: StoredProblem | null; path: string }

export function listProblems(home: string, which: 'open' | 'closed' | 'all' = 'open'): ListedProblem[] {
  return entries(home)
    .filter((e) => e.name.endsWith('.json') && (which === 'all' || (which === 'closed') === e.closed))
    .sort((a, b) => b.mtime - a.mtime)
    .map((e) => {
      const p = readJsonFile<StoredProblem>(e.path)
      return { fingerprint: e.fingerprint, closed: e.closed, path: e.path, problem: p && p.v === 1 ? p : null }
    })
}

/** Finds one problem by the start of its fingerprint. A prefix that matches two is refused, never guessed. */
export function findProblem(home: string, prefix: string): ListedProblem | 'none' | 'ambiguous' {
  if (!/^[0-9a-f]{4,32}$/.test(prefix)) return 'none'
  const hits = listProblems(home, 'all').filter((l) => l.fingerprint.startsWith(prefix))
  if (hits.length === 0) return 'none'
  if (hits.length > 1) return 'ambiguous'
  return hits[0] as ListedProblem
}

/** Moves a problem and its picture from open/ to closed/. A repeat after this starts a new open file. */
export function closeProblem(home: string, fingerprint: string): boolean {
  const d = problemDirs(home)
  ensureDir(d.closed)
  let moved = false
  for (const e of entries(home)) {
    if (e.closed || e.fingerprint !== fingerprint) continue
    renameSync(e.path, join(d.closed, e.name))
    moved = true
  }
  return moved
}

export function screenshotPath(home: string, l: ListedProblem): string | undefined {
  const f = l.problem?.screenshot_file
  if (!f || f.includes('/') || f.includes('..')) return undefined
  const p = join(l.closed ? problemDirs(home).closed : problemDirs(home).open, f)
  return existsSync(p) ? p : undefined
}
