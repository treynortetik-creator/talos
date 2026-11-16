// The SecretStore of the supervisor contract (@talos-app/protocol, section 5): one interface, three backends.
//   macos_keychain  the login Keychain through /usr/bin/security (values typed into `security -i` on stdin, never argv)
//   secret_service  the freedesktop Secret Service through `secret-tool` (libsecret: GNOME Keyring, KWallet), value on stdin
//   file_0600       one 0600 file per item in a 0700 folder under the Talos config, when there is no keyring (headless WSL).
//                   Weaker: anything running as the owner can read it. Refused on a Windows drive (/mnt/<drive> on WSL).
// Every value is stored as `v1.` + base64url, so an item that does not start with it is not ours, and `set` refuses to
// replace an item it cannot read (not ours, locked) rather than overwrite something another program keeps there.
// The backend chosen the first time is remembered: a keyring that is down later is an error, never a quiet move to the file.
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  b64urlDecode,
  b64urlEncode,
  type SecretBackend,
  type SecretErrorCode,
  type SecretStore,
} from '@talos-app/protocol'
import { pathIssue as defaultPathIssue } from './platform.ts'

export class SecretError extends Error {
  constructor(
    readonly code: SecretErrorCode,
    message: string,
  ) {
    super(message)
  }
}

const VALUE_PREFIX = 'v1.'
/** No space, quote, backslash or newline: a name goes into a `security -i` command line, so nothing in it may be parsed. */
const NAME = /^[A-Za-z0-9._@:/-]{1,200}$/
const SPAWN_TIMEOUT_MS = 15_000
/** Larger than any token or key the bridge keeps; a bigger value or file is refused. */
const MAX_VALUE_BYTES = 256 * 1024

function checkNames(service: string, account: string): void {
  if (!NAME.test(service) || !NAME.test(account)) throw new SecretError('bad_account', 'bad secret name')
}

export const encodeValue = (value: string): string => VALUE_PREFIX + b64urlEncode(new TextEncoder().encode(value))

export function decodeValue(stored: string): string {
  const text = stored.trim()
  if (!text.startsWith(VALUE_PREFIX)) throw new SecretError('not_ours', 'secret item is not ours')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b64urlDecode(text.slice(VALUE_PREFIX.length)))
  } catch {
    throw new SecretError('not_ours', 'secret item is not ours')
  }
}

// ---- running a tool -----------------------------------------------------------------------------------------------------------

export type SecretSpawnResult = { code: number; stdout: string; stderr: string }
/**
 * argv only, never a shell. `env` is added to this process's environment (the session bus address). Rejects when the tool
 * cannot start; a tool that runs past the limit is killed (code -1).
 */
export type SecretSpawn = (argv: string[], stdin?: string, env?: Record<string, string>) => Promise<SecretSpawnResult>

export const bunSecretSpawn: SecretSpawn = async (argv, stdin, env) => {
  const proc = Bun.spawn(argv, {
    ...(env ? { env: { ...process.env, ...env } } : {}),
    stdin: stdin === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (stdin !== undefined) {
    const sink = proc.stdin as { write(s: string): unknown; end(): unknown }
    sink.write(stdin)
    sink.end()
  }
  // a keyring that pops an unlock prompt nobody answers must not hang the caller
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill('SIGKILL')
  }, SPAWN_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ])
    return { code: timedOut ? -1 : code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function run(
  spawn: SecretSpawn,
  argv: string[],
  stdin?: string,
  env?: Record<string, string>,
): Promise<SecretSpawnResult> {
  try {
    return await spawn(argv, stdin, env)
  } catch {
    throw new SecretError('unavailable', `${argv[0]} could not start`)
  }
}

// ---- macOS Keychain -----------------------------------------------------------------------------------------------------------

const SECURITY = '/usr/bin/security'
const ERR_SEC_ITEM_NOT_FOUND = 44
/** Below the ~4 KB line `security -i` reads; a longer command is cut, and the rest runs as another command. */
const SECURITY_LINE_MAX = 3800

export function macosKeychainStore(spawn: SecretSpawn = bunSecretSpawn): SecretStore {
  const get = async (service: string, account: string): Promise<string | undefined> => {
    checkNames(service, account)
    const r = await run(spawn, [SECURITY, 'find-generic-password', '-s', service, '-a', account, '-w'])
    if (r.code === ERR_SEC_ITEM_NOT_FOUND) return undefined
    if (r.code !== 0) throw new SecretError('locked', 'Keychain locked or unreadable')
    return decodeValue(r.stdout)
  }
  return {
    backend: 'macos_keychain',
    strength: 'os_keyring',
    get,
    async set(service, account, value) {
      checkNames(service, account)
      await get(service, account) // throws for an item that is not ours or a locked Keychain: never replaced blind
      // `security -i` reads its commands from stdin, so the value never reaches argv or `ps`. It cuts a line at about 4 KB
      // (confirmed on a Mac: a 6 KB value stored nothing), so a longer line is refused here, never sent cut. The bridge's
      // securityRunner (apps/keychain.ts) stores longer values as chunks behind a verified manifest; this store does not yet.
      const line = `add-generic-password -U -s ${service} -a ${account} -w ${encodeValue(value)}\n`
      if (Buffer.byteLength(line) > SECURITY_LINE_MAX)
        throw new SecretError('unavailable', 'value too large for the Keychain tool')
      const r = await run(spawn, [SECURITY, '-i'], line)
      if (r.code !== 0) throw new SecretError('unavailable', 'Keychain write failed')
    },
    async delete(service, account) {
      checkNames(service, account)
      const r = await run(spawn, [SECURITY, '-i'], `delete-generic-password -s ${service} -a ${account}\n`)
      if (r.code !== 0 && r.code !== ERR_SEC_ITEM_NOT_FOUND)
        throw new SecretError('unavailable', 'Keychain delete failed')
    },
  }
}

// ---- Secret Service (secret-tool) ---------------------------------------------------------------------------------------------

/**
 * `secret-tool lookup` and `clear` exit 1 with nothing on stderr both for "no such item" and for an item in a LOCKED collection
 * (checked with gnome-keyring 51 and no prompter). `search` tells them apart: it lists an item that exists even when it is
 * locked (and says "Cannot get secret of a locked object" on stderr), and prints nothing for one that does not exist.
 */
const quietOne = (r: SecretSpawnResult) => r.code === 1 && r.stderr.trim() === '' && r.stdout === ''

export function secretServiceStore(
  spawn: SecretSpawn = bunSecretSpawn,
  tool = 'secret-tool',
  busEnv?: Record<string, string>,
): SecretStore {
  const sh = (argv: string[], stdin?: string) => run(spawn, argv, stdin, busEnv)
  const failed = (r: SecretSpawnResult, what: string) =>
    new SecretError(r.code === -1 ? 'locked' : 'unavailable', `Secret Service ${what} (locked or unreachable)`)
  /** After a quiet exit 1: is the item really absent, or there but locked? */
  const absent = async (service: string, account: string): Promise<boolean> => {
    const s = await sh([tool, 'search', 'service', service, 'account', account])
    if (s.code !== 0) throw failed(s, 'search failed')
    if (s.stdout.trim() !== '') throw new SecretError('locked', 'the keyring is locked')
    return true
  }
  const get = async (service: string, account: string): Promise<string | undefined> => {
    checkNames(service, account)
    const r = await sh([tool, 'lookup', 'service', service, 'account', account])
    if (r.code === 0) return decodeValue(r.stdout)
    if (quietOne(r) && (await absent(service, account))) return undefined
    throw failed(r, 'read failed')
  }
  return {
    backend: 'secret_service',
    strength: 'os_keyring',
    get,
    async set(service, account, value) {
      checkNames(service, account)
      await get(service, account)
      // the secret is read from stdin (not a terminal, so no prompt); no trailing newline, which secret-tool would keep
      const r = await sh(
        [tool, 'store', `--label=Talos: ${service} ${account}`, 'service', service, 'account', account],
        encodeValue(value),
      )
      if (r.code !== 0) throw failed(r, 'write failed')
    },
    async delete(service, account) {
      checkNames(service, account)
      const r = await sh([tool, 'clear', 'service', service, 'account', account])
      if (r.code === 0) return
      // a locked item is not cleared and says nothing: logout must not report a token gone that is still kept
      if (quietOne(r) && (await absent(service, account))) return
      throw failed(r, 'delete failed')
    },
  }
}

// ---- 0600 files ---------------------------------------------------------------------------------------------------------------

export type FileStoreOptions = {
  pathIssue?: (path: string) => 'windows_drive' | null
  uid?: number
}

/** One file per item, named by a hash of (service, account): the names never become paths. */
export function fileSecretStore(dir: string, opts: FileStoreOptions = {}): SecretStore {
  const issue = opts.pathIssue ?? ((p: string) => defaultPathIssue(p))
  const uid = opts.uid ?? process.getuid?.() ?? -1
  const fileOf = (service: string, account: string) =>
    join(dir, `${createHash('sha256').update(`${service}\u0000${account}`).digest('hex').slice(0, 32)}.secret`)

  /** The folder must be ours, a real folder (no link), and closed to everyone else; it is made 0700 when missing. */
  const folder = (create: boolean): boolean => {
    if (issue(dir)) throw new SecretError('unavailable', 'secrets cannot be kept on a Windows drive')
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(dir)
    } catch {
      if (!create) return false
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      st = lstatSync(dir)
    }
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0)
      throw new SecretError('not_ours', 'the secrets folder is not private to this user')
    return true
  }

  const read = (service: string, account: string): string | undefined => {
    if (!folder(false)) return undefined
    let fd: number
    try {
      fd = openSync(fileOf(service, account), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new SecretError('not_ours', 'secret file cannot be opened')
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.nlink !== 1 || st.size > MAX_VALUE_BYTES * 2)
        throw new SecretError('not_ours', 'secret file is not private to this user')
      let item: unknown
      try {
        item = JSON.parse(readFileSync(fd, 'utf8'))
      } catch {
        throw new SecretError('not_ours', 'secret file is not ours')
      }
      const it = item as { service?: unknown; account?: unknown; value?: unknown }
      if (it?.service !== service || it.account !== account || typeof it.value !== 'string')
        throw new SecretError('not_ours', 'secret file is not ours')
      return decodeValue(it.value)
    } finally {
      closeSync(fd)
    }
  }

  return {
    backend: 'file_0600',
    strength: 'file',
    async get(service, account) {
      checkNames(service, account)
      return read(service, account)
    },
    async set(service, account, value) {
      checkNames(service, account)
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new SecretError('unavailable', 'secret too large')
      read(service, account) // throws for a file that is not ours: never replaced blind
      folder(true)
      const path = fileOf(service, account)
      const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      // O_EXCL + O_NOFOLLOW: the temp file is new and ours, 0600 from its first byte
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        writeSync(fd, JSON.stringify({ service, account, value: encodeValue(value) }))
        fsyncSync(fd)
      } catch (e) {
        closeSync(fd)
        rm(tmp)
        throw e
      }
      closeSync(fd)
      try {
        renameSync(tmp, path)
      } catch (e) {
        rm(tmp)
        throw e
      }
    },
    async delete(service, account) {
      checkNames(service, account)
      if (!folder(false)) return
      rm(fileOf(service, account))
    },
  }
}

function rm(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

// ---- choosing one -------------------------------------------------------------------------------------------------------------

export type OpenSecretStoreOptions = {
  /** The Talos config folder ($TALOS_APP_HOME): holds `secrets/` (the file backend) and `secret-backend` (the choice). */
  home: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  spawn?: SecretSpawn
  pathIssue?: (path: string) => 'windows_drive' | null
  /** Where the session bus socket is looked for when the environment names none (default $XDG_RUNTIME_DIR, /run/user/<uid>). */
  runtimeDir?: string
}

const PROBE_SERVICE = 'com.talos.app.probe'
const unavailable = new WeakSet<SecretStore>()

/** True for a store made by unavailableStore: the caller may try to open again later instead of keeping it. */
export const isUnavailableStore = (s: SecretStore): boolean => unavailable.has(s)

/**
 * The store for this machine. macOS: the Keychain. Elsewhere: the Secret Service when it really stores (a probe item is
 * written, read back and removed), else, on a machine with no screen (headless WSL, a server), the 0600 file.
 * - On a desktop (DISPLAY or WAYLAND_DISPLAY) whose keyring does not work now (locked, still starting), every call fails
 *   `unavailable` and nothing is remembered: secrets are never moved to the weaker file because of one bad moment.
 * - A process with no session bus in its environment (ssh, cron) still finds the owner's bus at /run/user/<uid>/bus.
 * - The first choice is written to `<home>/secret-backend` with O_EXCL (two first starts agree on one) and kept: when the
 *   remembered keyring is down later, every call fails instead of quietly writing secrets to a file.
 * - `TALOS_SECRET_BACKEND` forces one (secret_service or file_0600), and is never remembered.
 */
export async function openSecretStore(opts: OpenSecretStoreOptions): Promise<SecretStore> {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const spawn = opts.spawn ?? bunSecretSpawn
  const bus = sessionBus(env, opts.runtimeDir)
  const file = () => fileSecretStore(join(opts.home, 'secrets'), opts.pathIssue ? { pathIssue: opts.pathIssue } : {})
  const keyring = () => secretServiceStore(spawn, 'secret-tool', bus ? { DBUS_SESSION_BUS_ADDRESS: bus } : undefined)
  if (platform === 'darwin') return macosKeychainStore(spawn)

  const forced = env.TALOS_SECRET_BACKEND
  if (forced !== undefined) {
    if (forced === 'secret_service') return keyring()
    if (forced === 'file_0600') return file()
    return unavailableStore('file_0600', `unknown TALOS_SECRET_BACKEND ${forced}`)
  }
  const choicePath = join(opts.home, 'secret-backend')
  const use = async (remembered: string | undefined): Promise<SecretStore | undefined> => {
    if (remembered === 'file_0600') return file()
    if (remembered === 'secret_service')
      return bus && (await reachable(spawn, bus))
        ? keyring()
        : unavailableStore(
            'secret_service',
            'the keyring this machine uses is not answering (is it running and unlocked?)',
          )
    if (remembered !== undefined) return unavailableStore('file_0600', 'secret-backend names no known store')
    return undefined
  }
  const known = await use(readChoice(choicePath))
  if (known) return known

  // decided from what the keyring itself reports, never from DISPLAY (WSLg sets DISPLAY in every WSL2 shell, and an ssh shell
  // has none on a desktop whose keyring is only locked)
  const probe = bus ? await probeKeyring(spawn, bus) : 'none'
  if (probe === 'busy')
    return unavailableStore(
      'secret_service',
      'the keyring is locked or not ready (unlock it and try again); nothing was saved',
    )
  const chosen: SecretBackend = probe === 'stores' ? 'secret_service' : 'file_0600'
  // whoever wrote the choice first wins; a process that lost the race uses the winner's choice, not its own
  const winner = writeChoiceOnce(opts.home, choicePath, chosen)
  return (await use(winner)) ?? (chosen === 'secret_service' ? keyring() : file())
}

function sessionBus(env: NodeJS.ProcessEnv, runtimeDir?: string): string | undefined {
  if (env.DBUS_SESSION_BUS_ADDRESS) return env.DBUS_SESSION_BUS_ADDRESS
  const dir = runtimeDir ?? env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ''}`
  try {
    return lstatSync(join(dir, 'bus')).isSocket() ? `unix:path=${join(dir, 'bus')}` : undefined
  } catch {
    return undefined
  }
}

/** The remembered keyring is there (a quiet miss or a hit; a locked one still answers, and its calls then say locked). */
async function reachable(spawn: SecretSpawn, bus: string): Promise<boolean> {
  try {
    const r = await spawn(['secret-tool', 'lookup', 'service', PROBE_SERVICE, 'account', 'probe'], undefined, {
      DBUS_SESSION_BUS_ADDRESS: bus,
    })
    return r.code === 0 || quietOne(r)
  } catch {
    return false
  }
}

/**
 * What a first start finds, from a probe item written, read back and removed:
 * - `stores`: a working keyring.
 * - `none`: no keyring on this machine. Cases: no secret-tool, no Secret Service on the bus, the bus unreachable, or a
 *   Secret Service with no collection and no way to make one, as on headless WSL with gnome-keyring installed. A desktop
 *   still asks to create a collection, so that case answers through the prompt or the timeout.
 * - `busy`: a keyring that exists but cannot be used now (locked, a prompt nobody answered, anything else). Nothing is
 *   decided, so a locked desktop keyring is never swapped for the file.
 */
async function probeKeyring(spawn: SecretSpawn, bus: string): Promise<'stores' | 'none' | 'busy'> {
  const env = { DBUS_SESSION_BUS_ADDRESS: bus }
  const account = `probe-${process.pid}`
  const args = ['service', PROBE_SERVICE, 'account', account]
  let r: SecretSpawnResult
  try {
    r = await spawn(
      ['secret-tool', 'store', '--label=Talos probe (removed at once)', ...args],
      encodeValue('probe'),
      env,
    )
  } catch {
    return 'none' // no secret-tool
  }
  if (r.code !== 0) {
    if (r.code === -1) return 'busy'
    return NO_KEYRING.test(r.stderr) ? 'none' : 'busy'
  }
  try {
    const back = await spawn(['secret-tool', 'lookup', ...args], undefined, env)
    return back.code === 0 && back.stdout.trim() === encodeValue('probe') ? 'stores' : 'busy'
  } catch {
    return 'busy'
  } finally {
    await spawn(['secret-tool', 'clear', ...args], undefined, env).catch(() => {})
  }
}

/**
 * secret-tool's words when there is no keyring to use, as opposed to a locked one ("Cannot create an item in a locked
 * collection"). Checked with secret-tool 0.21 and gnome-keyring 51: no bus, no service, no default collection.
 */
const NO_KEYRING =
  /Could not connect|was not provided by any \.service files|ServiceUnknown|Object does not exist at path|No such interface/i

function readChoice(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return undefined
  }
}

/** Writes the choice unless one exists (link() fails on an existing name), and returns the choice that is on disk. */
function writeChoiceOnce(home: string, path: string, backend: SecretBackend): string | undefined {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, `${backend}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    linkSync(tmp, path)
  } catch {
    // EEXIST: another process chose first. Anything else: not remembered, and the next start chooses again
  } finally {
    rm(tmp)
  }
  return readChoice(path)
}

/** A store whose every call fails `unavailable` (with why): the caller reports it, nothing is written anywhere. */
export function unavailableStore(backend: SecretBackend, why: string): SecretStore {
  const fail = async (): Promise<never> => {
    throw new SecretError('unavailable', why)
  }
  const store: SecretStore = {
    backend,
    strength: backend === 'file_0600' ? 'file' : 'os_keyring',
    get: fail,
    set: fail,
    delete: fail,
  }
  unavailable.add(store)
  return store
}
