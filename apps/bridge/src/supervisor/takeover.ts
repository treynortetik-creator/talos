// Single instance, takeover-safe: the port of the Mac's TakeoverCheck.swift. The Telegram plugin and the talos-app bridge each
// SIGTERM the previous holder when they start, so a second session does not fail: it silently deafens the first. Before a start
// the supervisor refuses when another session holds either, or runs with the Talos channel, in any folder. `check` is pure;
// the probes below read /proc and `claude agents --json`.
import { readFileSync, readlinkSync, statSync } from 'node:fs'
import { BRIDGE_ENTRY, isOurBridge, type PidRecord } from '../lifecycle.ts'

export type AgentEntry = {
  kind: string
  pid: number | null
  sessionId: string | null
  status: string | null
  cwd: string | null
}

/** `claude agents --json` → its entries; null when it cannot be read (a CLI change, a timeout): check 3 is then skipped. */
export function parseAgents(text: string): AgentEntry[] | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  // a list, or an object wrapping it (`agents` or `sessions`), as the Mac reads it
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as { agents?: unknown; sessions?: unknown }
    raw = Array.isArray(o.agents) ? o.agents : Array.isArray(o.sessions) ? o.sessions : null
  }
  if (!Array.isArray(raw)) return null
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return raw.flatMap((e) => {
    if (e === null || typeof e !== 'object') return []
    const o = e as Record<string, unknown>
    if (typeof o.kind !== 'string') return []
    return [
      {
        kind: o.kind,
        pid: typeof o.pid === 'number' && Number.isInteger(o.pid) ? o.pid : null,
        sessionId: str(o.sessionId)?.toLowerCase() ?? null,
        status: str(o.status) ?? str(o.state),
        cwd: str(o.cwd),
      },
    ]
  })
}

/** The interactive entry for Main's pid. */
export const interactiveEntry = (entries: AgentEntry[], pid: number) =>
  entries.find((e) => e.kind === 'interactive' && e.pid === pid) ?? null

export type Resource = 'telegram' | 'bridge' | 'channels'
export type Blocker = { resource: Resource; holderPid: number; sessionPid: number; folder: string | null }

const RESOURCE_WORDS: Record<Resource, string> = {
  telegram: 'Telegram',
  bridge: 'the Talos bridge',
  channels: 'channels',
}

/** Telegram can never be taken over (it would deafen the other session), so `--anyway` is offered for the others only. */
export const blockerText = (b: Blocker) =>
  `Another Claude session (pid ${b.sessionPid}${b.folder ? `, folder ${b.folder}` : ''}) holds ${RESOURCE_WORDS[b.resource]}. Quit it first${b.resource === 'telegram' ? '' : ', or run: talos-app supervise start --anyway'}.`

/**
 * A `bot.pid` holder that started this long after the file was written cannot have written it (a recycled pid). The Mac uses
 * 2 s; Linux's start time is boot time plus ticks, and boot time moves with every clock step (NTP after a boot or a resume),
 * so a minute: a recycled pid that is also Telegram's server.ts within a minute is not credible.
 */
export const RECYCLED_SLACK_S = 60
export const TELEGRAM_ENTRY = 'server.ts'

export type Proc = { pid: number; pgid: number; argv: string[]; cwd: string | null; startEpochS: number }

export type TakeoverInputs = {
  /** Process groups that are ours: Main now, the Main that just exited, later the thread sessions. */
  ourPgids: Set<number>
  botPid: { pid: number; fileModifiedAtS: number; holder: Proc | null } | null
  bridgePid: { record: PidRecord; ours: boolean; holder: Proc | null } | null
  agents: AgentEntry[] | null
  proc: (pid: number) => Proc | null
}

/** The channel flag in an argv: `--channels`, `--channels=…`, or a value list naming server:talos-app. */
export const argvHoldsChannels = (argv: string[]) =>
  argv.some(
    (a) =>
      a === '--channels' || a.startsWith('--channels=') || a.split(',').some((x) => x.trim() === 'server:talos-app'),
  )

export function checkTakeover(i: TakeoverInputs): Blocker[] {
  const out: Blocker[] = []
  const folder = (pgid: number) => i.proc(pgid)?.cwd ?? null
  const b = i.botPid
  if (
    b?.holder &&
    b.holder.pid === b.pid &&
    b.holder.argv.join(' ').includes(TELEGRAM_ENTRY) &&
    b.holder.startEpochS <= b.fileModifiedAtS + RECYCLED_SLACK_S &&
    !i.ourPgids.has(b.holder.pgid)
  )
    out.push({
      resource: 'telegram',
      holderPid: b.holder.pid,
      sessionPid: b.holder.pgid,
      folder: folder(b.holder.pgid),
    })
  const br = i.bridgePid
  if (br?.ours && br.holder && br.holder.pid === br.record.pid && !i.ourPgids.has(br.holder.pgid))
    out.push({
      resource: 'bridge',
      holderPid: br.holder.pid,
      sessionPid: br.holder.pgid,
      folder: folder(br.holder.pgid),
    })
  // only when `claude agents --json` was readable: an unreadable list skips this check rather than blocking every start
  for (const e of i.agents ?? []) {
    if (e.kind !== 'interactive' || e.pid === null || i.ourPgids.has(e.pid)) continue
    const p = i.proc(e.pid)
    if (!p || i.ourPgids.has(p.pgid) || !argvHoldsChannels(p.argv)) continue
    if (out.some((x) => x.sessionPid === e.pid)) continue
    out.push({ resource: 'channels', holderPid: e.pid, sessionPid: e.pid, folder: p.cwd ?? e.cwd })
  }
  return out
}

// ---- Linux probes ---------------------------------------------------------------------------------------------------------------

/** Seconds since 1970 the kernel booted (`btime` in /proc/stat), for a process's start time; null when unreadable. */
function bootTime(read: (p: string) => string): number | null {
  try {
    const m = /^btime (\d+)$/m.exec(read('/proc/stat'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Clock ticks per second of /proc/<pid>/stat's start time; 100 on every Linux the supervisor runs on (USER_HZ). */
const USER_HZ = 100

/** A process from /proc (its group, argv, folder and start), or null when it is gone or unreadable. */
export function procOf(pid: number, read: (p: string) => string = (p) => readFileSync(p, 'utf8')): Proc | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = read(`/proc/${pid}/stat`)
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const pgid = Number(rest[2])
    const ticks = Number(rest[19])
    const boot = bootTime(read)
    const argv = read(`/proc/${pid}/cmdline`)
      .split('\0')
      .filter((a) => a !== '')
    let cwd: string | null = null
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      // another user's process: no folder
    }
    if (!Number.isInteger(pgid) || boot === null || !Number.isFinite(ticks)) return null
    return { pid, pgid, argv, cwd, startEpochS: boot + ticks / USER_HZ }
  } catch {
    return null
  }
}

/** Telegram's bot.pid: its pid, when it was written, and the process now under that pid. */
export function readBotPid(path: string): TakeoverInputs['botPid'] {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 1) return null
    return { pid, fileModifiedAtS: statSync(path).mtimeMs / 1000, holder: procOf(pid) }
  } catch {
    return null
  }
}

/** The bridge's bridge.pid: the record, whether it is still that bridge (same start token and entry), and its process. */
export function readBridgePid(path: string): TakeoverInputs['bridgePid'] {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as PidRecord
    if (typeof record?.pid !== 'number' || typeof record.started_at !== 'string') return null
    const holder = procOf(record.pid)
    return { record, ours: isOurBridge(record) && Boolean(holder?.argv.join(' ').includes(BRIDGE_ENTRY)), holder }
  } catch {
    return null
  }
}
