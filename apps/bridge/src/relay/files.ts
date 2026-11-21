// The small files `talos-app relay ...` and the bridge's auto-update keep in the Talos home (shapes: packages/protocol/src/relay-redeploy.ts):
//   relay-connect.json            how this install may redeploy its relay (no token in it, ever)
//   relay-auto.json               when the bridge last looked, and the one redeploy attempt it is following
//   relay-redeploy-request.json   (via "app") what the bridge asks the Mac app to do
//   relay-redeploy-result.json    (via "app") what the Mac app answers
// Every write is atomic and 0600, and refused when the file is a symlink; every read refuses to follow one.
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RELAY_CONNECT_FILE,
  RELAY_REDEPLOY_REQUEST_FILE,
  RELAY_REDEPLOY_RESULT_FILE,
  RelayConnectFile,
  type RelayConnectFileT,
  type RelayRedeployErrorCodeT,
  RelayRedeployRequest,
  RelayRedeployResult,
  type SecretStore,
} from '@talos-app/protocol'
import { removeFile, writeJsonAtomic } from '../fsutil.ts'
import { homeScopedStore } from '../secrets/home-scope.ts'

/** The key store item of the Railway token. A keychain is shared by every Talos home, so the store is always wrapped by
 *  railwayStore: the item lives under `com.talos.app.railway.<h>` (secrets/home-scope.ts), one per home, like the peer secrets. */
export const RAILWAY_SERVICE = 'com.talos.app.railway'
export const RAILWAY_ACCOUNT = 'relay'
export const railwayStore = (store: SecretStore, home: string): SecretStore =>
  homeScopedStore(store, home, { kind: 'railway' })

export const connectPath = (home: string): string => join(home, RELAY_CONNECT_FILE)
export const statePath = (home: string): string => join(home, 'relay-auto.json')
export const requestPath = (home: string): string => join(home, RELAY_REDEPLOY_REQUEST_FILE)
export const resultPath = (home: string): string => join(home, RELAY_REDEPLOY_RESULT_FILE)

const MAX_FILE_BYTES = 64 * 1024

/** The file's JSON, or undefined when it is missing, too big, not JSON or a symlink. */
function readNoFollow(path: string): unknown {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    if (fstatSync(fd).size > MAX_FILE_BYTES) return undefined
    return JSON.parse(readFileSync(fd, 'utf8'))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Writes `value` as a 0600 file, refusing when something that is a symlink is already there. */
export function writeOwnFile(path: string, value: unknown): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symlink, so nothing is written there.`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  writeJsonAtomic(path, value, 0o600)
}

export type Connection = { file: RelayConnectFileT; raw: Record<string, unknown> }

/** The connection, or undefined when there is none (or the file is unreadable: then nothing is redeployed). */
export function readConnection(home: string): Connection | undefined {
  const raw = readNoFollow(connectPath(home))
  const parsed = RelayConnectFile.safeParse(raw)
  return parsed.success ? { file: parsed.data, raw: raw as Record<string, unknown> } : undefined
}

/** True when a file is there that is not a readable connection (so "not connected" is not said about it). */
export function connectionFileBroken(home: string): boolean {
  try {
    lstatSync(connectPath(home))
  } catch {
    return false
  }
  return readConnection(home) === undefined
}

export const writeConnection = (home: string, value: RelayConnectFileT | Record<string, unknown>): void =>
  writeOwnFile(connectPath(home), value)

export const removeConnectionFiles = (home: string): void => {
  for (const p of [connectPath(home), statePath(home), requestPath(home), resultPath(home)]) removeFile(p)
}

// ---- what the bridge is following -------------------------------------------------------------------------------------------------

export type Attempt = {
  release: string
  at: number
  state: 'sent' | 'on' | 'failed'
  /** Who asked: the owner's command, or the bridge's own auto-update (only that one posts rows). */
  by: 'cli' | 'auto'
  via: 'token' | 'app'
  /** via "app": the request this attempt wrote. */
  id?: string
  /** A failed attempt: the plain reason. */
  reason?: string
  /** via "app": the app's own short text for a failure, shown by `relay status` only. */
  detail?: string
  /** The last time a look at the relay was made for it (the bridge looks at most every 20 s). */
  polled_at?: number
}
export type AutoState = { v: 1; checked_at?: number; attempt?: Attempt }

const SEMVER_X = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/

export function readState(home: string): AutoState {
  const s = readNoFollow(statePath(home)) as Partial<AutoState> | undefined
  const out: AutoState = { v: 1 }
  if (typeof s?.checked_at === 'number') out.checked_at = s.checked_at
  const a = s?.attempt as Partial<Attempt> | undefined
  if (
    a &&
    typeof a.release === 'string' &&
    SEMVER_X.test(a.release) &&
    typeof a.at === 'number' &&
    (a.state === 'sent' || a.state === 'on' || a.state === 'failed') &&
    (a.by === 'cli' || a.by === 'auto') &&
    (a.via === 'token' || a.via === 'app')
  )
    out.attempt = {
      release: a.release,
      at: a.at,
      state: a.state,
      by: a.by,
      via: a.via,
      ...(typeof a.id === 'string' ? { id: a.id } : {}),
      ...(typeof a.reason === 'string' ? { reason: a.reason.slice(0, 200) } : {}),
      ...(typeof a.detail === 'string' ? { detail: a.detail.slice(0, 120) } : {}),
      ...(typeof a.polled_at === 'number' ? { polled_at: a.polled_at } : {}),
    }
  return out
}
export const writeState = (home: string, s: AutoState): void => writeOwnFile(statePath(home), s)

// ---- the app's two files ----------------------------------------------------------------------------------------------------------

/** Writes the one request (a new one replaces the old) and returns its id. */
export function writeRequest(home: string, release: string, now: number): string {
  const id = `rq_${randomBytes(15).toString('base64url')}`
  writeOwnFile(requestPath(home), RelayRedeployRequest.parse({ v: 1, id, release, requested_at: now }))
  return id
}

export type AppResult =
  | { state: 'none' }
  | { state: 'ok' }
  | { state: 'failed'; code: RelayRedeployErrorCodeT; detail?: string }

/** The app's answer to THIS request: the same id and the same release, else none (a stale or foreign result is not believed). */
export function readResult(home: string, id: string, release: string): AppResult {
  const r = RelayRedeployResult.safeParse(readNoFollow(resultPath(home)))
  if (!r.success || r.data.id !== id || r.data.release !== release) return { state: 'none' }
  if (r.data.ok) return { state: 'ok' }
  return { state: 'failed', code: r.data.code ?? 'other', ...(r.data.error ? { detail: r.data.error } : {}) }
}
