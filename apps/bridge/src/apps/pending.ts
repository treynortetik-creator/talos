// Pending app requests, shared by the live bridge and the hook processes through files (M5.2, M5.5). One schema
// (AppPendingRequest). A claim is an atomic rename into claimed/, so only one process wins it.
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AppPendingRequest, type AppPendingRequestT, AppRequestId, CaptureId, IsoTs, jcs } from '@talos-app/protocol'
import type { z } from 'zod'
import { ensureDir, writeJsonAtomic } from '../fsutil.ts'
import type { AppPaths } from './paths.ts'

/** A pending file that has been claimed by a PreToolUse call: the request plus the call that took it. */
export const ClaimedRequest = AppPendingRequest.extend({ tool_use_id: CaptureId, claimed_at: IsoTs })
export type ClaimedRequestT = z.infer<typeof ClaimedRequest>

/** Pending timeouts (M5.5). */
export const AUTHORISED_UNCLAIMED_MS = 120_000
export const CLAIM_TO_POST_MS = 120_000
export const CARD_GRACE_MS = 120_000
export const TOMBSTONE_MS = 10 * 60_000

export function ensureAppDirs(p: AppPaths): void {
  for (const d of [p.dir, p.resources, p.captures, p.pending, p.claimed]) ensureDir(d)
}

const fileOf = (dir: string, id: string) => join(dir, `${id}.json`)

export function writePending(p: AppPaths, req: AppPendingRequestT): void {
  const parsed = AppPendingRequest.parse(req)
  ensureDir(p.pending)
  writeJsonAtomic(fileOf(p.pending, parsed.request_id), parsed, 0o600)
}

export function readPending(p: AppPaths, id: string): AppPendingRequestT | undefined {
  if (!AppRequestId.safeParse(id).success) return undefined
  try {
    const r = AppPendingRequest.safeParse(JSON.parse(readFileSync(fileOf(p.pending, id), 'utf8')))
    return r.success ? r.data : undefined
  } catch {
    return undefined
  }
}

export function removePending(p: AppPaths, id: string): void {
  if (!AppRequestId.safeParse(id).success) return
  for (const dir of [p.pending, p.claimed]) {
    try {
      unlinkSync(fileOf(dir, id))
    } catch {
      // already gone
    }
  }
}

export type PendingListing = {
  requests: AppPendingRequestT[]
  /** Files that exist but do not parse, with their age in ms. The gate treats a recent one as an error (fail closed). */
  corrupt: Array<{ file: string; ageMs: number }>
}

export function listPending(p: AppPaths, nowMs: number): PendingListing {
  const out: PendingListing = { requests: [], corrupt: [] }
  let names: string[]
  try {
    names = readdirSync(p.pending)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw e
  }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue
    const f = join(p.pending, n)
    try {
      const r = AppPendingRequest.safeParse(JSON.parse(readFileSync(f, 'utf8')))
      if (r.success && `${r.data.request_id}.json` === n) out.requests.push(r.data)
      else out.corrupt.push({ file: n, ageMs: nowMs - statSync(f).mtimeMs })
    } catch {
      let age = 0
      try {
        age = nowMs - statSync(f).mtimeMs
      } catch {
        continue // vanished between readdir and read: someone claimed it
      }
      out.corrupt.push({ file: n, ageMs: age })
    }
  }
  return out
}

export function listClaimed(
  p: AppPaths,
): Array<{ req: ClaimedRequestT | AppPendingRequestT; linked: boolean; mtimeMs: number }> {
  const out: Array<{ req: ClaimedRequestT | AppPendingRequestT; linked: boolean; mtimeMs: number }> = []
  let names: string[]
  try {
    names = readdirSync(p.claimed)
  } catch {
    return out
  }
  for (const n of names) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue
    const f = join(p.claimed, n)
    try {
      const raw: unknown = JSON.parse(readFileSync(f, 'utf8'))
      const mtimeMs = statSync(f).mtimeMs
      const linked = ClaimedRequest.safeParse(raw)
      if (linked.success) {
        out.push({ req: linked.data, linked: true, mtimeMs })
        continue
      }
      const bare = AppPendingRequest.safeParse(raw)
      if (bare.success) out.push({ req: bare.data, linked: false, mtimeMs })
    } catch {
      // half-written or gone
    }
  }
  return out
}

export function readClaimedByToolUse(p: AppPaths, toolUseId: string): ClaimedRequestT | undefined {
  for (const c of listClaimed(p))
    if (c.linked && (c.req as ClaimedRequestT).tool_use_id === toolUseId) return c.req as ClaimedRequestT
  return undefined
}

/**
 * Takes the request by renaming it into claimed/. Exactly one caller wins: a rename of a file that is already gone throws.
 * Returns false for a loser (or a request that vanished). The winner then links the call that took it.
 */
export function claim(p: AppPaths, req: AppPendingRequestT, toolUseId: string, nowIso: string): boolean {
  ensureDir(p.claimed)
  try {
    renameSync(fileOf(p.pending, req.request_id), fileOf(p.claimed, req.request_id))
  } catch {
    return false
  }
  writeJsonAtomic(
    fileOf(p.claimed, req.request_id),
    ClaimedRequest.parse({ ...req, tool_use_id: toolUseId, claimed_at: nowIso }),
    0o600,
  )
  return true
}

/** JCS equality: `1.0` and `1` are the same number, key order is irrelevant. */
export function sameArguments(a: unknown, b: unknown): boolean {
  try {
    return jcs(a) === jcs(b)
  } catch {
    return false
  }
}

/** The state a request is really in at `nowMs`: a deadline that passed before the bridge swept it counts as a tombstone. */
export function effectiveState(
  req: AppPendingRequestT,
  nowMs: number,
): { state: 'authorised' | 'awaiting_card' | 'expired' | 'gone' } {
  const deadline = Date.parse(req.expires_at)
  if (!Number.isFinite(deadline)) return { state: 'expired' }
  if (req.state === 'expired') return { state: nowMs <= deadline ? 'expired' : 'gone' }
  if (nowMs <= deadline) return { state: req.state }
  return { state: nowMs <= deadline + TOMBSTONE_MS ? 'expired' : 'gone' }
}

export { AppRequestId }
