// Secrets live in the macOS login Keychain (M5.6, rev 2.4), or off macOS in the SecretStore (secrets/store.ts): OAuth tokens and client registrations, each http/sse
// server's reported config (URL and headers), and the HMAC key behind the config fingerprint. The runner is an interface:
// tests use a memory double and never touch a real Keychain; the real runner drives /usr/bin/security with values on STDIN.
// Values longer than one `security -i` line are stored as chunks behind a manifest (see securityRunner).
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { accessSync, constants as fsConstants, statSync } from 'node:fs'
import { b64urlDecode, b64urlEncode, jcs, type SecretStore } from '@talos-app/protocol'
import { isUnavailableStore, openSecretStore, SecretError } from '../secrets/store.ts'

export const KEYCHAIN_SERVICE = 'talos-app.direct'
const ACCOUNT = /^[0-9a-f]{16}\/(oauth|config|hmac-key)$/
const VALUE_PREFIX = 'v1.'

export class KeychainError extends Error {
  constructor(
    message: string,
    readonly kind: 'unavailable' | 'bad_account',
    /** Which step of a write, read or delete failed; set by the runner on the failures it reports. Never a value. */
    public step?: string,
  ) {
    super(message)
  }
}

export interface KeychainRunner {
  /** `value` is any string; the runner stores it encoded so no character reaches a command line unescaped. */
  write(account: string, value: string): Promise<void>
  /** `undefined` for a missing item; throws `KeychainError` when the Keychain cannot be read (locked, no tool). */
  read(account: string): Promise<string | undefined>
  delete(account: string): Promise<void>
}

/** `timedOut` is set when the tool ran past its time limit and was killed; `code` is then -1 and `stdout` is empty. */
export type SpawnResult = { code: number; stdout: string; timedOut?: boolean }
export type KeychainSpawn = (argv: string[], stdin?: string) => Promise<SpawnResult>

/** How long one Keychain tool call may take: a locked keychain whose unlock prompt nobody answers must not hang the caller. */
export const KEYCHAIN_SPAWN_TIMEOUT_MS = 10_000

/**
 * argv array only, never a shell. A tool still running after `timeoutMs` is killed and answers code -1, which every caller already
 * reads as "the Keychain did not do it", with `timedOut` set and no output: half a listing must never pass for a whole one.
 */
export function keychainSpawnWithin(timeoutMs: number): KeychainSpawn {
  return async (argv, stdin) => {
    const proc = Bun.spawn(argv, {
      stdin: stdin === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (stdin !== undefined) {
      const sink = proc.stdin as { write(s: string): unknown; end(): unknown }
      sink.write(stdin)
      sink.end()
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGKILL')
    }, timeoutMs)
    try {
      const [stdout, code] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited])
      return timedOut ? { code: -1, stdout: '', timedOut } : { code, stdout }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const bunKeychainSpawn: KeychainSpawn = keychainSpawnWithin(KEYCHAIN_SPAWN_TIMEOUT_MS)

const SECURITY = '/usr/bin/security'

// `security -i` reads one command per line and splits a line near 4 KB: a longer `-w <value>` was cut, the tail ran as an
// unknown command and nothing was stored. A value that fits one line (VALUE_LINE_MAX characters including `v1.`) is kept
// as before: one item. A longer one is split into chunk items of the same size, and the item at the account itself
// becomes a small manifest naming the chunk set (a generation), how many chunks it has and a SHA-256 of the whole encoded
// value. The manifest is the only thing a reader follows, and it is written last, so a failed write leaves the old value
// whole and a read never sees a mix of old and new chunks.
const VALUE_LINE_MAX = 3000
const CHUNK_CHARS = VALUE_LINE_MAX - VALUE_PREFIX.length
const MAX_CHUNKS = 256
const MANIFEST_PREFIX = 'v2.'
const MANIFEST = /^v2\.([0-9a-f]{8})\.([1-9][0-9]{0,2})\.([0-9a-f]{64})$/
/** A sweep's listing: tried this many times, waiting this many ms, doubled each time, before each retry (see listPieces). */
const LIST_ATTEMPTS = 4
const LIST_RETRY_MS = 100
/** No new listing attempt starts after this; an attempt already running keeps each tool call's own 10 s limit. */
const SWEEP_BUDGET_MS = 20_000

type Manifest = { gen: string; count: number; sha: string }

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')
const parseManifest = (text: string): Manifest | undefined => {
  const m = MANIFEST.exec(text)
  if (!m || Number(m[2]) > MAX_CHUNKS) return undefined
  return { gen: m[1] as string, count: Number(m[2]), sha: m[3] as string }
}
const chunkAccount = (account: string, gen: string, i: number): string => `${account}.${gen}.${i}`

export type SecurityRunnerOptions = {
  /**
   * Called with a fixed message and no secret when a write does not verify, a stored value is damaged or old chunks could
   * not be deleted. The live bridge turns it into an `error` log line, which becomes a problem report (docs/ERRORS.md).
   */
  onProblem?: (message: string, fields: Record<string, unknown>) => void
  /**
   * Whether the keychain file at this path exists and can be read. `security` answers "no such item" (44) and lists
   * nothing for a missing or unreadable file too, so the sweep believes an empty keychain only when this says yes.
   */
  keychainReadable?: (path: string) => boolean
}

const keychainFileReadable = (path: string): boolean => {
  try {
    accessSync(path, fsConstants.R_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

export function securityRunner(
  spawn: KeychainSpawn = bunKeychainSpawn,
  opts: SecurityRunnerOptions = {},
): KeychainRunner {
  const check = (account: string) => {
    if (!ACCOUNT.test(account)) throw new KeychainError('bad keychain account', 'bad_account')
  }
  const run = async (argv: string[], stdin?: string): Promise<SpawnResult> => {
    try {
      return await spawn(argv, stdin)
    } catch {
      throw new KeychainError('Keychain tool could not start', 'unavailable')
    }
  }
  const tell = (message: string, account: string, step: string) =>
    opts.onProblem?.(message, { item: account.split('/')[1], step }) // never holds a value
  const problem = (message: string, step: string): KeychainError => new KeychainError(message, 'unavailable', step)
  const readable = opts.keychainReadable ?? keychainFileReadable
  const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
  /**
   * The one place a failure is reported, so one failure files one report however many steps noticed it. A write or delete
   * is reported whatever went wrong (locked, no tool); a read only when the stored value is damaged.
   */
  const loud = async <T>(account: string, step: string, fn: () => Promise<T>, ownOnly = false): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      const ours = e instanceof KeychainError && e.step !== undefined
      if (e instanceof Error && (ours || !ownOnly)) tell(e.message, account, (e as KeychainError).step ?? step)
      throw e
    }
  }

  // ---- one item at a time ----
  /** `security -i` reads the command from stdin, so the secret never appears in argv or `ps` (gate G9). */
  const putItem = async (account: string, text: string, step: string): Promise<void> => {
    const r = await run([SECURITY, '-i'], `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${text}\n`)
    if (r.code !== 0) throw problem('Keychain write failed', step)
  }
  const getItem = async (account: string): Promise<string | undefined> => {
    const r = await run([SECURITY, 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
    if (r.code === 44) return undefined // errSecItemNotFound
    if (r.code !== 0) throw new KeychainError('Keychain locked or unreadable', 'unavailable')
    return r.stdout.trim()
  }
  /** A missing item is fine; any other failure is not, so a leftover is never mistaken for a deleted value. */
  const dropItem = async (account: string): Promise<void> => {
    const r = await run([SECURITY, 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])
    if (r.code !== 0 && r.code !== 44) throw new KeychainError('Keychain delete failed', 'unavailable')
  }
  /** Every chunk of a set, best effort; returns whether all went. */
  const dropChunks = async (account: string, m: Manifest): Promise<boolean> => {
    let ok = true
    for (let i = 0; i < m.count; i++) await dropItem(chunkAccount(account, m.gen, i)).catch(() => (ok = false))
    return ok
  }

  // ---- values ----
  const decode = (account: string, payload: string): string => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(payload))
    } catch {
      throw problem('Keychain value is damaged', 'decode')
    }
  }
  /** Reads the chunks a manifest names, in order, and checks the whole against its hash. */
  const assemble = async (account: string, m: Manifest): Promise<string | undefined> => {
    let payload = ''
    for (let i = 0; i < m.count; i++) {
      const t = await getItem(chunkAccount(account, m.gen, i))
      if (t === undefined || !t.startsWith(VALUE_PREFIX)) return undefined
      payload += t.slice(VALUE_PREFIX.length)
    }
    return sha256Hex(payload) === m.sha ? payload : undefined
  }
  const readNow = async (account: string): Promise<string | undefined> => {
    // a writer in another process may replace the chunk set between the manifest read and the chunk reads: try again
    // while the manifest keeps changing, and call it damaged only when it holds still
    for (let attempt = 0; ; attempt++) {
      const text = await getItem(account)
      if (text === undefined) return undefined
      if (text.startsWith(VALUE_PREFIX)) return decode(account, text.slice(VALUE_PREFIX.length))
      const m = text.startsWith(MANIFEST_PREFIX) ? parseManifest(text) : undefined
      if (!m) throw new KeychainError('Keychain item is not ours', 'unavailable')
      const payload = await assemble(account, m)
      if (payload !== undefined) return decode(account, payload)
      if (attempt >= 2 || (await getItem(account)) === text) throw problem('Keychain value is damaged', 'assemble')
    }
  }
  const writeNow = async (account: string, value: string): Promise<void> => {
    const payload = b64urlEncode(new TextEncoder().encode(value))
    const count = Math.ceil(payload.length / CHUNK_CHARS)
    if (count > MAX_CHUNKS) throw problem('Keychain value is too large', 'size')
    const before = await getItem(account)
    const old = before?.startsWith(MANIFEST_PREFIX) ? parseManifest(before) : undefined
    const inline = payload.length + VALUE_PREFIX.length <= VALUE_LINE_MAX
    let gen = randomBytes(4).toString('hex')
    while (gen === old?.gen) gen = randomBytes(4).toString('hex') // never the set about to be deleted
    const m: Manifest = { gen, count: inline ? 0 : count, sha: sha256Hex(payload) }
    const target = inline ? VALUE_PREFIX + payload : `${MANIFEST_PREFIX}${m.gen}.${m.count}.${m.sha}`
    try {
      if (!inline) {
        for (let i = 0; i < count; i++)
          await putItem(
            chunkAccount(account, m.gen, i),
            VALUE_PREFIX + payload.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
            'chunk',
          )
        // the chunks are read back and checked before the manifest points at them
        if ((await assemble(account, m)) !== payload) throw problem('Keychain write did not verify', 'verify')
      }
      await putItem(account, target, inline ? 'item' : 'manifest')
      if ((await getItem(account)) !== target) throw problem('Keychain write did not verify', 'verify')
    } catch (e) {
      // a step can fail after the new value landed (a read-back that hit a locked tool): look before cleaning up
      let live: string | undefined
      try {
        live = await getItem(account)
      } catch {
        // could not look: the manifest may be live, so nothing is deleted
        throw problem('Keychain write state unknown', 'verify')
      }
      if (live !== target) {
        // the old value is still the live one, so the new chunks are unreachable: remove them
        if (!inline && !(await dropChunks(account, m)) && e instanceof KeychainError)
          e.step = `${e.step ?? 'write'}+cleanup` // pieces left behind
        throw e
      }
    }
    // the new value is in place and verified; the old chunk set is now unreachable and is removed
    if (old && !(await dropChunks(account, old))) tell('Keychain old chunks not deleted', account, 'cleanup')
  }
  /**
   * Every piece of this account in the Keychain, whichever manifest (if any) names it: leftovers of failed writes, failed
   * deletes and writers in other processes. `dump-keychain` without `-d` lists attributes only, never a secret. Only an item
   * of this service whose name is exactly `<account>.<8 hex>.<number>` counts.
   */
  const listPieces = async (account: string): Promise<string[]> => {
    // only the default keychain, where `add-generic-password` writes: not the whole search list (System, others)
    const d = await run([SECURITY, 'default-keychain'])
    if (d.timedOut) throw problem('Keychain listing timed out', 'sweep')
    const paths = [...d.stdout.matchAll(/^\s*"(\/[^"\n]+)"\s*$/gm)].map((x) => x[1] as string)
    if (d.code !== 0 || paths.length !== 1) throw problem('Default keychain not found', 'sweep')
    const path = paths[0] as string
    // An empty listing is unknown, never "nothing there": while another process writes the same keychain, dump-keychain
    // can print nothing at all and still exit 0 (or 1). A keychain that truly holds none of our items prints nothing too,
    // so an empty or failed listing is settled by a lookup of the service alone (no account, no value). Its 44 counts as
    // "no item of ours" only when the keychain file is there and readable (a missing or unreadable file also answers 44
    // and lists nothing) and a second lookup after a pause agrees. Otherwise the listing is tried again, and one that never
    // comes back whole fails the sweep instead of passing for an empty one.
    const lookupSaysNone = async (): Promise<boolean> => {
      const any = await run([SECURITY, 'find-generic-password', '-s', KEYCHAIN_SERVICE, path])
      if (any.timedOut) throw problem('Keychain listing timed out', 'sweep')
      return any.code === 44
    }
    const deadline = Date.now() + SWEEP_BUDGET_MS
    let r: SpawnResult | undefined
    for (let attempt = 0; attempt < LIST_ATTEMPTS && (attempt === 0 || Date.now() < deadline); attempt++) {
      if (attempt > 0) await pause(LIST_RETRY_MS * 2 ** (attempt - 1))
      const got = await run([SECURITY, 'dump-keychain', path])
      if (got.timedOut) throw problem('Keychain listing timed out', 'sweep')
      if (got.code === 0 && got.stdout.trim() !== '') {
        r = got
        break
      }
      if (readable(path) && (await lookupSaysNone())) {
        await pause(LIST_RETRY_MS)
        if (readable(path) && (await lookupSaysNone())) return []
      }
    }
    if (!r) throw problem('Keychain items could not be listed', 'sweep')
    const piece = new RegExp(`^${account.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\.[0-9a-f]{8}\\.[0-9]{1,3}$`)
    const found: string[] = []
    let acct: string | undefined
    let svce: string | undefined
    const flush = () => {
      if (svce === KEYCHAIN_SERVICE && acct !== undefined && piece.test(acct)) found.push(acct)
      acct = svce = undefined
    }
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('keychain: ')) flush()
      acct = /^\s+"acct"<blob>="(.*)"$/.exec(line)?.[1] ?? acct
      svce = /^\s+"svce"<blob>="(.*)"$/.exec(line)?.[1] ?? svce
    }
    flush()
    return found
  }
  const deleteNow = async (account: string): Promise<void> => {
    const text = await getItem(account)
    const m = text?.startsWith(MANIFEST_PREFIX) ? parseManifest(text) : undefined
    await dropItem(account) // the manifest first: a reader stops following the chunks before they go
    // the pieces it names go next, whatever any listing says; the listing below retries any that stayed
    const named = m ? await dropChunks(account, m) : true
    let pieces: string[]
    try {
      pieces = await listPieces(account)
    } catch (e) {
      // say only what is certain: the value and the pieces it named are gone (or not), and leftovers were not checked
      if (!named) throw problem('Keychain pieces not deleted', 'delete')
      if (e instanceof KeychainError)
        e.message = `${text === undefined ? 'Keychain item was not there' : 'Keychain value removed'}; leftover pieces could not be checked (${e.message})`
      throw e
    }
    let ok = true
    for (const piece of pieces) await dropItem(piece).catch(() => (ok = false))
    if (!ok) throw problem('Keychain pieces not deleted', 'delete')
  }

  // One operation at a time per account inside this process, so two saves cannot interleave their chunk sets.
  const tails = new Map<string, Promise<unknown>>()
  const serial = <T>(account: string, fn: () => Promise<T>): Promise<T> => {
    const result = (tails.get(account) ?? Promise.resolve()).then(fn, fn)
    const tail = result.catch(() => undefined)
    tails.set(account, tail)
    void tail.then(() => tails.get(account) === tail && tails.delete(account))
    return result
  }

  return {
    async write(account, value) {
      check(account)
      return serial(account, () => loud(account, 'write', () => writeNow(account, value)))
    },
    async read(account) {
      check(account)
      return serial(account, () => loud(account, 'read', () => readNow(account), true))
    },
    async delete(account) {
      check(account)
      return serial(account, () => loud(account, 'delete', () => deleteNow(account)))
    },
  }
}

/**
 * The runner on top of a SecretStore (the contract's): the Secret Service or a 0600 file off macOS. The account rule is the
 * same as on the Mac, and a store that cannot be read is reported as `unavailable`, never written over.
 */
export function storeRunner(store: () => Promise<SecretStore>): KeychainRunner {
  const check = (account: string) => {
    if (!ACCOUNT.test(account)) throw new KeychainError('bad keychain account', 'bad_account')
  }
  const call = async <T>(f: (s: SecretStore) => Promise<T>): Promise<T> => {
    try {
      return await f(await store())
    } catch (e) {
      if (e instanceof KeychainError) throw e
      const code = e instanceof SecretError ? e.code : 'unavailable'
      throw new KeychainError(
        `secret store: ${e instanceof Error ? e.message : 'failed'}`,
        code === 'bad_account' ? 'bad_account' : 'unavailable',
      )
    }
  }
  return {
    async write(account, value) {
      check(account)
      await call((s) => s.set(KEYCHAIN_SERVICE, account, value))
    },
    async read(account) {
      check(account)
      return call((s) => s.get(KEYCHAIN_SERVICE, account))
    },
    async delete(account) {
      check(account)
      await call((s) => s.delete(KEYCHAIN_SERVICE, account))
    },
  }
}

const REOPEN_AFTER_MS = 60_000

/** macOS: the Keychain through `security`, as always. Elsewhere: the machine's SecretStore, chosen once on first use. */
export function defaultKeychainRunner(
  home: string,
  open: (home: string) => Promise<SecretStore> = (h) => openSecretStore({ home: h }),
  now: () => number = Date.now,
  security: SecurityRunnerOptions = {},
): KeychainRunner {
  if (process.platform === 'darwin') return securityRunner(undefined, security)
  let opened: Promise<SecretStore> | undefined
  let failedAt: number | undefined
  return storeRunner(async () => {
    // a keyring that was not working is asked again after a while, not kept failing until the bridge restarts, and not
    // probed on every call either (each probe is a few secret-tool runs, and may show the owner a prompt)
    if (opened && failedAt !== undefined && now() - failedAt > REOPEN_AFTER_MS) opened = undefined
    const fresh = !opened
    opened ??= open(home)
    const store = await opened
    if (!isUnavailableStore(store)) failedAt = undefined
    else if (fresh) failedAt = now()
    return store
  })
}

/** First 16 hex of sha256(server, source), the account stem. */
export const serverIdOf = (server: string, source: string): string =>
  createHash('sha256').update(`${server}\u0000${source}`).digest('hex').slice(0, 16)

/** Per-server secrets on top of a runner. */
export class ServerSecrets {
  constructor(private readonly kc: KeychainRunner) {}

  async hmacKey(id: string): Promise<Uint8Array> {
    const have = await this.kc.read(`${id}/hmac-key`)
    if (have) return b64urlDecode(have)
    const key = new Uint8Array(randomBytes(32))
    await this.kc.write(`${id}/hmac-key`, b64urlEncode(key))
    return key
  }

  /** HMAC-SHA256 (hex) over the JCS form of the reported config. Two callers with the same config get the same value. */
  async fingerprint(id: string, config: unknown): Promise<string> {
    const key = await this.hmacKey(id)
    return createHmac('sha256', key).update(jcs(config)).digest('hex')
  }

  async saveConfig(id: string, config: unknown): Promise<void> {
    await this.kc.write(`${id}/config`, jcs(config))
  }

  async loadConfig(id: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.kc.read(`${id}/config`)
    if (raw === undefined) return undefined
    try {
      const v: unknown = JSON.parse(raw)
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  async saveOauth(id: string, state: unknown): Promise<void> {
    await this.kc.write(`${id}/oauth`, jcs(state))
  }

  async loadOauth(id: string): Promise<Record<string, unknown> | undefined> {
    const raw = await this.kc.read(`${id}/oauth`)
    if (raw === undefined) return undefined
    try {
      const v: unknown = JSON.parse(raw)
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }

  /** `apps logout`: the server's `oauth` and `config` items. */
  async logout(id: string): Promise<void> {
    // one after the other: two deletes at once each list the keychain while the other writes it, which can empty a listing
    // (see listPieces). Both are tried; a failure on the first does not leave the second behind, and the first is thrown.
    let failed: { reason: unknown } | undefined
    for (const kind of ['oauth', 'config']) {
      try {
        await this.kc.delete(`${id}/${kind}`)
      } catch (reason) {
        failed ??= { reason }
      }
    }
    if (failed) throw failed.reason
  }
}
