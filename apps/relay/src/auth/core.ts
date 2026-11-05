// All auth state and rules, with no HTTP in it: sessions, enrollment codes, passkey credentials, step-up tokens, the
// device registry and bridge keys. Everything lives in the `auth_*` tables (migrations/auth/0001_init.sql).
import { createHash } from 'node:crypto'
import type { JwkP256T } from '@talos-app/protocol'
import { b64urlDecode, bridgeKeyId, enrollCodeId, randomBytes } from '@talos-app/protocol'
import type Database from 'better-sqlite3'
import type { RelayServices } from '../services.ts'
import {
  BRIDGE_NONCE_TTL_MS,
  BRIDGE_PREVIOUS_KEY_MS,
  CHALLENGE_TTL_MS,
  ENROLL_FAILURE_LIMIT,
  ENROLL_FAILURE_WINDOW_MS,
  newToken,
  STEPUP_TTL_MS,
  sessionIdleMs,
  sessionTtlMs,
  sha256,
} from './util.ts'

/** Why a session ended. The app keeps unsent messages only for 'expired' and 'signed_in_again'; any other value, or none, wipes them. */
export type SessionEndReason =
  | 'expired'
  | 'revoked'
  | 'logged_out'
  | 'logged_out_everywhere'
  | 'replaced'
  | 'signed_in_again'
/**
 * A cookie lives as long as the sign-in length in force when it was issued, and that setting can be lowered later. So every
 * end record is kept for the largest value the setting allows (365 days), whatever the current setting is.
 */
const SESSION_END_KEEP_MS = 365 * 24 * 3600_000

export type SessionRow = { id: string; credentialId: string | null; deviceId: string | null; slid?: boolean }
export type CredentialRow = {
  credentialId: string
  publicKey: Uint8Array
  counter: number
  transports: string[] | undefined
  deviceName: string
  createdAt: number
  lastUsedAt: number | null
}
export type DeviceRow = {
  id: string
  name: string
  pubkeyJwk: JwkP256T
  credentialId: string | null
  binding: string
  codeId: string | null
  pinned: boolean
  revoked: boolean
  createdAt: number
  lastUsedAt: number | null
  /** When this device first signed in by proving its device key; null until then (older clients never do). */
  loginProvenAt: number | null
}
export type TrustedKey = { keyId: string; publicKeyB64: string }

/** A device's last-used time moves at most this often. Fine enough for "used 5 minutes ago", coarse enough to be cheap. */
export const DEVICE_USE_INTERVAL_MS = 5 * 60_000
/** After a failed last-used write, that device is not tried again (or logged again) for this long. */
export const DEVICE_USE_RETRY_MS = 60_000

export class AuthCore {
  /** When this process last wrote each device's last-used time, so a busy socket does not ask the database every frame. */
  private deviceUseSeen = new Map<string, number>()
  /** When each device's last-used write last failed, so a broken database is logged and retried once a minute, not per frame. */
  private deviceUseFailed = new Map<string, number>()
  readonly db: Database.Database
  private readonly ttlMs: number
  private readonly idleMs: number
  constructor(private services: RelayServices) {
    this.ttlMs = sessionTtlMs(services.env)
    this.idleMs = sessionIdleMs(services.env)
    this.db = services.db
    this.adoptForcedEnvKey()
  }

  /**
   * Recovery boot (BRIDGE_PUBKEY_FORCE=1): the env key becomes THE active key and every stored key is retired, in one
   * transaction. Without this the rotated key stays in the table as 'active', and turning FORCE off again would trust
   * a key the owner just declared dead (audit D12). Runs once per relay start, when the auth state is first built.
   */
  private adoptForcedEnvKey(): void {
    const env = this.envKey()
    if (!env || !this.services.env.BRIDGE_PUBKEY_FORCE) return
    const now = this.now()
    this.db.transaction(() => {
      this.db.prepare('delete from auth_bridge_keys').run()
      this.db
        .prepare(
          "insert into auth_bridge_keys (key_id, pubkey, status, created_at, valid_until) values (?, ?, 'active', ?, null)",
        )
        .run(env.keyId, env.publicKeyB64, now)
    })()
  }

  private now(): number {
    return this.services.clock.now()
  }

  /** Removes expired rows. Cheap enough to run on every login and enrollment call. */
  purge(): void {
    const now = this.now()
    this.db.prepare('delete from auth_challenges where expires_at <= ?').run(now)
    this.db.prepare('delete from auth_stepup where expires_at <= ?').run(now)
    this.db.prepare('delete from auth_bridge_nonces where expires_at <= ?').run(now)
    this.db.prepare('delete from auth_enroll_codes where expires_at <= ?').run(now - 24 * 3600_000)
    this.endSessions('expires_at <= ? or last_seen_at <= ?', [now, now - this.idleMs], 'expired')
    this.db.prepare('delete from auth_session_ends where ended_at <= ?').run(now - SESSION_END_KEEP_MS)
    this.db.prepare('delete from auth_bridge_keys where status = ? and valid_until <= ?').run('previous', now)
  }

  // ---- user ------------------------------------------------------------------------------------------------------

  /** The fixed WebAuthn userID: 16 random bytes created once. */
  userHandle(): Uint8Array<ArrayBuffer> {
    const row = this.db.prepare('select user_handle from auth_user where id = 1').get() as
      | { user_handle: Buffer }
      | undefined
    if (row) return new Uint8Array(row.user_handle)
    const handle = randomBytes(16)
    this.db
      .prepare('insert or ignore into auth_user (id, user_handle, created_at) values (1, ?, ?)')
      .run(Buffer.from(handle), this.now())
    const again = this.db.prepare('select user_handle from auth_user where id = 1').get() as { user_handle: Buffer }
    return new Uint8Array(again.user_handle)
  }

  // ---- credentials -----------------------------------------------------------------------------------------------

  private credFrom(r: Record<string, unknown>): CredentialRow {
    return {
      credentialId: r.credential_id as string,
      publicKey: new Uint8Array(r.public_key as Buffer),
      counter: r.counter as number,
      transports: r.transports ? (JSON.parse(r.transports as string) as string[]) : undefined,
      deviceName: r.device_name as string,
      createdAt: r.created_at as number,
      lastUsedAt: (r.last_used_at as number | null) ?? null,
    }
  }

  credentials(): CredentialRow[] {
    return (
      this.db.prepare('select * from auth_credentials order by created_at').all() as Record<string, unknown>[]
    ).map((r) => this.credFrom(r))
  }

  credential(id: string): CredentialRow | null {
    const r = this.db.prepare('select * from auth_credentials where credential_id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return r ? this.credFrom(r) : null
  }

  addCredential(c: {
    credentialId: string
    publicKey: Uint8Array
    counter: number
    transports?: string[]
    deviceName: string
  }): void {
    this.db
      .prepare(
        'insert into auth_credentials (credential_id, public_key, counter, transports, device_name, created_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(
        c.credentialId,
        Buffer.from(c.publicKey),
        c.counter,
        c.transports ? JSON.stringify(c.transports) : null,
        c.deviceName,
        this.now(),
      )
  }

  touchCredential(id: string, counter: number): void {
    this.db
      .prepare('update auth_credentials set counter = ?, last_used_at = ? where credential_id = ?')
      .run(counter, this.now(), id)
  }

  // ---- enrollment codes ------------------------------------------------------------------------------------------

  addCode(c: { codeId: string; hash: string; expiresAt: number; label?: string }): 'created' | 'exists' | 'conflict' {
    const row = this.db.prepare('select code_auth_hash from auth_enroll_codes where code_id = ?').get(c.codeId) as
      | { code_auth_hash: string }
      | undefined
    if (row) return row.code_auth_hash === c.hash ? 'exists' : 'conflict'
    if (enrollCodeId(c.hash) !== c.codeId) return 'conflict'
    this.db
      .prepare(
        'insert into auth_enroll_codes (code_id, code_auth_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?)',
      )
      .run(c.codeId, c.hash, c.label ?? null, this.now(), c.expiresAt)
    return 'created'
  }

  /** The unburned, unused, unexpired code whose hash is sha256(codeAuth), or null. Does not count a failure. */
  findCode(codeAuth: string): { codeId: string; expiresAt: number; registeredCredentialId: string | null } | null {
    const r = this.db
      .prepare(
        'select code_id, expires_at, registered_credential_id from auth_enroll_codes where code_auth_hash = ? and used_at is null and burned_at is null and expires_at > ?',
      )
      .get(sha256(codeAuth), this.now()) as
      | { code_id: string; expires_at: number; registered_credential_id: string | null }
      | undefined
    return r ? { codeId: r.code_id, expiresAt: r.expires_at, registeredCredentialId: r.registered_credential_id } : null
  }

  /** One passkey per code: true only for the first registration that claims it. */
  claimCodeForRegistration(codeId: string, credentialId: string): boolean {
    return (
      this.db
        .prepare(
          'update auth_enroll_codes set registered_at = ?, registered_credential_id = ? where code_id = ? and registered_at is null',
        )
        .run(this.now(), credentialId, codeId).changes === 1
    )
  }

  /**
   * Checks a presented code_auth. A miss is recorded; the 5th miss in 10 minutes (from any IP) burns every outstanding
   * code, because a wrong code_auth matches no code so failures cannot be counted per code (spec 5.2).
   */
  checkCode(codeAuth: string): ReturnType<AuthCore['findCode']> {
    const hit = this.findCode(codeAuth)
    if (hit) return hit
    this.recordEnrollFailure()
    return null
  }

  /**
   * Counts one failed code attempt; the 5th in 10 minutes burns every outstanding code. `heldCodeId` is a code the failing
   * call has claimed (used_at set, so "outstanding" skips it): it burns too, or whoever holds a leaked code could loop
   * wrong proofs, burn the owner's other codes and keep their own.
   */
  recordEnrollFailure(heldCodeId?: string): void {
    const now = this.now()
    this.db.prepare('insert into auth_enroll_failures (at) values (?)').run(now)
    this.db.prepare('delete from auth_enroll_failures where at <= ?').run(now - ENROLL_FAILURE_WINDOW_MS)
    const { n } = this.db.prepare('select count(*) as n from auth_enroll_failures').get() as { n: number }
    if (n >= ENROLL_FAILURE_LIMIT) {
      this.db.prepare('update auth_enroll_codes set burned_at = ? where used_at is null and burned_at is null').run(now)
      if (heldCodeId !== undefined)
        this.db
          .prepare('update auth_enroll_codes set burned_at = ? where code_id = ? and burned_at is null')
          .run(now, heldCodeId)
      this.db.prepare('delete from auth_enroll_failures').run()
    }
  }

  /** The setup code (public id) that minted this session via enroll/session, or null for a passkey session. */
  sessionEnrollCodeId(sessionId: string): string | null {
    return (
      (this.db.prepare('select enroll_code_id from auth_sessions where id = ?').pluck().get(sessionId) as
        | string
        | null
        | undefined) ?? null
    )
  }

  /**
   * Takes the code for ONE device/verify call, atomically and synchronously (WP-N0 review F2: before the first await, so
   * two parallel calls cannot both enroll). True only for the call that got it.
   */
  claimCode(codeId: string): boolean {
    return (
      this.db
        .prepare('update auth_enroll_codes set used_at = ? where code_id = ? and used_at is null and burned_at is null')
        .run(this.now(), codeId).changes === 1
    )
  }

  /** Gives a claimed code back when the call that claimed it did not enroll anything (a retry with proof must work). */
  releaseCode(codeId: string): void {
    this.db.prepare('update auth_enroll_codes set used_at = null where code_id = ? and burned_at is null').run(codeId)
  }

  markCodeUsed(codeId: string): void {
    this.db.prepare('update auth_enroll_codes set used_at = ? where code_id = ?').run(this.now(), codeId)
  }

  // ---- sessions --------------------------------------------------------------------------------------------------

  /** Creates a session and returns the cookie value (only its sha256 is stored). */
  createSession(credentialId: string | null, deviceId: string | null): string {
    const token = newToken(32)
    const now = this.now()
    this.db
      .prepare(
        'insert into auth_sessions (id, credential_id, device_id, created_at, last_seen_at, expires_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run(sha256(token), credentialId, deviceId, now, now, now + this.ttlMs)
    return token
  }

  /**
   * WP-N0: the session a setup code buys in a native shell. Unpinned and passkey-less (`credential_id` null). One per
   * code: any session an earlier call made for this code is deleted in the same transaction, so two never coexist.
   */
  createSessionForCode(codeId: string): string {
    const token = newToken(32)
    const now = this.now()
    this.db.transaction(() => {
      this.db.prepare('delete from auth_sessions where enroll_code_id = ?').run(codeId)
      this.db
        .prepare(
          'insert into auth_sessions (id, credential_id, device_id, created_at, last_seen_at, expires_at, enroll_code_id) values (?, null, null, ?, ?, ?, ?)',
        )
        .run(sha256(token), now, now, now + this.ttlMs, codeId)
    })()
    return token
  }

  /** Valid, unexpired, not idle for 14 days. Slides the 30-day expiry forward. */
  lookupSession(token: string | null): SessionRow | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    const id = sha256(token)
    const r = this.db.prepare('select * from auth_sessions where id = ?').get(id) as
      | { id: string; credential_id: string | null; device_id: string | null; last_seen_at: number; expires_at: number }
      | undefined
    if (!r) return null
    const now = this.now()
    if (now >= r.expires_at || now - r.last_seen_at > this.idleMs) {
      this.endSessions('id = ?', [id], 'expired')
      return null
    }
    if (now - r.last_seen_at > 60_000) {
      this.db
        .prepare('update auth_sessions set last_seen_at = ?, expires_at = ? where id = ?')
        .run(now, now + this.ttlMs, id)
      return { id, credentialId: r.credential_id, deviceId: r.device_id, slid: true }
    }
    return { id, credentialId: r.credential_id, deviceId: r.device_id }
  }

  attachDevice(sessionId: string, deviceId: string): void {
    this.db.prepare('update auth_sessions set device_id = ? where id = ?').run(deviceId, sessionId)
  }
  /** True while the session row exists and has not expired. Does not slide the expiry. */
  sessionExists(sessionId: string): boolean {
    const r = this.db.prepare('select expires_at from auth_sessions where id = ?').get(sessionId) as
      | { expires_at: number }
      | undefined
    return Boolean(r && r.expires_at > this.now())
  }

  /** Ends sessions and remembers why, in one step: the app asks (`endedReason`) when its cookie stops working. */
  private endSessions(where: string, params: unknown[], reason: string): number {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `insert or replace into auth_session_ends (id, reason, ended_at, device_id, credential_id) select id, ?, ?, device_id, credential_id from auth_sessions where ${where}`,
        )
        .run(reason, this.now(), ...params)
      return this.db.prepare(`delete from auth_sessions where ${where}`).run(...params).changes
    })()
  }

  /** `reason` names why it ended for the app. A sign-in over a live cookie passes 'signed_in_again' (the queue is kept). */
  deleteSession(sessionId: string, reason?: SessionEndReason): void {
    if (reason) this.endSessions('id = ?', [sessionId], reason)
    else this.db.prepare('delete from auth_sessions where id = ?').run(sessionId)
  }
  deleteAllSessions(): void {
    // One transaction: a failure while relabelling must not leave sessions ended with the wrong reason.
    this.db.transaction(() => {
      this.endSessions('1 = 1', [], 'logged_out_everywhere')
      // A session that had already run out of time, or was signed in again, is "signed out everywhere" too, from this moment.
      this.db
        .prepare(
          "update auth_session_ends set reason = 'logged_out_everywhere' where reason in ('expired', 'signed_in_again')",
        )
        .run()
    })()
  }

  /**
   * Why this session is no longer good: what was recorded when it ended, or 'expired' for a row that is still stored but
   * past its limits. Null when nothing is known (a cookie the relay never issued, or a record it has since dropped): the
   * app treats that as "wipe", never as "keep".
   */
  endedReason(sessionId: string): SessionEndReason | null {
    const ended = this.db.prepare('select reason from auth_session_ends where id = ?').get(sessionId) as
      | { reason: SessionEndReason }
      | undefined
    if (ended) return ended.reason
    const r = this.db.prepare('select last_seen_at, expires_at from auth_sessions where id = ?').get(sessionId) as
      | { last_seen_at: number; expires_at: number }
      | undefined
    const now = this.now()
    return r && (now >= r.expires_at || now - r.last_seen_at > this.idleMs) ? 'expired' : null
  }
  endedReasonForToken(token: string | null): SessionEndReason | null {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    return this.endedReason(sha256(token))
  }

  // ---- WebAuthn challenges ---------------------------------------------------------------------------------------

  putChallenge(
    kind: 'reg' | 'login' | 'stepup' | 'device',
    challenge: string,
    sessionId?: string,
    purpose?: string,
    ttlMs: number = CHALLENGE_TTL_MS,
  ): void {
    this.db
      .prepare(
        'insert or replace into auth_challenges (challenge, kind, session_id, purpose, expires_at) values (?, ?, ?, ?, ?)',
      )
      .run(challenge, kind, sessionId ?? null, purpose ?? null, this.now() + ttlMs)
  }

  /** Single use: true only for the first call with a live challenge of this kind (and session and purpose, if given). */
  consumeChallenge(
    kind: 'reg' | 'login' | 'stepup' | 'device',
    challenge: string,
    sessionId?: string,
    purpose?: string,
  ): boolean {
    const r = this.db
      .prepare(
        "delete from auth_challenges where challenge = ? and kind = ? and expires_at > ? and coalesce(session_id, '') = ? and coalesce(purpose, '') = ?",
      )
      .run(challenge, kind, this.now(), sessionId ?? '', purpose ?? '')
    return r.changes === 1
  }

  // ---- step-up tokens --------------------------------------------------------------------------------------------

  mintStepup(sessionId: string, purpose: string): string {
    const token = newToken(32)
    this.db
      .prepare('insert into auth_stepup (token_hash, session_id, purpose, expires_at) values (?, ?, ?, ?)')
      .run(sha256(token), sessionId, purpose, this.now() + STEPUP_TTL_MS)
    return token
  }

  /** Burns the token. True only if unexpired, unused, bound to this session and minted for exactly this purpose. */
  consumeStepup(token: string, purpose: string, sessionId: string | null): boolean {
    if (!sessionId || !token) return false
    const r = this.db
      .prepare(
        'update auth_stepup set used_at = ? where token_hash = ? and used_at is null and expires_at > ? and session_id = ? and purpose = ?',
      )
      .run(this.now(), sha256(token), this.now(), sessionId, purpose)
    return r.changes === 1
  }

  // ---- devices ---------------------------------------------------------------------------------------------------

  private deviceFrom(r: Record<string, unknown>): DeviceRow {
    return {
      id: r.id as string,
      name: r.name as string,
      pubkeyJwk: JSON.parse(r.pubkey_jwk as string) as JwkP256T,
      credentialId: (r.credential_id as string | null) ?? null,
      binding: r.binding as string,
      codeId: (r.code_id as string | null) ?? null,
      pinned: r.pinned === 1,
      revoked: r.revoked === 1,
      createdAt: r.created_at as number,
      lastUsedAt: (r.last_used_at as number | null) ?? null,
      loginProvenAt: (r.login_proven_at as number | null) ?? null,
    }
  }

  device(id: string): DeviceRow | null {
    const r = this.db.prepare('select * from auth_devices where id = ?').get(id) as Record<string, unknown> | undefined
    return r ? this.deviceFrom(r) : null
  }

  devices(): DeviceRow[] {
    return (this.db.prepare('select * from auth_devices order by created_at').all() as Record<string, unknown>[]).map(
      (r) => this.deviceFrom(r),
    )
  }

  /** Inserts a device, or re-enrolls an existing unrevoked one (an unpinned one stays unpinned; a pinned one stays pinned). */
  upsertDevice(d: {
    id: string
    name: string
    pubkeyJwk: JwkP256T
    credentialId: string | null
    binding: string
    codeId: string
  }): void {
    this.db
      .prepare(
        `insert into auth_devices (id, name, pubkey_jwk, credential_id, binding, code_id, pinned, revoked, created_at)
         values (?, ?, ?, ?, ?, ?, 0, 0, ?)
         on conflict(id) do update set name = excluded.name, credential_id = excluded.credential_id,
           binding = excluded.binding, code_id = excluded.code_id, pinned = auth_devices.pinned`,
      )
      .run(d.id, d.name, JSON.stringify(d.pubkeyJwk), d.credentialId, d.binding, d.codeId, this.now())
  }

  setPinned(id: string, pinned: boolean): void {
    this.db
      .prepare('update auth_devices set pinned = ?, ever_pinned = ever_pinned or ? where id = ? and revoked = 0')
      .run(pinned ? 1 : 0, pinned ? 1 : 0, id)
  }

  /**
   * The Mac answered N. A device that was never pinned takes the passkey it registered with it (unless a pinned device
   * still uses that passkey), so a stranger cannot sign in again later. Its current session stays, unpinned: it sees the
   * waiting notice and nothing else (and cannot log the owner out, which needs a pinned session).
   */
  declineDevice(id: string): void {
    const d = this.db
      .prepare('select credential_id, ever_pinned from auth_devices where id = ? and revoked = 0')
      .get(id) as { credential_id: string | null; ever_pinned: number } | undefined
    if (!d) return
    this.db.transaction(() => {
      this.db.prepare('update auth_devices set pinned = 0 where id = ?').run(id)
      if (d.ever_pinned || !d.credential_id) return
      const { n } = this.db
        .prepare('select count(*) as n from auth_devices where credential_id = ? and pinned = 1 and revoked = 0')
        .get(d.credential_id) as { n: number }
      if (n === 0) {
        this.db.prepare('delete from auth_credentials where credential_id = ?').run(d.credential_id)
      }
    })()
  }

  /**
   * Unpins a device, kills its sessions, and drops the passkey credential once no pinned device still uses it.
   * Returns false if the device is unknown.
   */
  revokeDevice(id: string): boolean {
    const d = this.device(id)
    if (!d) return false
    this.db.transaction(() => {
      this.db.prepare('update auth_devices set revoked = 1, pinned = 0 where id = ?').run(id)
      this.endSessions('device_id = ?', [id], 'revoked')
      // Its browser and Home Screen push subscriptions go with it, whichever route revoked it.
      this.db.prepare('delete from core_push_subs where device_id = ?').run(id)
      // ...including a session of this device that ended earlier in a way that keeps the queue ('expired', 'signed_in_again').
      this.db
        .prepare(
          "update auth_session_ends set reason = 'revoked' where reason in ('expired', 'signed_in_again') and device_id = ?",
        )
        .run(id)
      if (d.credentialId) {
        const { n } = this.db
          .prepare('select count(*) as n from auth_devices where credential_id = ? and pinned = 1 and revoked = 0')
          .get(d.credentialId) as { n: number }
        if (n === 0) {
          this.db.prepare('delete from auth_credentials where credential_id = ?').run(d.credentialId)
          this.endSessions('credential_id = ?', [d.credentialId], 'revoked')
          this.db
            .prepare(
              "update auth_session_ends set reason = 'revoked' where reason in ('expired', 'signed_in_again') and credential_id = ?",
            )
            .run(d.credentialId)
        }
      }
    })()
    return true
  }

  /**
   * Remembers that this device has proved its key, so a later sign-in naming it must prove it again. Keeps the first time.
   * The first time ever (login_proven_at was null) also ends every session already attached to this device except
   * `keepSessionId`: those were attached without a proof (the compat path, or before this change) and must not outlive the
   * moment the device becomes provable. One transaction. Returns how many sessions it ended (0 on a repeat).
   */
  markLoginProven(id: string, keepSessionId?: string): number {
    return this.db.transaction(() => {
      const r = this.db
        .prepare('update auth_devices set login_proven_at = ? where id = ? and login_proven_at is null')
        .run(this.now(), id)
      if (r.changes === 0) return 0
      return this.endSessions('device_id = ? and id != ?', [id, keepSessionId ?? ''], 'replaced')
    })()
  }

  /** True when another live (pinned, unrevoked) device signs in with the same passkey, so revoking this one leaves that passkey valid. */
  sharesPasskey(id: string): boolean {
    const d = this.device(id)
    if (!d?.credentialId) return false
    const { n } = this.db
      .prepare(
        'select count(*) as n from auth_devices where credential_id = ? and pinned = 1 and revoked = 0 and id != ?',
      )
      .get(d.credentialId, id) as { n: number }
    return n > 0
  }

  /**
   * Stamps a device as used right now. Bookkeeping only: a failed write is logged and never thrown, so it cannot undo the
   * sign-in or enrolment it rides on.
   */
  touchDevice(id: string): void {
    try {
      this.db.prepare('update auth_devices set last_used_at = ? where id = ?').run(this.now(), id)
      this.deviceUseSeen.set(id, this.now())
    } catch (e) {
      this.services.log.warn({ err: String(e), device_id: id }, 'could not record device use')
    }
  }

  /**
   * Records that a signed-in device is in use, at most once per DEVICE_USE_INTERVAL_MS per device. Called for every
   * authenticated request, every socket frame that shows real activity and every signed notification action (never for a
   * keepalive, a socket upgrade or the relay's own session checks), so the common case answers from memory without touching the
   * database. The update itself is one conditional statement, so two relay processes (or two requests at once) cannot both
   * write inside the window. A last-used time in the future (the clock went back) is overwritten. Revoked devices are not
   * touched: a revoked phone must not look alive.
   */
  noteDeviceUse(id: string): void {
    const now = this.now()
    const seen = this.deviceUseSeen.get(id)
    if (seen !== undefined && Math.abs(now - seen) < DEVICE_USE_INTERVAL_MS) return
    const failed = this.deviceUseFailed.get(id)
    if (failed !== undefined && Math.abs(now - failed) < DEVICE_USE_RETRY_MS) return
    try {
      this.db
        .prepare(
          `update auth_devices set last_used_at = ?
           where id = ? and revoked = 0
             and (last_used_at is null or last_used_at <= ? or last_used_at > ?)`,
        )
        .run(now, id, now - DEVICE_USE_INTERVAL_MS, now)
      this.deviceUseSeen.set(id, now)
      this.deviceUseFailed.delete(id)
    } catch (e) {
      // A failed bookkeeping write must not fail the request or socket it rides on, and is not remembered as done: it is
      // tried again after DEVICE_USE_RETRY_MS, not on every frame. It is logged, not swallowed.
      this.deviceUseFailed.set(id, now)
      this.services.log.warn({ err: String(e), device_id: id }, 'could not record device use')
    }
  }

  // ---- bridge keys -----------------------------------------------------------------------------------------------

  private envKey(): TrustedKey | null {
    const b64 = this.services.env.BRIDGE_PUBKEY
    if (!b64) return null
    try {
      return { keyId: bridgeKeyId(b64urlDecode(b64)), publicKeyB64: b64 }
    } catch {
      return null
    }
  }

  /**
   * The bridge keys the relay trusts right now. BRIDGE_PUBKEY_FORCE=1: only the env key (recovery). Otherwise the
   * rotated active key plus any previous key inside its 5-minute window; the env key bootstraps while no rotation
   * has happened.
   */
  trustedKeys(): TrustedKey[] {
    const env = this.envKey()
    if (env && this.services.env.BRIDGE_PUBKEY_FORCE) return [env]
    const now = this.now()
    const rows = this.db
      .prepare(
        "select key_id, pubkey, status, valid_until from auth_bridge_keys where status = 'active' or valid_until > ?",
      )
      .all(now) as Array<{ key_id: string; pubkey: string; status: string }>
    const keys = rows.map((r) => ({ keyId: r.key_id, publicKeyB64: r.pubkey }))
    if (env && !rows.some((r) => r.status === 'active')) keys.push(env)
    return keys
  }

  /** The key allowed to rotate: the active row, else the env bootstrap key. */
  activeKey(): TrustedKey | null {
    const r = this.db.prepare("select key_id, pubkey from auth_bridge_keys where status = 'active'").get() as
      | { key_id: string; pubkey: string }
      | undefined
    return r ? { keyId: r.key_id, publicKeyB64: r.pubkey } : this.envKey()
  }

  /** Makes `newPubkeyB64` the active key; the key that signed the request stays valid for 5 more minutes. */
  rotateBridgeKey(currentKey: TrustedKey, newPubkeyB64: string): string {
    const now = this.now()
    const newId = bridgeKeyId(b64urlDecode(newPubkeyB64))
    this.db.transaction(() => {
      this.db
        .prepare("update auth_bridge_keys set status = 'previous', valid_until = ? where status = 'active'")
        .run(now + BRIDGE_PREVIOUS_KEY_MS)
      this.db
        .prepare(
          `insert into auth_bridge_keys (key_id, pubkey, status, created_at, valid_until) values (?, ?, 'previous', ?, ?)
           on conflict(key_id) do update set status = 'previous', valid_until = excluded.valid_until`,
        )
        .run(currentKey.keyId, currentKey.publicKeyB64, now, now + BRIDGE_PREVIOUS_KEY_MS)
      this.db
        .prepare(
          `insert into auth_bridge_keys (key_id, pubkey, status, created_at, valid_until) values (?, ?, 'active', ?, null)
           on conflict(key_id) do update set status = 'active', valid_until = null`,
        )
        .run(newId, newPubkeyB64, now)
    })()
    return newId
  }

  /** Records a nonce for 10 minutes. False if it was already seen (a replay). */
  useNonce(nonce: string): boolean {
    const r = this.db
      .prepare('insert or ignore into auth_bridge_nonces (nonce, expires_at) values (?, ?)')
      .run(createHash('sha256').update(nonce).digest('hex'), this.now() + BRIDGE_NONCE_TTL_MS)
    return r.changes === 1
  }

  get hasPasskey(): boolean {
    return (this.db.prepare('select count(*) as n from auth_credentials').get() as { n: number }).n > 0
  }
}
