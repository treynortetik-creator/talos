// $TALOS_APP_HOME/memory.json (docs/V2-FEATURES.md V5.1): written on the Mac by `talos-app memory init`, never by the app.
import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MemoryRootId } from '@talos-app/protocol'
import { mtimeMs, readJsonFile, writeJsonAtomic } from '../fsutil.ts'
import { segmentDenied } from './deny.ts'

export type MemoryRootCfg = {
  id: string
  label: string
  /** Relative to `agent_dir`. */
  path: string
  include: string[]
  exclude: string[]
}
export type MemoryConfig = {
  version: 1
  enabled: boolean
  agent_dir: string
  roots: MemoryRootCfg[]
  max_file_kb: number
}

export const DEFAULT_INCLUDE = ['**/*.md', '**/*.txt']
export const DEFAULT_MAX_FILE_KB = 512
export const MAX_ROOTS = 20

export const memoryJsonPath = (home: string) => join(home, 'memory.json')
export const memoryIndexPath = (home: string) => join(home, 'memory-index.sqlite')

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

/** True when `child` is `parent` or inside it (both already realpath'd). */
export function within(parent: string, child: string): boolean {
  const r = relative(parent, child)
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}

/** True when `real` (inside `agentReal`) passes through a denied folder such as .git, .ssh or .vault: a root there would
 * be measured against itself and the denylist would never see that segment. */
export function throughDenied(agentReal: string, real: string): boolean {
  return relative(agentReal, real)
    .split(sep)
    .some((s) => s !== '' && segmentDenied(s))
}

export type ParseResult = { ok: true; config: MemoryConfig } | { ok: false; message: string }

/** Validates the file's shape and its paths. `home` is $TALOS_APP_HOME (the agent dir may not be it). */
export function parseMemoryConfig(raw: unknown, home: string): ParseResult {
  const bad = (message: string): ParseResult => ({ ok: false, message })
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('memory.json is not an object')
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return bad('memory.json: version must be 1')
  if (typeof o.enabled !== 'boolean') return bad('memory.json: enabled must be true or false')
  if (typeof o.agent_dir !== 'string' || !isAbsolute(o.agent_dir)) return bad('memory.json: agent_dir must be absolute')
  let agentReal: string
  try {
    agentReal = realpathSync(o.agent_dir)
  } catch {
    return bad(`memory.json: agent_dir ${o.agent_dir} does not exist`)
  }
  let homeReal = home
  try {
    homeReal = realpathSync(home)
  } catch {
    // a missing app home cannot be the agent dir
  }
  // / , your home folder, anything that contains it (/Users), and the Talos app folder or anything that contains it
  if (within(agentReal, safeReal(homedir())) || within(agentReal, homeReal))
    return bad(
      'memory.json: agent_dir may not be /, your home folder or a folder that contains it, or the Talos app folder',
    )
  if (!Array.isArray(o.roots) || o.roots.length > MAX_ROOTS) return bad('memory.json: roots must be a list of up to 20')
  const roots: MemoryRootCfg[] = []
  const seen = new Set<string>()
  for (const [i, r] of o.roots.entries()) {
    const at = `memory.json: roots[${i}]`
    if (typeof r !== 'object' || r === null) return bad(`${at} is not an object`)
    const x = r as Record<string, unknown>
    if (typeof x.id !== 'string' || !MemoryRootId.safeParse(x.id).success) return bad(`${at}.id is not a valid id`)
    if (seen.has(x.id)) return bad(`${at}.id ${x.id} is used twice`)
    seen.add(x.id)
    if (typeof x.label !== 'string' || x.label.length === 0 || x.label.length > 40)
      return bad(`${at}.label must be 1-40 characters`)
    if (typeof x.path !== 'string' || x.path === '' || isAbsolute(x.path)) return bad(`${at}.path must be relative`)
    let real: string
    try {
      real = realpathSync(resolve(agentReal, x.path))
      if (!statSync(real).isDirectory()) return bad(`${at}.path is not a folder`)
    } catch {
      return bad(`${at}.path ${x.path} does not exist`)
    }
    if (!within(agentReal, real)) return bad(`${at}.path leaves agent_dir`)
    if (throughDenied(agentReal, real)) return bad(`${at}.path goes through a protected folder`)
    if (x.include !== undefined && !isStrings(x.include)) return bad(`${at}.include must be a list of globs`)
    if (x.exclude !== undefined && !isStrings(x.exclude)) return bad(`${at}.exclude must be a list of globs`)
    roots.push({
      id: x.id,
      label: x.label,
      path: x.path,
      include: x.include?.length ? x.include : DEFAULT_INCLUDE,
      exclude: x.exclude ?? [],
    })
  }
  const kb = o.max_file_kb === undefined ? DEFAULT_MAX_FILE_KB : o.max_file_kb
  if (typeof kb !== 'number' || !Number.isInteger(kb) || kb < 1 || kb > 5120)
    return bad('memory.json: max_file_kb is 1-5120')
  return { ok: true, config: { version: 1, enabled: o.enabled, agent_dir: agentReal, roots, max_file_kb: kb } }
}

function safeReal(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export function loadMemoryConfig(
  home: string,
): (ParseResult & { missing?: false }) | { ok: false; missing: true; message: string } {
  const p = memoryJsonPath(home)
  if (!existsSync(p)) return { ok: false, missing: true, message: 'no memory.json' }
  const raw = readJsonFile(p)
  if (raw === undefined) return { ok: false, message: 'memory.json is not valid JSON' }
  return parseMemoryConfig(raw, home)
}

export function writeMemoryConfig(home: string, c: MemoryConfig): void {
  writeJsonAtomic(memoryJsonPath(home), c, 0o600)
}

export const memoryJsonMtime = (home: string) => mtimeMs(memoryJsonPath(home))
