// A restart of Main asked for in `$TALOS_APP_HOME/agent-request.json` (the bridge writes it: the phone's signed Restart agent, or
// a session's `restart_main go`), acted on by the Linux supervisor: the Mac's AgentRecovery.swift and SupervisorRecovery.swift,
// ported, with one change the Linux side makes stricter. Each tick (`RestartActor.tick`):
//
// 1. TAKE. The request is renamed to agent-request.json.taken, that copy is read (one open refusing a link, a regular file of at
//    most 4096 bytes) and DELETED, all before anything is decided: a request is acted on at most once, whatever happens next,
//    a crash included (a .taken file left behind is discarded at the next start, never read). The same control_id is never acted
//    on twice in one run; a request older than five minutes, more than one ahead, or dated before this supervisor started is
//    discarded.
// 2. WHO. A proof that verifies (restart-proof.ts) makes it the owner's own tap: it skips the restart check, as on the Mac. Only
//    the owner's Stop, his own two-minute gap, and Claude Code's usage-limit menu (a restart would land on it again) refuse him.
//    Anything else (a session's request, the phone's through an older bridge, a proof whose time this computer does not take) is
//    checked again now: the reasons (main-restart-check.ts), the hourly cap, and any screen Main waits on the owner at. A proof
//    that claims the owner and does not verify is refused, whatever the check says.
// 3. ACT. A quiet stop, then a cold start; followed until Main is ready (`came_back`) or waits (`stalled`, said at once in the
//    default thread with what it waits at). Every outcome is in `last` in main-restart-check.json, which this actor also writes.
import { randomBytes } from 'node:crypto'
import { readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_REQUEST_FILE,
  b64urlDecode,
  DeviceId,
  type JwkP256T,
  type MainRestartLastT,
  type MainRestartReasonT,
  type MainStatus,
  ThreadId,
} from '@talos-app/protocol'
import { writeFileAtomic } from '../fsutil.ts'
import {
  AGENT_RESTARTS_PER_HOUR,
  type CheckInputs,
  clockLine,
  LABEL,
  type NeedsYouNow,
  needsYouLabel,
  PhoneLines,
  plainDetail,
  proofBadLine,
  REQUEST_MIN_GAP_S,
  RestartCheckFile,
  readLastBack,
  refusedLine,
  refusedUnprovedLine,
  refusedWaitingLine,
  restartingLine,
  restartReasons,
  STALL,
  stalledLine,
  usageRefusedLine,
} from './main-restart-check.ts'
import type { MainStateExtras } from './main-state.ts'
import {
  proofMarkText,
  RESTART_PROOF_MARK_FILE,
  RESTART_PROOFS_KEPT,
  RESTART_PROOFS_USED_FILE,
  type RestartProof,
  readProofMark,
  readProofsUsed,
  recordProofUsed,
  verifyRestartProof,
} from './restart-proof.ts'
import { readSmallFile } from './worker-dialogs.ts'

export const REQUEST_MAX_BYTES = 4096
export const REQUEST_MAX_AGE_MS = 300_000
export const REQUEST_MAX_FUTURE_MS = 60_000
const TAKEN_SUFFIX = '.taken'
const SIGNED_MAX = 1024

export type RequestProof = { kind: 'none' } | { kind: 'malformed' } | { kind: 'present'; proof: RestartProof }
export type AgentRequest = {
  controlId: string
  ts: number
  proof: RequestProof
  byThread: string | null
  why: string | null
}
export type TakenRequest = { kind: 'absent' } | { kind: 'invalid'; why: string } | { kind: 'request'; r: AgentRequest }

/** The Mac's AgentRequest.plainText: letters, digits and a few marks; anything else one space; 80 scalars, 320 bytes. */
export function plainText(s: string, max = 80): string {
  const out: string[] = []
  let bytes = 0
  for (const u of s) {
    const c = /^[\p{L}\p{Nd}.,:;!?'()\-/]$/u.test(u) ? u : out.length > 0 && out[out.length - 1] !== ' ' ? ' ' : null
    if (c === null) continue
    const n = Buffer.byteLength(c)
    if (out.length >= max || bytes + n > 320) break
    out.push(c)
    bytes += n
  }
  while (out[out.length - 1] === ' ') out.pop()
  return out.join('')
}

function proofOf(v: unknown): RequestProof {
  if (v === undefined) return { kind: 'none' }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { kind: 'malformed' }
  const p = v as Record<string, unknown>
  const keys = Object.keys(p).sort()
  if (keys.join(',') !== 'device_id,osig,signed_b64url') return { kind: 'malformed' }
  const { device_id: device, osig, signed_b64url: b64 } = p
  if (typeof device !== 'string' || !DeviceId.safeParse(device).success) return { kind: 'malformed' }
  if (typeof osig !== 'string' || osig.length !== 86 || !/^[A-Za-z0-9_-]+$/.test(osig)) return { kind: 'malformed' }
  if (typeof b64 !== 'string' || b64.length < 1 || b64.length > SIGNED_MAX || !/^[A-Za-z0-9_-]+$/.test(b64))
    return { kind: 'malformed' }
  try {
    if (b64urlDecode(osig).length !== 64) return { kind: 'malformed' }
    const signed = b64urlDecode(b64)
    if (signed.length === 0) return { kind: 'malformed' }
    return { kind: 'present', proof: { deviceId: device, osig, signed } }
  } catch {
    return { kind: 'malformed' }
  }
}

/** The Mac's AgentRequest.parse: lenient where it is (extra fields, a bad by_thread dropped), strict on what decides. */
export function parseRequest(text: string): AgentRequest | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (r.v !== 1 || r.action !== 'restart') return null
  const id = r.control_id
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts)) return null
  const by = typeof r.by_thread === 'string' && ThreadId.safeParse(r.by_thread).success ? r.by_thread : null
  const why = typeof r.why === 'string' ? plainText(r.why) || null : null
  return { controlId: id, ts: r.ts, proof: proofOf(r.proof), byThread: by, why }
}

/**
 * Takes the request: renamed aside, read, and deleted before anything is decided (so it is acted on at most once). `absent`:
 * there is none. A file that could not be moved aside is never read (it would be read again next tick).
 */
export function takeRequest(home: string): TakenRequest {
  const path = join(home, AGENT_REQUEST_FILE)
  // a name nobody can guess (a folder put at a fixed one would block every take; Fable R1-7)
  const taken = `${path}${TAKEN_SUFFIX}.${randomBytes(8).toString('hex')}`
  try {
    renameSync(path, taken)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'invalid', why: `not taken (${code ?? 'error'})` }
  }
  const f = readSmallFile(taken, REQUEST_MAX_BYTES)
  // gone before anything is decided; a folder put there goes too (removing a link never touches its target)
  try {
    rmSync(taken, { recursive: true, force: true })
  } catch {
    return { kind: 'invalid', why: 'could not be removed' }
  }
  if (f.kind !== 'data') return { kind: 'invalid', why: 'not a small regular file' }
  const r = parseRequest(f.text)
  return r ? { kind: 'request', r } : { kind: 'invalid', why: 'not a request' }
}

/** A .taken file left by a supervisor that stopped between taking and deleting: discarded unread. True when there was one. */
export function discardTakenLeftover(home: string): boolean {
  const prefix = AGENT_REQUEST_FILE + TAKEN_SUFFIX
  let found = false
  let names: string[] = []
  try {
    names = readdirSync(home)
  } catch {
    return false
  }
  for (const n of names) {
    if (n !== prefix && !n.startsWith(`${prefix}.`)) continue
    found = true
    try {
      rmSync(join(home, n), { recursive: true, force: true })
    } catch {
      // tried again at the next start
    }
  }
  return found
}

type Asker =
  | { kind: 'agent' }
  | { kind: 'owner'; usedKey: string; signedMs: number }
  | { kind: 'clock_off'; usedKey: string; why: string }
  | { kind: 'bad_proof'; step: string }

/** What the actor needs from the supervisor; everything is read fresh when it is used. */
export type RestartActorDeps = {
  home: string
  audit: (e: string, f?: Record<string, string>) => void
  /** Monotonic seconds (the gap and the line limits). */
  now: () => number
  wallMs: () => number
  /** When this supervisor started, whole unix ms: a request (or a proof) dated before it is from before. */
  launchedAtMs: number
  status: () => MainStatus
  /** main-state's extras as last published (a first-start screen Main waits at). */
  extras: () => MainStateExtras | undefined
  /** The reasons' inputs this supervisor reads itself (config, approval, claude, the pane's clients). */
  inputs: () => Promise<Omit<CheckInputs, 'phase' | 'ownerStopped' | 'sinceLastRequestS' | 'agentRestartsLastHour'>>
  ownerStopped: () => boolean
  /** A quiet stop (the owner is not told Main stopped), then a cold start. */
  stop: () => Promise<void>
  start: () => Promise<void>
  pinnedKey: (deviceId: string) => JwkP256T | undefined
  knownThread: (id: string) => boolean
  /** One line to the default thread, as the supervisor's own row. */
  post: (text: string) => Promise<void>
}

const HOUR_S = 3600
/** How far ahead of this computer's clock the owner's signed tap may be dated: the Mac's two minutes (RestartProofCheck). */
export const OWNER_TAP_MAX_FUTURE_MS = 120_000
/** The actor's own state across a restart (the guards deny it to sessions). */
export const RESTART_ACTOR_FILE = 'restart-actor.json'
/** Each kind of ignored request is audited at most once per this many seconds (a writer at one a second fills no log). */
const IGNORED_AUDIT_GAP_S = 60

export class RestartActor {
  private lastHandledId: string | null = null
  /** When (monotonic s) an owner's request, and one not the owner's, were last acted on. */
  private lastActedAt: number | null = null
  private lastAgentActedAt: number | null = null
  /** Requests not the owner's acted on (monotonic s), for the hourly cap. */
  private agentActs: number[] = []
  private proofsUsed: string[] | null = null
  private markMs = 0
  private last: MainRestartLastT | null
  /** The restart a request began: stopping, then started, then followed until it came back. */
  private restart: { id: string; started: boolean; stallSaid: boolean } | null = null
  private needsYou: NeedsYouNow | null = null
  private readonly lines = new PhoneLines()
  private readonly file: RestartCheckFile

  /** This start in the wall clock's terms now: the launch time, moved with any step of the wall clock since (by the monotonic). */
  private launchedNowMs(): number {
    return this.d.wallMs() - ((this.d.now() - this.startedAt) * 1000 + this.launchToStart)
  }
  private readonly startedAt: number
  private readonly launchToStart: number

  constructor(private readonly d: RestartActorDeps) {
    this.startedAt = d.now()
    this.launchToStart = Math.max(0, d.wallMs() - d.launchedAtMs)
    this.last = readLastBack(d.home)
    this.file = new RestartCheckFile({ home: d.home, audit: d.audit })
    if (discardTakenLeftover(d.home)) d.audit('agent_request_ignored', { why: 'left over from a stop mid-request' })
    this.loadState()
  }

  /** Wall ms to this run's monotonic seconds (a stamp dated ahead of the wall clock counts as now: it holds, never frees). */
  private toNow(ms: number): number {
    const wall = this.d.wallMs()
    return this.d.now() - Math.max(0, wall - Math.min(ms, wall)) / 1000
  }
  private toWall(s: number): number {
    return Math.round(this.d.wallMs() - (this.d.now() - s) * 1000)
  }

  /**
   * What the last supervisor kept (restart-actor.json, 0600; the guards deny it to sessions): the request it handled last, when an
   * owner's and a session's request were acted on, the session restarts of the past hour, when each line went, and the owner's
   * newest accepted signed time (kept here as well as in restart-proof-mark.json: deleting one file alone does not reopen a
   * replay). Code running as the same user that kills the supervisor and rewrites both is outside what this stops.
   */
  private loadState(): void {
    const f = readSmallFile(join(this.d.home, RESTART_ACTOR_FILE), 64 * 1024)
    if (f.kind === 'absent') return // a first run
    // a file there that does not read (truncated, a folder, a link, wrong types): never looser for a session's request than a
    // restart that just happened with the hourly cap reached; the owner's tap is not held by it (Fable R2 on the restart port)
    const unreadable = () => {
      const now = this.d.now()
      this.lastAgentActedAt = now
      this.agentActs = Array.from({ length: AGENT_RESTARTS_PER_HOUR }, () => now)
      this.d.audit('restart_state_unreadable', { file: RESTART_ACTOR_FILE })
    }
    if (f.kind !== 'data') {
      unreadable()
      return
    }
    try {
      const o = JSON.parse(f.text) as Record<string, unknown>
      if (typeof o !== 'object' || o === null || Array.isArray(o) || o.v !== 1) {
        unreadable()
        return
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
      // every field present must be its own type: one that is not makes the whole file unreadable
      const typed =
        (o.last_handled_id === undefined || typeof o.last_handled_id === 'string') &&
        ['owner_acted_ms', 'agent_acted_ms', 'mark_ms'].every((k) => o[k] === undefined || num(o[k]) !== null) &&
        (o.agent_acts_ms === undefined ||
          (Array.isArray(o.agent_acts_ms) && o.agent_acts_ms.every((t) => num(t) !== null))) &&
        (o.used === undefined || (Array.isArray(o.used) && o.used.every((u) => typeof u === 'string'))) &&
        (o.lines_ms === undefined ||
          (typeof o.lines_ms === 'object' && o.lines_ms !== null && !Array.isArray(o.lines_ms)))
      if (!typed) {
        unreadable()
        return
      }
      if (typeof o.last_handled_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(o.last_handled_id))
        this.lastHandledId = o.last_handled_id
      const owner = num(o.owner_acted_ms)
      if (owner !== null) this.lastActedAt = this.toNow(owner)
      const agent = num(o.agent_acted_ms)
      if (agent !== null) this.lastAgentActedAt = this.toNow(agent)
      if (Array.isArray(o.agent_acts_ms))
        this.agentActs = o.agent_acts_ms.slice(-16).flatMap((t) => (num(t) === null ? [] : [this.toNow(t as number)]))
      if (typeof o.lines_ms === 'object' && o.lines_ms !== null)
        for (const [k, t] of Object.entries(o.lines_ms as Record<string, unknown>))
          if (num(t) !== null && ['restarting', 'refused', 'stalled'].includes(k))
            this.lines.seed(k, this.toNow(t as number))
      if (Array.isArray(o.used))
        this.stateUsed = o.used
          .filter((u): u is string => typeof u === 'string' && u.length <= 80)
          .slice(-RESTART_PROOFS_KEPT)
      const mark = num(o.mark_ms)
      if (mark !== null) this.markMs = Math.max(this.markMs, Math.min(mark, this.d.launchedAtMs))
    } catch {
      unreadable()
    }
  }

  private saveState(): void {
    try {
      writeFileAtomic(
        join(this.d.home, RESTART_ACTOR_FILE),
        JSON.stringify({
          v: 1,
          ...(this.lastHandledId ? { last_handled_id: this.lastHandledId } : {}),
          ...(this.lastActedAt !== null ? { owner_acted_ms: this.toWall(this.lastActedAt) } : {}),
          ...(this.lastAgentActedAt !== null ? { agent_acted_ms: this.toWall(this.lastAgentActedAt) } : {}),
          agent_acts_ms: this.agentActs.map((t) => this.toWall(t)),
          lines_ms: Object.fromEntries(Object.entries(this.lines.posted()).map(([k, t]) => [k, this.toWall(t)])),
          ...(this.markMs > 0 ? { mark_ms: this.markMs } : {}),
          // the owner's proofs already used, a second time (restart-proofs-used.json is the first)
          used: [...new Set([...this.stateUsed, ...(this.proofsUsed ?? [])])].slice(-RESTART_PROOFS_KEPT),
        }),
        0o600,
      )
    } catch (e) {
      this.d.audit('restart_state_write_failed', { error: String((e as Error)?.message ?? e) })
    }
  }

  /** Seconds since the last request this asker is held to (the Mac's RecoveryState.sinceLastRequest). */
  private sinceLastRequest(owner: boolean, now: number): number | null {
    const mine = this.lastActedAt
    if (owner) return mine === null ? null : now - mine
    const latest = Math.max(mine ?? -Infinity, this.lastAgentActedAt ?? -Infinity)
    return Number.isFinite(latest) ? now - latest : null
  }

  private agentCount(now: number): number {
    this.agentActs = this.agentActs.filter((t) => now - t < HOUR_S)
    return this.agentActs.length
  }

  /** An ignored request, audited at most once per IGNORED_AUDIT_GAP_S for the same reason (Fable R1-7). */
  private ignored(why: string): void {
    const now = this.d.now()
    const at = this.ignoredAt.get(why)
    if (at !== undefined && now - at < IGNORED_AUDIT_GAP_S) return
    this.ignoredAt.set(why, now)
    this.d.audit('agent_request_ignored', { why })
  }
  private readonly ignoredAt = new Map<string, number>()
  /** The used proofs as the actor's own state kept them (read at a start). */
  private stateUsed: string[] = []

  private async checkInputs(now: number): Promise<CheckInputs> {
    return {
      ...(await this.d.inputs()),
      phase: this.d.status().phase,
      ownerStopped: this.d.ownerStopped(),
      sinceLastRequestS: this.sinceLastRequest(false, now),
      agentRestartsLastHour: this.agentCount(now),
    }
  }

  private setLast(l: MainRestartLastT): void {
    this.last = l
    this.file.markDirty()
  }

  private record(id: string, outcome: MainRestartLastT['outcome'], detail?: string): void {
    const det = detail !== undefined ? plainDetail(detail) : undefined
    this.setLast({
      control_id: id,
      at: new Date(this.d.wallMs()).toISOString(),
      outcome,
      ...(det ? { detail: det } : {}),
    })
  }

  private say(kind: 'restarting' | 'refused' | 'stalled', text: string): void {
    if (!this.lines.take(kind, this.d.now())) return
    this.saveState()
    this.d
      .post(text)
      .then(
        () => this.d.audit('restart_line', { kind, ok: '1' }),
        (e) => this.d.audit('restart_line', { kind, ok: '0', error: String((e as Error)?.message ?? e) }),
      )
      .finally(() => this.lines.finished())
  }

  private async asker(r: AgentRequest): Promise<Asker> {
    if (r.proof.kind === 'none') return { kind: 'agent' }
    if (r.proof.kind === 'malformed') return { kind: 'bad_proof', step: 'shape' }
    if (this.proofsUsed === null) {
      // seeded once: the newest kept, and the mark capped at this start (a file can only say what came before it)
      this.proofsUsed = [
        ...new Set([...this.stateUsed, ...readProofsUsed(join(this.d.home, RESTART_PROOFS_USED_FILE))]),
      ]
      // (both places: restart-proof-mark.json and the actor's own state, each capped at this start)
      const m = readProofMark(join(this.d.home, RESTART_PROOF_MARK_FILE))
      if (m !== null) this.markMs = Math.max(this.markMs, Math.min(m, this.d.launchedAtMs))
    }
    const used = this.proofsUsed
    const v = await verifyRestartProof(r.proof.proof, {
      controlId: r.controlId,
      nowMs: this.d.wallMs(),
      launchedAtMs: this.d.launchedAtMs,
      markMs: this.markMs,
      // as the Mac: a phone's clock may run up to two minutes ahead of this one (Fable R2-1 on the restart port; the replay this
      // leaves needs code past the guards, the docs' stated limit)
      maxFutureMs: OWNER_TAP_MAX_FUTURE_MS,
      pinnedKey: this.d.pinnedKey,
      isUsed: (k) => used.includes(k) || readProofsUsed(join(this.d.home, RESTART_PROOFS_USED_FILE)).includes(k),
    })
    if (v.ok) return { kind: 'owner', usedKey: v.usedKey, signedMs: v.signedMs }
    if ('outOfTime' in v) return { kind: 'clock_off', usedKey: v.usedKey, why: v.outOfTime }
    return { kind: 'bad_proof', step: v.step }
  }

  /** Spends a proof that verified, whatever the decision; true when the used list reached the disk (only then is it his word). */
  private spend(a: Asker): boolean {
    if (a.kind !== 'owner' && a.kind !== 'clock_off') return false
    const rec = recordProofUsed(join(this.d.home, RESTART_PROOFS_USED_FILE), this.proofsUsed ?? [], a.usedKey)
    this.proofsUsed = rec.memory
    if (a.kind === 'owner' && a.signedMs > this.markMs) {
      this.markMs = a.signedMs
      try {
        writeFileAtomic(join(this.d.home, RESTART_PROOF_MARK_FILE), proofMarkText(a.signedMs), 0o600)
      } catch {
        this.d.audit('restart_proof_mark_write_failed')
      }
    }
    this.saveState()
    return rec.written
  }

  private refuse(r: AgentRequest, detail: string | undefined, line: string, audit: Record<string, string>): void {
    this.lastHandledId = r.controlId
    this.record(r.controlId, 'refused', detail)
    this.saveState()
    this.d.audit('agent_request_refused', audit)
    this.say('refused', line)
  }

  private async handle(r: AgentRequest): Promise<void> {
    const nowMs = this.d.wallMs()
    if (
      r.controlId === this.lastHandledId ||
      nowMs - r.ts > REQUEST_MAX_AGE_MS ||
      r.ts - nowMs > REQUEST_MAX_FUTURE_MS ||
      r.ts < this.launchedNowMs()
    ) {
      this.ignored('stale, repeated, or from before this start')
      return
    }
    const a = await this.asker(r)
    if (a.kind === 'bad_proof') {
      this.lastHandledId = r.controlId
      this.record(r.controlId, 'refused')
      this.saveState()
      this.d.audit('restart_proof_bad', { step: a.step })
      this.say('refused', proofBadLine)
      return
    }
    const asOwner = this.spend(a) && a.kind === 'owner'
    if (a.kind === 'owner' && !asOwner) this.d.audit('restart_proof_unrecorded')
    const lead = a.kind === 'clock_off' ? `${clockLine(a.why)} ` : ''
    const proof = asOwner ? 'owner' : a.kind
    const now = this.d.now()
    if (this.d.ownerStopped())
      return this.refuse(r, 'owner_stopped', lead + refusedLine('owner_stopped'), { why: 'owner_stopped', proof })
    const since = this.sinceLastRequest(asOwner, now)
    if (since !== null && since < REQUEST_MIN_GAP_S)
      return this.refuse(r, 'too_soon', lead + refusedLine('too_soon'), { why: 'too_soon', proof })
    // the usage-limit menu: a restart would land on the same menu, for the owner too
    const label = needsYouLabel(this.d.status(), this.d.extras())
    if (label === LABEL.usage) return this.refuse(r, label, lead + usageRefusedLine, { why: 'usage_limit', proof })
    if (!asOwner) {
      // not the owner's word: checked again now, and refused at any screen Main waits on the owner at
      if (label !== null) return this.refuse(r, label, lead + refusedWaitingLine(label), { why: 'needs_you', proof })
      const why: MainRestartReasonT | undefined = restartReasons(await this.checkInputs(now))[0]
      if (why !== undefined) {
        const unproved = r.proof.kind === 'none' && r.byThread === null
        return this.refuse(r, why, lead + (unproved ? refusedUnprovedLine(why) : refusedLine(why)), { why, proof })
      }
    }
    this.lastHandledId = r.controlId
    if (asOwner) this.lastActedAt = now
    else {
      this.lastAgentActedAt = now
      this.agentActs.push(now)
    }
    this.saveState()
    this.d.audit('agent_request', { action: 'restart', proof })
    if (a.kind === 'clock_off') this.say('restarting', clockLine(a.why))
    else if (!asOwner)
      this.say(
        'restarting',
        restartingLine(r.byThread, r.byThread !== null && this.d.knownThread(r.byThread), r.proof.kind === 'none'),
      )
    this.restart = { id: r.controlId, started: false, stallSaid: false }
    const phase = this.d.status().phase
    if (phase !== 'stopped' && phase !== 'idle') await this.d.stop()
  }

  /** The restart a request began: started once Main is down, then followed to `came_back` or `stalled`. */
  private async follow(): Promise<void> {
    const f = this.restart
    if (!f) return
    const st = this.d.status()
    if (!f.started) {
      if (st.phase !== 'stopped' && st.phase !== 'idle') return
      // the owner's Stop while it was on its way down wins: nothing is started
      if (this.d.ownerStopped()) {
        this.restart = null
        return
      }
      f.started = true
      await this.d.start()
      return
    }
    const label = needsYouLabel(st, this.d.extras())
    let stall: string | null = label
    if (stall === null && st.phase === 'blocked') stall = STALL.blocked
    if (stall === null && (st.phase === 'stopped' || st.phase === 'idle')) stall = STALL.notStarted
    if (stall === null && st.needsYou?.kind === 'start_stalled') stall = STALL.nothingKnown
    if (stall !== null) {
      if (this.last?.control_id !== f.id || this.last.outcome !== 'stalled' || this.last.detail !== stall)
        this.record(f.id, 'stalled', stall)
      if (!f.stallSaid) {
        f.stallSaid = true
        this.d.audit('restart_stalled', { detail: stall })
        this.say('stalled', stalledLine(stall))
      }
      // a start that could not be made is over; a dialog may still be answered, and is followed on
      if (stall === STALL.notStarted) this.restart = null
      return
    }
    if (st.phase === 'running') {
      this.record(f.id, 'came_back')
      this.d.audit('restart_came_back')
      this.restart = null
    }
  }

  /** The needs-you this file says now, and since when (the wall clock it was first seen at). */
  private noteNeedsYou(): void {
    const st = this.d.status()
    const label = needsYouLabel(st, this.d.extras())
    if (label === null) {
      if (this.needsYou !== null) this.file.markDirty()
      this.needsYou = null
      return
    }
    const n = st.needsYou
    const resets = n?.kind === 'usage_limit' && label === LABEL.usage ? n.resets_at : undefined
    if (this.needsYou?.kind !== label || this.needsYou.resets_at !== resets) {
      this.needsYou = {
        kind: label,
        since: this.needsYou?.kind === label ? this.needsYou.since : new Date(this.d.wallMs()).toISOString(),
        ...(resets ? { resets_at: resets } : {}),
      }
      this.file.markDirty()
    }
  }

  async tick(): Promise<void> {
    const t = takeRequest(this.d.home)
    if (t.kind === 'invalid') this.ignored(t.why)
    else if (t.kind === 'request') await this.handle(t.r)
    await this.follow()
    this.noteNeedsYou()
    const atMs = this.d.wallMs()
    if (!this.file.due(atMs)) return
    this.file.write({
      atMs,
      reasons: restartReasons(await this.checkInputs(this.d.now())),
      last: this.last,
      needsYou: this.needsYou,
    })
  }
}
