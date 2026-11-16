// One sandbox on disk: where it lives, what it started, and how its processes are told apart from anyone else's.
// A sandbox is a folder `<base>/talos-sandbox-<id>` holding its own Talos home, agent folder, relay data and logs.
// Every process it starts is recorded by pid AND start time, and is only ever signalled while both still match, so a
// pid the system handed to another process later is never touched.
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isInheritedClaudeVar } from '../../apps/bridge/src/claude-env.ts'
import { processGroup, processStartTime } from '../../apps/bridge/src/proc-identity.ts'

export type Proc = { pid: number; start: string }

export type SandboxRecord = {
  v: 1
  id: string
  root: string
  created_at: string
  /** `fake`: a scripted stand-in for Claude Code. `real`: the `claude` on PATH, with the model below. */
  mode: 'fake' | 'real'
  model: string
  relay: { port: number; origin: string; proc: Proc | null }
  supervisor: { proc: Proc | null }
  tmux: { bin: string; socket: string }
  home: string
  agent_dir: string
  claude_path: string
  /**
   * `up --auto-dev-channels` (a real-claude sandbox only): every `drive` command and every wait for a restart answer the
   * development-channels warning a restarted Main stops at. Off unless asked for: the product never answers it alone.
   */
  auto_dev_channels?: boolean
}

/** The phone the driver plays: its device key and its session cookie. Lives in the sandbox root, mode 0600. */
export type PhoneRecord = {
  device_id: string
  private_jwk: JsonWebKey
  public_jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  cookie: string
  /** The highest relay seq this phone has seen, so the next connection catches up from there. */
  last_seq: number
}

export class SandboxError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const ID = /^[0-9a-f]{8}$/
export const PREFIX = 'talos-sandbox-'

export const newId = (): string => randomBytes(4).toString('hex')

/** Where sandboxes live. `/tmp` unless TALOS_SANDBOX_BASE names another folder (the tests do). */
export function baseDir(): string {
  const base = process.env.TALOS_SANDBOX_BASE || '/tmp'
  mkdirSync(base, { recursive: true })
  return realpathSync(base)
}

export function rootOf(id: string): string {
  if (!ID.test(id)) throw new SandboxError('bad_id', `not a sandbox id: ${JSON.stringify(id)} (eight hex characters)`)
  return join(baseDir(), `${PREFIX}${id}`)
}

/** The private tmux server of one sandbox. Never `talos` (the owner's) and never `default`. */
export const socketOf = (id: string): string => `${PREFIX}${id}`

export const files = (root: string) => ({
  record: join(root, 'sandbox.json'),
  phone: join(root, 'phone.json'),
  relayEnv: join(root, 'relay.json'),
  relayLog: join(root, 'relay.log'),
  relayData: join(root, 'relay-data'),
  supervisorOut: join(root, 'supervisor.out'),
  fakeClaude: join(root, 'fake-claude.json'),
  fakeClaudeLog: join(root, 'fake-claude.log'),
  home: join(root, 'home'),
  agent: join(root, 'agent'),
  userHome: join(root, 'userhome'),
  inbox: join(root, 'inbox'),
  bin: join(root, 'bin'),
})

export function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function loadRecord(id: string): SandboxRecord {
  const root = rootOf(id)
  const rec = readJson<SandboxRecord>(files(root).record)
  if (!rec || rec.id !== id || rec.root !== root)
    throw new SandboxError(
      'no_sandbox',
      existsSync(root) ? `${root} has no readable sandbox.json` : `no sandbox ${id} (looked for ${root})`,
    )
  return rec
}

export const saveRecord = (rec: SandboxRecord): void => writeJson(files(rec.root).record, rec)

export function listIds(): string[] {
  try {
    return readdirSync(baseDir())
      .filter((n) => n.startsWith(PREFIX) && ID.test(n.slice(PREFIX.length)))
      .map((n) => n.slice(PREFIX.length))
      .sort()
  } catch {
    return []
  }
}

// ---- processes ----------------------------------------------------------------------------------------------------

export function procOf(pid: number | null | undefined): Proc | null {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return null
  const start = processStartTime(pid)
  return start === null ? null : { pid, start }
}

/** Still the process that was recorded (same pid, same start time). */
export const isAlive = (p: Proc | null): boolean => p !== null && processStartTime(p.pid) === p.start

/** Signals the recorded process only while it is still that process. */
export function signal(p: Proc | null, sig: NodeJS.Signals): boolean {
  if (!isAlive(p)) return false
  try {
    process.kill((p as Proc).pid, sig)
    return true
  } catch {
    return false
  }
}

export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Signals a whole process group, never this process's own. */
export function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid || pgid === processGroup(process.pid)) return false
  try {
    process.kill(-pgid, sig)
    return true
  } catch {
    return false
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function waitUntil(
  fn: () => boolean | Promise<boolean>,
  what: string,
  ms: number,
  everyMs = 100,
): Promise<void> {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end)
      throw new SandboxError('timeout', `timed out after ${Math.round(ms / 1000)} s waiting for ${what}`)
    await sleep(everyMs)
  }
}

/** SIGTERM, then SIGKILL after `graceMs` if it is still that process. True when it is gone at the end. */
export async function stopProc(p: Proc | null, graceMs: number): Promise<boolean> {
  if (!isAlive(p)) return true
  signal(p, 'SIGTERM')
  const end = Date.now() + graceMs
  while (isAlive(p) && Date.now() < end) await sleep(100)
  if (isAlive(p)) {
    signal(p, 'SIGKILL')
    const end2 = Date.now() + 3000
    while (isAlive(p) && Date.now() < end2) await sleep(50)
  }
  return !isAlive(p)
}

/**
 * The environment every sandbox process starts from: this process's own, minus anything that would tie a child to the
 * session or the Talos install that launched the command (a thread session's identity, an inherited Talos home, the markers
 * of a running Claude Code, an outer tmux).
 */
export function cleanEnv(from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue
    if (k.startsWith('TALOS_') && k !== 'TALOS_SANDBOX_BASE' && k !== 'TALOS_TEST_WAIT_SCALE') continue
    if (isInheritedClaudeVar(k) || k === 'TMUX_TMPDIR') continue
    if (k === 'TELEGRAM_STATE_DIR' || k === 'IMESSAGE_STATE_DIR' || k === 'TELEGRAM_BOT_TOKEN') continue
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue
    out[k] = v
  }
  return out
}
