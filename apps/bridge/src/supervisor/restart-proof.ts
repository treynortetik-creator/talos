// The owner's proof on a restart request (agent-request.json `proof`): the Linux port of the Mac's RestartProofCheck
// (apps/desktop/Sources/TalosDesktopCore/RestartProof.swift), checked on the same shared fixtures
// (packages/protocol/fixtures/agent-request). A proof that verifies makes the request the owner's own tap on the phone: it skips
// the restart check (main-request.ts). One that claims the owner and does not verify is refused, whatever the check says.
//
// The steps, in the Mac's order: the device is pinned and not revoked (devices.json), its key is that device's, the
// `talos-owner/v1` signature holds over the exact signed bytes, those bytes are their own canonical JSON (a frame `agent.recover`,
// action `restart`, the proof's device, the file's control_id), and the proof was not used before. Then its signed time: within
// five minutes back and two ahead, at or after this supervisor's start, and after the newest one already accepted (the mark). A
// time that fails, or a form the canonical check cannot judge, is not a forgery: the request goes the agent's way, said so.
import { createHash } from 'node:crypto'
import { deviceIdFromJwk, type JwkP256T, jcs, verifyOwnerSignedString } from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import { readSmallFile } from './worker-dialogs.ts'

export const RESTART_PROOF_MAX_AGE_MS = 5 * 60_000
export const RESTART_PROOF_MAX_FUTURE_MS = 2 * 60_000
/** The newest used proofs kept (the Mac's DialogProofsUsed.keep). */
export const RESTART_PROOFS_KEPT = 64
const PROOFS_MAX_BYTES = 64 * 1024
const MARK_MAX_BYTES = 256
export const RESTART_PROOFS_USED_FILE = 'restart-proofs-used.json'
export const RESTART_PROOF_MARK_FILE = 'restart-proof-mark.json'

export type RestartProof = { deviceId: string; osig: string; signed: Uint8Array }
/** The step that failed (the Mac's RestartProofCheck.Step raw values). */
export type ProofStep = 'shape' | 'device' | 'signature' | 'frame' | 'control_id' | 'used'
/** Why a proof that verified is still not taken as the owner's word (the Mac's Unaccepted raw values). */
export type ProofUnaccepted = 'time_skew' | 'time_before_launch' | 'time_before_mark' | 'form_unknown'
export type ProofVerdict =
  | { ok: true; deviceId: string; usedKey: string; signedMs: number }
  | { ok: false; outOfTime: ProofUnaccepted; usedKey: string; signedMs: number | null }
  | { ok: false; step: ProofStep }

/** The used-list key of a proof: its signed bytes' hash. */
export const proofUsedKey = (p: RestartProof): string =>
  `restart|${createHash('sha256').update(p.signed).digest('hex')}`

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const parseIso = (v: unknown): number | null => {
  if (typeof v !== 'string' || !ISO.test(v)) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/**
 * The canonical form the Mac checks (RestartProofCheck.canonical): a flat object of strings, booleans, null and whole numbers
 * within the safe range, keys sorted by UTF-16 code units. null when a value is outside that (the form is unknown here, which is
 * not a forgery). For such a flat object JCS is the same text.
 */
function canonicalForm(o: Record<string, unknown>): string | null {
  for (const v of Object.values(o)) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') continue
    if (typeof v === 'number' && Number.isSafeInteger(v)) continue
    return null
  }
  return jcs(o)
}

/** The Mac's RestartProofCheck.verify. Never throws. */
export async function verifyRestartProof(
  p: RestartProof,
  o: {
    controlId: string
    nowMs: number
    launchedAtMs: number
    markMs: number
    /** How far ahead of this clock a signed time may be (default RESTART_PROOF_MAX_FUTURE_MS). */
    maxFutureMs?: number
    pinnedKey: (deviceId: string) => JwkP256T | undefined
    isUsed: (key: string) => boolean
  },
): Promise<ProofVerdict> {
  try {
    const key = o.pinnedKey(p.deviceId)
    if (!key || (await deviceIdFromJwk(key)) !== p.deviceId) return { ok: false, step: 'device' }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(p.signed)
    } catch {
      return { ok: false, step: 'signature' }
    }
    if (!(await verifyOwnerSignedString(text, p.osig, p.deviceId, key))) return { ok: false, step: 'signature' }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, step: 'frame' }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, step: 'frame' }
    const f = parsed as Record<string, unknown>
    const form = canonicalForm(f)
    if (form !== null && form !== text) return { ok: false, step: 'frame' }
    if (f.v !== 1 || f.type !== 'agent.recover' || f.action !== 'restart' || f.device_id !== p.deviceId)
      return { ok: false, step: 'frame' }
    if (f.control_id !== o.controlId) return { ok: false, step: 'control_id' }
    const usedKey = proofUsedKey(p)
    if (o.isUsed(usedKey)) return { ok: false, step: 'used' }
    const ts = parseIso(f.ts)
    if (form === null) return { ok: false, outOfTime: 'form_unknown', usedKey, signedMs: ts }
    if (
      ts === null ||
      o.nowMs - ts > RESTART_PROOF_MAX_AGE_MS ||
      ts - o.nowMs > (o.maxFutureMs ?? RESTART_PROOF_MAX_FUTURE_MS)
    )
      return { ok: false, outOfTime: 'time_skew', usedKey, signedMs: ts }
    if (ts < o.launchedAtMs) return { ok: false, outOfTime: 'time_before_launch', usedKey, signedMs: ts }
    if (o.markMs > 0 && ts <= o.markMs) return { ok: false, outOfTime: 'time_before_mark', usedKey, signedMs: ts }
    return { ok: true, deviceId: p.deviceId, usedKey, signedMs: ts }
  } catch {
    return { ok: false, step: 'signature' }
  }
}

/** The used list on disk ({"v":1,"used":[...]}); missing or not that shape reads as none. */
export function readProofsUsed(path: string): string[] {
  const f = readSmallFile(path, PROOFS_MAX_BYTES)
  if (f.kind !== 'data') return []
  try {
    const o = JSON.parse(f.text) as { v?: unknown; used?: unknown }
    return o.v === 1 && Array.isArray(o.used) ? o.used.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

/** The used list with `key` added (newest RESTART_PROOFS_KEPT), written 0600; false when it could not be written. */
export function recordProofUsed(path: string, memory: string[], key: string): { memory: string[]; written: boolean } {
  const all = [...new Set([...readProofsUsed(path), ...memory, key])].slice(-RESTART_PROOFS_KEPT)
  try {
    writeFileAtomic(path, JSON.stringify({ used: all, v: 1 }), 0o600)
    return { memory: all, written: true }
  } catch {
    return { memory: all, written: false }
  }
}

/** The mark ({"v":1,"signed_ms":n}), or null. */
export function readProofMark(path: string): number | null {
  const f = readSmallFile(path, MARK_MAX_BYTES)
  if (f.kind !== 'data') return null
  try {
    const o = JSON.parse(f.text) as { v?: unknown; signed_ms?: unknown }
    const n = o.signed_ms
    return o.v === 1 && typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

export const proofMarkText = (ms: number): string => JSON.stringify({ signed_ms: Math.trunc(ms), v: 1 })
