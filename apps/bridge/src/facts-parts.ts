// The pieces of `talos-app facts` that are not its list of fields: the types, the 5 second limit, the history database read without
// making a file, the app's Info.plist, and the three fields built from them (app, cards, peers). See facts.ts.
import { Database } from 'bun:sqlite'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { CARD_KINDS, type SecretStore } from '@talos-app/protocol'
import type { GuardedFetch } from '@talos-app/protocol/guarded-fetch'
import type { Clock } from './clock.ts'
import type { BridgeEnv } from './config.ts'
import type { parseConfig } from './config-file.ts'
import type { GhRun, GitRun } from './facts-dev.ts'
import { realRunAsync } from './facts-dev.ts'
import { readJsonFile } from './fsutil.ts'
import { PEER_SECRET_SERVICE, peerSecretAccount, readInboundPeers } from './peer/records.ts'
import { peerCopyState, peerScopedStore } from './peer/secret-store.ts'
import { realFileSync } from './real-file.ts'
import type { FetchFn } from './relay-http.ts'
import { openSecretStore, SecretError, type SecretSpawn } from './secrets/store.ts'
/** Every outside source gets this long, all at the same time. */
export const DEADLINE_MS = 5000
export const LATE = 'no answer in 5 s'
export type FactsDeps = {
  now?: () => number
  /** The timers of the 5 second limits (tests: a fake clock). */
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  platform?: NodeJS.Platform
  alive?: (pid: number) => boolean
  bridge?: { version: string; commit: string | undefined }
  /** The relay's /healthz. */
  fetch?: FetchFn
  /** The release list's fetch. */
  releaseFetch?: GuardedFetch
  /** The key store (default: this machine's, opened read-only: it never chooses one). */
  secrets?: SecretStore
  /** The running processes' programs, one per line (default `ps -axo comm=`, a Mac's); the signal kills it at the time limit. */
  ps?: (o: { signal: AbortSignal }) => Promise<string | undefined>
  /** Spotlight's answer for the app's bundle id, one path per line (default `mdfind`, a Mac's). */
  mdfind?: (o: { signal: AbortSignal }) => Promise<string | undefined>
  /** The key store's own program runner, for the real store (tests: a fake, so a test never starts `security` or `gdbus`). */
  secretSpawn?: SecretSpawn
  /** The system-wide applications folder (default /Applications; tests: another), which Spotlight's answers rank second. */
  systemApps?: string
  /** Where the copy of history.sqlite is made (default the system's temp folder): never inside the Talos home. */
  scratch?: string
  /** A binary Info.plist as JSON (default `plutil`, a Mac's); the signal kills it at the time limit. */
  plutil?: (path: string, o: { signal: AbortSignal }) => Promise<string | undefined>
  /** The folder of this code, to tell a source checkout (default: the checkout this file is in). */
  checkout?: string
  git?: GitRun
  /** Run by an agent session (no terminal): then Lock Talos settings hides the links. The command sets it from the terminal check. */
  agent?: boolean
  gh?: GhRun
}

export type Known = { value: unknown; source: string; as_of: string; [k: string]: unknown }
export type Unknown = { state: 'unknown'; reason: string }
export type Facts = Record<string, unknown>
export type Field = Known | Unknown

export const isUnknown = (f: unknown): f is Unknown => (f as Unknown)?.state === 'unknown'
export const no = (reason: string): Unknown => ({ state: 'unknown', reason })
export const isoOf = (ms: number): string => new Date(ms).toISOString()

/** `work`, cut at the limit: late is `{late: true}`; a throw goes on to the caller. The timer is always cleared. */
export function within<T>(
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<{ late: true } | { late: false; value: T }> {
  const ac = new AbortController()
  return new Promise((resolve, reject) => {
    const h = clock.setTimeout(() => {
      ac.abort()
      resolve({ late: true })
    }, DEADLINE_MS)
    new Promise<T>((r) => r(work(ac.signal))).then(
      (value) => {
        clock.clearTimeout(h)
        resolve({ late: false, value })
      },
      (e) => {
        clock.clearTimeout(h)
        reject(e)
      },
    )
  })
}

/** The words for a key store that failed: its own fixed sentence when it is a SecretError, never any other text (it could hold a value). */
export const storeReason = (e: unknown) =>
  `the key store cannot be read${e instanceof SecretError ? ` (${e.message})` : ''}`

// ---- the history database, read without making a file -----------------------------------------------------------------------------

export type HistoryRead =
  | {
      ok: true
      absent: boolean
      cards: Array<{ kind: unknown; created_at: unknown; expires_at: unknown }>
      sends: Map<string, { state: string; at: number }>
    }
  | { ok: false; reason: string }

/** The most history.sqlite plus its -wal may be for a copy to be made of them (a bigger one is not read). */
export const HISTORY_COPY_MAX = 200 * 1024 * 1024

/** Does something exist at this path (a link counts, whatever it points at)? */
const present = (p: string): boolean => {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * Is this path safe to hand to a reader that opens it blocking? False only for something that exists and is not a regular file once
 * links are followed (a FIFO, a socket, a device): opening a FIFO nobody writes to blocks forever, and no timer can stop that. Absent,
 * or not statable, is true: the reader says so in its own words.
 */
export function plainFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return true
  }
}

/** A refusal with its own plain reason. */
class Refused extends Error {}
const NOT_PLAIN = 'is not a plain file (a link, a pipe or something else)'

/** Opens a file for reading without blocking and without following a link, and requires a regular file. */
function openPlain(path: string, what: string): number {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    if (!fstatSync(fd).isFile()) throw new Refused(`${what} ${NOT_PLAIN}`)
    return fd
  } catch (e) {
    if (fd !== undefined) closeSync(fd)
    if ((e as NodeJS.ErrnoException)?.code === 'ELOOP') throw new Refused(`${what} ${NOT_PLAIN}`)
    throw e
  }
}

/** A small JSON file read the same way (a regular file under 64 KB, not a link), or undefined. */
function readPlainJson(path: string): unknown {
  let fd: number | undefined
  try {
    fd = openPlain(path, path)
    if (fstatSync(fd).size > 64 * 1024) return undefined
    return JSON.parse(readFileSync(fd, 'utf8'))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Copies `src` to `dest` (new, mode 0600, O_EXCL) from an open descriptor, counting bytes against `left`: over it the copy stops, so
 * a file that grows while it is read is caught too. The source must be a regular file (never a FIFO or a link).
 */
function copyCapped(src: string, dest: string, what: string, left: { n: number }): void {
  const fd = openPlain(src, what)
  try {
    if (fstatSync(fd).size > left.n)
      throw new Refused('history.sqlite is too big to read here (over 200 MB with its log)')
    const out = openSync(dest, 'wx', 0o600)
    try {
      const buf = Buffer.allocUnsafe(1 << 20)
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null)
        if (n === 0) break
        left.n -= n
        if (left.n < 0) throw new Refused('history.sqlite is too big to read here (over 200 MB with its log)')
        writeSync(out, buf, 0, n)
      }
    } finally {
      closeSync(out)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * history.sqlite, read from a COPY. Opening a WAL database in place, even read-only, can make or touch its -shm (macOS does), and
 * `immutable` ignores the WAL and counts stale. So the database and its -wal (the -shm is derived: SQLite rebuilds it from the WAL)
 * are copied into a private folder of our own outside the Talos home, the copy is opened, and the folder is removed in a `finally`,
 * whatever happens. Each source is opened without blocking and without following a link, must be a regular file, and is copied from
 * its descriptor under one byte budget, so a FIFO planted there reads as unknown instead of hanging. The WAL is copied first: a
 * checkpoint between the two copies then only repeats what the database copy has. A -wal with no -shm is a writer mid-start or a
 * crash: not read. A temporary folder inside the Talos home is never used.
 */
export function readHistory(file: string, scratch: string = tmpdir(), max: number = HISTORY_COPY_MAX): HistoryRead {
  if (!present(file)) return { ok: true, absent: true, cards: [], sends: new Map() }
  const wal = present(`${file}-wal`)
  if (wal !== present(`${file}-shm`))
    return { ok: false, reason: 'history.sqlite is in use (a -wal without its -shm); try again in a moment' }
  try {
    const rs = realFileSync(scratch)
    const rh = realFileSync(dirname(file))
    if (rs === rh || rs.startsWith(rh.endsWith(sep) ? rh : rh + sep))
      return {
        ok: false,
        reason: 'the temporary folder is inside the Talos home, so no copy of history.sqlite is made',
      }
  } catch {
    // a scratch folder that is not there fails below, where the copy is made
  }
  let folder: string | undefined
  let db: Database | undefined
  try {
    folder = mkdtempSync(join(scratch, 'talos-facts-'))
    chmodSync(folder, 0o700)
    const copy = join(folder, 'history.sqlite')
    const left = { n: max }
    if (wal) copyCapped(`${file}-wal`, `${copy}-wal`, 'history.sqlite-wal', left)
    copyCapped(file, copy, 'history.sqlite', left)
    db = new Database(copy, { readonly: true })
    db.exec('PRAGMA busy_timeout = 250')
    const has = (t: string) =>
      db?.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== null
    // the kind and the time only: a card's title, summary and body are never selected
    const cards = has('cards')
      ? (db
          .query(
            "SELECT json_extract(binding_json, '$.kind') AS kind, created_at, expires_at FROM cards WHERE state = 'pending'",
          )
          .all() as Array<{ kind: unknown; created_at: unknown; expires_at: unknown }>)
      : []
    const sends = new Map<string, { state: string; at: number }>()
    if (has('peer_outbox'))
      for (const r of db
        .query('SELECT peer, state, MAX(created_at) AS at FROM peer_outbox GROUP BY peer')
        .all() as Array<{ peer: string; state: string; at: number }>)
        sends.set(r.peer, { state: r.state, at: r.at })
    return { ok: true, absent: false, cards, sends }
  } catch (e) {
    return { ok: false, reason: e instanceof Refused ? e.message : 'history.sqlite cannot be read' }
  } finally {
    db?.close()
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
}

// ---- Info.plist ----------------------------------------------------------------------------------------------------------------

const PLIST_MAX = 256 * 1024
const plistString = (xml: string, key: string): string | undefined =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1]

/**
 * The keys read from the app's Info.plist (XML, or binary through `plutil`). Never TalosCheckout: that is a folder of the build machine.
 * The file is opened without blocking and must be a regular file under a size cap before it is read: a FIFO or a folder at that path
 * is not a plist (a plain read of a FIFO with no writer would never return, and no timer can stop a synchronous read).
 */
async function readPlist(
  file: string,
  plutil: (p: string, o: { signal: AbortSignal }) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<Record<string, string | undefined> | string> {
  let buf: Buffer
  let fd: number | undefined
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK)
    const st = fstatSync(fd)
    if (!st.isFile()) return 'Info.plist is not a regular file'
    if (st.size > PLIST_MAX) return 'Info.plist is too big to be one'
    buf = readFileSync(fd)
  } catch {
    return 'Info.plist cannot be read'
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  const keys = ['CFBundleShortVersionString', 'TalosSourceCommit', 'TalosGitSha']
  if (buf.subarray(0, 6).toString('latin1') === 'bplist') {
    const json = await plutil(file, { signal })
    if (json === undefined) return 'Info.plist is a binary plist and plutil is not available to read it'
    try {
      const o = JSON.parse(json) as Record<string, unknown>
      return Object.fromEntries(keys.map((k) => [k, typeof o[k] === 'string' ? (o[k] as string) : undefined]))
    } catch {
      return 'Info.plist is a binary plist that plutil could not read'
    }
  }
  const xml = buf.toString('utf8')
  return Object.fromEntries(keys.map((k) => [k, plistString(xml, k)]))
}

/** A candidate app folder, accepted only as an absolute path to a folder that ends in .app before and after its links are resolved, with an Info.plist in it. */
function validApp(candidate: string): string | undefined {
  try {
    if (!isAbsolute(candidate) || !candidate.endsWith('.app')) return undefined
    const real = realFileSync(candidate)
    if (!real.endsWith('.app') || !statSync(real).isDirectory()) return undefined
    return existsSync(join(real, 'Contents', 'Info.plist')) ? real : undefined
  } catch {
    return undefined
  }
}

const APP_PROCESS = '/Talos.app/Contents/MacOS/Talos'

/**
 * Where the installed Talos.app is, in this order, the first that names a usable folder: (1) `app_path` in status.json (the app writes
 * it at start); (2) the running process, `ps -axo comm=` with a line ending in /Talos.app/Contents/MacOS/Talos, cut back to the .app;
 * (3) Spotlight (`mdfind` for the bundle id), ~/Applications first, then /Applications, then any other. Otherwise nowhere.
 */
async function findApp(c: Ctx, signal: AbortSignal): Promise<{ app: string; via: string } | undefined> {
  const { env, deps } = c
  const named = (readPlainJson(join(env.home, 'status.json')) as { app_path?: unknown } | undefined)?.app_path
  const first = typeof named === 'string' ? validApp(named) : undefined
  if (first) return { app: first, via: 'status.json' }
  const ps = await (deps.ps ?? ((o) => realRunAsync('ps', ['-axo', 'comm='], o)))({ signal })
  for (const line of (ps ?? '').split('\n')) {
    const t = line.trim()
    const app = t.endsWith(APP_PROCESS) ? validApp(t.slice(0, -'/Contents/MacOS/Talos'.length)) : undefined
    if (app) return { app, via: 'the running process' }
  }
  const md = await (
    deps.mdfind ?? ((o) => realRunAsync('mdfind', ["kMDItemCFBundleIdentifier == 'app.talos.desktop'"], o))
  )({ signal })
  const paths = (md ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const rank = (p: string) =>
    p.startsWith(`${join(env.userHome, 'Applications')}/`)
      ? 0
      : p.startsWith(`${deps.systemApps ?? '/Applications'}/`)
        ? 1
        : 2
  for (const p of [...paths].sort((x, y) => rank(x) - rank(y))) {
    const app = validApp(p)
    if (app) return { app, via: 'Spotlight' }
  }
  return undefined
}

// ---- the command's data ----------------------------------------------------------------------------------------------------------

/** What every field's reader is given. */
export type Ctx = {
  env: BridgeEnv
  deps: FactsDeps
  clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>
  nowMs: number
  iso: string
  platform: NodeJS.Platform
  ok: (value: unknown, source: string, as_of?: string, extra?: Record<string, unknown>) => Known
}
export type ConfigRead =
  | { ok: true; config: ReturnType<typeof parseConfig> & { ok: true } }
  | { ok: false; reason: string }

export function appField(c: Ctx): Promise<Field> {
  const { env, deps, clock, platform, ok } = c
  const guarded = async (fn: () => Promise<Field> | Field, why: string): Promise<Field> => {
    try {
      return await fn()
    } catch {
      return no(why)
    }
  }
  return guarded(async () => {
    if (platform !== 'darwin') return no('no desktop app here')
    // every step (ps, mdfind, plutil) shares one 5 s limit and is killed at it
    const r = await within(clock, async (signal) => {
      const found = await findApp(c, signal)
      if (!found) return 'Talos.app was not found (status.json, the running process and Spotlight named none)'
      const got = await readPlist(
        join(found.app, 'Contents', 'Info.plist'),
        deps.plutil ?? ((f, o) => realRunAsync('plutil', ['-convert', 'json', '-o', '-', f], o)),
        signal,
      )
      return typeof got === 'string' ? got : { got, via: found.via }
    })
    if (r.late) return no(LATE)
    if (typeof r.value === 'string') return no(r.value)
    const { got, via } = r.value
    const version = got.CFBundleShortVersionString
    if (!version || !/^[0-9A-Za-z.+-]{1,40}$/.test(version)) return no('Info.plist names no version')
    const full = got.TalosSourceCommit
    const built = got.TalosGitSha
    const commit =
      full && /^[0-9a-f]{40}$/.test(full)
        ? full.slice(0, 7)
        : built && /^[0-9a-f]{7,40}$/.test(built)
          ? built.slice(0, 7)
          : null
    return ok({ version, commit }, 'Talos.app Info.plist', c.iso, { found_by: via })
  }, 'the app cannot be read')
}

export function peersField(c: Ctx, config: ConfigRead, history: HistoryRead): Promise<Field> {
  const { env, deps, clock, iso, ok } = c
  for (const f of ['peers-inbound.json', 'peer-copied.json'])
    if (!plainFile(join(env.home, f))) return Promise.resolve(no(`${f} is not a regular file`))
  let storeP: Promise<SecretStore> | undefined
  const store = () =>
    // the home-scoped store, so a legacy item counts as the first real read would count it; has() never moves or copies one
    (storeP ??= (async () =>
      peerScopedStore(
        deps.secrets ??
          (await openSecretStore({
            home: env.home,
            readOnly: true,
            ...(deps.platform ? { platform: deps.platform } : {}),
            ...(deps.secretSpawn ? { spawn: deps.secretSpawn } : {}),
          })),
        env.home,
      ))())
  /** Is the item there? has() only: no secret is read into this process. true / false / undefined (the store could not tell). */
  const secretThere = async (name: string): Promise<boolean | undefined> =>
    (await store()).has(PEER_SECRET_SERVICE, peerSecretAccount(name))
  const linkNames = config.ok
    ? [
        ...new Set([
          ...config.config.config.peers.map((c) => c.name),
          ...readInboundPeers(env.home).map((i) => i.name),
        ]),
      ].sort()
    : []
  return (async (): Promise<Field> =>
    !config.ok
      ? no(config.reason)
      : deps.agent === true && config.config.config.settings_lock === true
        ? // an agent session while Lock Talos settings is on sees how many links there are and nothing about them
          ({ state: 'locked', reason: 'Lock Talos settings is on', count: linkNames.length } as unknown as Field)
        : ok(
            await Promise.all(
              [
                ...new Set([
                  ...config.config.config.peers.map((c) => c.name),
                  ...readInboundPeers(env.home).map((i) => i.name),
                ]),
              ]
                .sort()
                .map(async (name) => {
                  const sends = config.config.config.peers.some((c) => c.name === name)
                  const receives = readInboundPeers(env.home).some((i) => i.name === name)
                  const copy = peerCopyState(env.home, name)
                  let secret: Field = no('this install does not send to it (no outgoing link here)')
                  if (sends)
                    try {
                      const r = await within(clock, () => secretThere(name))
                      secret = r.late
                        ? no(LATE)
                        : r.value === undefined
                          ? no('the key store could not tell whether the item is there')
                          : ok(r.value, 'key store')
                    } catch (e) {
                      secret = no(storeReason(e))
                    }
                  const needsRelink: Field = !sends
                    ? no('this install does not send to it (no outgoing link here)')
                    : copy === 'rejected'
                      ? ok(true, 'peer-copied.json')
                      : isUnknown(secret)
                        ? no(secret.reason)
                        : ok(secret.value !== true, 'key store')
                  const sent = history.ok ? history.sends.get(name) : undefined
                  const lastSend: Field = !history.ok
                    ? no(history.reason)
                    : sent
                      ? ok(
                          {
                            // the ledger's own states stay apart: revoked, refused and gave_up are different news
                            state: sent.state === 'sent' ? 'ok' : sent.state,
                            at: isoOf(sent.at),
                          },
                          'history.sqlite',
                        )
                      : ok({ state: 'none' }, history.absent ? 'history.sqlite (not created yet)' : 'history.sqlite')
                  return {
                    name,
                    sends,
                    receives,
                    linked: sends && receives,
                    secret_present: secret,
                    needs_relink: needsRelink,
                    copied_legacy: ok(copy !== 'none', 'peer-copied.json'),
                    last_send: lastSend,
                  }
                }),
            ),
            'config.json',
          ))()
}

export function cardsField(c: Ctx, history: HistoryRead): Field {
  const { nowMs, ok } = c
  return !history.ok
    ? no(history.reason)
    : ((): Field => {
        const kinds: Record<string, number> = {}
        let oldest: number | undefined
        let pending = 0
        let expired = 0
        for (const c of history.cards) {
          // a card past its expiry that nothing has swept yet is not waiting for the owner: counted apart
          const until = Date.parse(String(c.expires_at))
          if (!(until > nowMs)) {
            expired++
            continue
          }
          pending++
          const k = typeof c.kind === 'string' && (CARD_KINDS as readonly string[]).includes(c.kind) ? c.kind : 'other'
          kinds[k] = (kinds[k] ?? 0) + 1
          const t = Date.parse(String(c.created_at))
          if (Number.isFinite(t) && (oldest === undefined || t < oldest)) oldest = t
        }
        return ok(
          {
            pending,
            expired_pending: expired,
            oldest_age_s: oldest === undefined ? null : Math.max(0, Math.floor((nowMs - oldest) / 1000)),
            kinds,
          },
          history.absent ? 'history.sqlite (not created yet)' : 'history.sqlite',
        )
      })()
}
