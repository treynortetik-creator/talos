// Which process a pid is, for every check that decides a kill or a takeover: a recycled pid must not pass for the process that
// had the number before. The identity is the start time the kernel keeps. On macOS that is `ps -o lstart=`. On Linux ps
// computes lstart from the boot time plus the start tick, and on WSL that boot time drifts: one live process read 200 times
// showed two start times 17 s apart, so a live owner looked recycled and lost its lock. /proc/<pid>/stat field 22 (the start,
// in clock ticks since boot) never changes; with the boot id it names one process for as long as it lives. Runtime-neutral
// (node:child_process, not Bun): the bridge, the scripts and the supervisor share it. scripts/ci-local.sh ci_proc_start
// prints the same token.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export type ProcRead = (path: string) => string

const readText: ProcRead = (p) => readFileSync(p, 'utf8')

/**
 * The two fields of /proc/<pid>/stat this module needs. Field 2 is the command in parentheses and may itself hold spaces or
 * `)`, so the fields are counted from the LAST `)`: after it come field 3 (state), field 5 (pgrp) ... field 22 (starttime).
 */
export function parseProcStat(text: string): { pgid: number; startTicks: string } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const rest = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const pgid = rest[5 - 3]
  const startTicks = rest[22 - 3]
  if (!pgid || !/^\d+$/.test(pgid) || !startTicks || !/^\d+$/.test(startTicks)) return null
  return { pgid: Number(pgid), startTicks }
}

const validPid = (pid: number) => Number.isInteger(pid) && pid > 0

function procStat(pid: number, read: ProcRead) {
  try {
    return parseProcStat(read(`/proc/${pid}/stat`))
  } catch {
    return null
  }
}

/**
 * `ps -p <pid> -o <field>=` in the C locale, or null when ps does not answer (gone, failed, or slower than 2 s). The same
 * environment as lifecycle.ts psInfo, so on macOS both print the same lstart text for one process.
 */
function psField(pid: number, field: 'lstart' | 'pgid'): string | null {
  try {
    const r = spawnSync('ps', ['-p', String(pid), '-o', `${field}=`], {
      encoding: 'utf8',
      timeout: 2000,
      env: { ...process.env, LC_ALL: 'C' },
    })
    const out = r.status === 0 ? r.stdout.trim() : ''
    return out === '' ? null : out
  } catch {
    return null
  }
}

export type IdentityDeps = { platform?: NodeJS.Platform; read?: ProcRead }

/** A /proc token, as opposed to ps's text. A record written before Linux read /proc holds ps's text. */
export const isProcToken = (s: string) => s.startsWith('linux:')

/**
 * Whether two start times can prove anything about each other: both /proc tokens, or both ps text. A /proc token against a
 * record from before the switch is no answer (as an unreadable start time is), never "a different process".
 */
export const comparableStarts = (a: string, b: string) => isProcToken(a) === isProcToken(b)

/**
 * An opaque start-time token for a live pid: compare tokens with `===` only. Linux (and WSL):
 * `linux:<first 12 hex of the boot id>:<start ticks>`. macOS: ps's lstart. Null when the process is gone or the answer cannot
 * be read, which never proves "the same process": a kill must not follow from it.
 */
export function processStartTime(pid: number, deps: IdentityDeps = {}): string | null {
  if (!validPid(pid)) return null
  if ((deps.platform ?? process.platform) !== 'linux') return psField(pid, 'lstart')
  const read = deps.read ?? readText
  const stat = procStat(pid, read)
  if (!stat) return null
  let boot: string
  try {
    boot = read('/proc/sys/kernel/random/boot_id')
      .replace(/[^0-9a-f]/gi, '')
      .slice(0, 12)
  } catch {
    return null
  }
  return boot ? `linux:${boot}:${stat.startTicks}` : null
}

/** The process group of a live pid (stat field 5 on Linux, `ps -o pgid=` elsewhere), or null when it cannot be read. */
export function processGroup(pid: number, deps: IdentityDeps = {}): number | null {
  if (!validPid(pid)) return null
  if ((deps.platform ?? process.platform) === 'linux') return procStat(pid, deps.read ?? readText)?.pgid ?? null
  const out = psField(pid, 'pgid')
  return out && /^\d+$/.test(out) ? Number(out) : null
}
