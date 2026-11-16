// A heartbeat source that exits can leave a child of its own running in its process group (a backgrounded helper). Its leader is
// reaped by then, so its number alone proves nothing. The rule: never signal a group that has no members. A group id cannot be
// handed out again as a pid while the group still has a member, so a group that has live members, all in the session the source
// was started in, is still the source's group. Anything less certain is left alone.
import { dlopen, FFIType } from 'bun:ffi'

/** What the source was started as: a detached spawn is its own session and group leader (pid = pgid = sid). */
export type Spawned = { pid: number; pgid: number; sid: number }
export type Member = { pid: number; pgid: number }

type Ids = { getsid: (pid: number) => number; getpgid: (pid: number) => number }
let ids: Ids | null | undefined
function sys(): Ids | null {
  if (ids !== undefined) return ids
  try {
    const lib = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
    const s = dlopen(lib, {
      getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      getpgid: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols
    ids = { getsid: (p) => s.getsid(p) as number, getpgid: (p) => s.getpgid(p) as number }
  } catch {
    ids = null
  }
  return ids
}

/** The session of `pid` (0: this process), or undefined when it is gone or cannot be read. */
export function sessionOf(pid: number): number | undefined {
  const s = sys()?.getsid(pid)
  return s !== undefined && s > 0 ? s : undefined
}
function groupOf(pid: number): number | undefined {
  const g = sys()?.getpgid(pid)
  return g !== undefined && g > 0 ? g : undefined
}

export type RecordDeps = {
  getsid: (pid: number) => number | undefined
  getpgid: (pid: number) => number | undefined
  /** The child has not exited (as this process has seen it). */
  alive: () => boolean
  sleep: (ms: number) => Promise<void>
  everyMs: number
  forMs: number
}
/** Why there is no record: there is then nothing to signal. */
export type NoRecord = { why: string }

/**
 * A detached child is made its own session and group leader before it runs (Bun's detached spawn: pid = pgid = sid). Read that
 * back while it lives, every 1 ms for the first 50 ms then every `everyMs`, for up to `forMs`, and record it once both are its pid.
 * A child that is gone before the first read (a source that is over in a few ms is often reaped before spawn's caller runs on a
 * loaded Mac) is recorded as it was made, pid = pgid = sid: endLeftovers still signals only a group that has live members, all
 * in that session, and a session or group id is not handed out again while it has a member, so a stranger cannot pass. Started
 * at spawn, off the source's start and result paths.
 */
export async function recordSpawn(
  pid: number | undefined,
  deps: Partial<RecordDeps> = {},
): Promise<Spawned | NoRecord> {
  const d: RecordDeps = {
    getsid: sessionOf,
    getpgid: groupOf,
    alive: () => true,
    sleep: (ms) => Bun.sleep(ms),
    everyMs: 10,
    forMs: 5000,
    ...deps,
  }
  if (!pid) return { why: 'no child was started' }
  const made: Spawned = { pid, pgid: pid, sid: pid }
  try {
    for (let n = 0, end = Date.now() + d.forMs; ; n++, await d.sleep(n < 50 ? 1 : d.everyMs)) {
      if (!d.alive()) return made // over before it could be read: as it was made
      const sid = d.getsid(pid)
      const pgid = d.getpgid(pid)
      if (sid === undefined || pgid === undefined) return made // reaped before the read: as it was made
      if (sid === pid && pgid === pid) return made // read back while it lives
      if (Date.now() >= end) return { why: `leader not yet in its own session after ${d.forMs} ms` }
    }
  } catch {
    return { why: 'its session and group could not be read' }
  }
}

/** The live members of group `pgid` (`ps`, with a timeout), or 'unknown' when ps could not answer. */
export async function groupMembers(pgid: number, timeoutMs = 5000): Promise<Member[] | 'unknown'> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(['ps', '-Ao', 'pid=,pgid='], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
  } catch {
    return 'unknown'
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), timeoutMs)
  })
  try {
    const answer = (async () => ({
      text: await new Response(proc.stdout as ReadableStream).text(),
      code: await proc.exited,
    }))()
    answer.catch(() => {})
    const r = await Promise.race([answer, late])
    if (r === 'late') {
      proc.kill('SIGKILL') // ps itself, still running
      return 'unknown'
    }
    if (r.code !== 0) return 'unknown'
    const out: Member[] = []
    for (const line of r.text.split('\n')) {
      const [pid, g] = line.trim().split(/\s+/).map(Number)
      if (pid && g === pgid && pid !== proc.pid) out.push({ pid, pgid: g })
    }
    return out
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

export type LeftoverDeps = {
  members: (pgid: number) => Promise<Member[] | 'unknown'>
  sessionOf: (pid: number) => number | undefined
  signal: (pgid: number, sig: 'SIGTERM' | 'SIGKILL') => void
  sleep: (ms: number) => Promise<void>
  graceMs: number
  log?: (line: string) => void
}
const realDeps: LeftoverDeps = {
  members: (g) => groupMembers(g),
  sessionOf,
  signal: (g, sig) => process.kill(-g, sig),
  sleep: (ms) => Bun.sleep(ms),
  graceMs: 300,
}

/** Whether the group may be signalled now ('live'): it has a member, every member is in the source's session, it is not ours. */
async function liveGroup(rec: Spawned, d: LeftoverDeps): Promise<'live' | 'empty' | 'unlisted' | 'foreign'> {
  const own = groupOf(0)
  if (rec.pgid <= 1 || rec.pgid === process.pid || (own !== undefined && rec.pgid === own)) return 'foreign'
  const m = await d.members(rec.pgid)
  if (m === 'unknown') return 'unlisted'
  if (m.length === 0) return 'empty'
  return m.every((x) => x.pgid === rec.pgid && d.sessionOf(x.pid) === rec.sid) ? 'live' : 'foreign'
}

const WHY = {
  empty: 'no leftovers',
  unlisted: 'leftovers not checked: ps did not answer',
  foreign: 'leftovers left alone: the group is not only the source session',
} as const

/**
 * After the source exited: TERM its group if it still has members of the source's own session, look again after a grace, and
 * KILL only if members are still there. Never signals an empty group or one it cannot vouch for. Never throws.
 */
export async function endLeftovers(
  rec: Spawned | NoRecord | undefined,
  deps: Partial<LeftoverDeps> = {},
): Promise<'none' | 'ended' | 'refused'> {
  const given = { ...realDeps, ...deps }
  const d = {
    ...given,
    log: (line: string) => {
      try {
        given.log?.(line)
      } catch {
        // a logger that fails must not break the look at the group
      }
    },
  }
  if (!rec || 'why' in rec) {
    d.log(`leftovers not checked: ${rec?.why ?? 'no group or session was recorded at the start'}`)
    return 'refused'
  }
  try {
    const now = await liveGroup(rec, d)
    if (now !== 'live') {
      d.log(WHY[now])
      return 'none'
    }
    d.signal(rec.pgid, 'SIGTERM')
    await d.sleep(d.graceMs)
    if ((await liveGroup(rec, d)) === 'live') d.signal(rec.pgid, 'SIGKILL')
    d.log('leftovers ended')
    return 'ended'
  } catch {
    d.log('leftovers: a signal failed (the group went in between)')
    return 'refused'
  }
}
