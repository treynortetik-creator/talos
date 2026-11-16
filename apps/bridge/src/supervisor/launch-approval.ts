// The launch the owner approved, on Linux and WSL: the only thing that lets the supervisor answer Main's development-channels
// warning on its own (with the constant checks; main.ts). The Mac seals its approval with an HMAC under a Keychain key; on Linux
// the distro gives something simpler and stronger: root exists and the agent is not root. The approved fingerprint lives in a
// ROOT-owned file the talos user can read but never write, so the file's ownership is the seal: no key an agent could read.
//   /etc/talos/launch-approved   root:root 0644, in /etc/talos root:root 0755
//   {"v":1,"fingerprint":"<64 hex>","parts":{"folder","program","flags","env": "<16 hex>"}}
// Written only by root: the install's root setup (the install is the owner's confirmation) and the Windows tray's root path when
// the owner approves a changed launch (`talos-wsl.sh launch-approve`, which computes the fingerprint itself from supervisor.json,
// never taking it from the talos user). No file, a file this cannot trust, or a different fingerprint: never answered.
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import type { MainLaunchConfig } from '@talos-app/protocol'
import { realFileSync } from '../real-file.ts'

export const LAUNCH_APPROVED_FILE = '/etc/talos/launch-approved'

/** What a start launches, as supervisor.json says it (as written: no `~` expanded, no PATH looked up). */
export interface LaunchInputs {
  agentDir: string
  /** supervisor.json's claude_path; null when it names none (then no launch is ever approved). */
  claudePath: string | null
  args: readonly string[]
  env: Readonly<Record<string, string>>
}

/** SHA-256 over the items, each as its UTF-8 byte count, a colon and its bytes (the Mac's Fingerprint.sha256); lowercase hex. */
export function lengthPrefixedSha256(items: readonly string[], bytes = 32): string {
  const h = createHash('sha256')
  for (const item of items) {
    const b = Buffer.from(item, 'utf8')
    h.update(`${b.length}:`)
    h.update(b)
  }
  return h.digest().subarray(0, bytes).toString('hex')
}

// Keys in UTF-8 byte order (= code point order), pinned so the three implementations agree: JS's default sort compares UTF-16
// code units (an astral character would sort before U+FFFD), and the tray's root side sorts by UTF-8 bytes.
// REVIEW (Mac): DesktopConfig's `env.keys.sorted()` compares NFC scalars, which matches this for NFC keys only; sorting by
// `Array($0.utf8).lexicographicallyPrecedes($1.utf8)` would pin it the same way.
const envRows = (env: Readonly<Record<string, string>>) =>
  Object.keys(env)
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .flatMap((k) => [k, env[k] ?? ''])

/** The launch's fingerprint (the Mac's DesktopConfig.launchFingerprint); null when there is no claude_path to name the program. */
export function launchFingerprint(l: LaunchInputs): string | null {
  if (l.claudePath === null) return null
  const rows = envRows(l.env)
  return lengthPrefixedSha256([
    'dir',
    l.agentDir,
    'claude',
    l.claudePath,
    'args',
    String(l.args.length),
    ...l.args,
    'env',
    String(rows.length),
    ...rows,
  ])
}

/** One short hash per piece, so a reader can say which piece changed (never to decide anything). */
export function launchParts(l: LaunchInputs): Record<'folder' | 'program' | 'flags' | 'env', string> {
  return {
    folder: lengthPrefixedSha256([l.agentDir], 8),
    program: lengthPrefixedSha256([l.claudePath ?? ''], 8),
    flags: lengthPrefixedSha256([...l.args], 8),
    env: lengthPrefixedSha256(envRows(l.env), 8),
  }
}

/** The approved launch, or why there is none the supervisor may trust. */
export type Approved = { fingerprint: string; parts: Record<string, string> } | { refused: string }

/**
 * Reads the approval: the folder and the file both owned by root and writable by nobody else, the file a regular file (never
 * through a link) of at most 4 KB, opened without blocking or following a link and judged by its own descriptor. `root` is the
 * owner the folder and the file must have (0; tests pass their own).
 */
export function readApproved(path: string = LAUNCH_APPROVED_FILE, root = 0): Approved {
  const dir = dirname(path)
  let d: ReturnType<typeof lstatSync>
  try {
    d = lstatSync(dir)
  } catch {
    return { refused: `${dir} is not there` }
  }
  if (d.isSymbolicLink() || !d.isDirectory()) return { refused: `${dir} is not a folder` }
  if (d.uid !== root || (d.mode & 0o022) !== 0) return { refused: `${dir} can be written by someone other than root` }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { refused: code === 'ENOENT' ? 'no launch has been approved' : `${path} cannot be opened (${code})` }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { refused: `${path} is not a plain file` }
    if (st.uid !== root || (st.mode & 0o022) !== 0)
      return { refused: `${path} can be written by someone other than root` }
    if (st.size > 4096) return { refused: `${path} is larger than 4 KB` }
    const buf = Buffer.alloc(4097)
    const n = readSync(fd, buf, 0, 4097, 0)
    const raw = JSON.parse(buf.subarray(0, n).toString('utf8')) as {
      v?: unknown
      fingerprint?: unknown
      parts?: unknown
    }
    if (raw.v !== 1 || typeof raw.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(raw.fingerprint))
      return { refused: `${path} is not an approval this supervisor reads` }
    const parts =
      raw.parts && typeof raw.parts === 'object' && !Array.isArray(raw.parts)
        ? Object.fromEntries(
            Object.entries(raw.parts).filter(([, v]) => typeof v === 'string') as Array<[string, string]>,
          )
        : {}
    return { fingerprint: raw.fingerprint, parts }
  } catch {
    return { refused: `${path} cannot be read as an approval` }
  } finally {
    closeSync(fd)
  }
}

/** Whether this launch is the approved one; when not, why (in words for the owner and the tray). */
export function launchApproved(l: LaunchInputs, approved: Approved): { ok: true } | { ok: false; why: string } {
  const fp = launchFingerprint(l)
  if (fp === null) return { ok: false, why: 'supervisor.json names no claude_path' }
  if ('refused' in approved) return { ok: false, why: approved.refused }
  if (approved.fingerprint !== fp) {
    const now = launchParts(l)
    const changed = (['folder', 'program', 'flags', 'env'] as const).filter(
      (k) => approved.parts[k] !== undefined && approved.parts[k] !== now[k],
    )
    return {
      ok: false,
      why:
        changed.length > 0
          ? `the launch changed since it was approved (${changed.join(', ')})`
          : 'the launch is not the approved one',
    }
  }
  return { ok: true }
}

/**
 * supervisor.json as the approval sees it, with the strict schema both sides hold to (the tray's root `launch.py` too; vectors in
 * packages/protocol/fixtures/launch-fingerprint.json): no defaults anywhere. `agent_dir` and `claude_path` are absolute strings
 * (no `~`), `claude_path` is its own real path (no link, no PATH lookup: the program the fingerprint names is the one launched),
 * `args` is a list of strings and must be there, `env` is an object of strings or absent ({}). Anything else is not approvable.
 * `session` and `auto_confirm_restart` are not hashed: the supervisor rewrites the session id at every new session (as the
 * Mac leaves the resume id out), and auto_confirm_restart false already answers nothing. But `session.id` and every
 * `previous_ids` entry reach Claude Code's argv, so each must be absent, null or a lowercase UUID.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A session id as Claude Code makes them: a lowercase UUID, nothing before or after (JS `$` never takes a final newline). */
export const isSessionId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)

export function approvableLaunch(
  raw: unknown,
  // a file's real path by walking it (real-file.ts): on a Mac realpath of a hard-linked file can come back as another name
  realFile: (p: string) => string = realFileSync,
): LaunchInputs | { refused: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    return { refused: 'supervisor.json is not an object' }
  const o = raw as Record<string, unknown>
  const absolute = (v: unknown): v is string => typeof v === 'string' && isAbsolute(v)
  if (!absolute(o.agent_dir)) return { refused: 'agent_dir is not an absolute path' }
  if (!absolute(o.claude_path)) return { refused: 'claude_path is not an absolute path' }
  let real: string
  try {
    real = realFile(o.claude_path)
  } catch {
    return { refused: 'claude_path is not there' }
  }
  // Linux only (this supervisor, and root's launch.py on WSL): on a Mac one file can carry many hard-linked names and realpath
  // may return another of them (/usr/bin's), so a check like this one must not be ported there as it is
  if (real !== o.claude_path) return { refused: 'claude_path is not its own real path (a link, or not normal)' }
  if (!Array.isArray(o.args) || !o.args.every((a) => typeof a === 'string'))
    return { refused: 'args is not a list of strings' }
  // the session id is not hashed (it changes every session) but it reaches the argv: a UUID or nothing (Fable R3-4)
  const session = o.session
  if (session !== undefined) {
    if (session === null || typeof session !== 'object' || Array.isArray(session))
      return { refused: 'session is not an object' }
    const { id, previous_ids: prev } = session as Record<string, unknown>
    if (id !== undefined && id !== null && !(typeof id === 'string' && UUID.test(id)))
      return { refused: 'session.id is not a session id' }
    if (prev !== undefined && !(Array.isArray(prev) && prev.every((p) => typeof p === 'string' && UUID.test(p))))
      return { refused: 'session.previous_ids holds something that is not a session id' }
  }
  let env: Record<string, string> = {}
  if (o.env !== undefined) {
    if (o.env === null || typeof o.env !== 'object' || Array.isArray(o.env)) return { refused: 'env is not an object' }
    if (!Object.values(o.env).every((v) => typeof v === 'string'))
      return { refused: 'env holds a value that is not a string' }
    env = o.env as Record<string, string>
  }
  return { agentDir: o.agent_dir, claudePath: o.claude_path, args: o.args as string[], env }
}

/**
 * Whether root approved the launch a start just read: supervisor.json, read again, must still give exactly `cfg` (the settings
 * the start launched with), be approvable as written (approvableLaunch), and its fingerprint must be the approved one. Any
 * doubt is "not approved", with why.
 */
export function launchIsApproved(
  configPath: string,
  reread: () => MainLaunchConfig | { error: string },
  cfg: MainLaunchConfig,
  approvedPath = LAUNCH_APPROVED_FILE,
  root = 0,
  realFile?: (p: string) => string,
): { ok: true } | { ok: false; why: string } {
  let o: unknown
  try {
    o = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { ok: false, why: 'supervisor.json could not be read' }
  }
  const now = reread()
  if ('error' in now) return { ok: false, why: now.error }
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const sorted = (e: Record<string, string>) =>
    Object.fromEntries(Object.entries(e).sort(([a], [b]) => (a < b ? -1 : 1)))
  if (
    now.agentDir !== cfg.agentDir ||
    now.claudePath !== cfg.claudePath ||
    !same(now.args, cfg.args) ||
    !same(sorted(now.env), sorted(cfg.env))
  )
    return { ok: false, why: 'supervisor.json changed since the start read it' }
  const inputs = approvableLaunch(o, realFile)
  if ('refused' in inputs) return { ok: false, why: `supervisor.json is not approvable: ${inputs.refused}` }
  // what the start launches is exactly what is approved: the bytes this read hashed name the same folder, program, flags and
  // env as the settings the start launched with (a file swapped between reads never pairs approved bytes with other flags)
  if (
    inputs.agentDir !== cfg.agentDir ||
    inputs.claudePath !== cfg.claudePath ||
    !same(inputs.args, cfg.args) ||
    !same(sorted(inputs.env), sorted(cfg.env))
  )
    return { ok: false, why: 'the launch is not supervisor.json as written' }
  const r = launchApproved(inputs, readApproved(approvedPath, root))
  return r.ok ? { ok: true } : { ok: false, why: r.why }
}

/** The folder holds `.talos-version` as a plain file (the install wrote it), never through a link. */
export function isTalosFolder(dir: string): boolean {
  try {
    return lstatSync(join(dir, '.talos-version')).isFile()
  } catch {
    return false
  }
}
