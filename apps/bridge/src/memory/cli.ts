// `talos-app memory init|on|off|show|reindex` (docs/V2-FEATURES.md V5.1). Mac only: the app can switch the browser off,
// never on. Nothing here writes under the agent dir; the files written are memory.json and config.json in the app home.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MemoryRootId } from '@talos-app/protocol'
import { realClock } from '../clock.ts'
import { type BridgeEnv, paths } from '../config.ts'
import { ConfigFile } from '../config-file.ts'
import { nullLogger } from '../log.ts'
import {
  DEFAULT_INCLUDE,
  DEFAULT_MAX_FILE_KB,
  loadMemoryConfig,
  type MemoryConfig,
  type MemoryRootCfg,
  memoryJsonPath,
  parseMemoryConfig,
  writeMemoryConfig,
} from './config.ts'
import { PRIVATE_MARKER, segmentDenied } from './deny.ts'
import { MemoryScope } from './scope.ts'
import { MemoryBrowser, type MemoryServiceOptions } from './service.ts'

export type MemoryIO = {
  out(line: string): void
  err(line: string): void
  prompt?(question: string): Promise<string>
  /** Test seam: extra options for the MemoryBrowser that `reindex` builds. */
  serviceOptions?: Partial<MemoryServiceOptions>
}

export const MEMORY_USAGE = 'usage: talos-app memory init [--agent-dir <dir>] | on | off | show | reindex'

const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a)

/** Visible markdown/text files under one folder, and what the denylist and private markers hid. */
function survey(agentDir: string, rel: string, exclude: string[] = []) {
  const cfg: MemoryConfig = {
    version: 1,
    enabled: true,
    agent_dir: agentDir,
    roots: [{ id: 'x', label: 'x', path: rel, include: DEFAULT_INCLUDE, exclude }],
    max_file_kb: DEFAULT_MAX_FILE_KB,
  }
  const scope = new MemoryScope(cfg)
  const root = scope.roots[0]
  if (!root) return { files: [] as string[], hidden: 0, privateDirs: [] as string[] }
  const w = scope.walk(root, 20_000)
  return { files: w.files.map((f) => f.path), ...hiddenIn(join(agentDir, rel)) }
}

/** Denylist hits (names only counted) and folders holding a `.talos-private` marker, relative to `dir`. */
function hiddenIn(dir: string): { hidden: number; privateDirs: string[] } {
  let hidden = 0
  const privateDirs: string[] = []
  const walk = (d: string, rel: string, depth: number) => {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((e) => e.name === PRIVATE_MARKER)) {
      privateDirs.push(rel || '.')
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (segmentDenied(e.name)) {
        if (e.name !== PRIVATE_MARKER) hidden++
        continue
      }
      if (e.isDirectory()) walk(join(d, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1)
    }
  }
  walk(dir, '', 0)
  return { hidden, privateDirs }
}

function subdirs(agentDir: string, rel: string): string[] {
  try {
    return readdirSync(join(agentDir, rel), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !segmentDenied(e.name))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function slug(name: string, taken: Set<string>): string {
  let s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!/^[a-z]/.test(s)) s = `n_${s}`
  s = s.slice(0, 28) || 'notes'
  let id = s
  for (let i = 2; taken.has(id) || !MemoryRootId.safeParse(id).success; i++) id = `${s.slice(0, 26)}_${i}`
  taken.add(id)
  return id
}

/** History failures from the CLI go to stderr instead of vanishing. */
const cliLog = (io?: MemoryIO) => ({
  warn: (m: string, f?: Record<string, unknown>) => {
    const line = `talos-app: ${m}${f?.error ? `: ${String(f.error)}` : ''}`
    if (io) io.err(line)
    else process.stderr.write(`${line}\n`)
  },
})

function setSwitch(home: string, on: boolean, io: MemoryIO): boolean {
  const p = paths(home)
  if (!existsSync(p.configJson)) {
    io.err(`no ${p.configJson}; run: talos-app init --relay-url <url> first`)
    return false
  }
  const cf = new ConfigFile(p.configJson, { log: cliLog(io) })
  cf.load()
  if (cf.config.memory_browser !== on) cf.update((c) => ({ ...c, memory_browser: on }))
  return true
}

async function init(env: BridgeEnv, args: string[], io: MemoryIO): Promise<number> {
  if (!io.prompt) {
    io.err('talos-app memory init asks questions; run it in a terminal.')
    return 2
  }
  const i = args.indexOf('--agent-dir')
  const agentArg = i >= 0 ? args[i + 1] : undefined
  if (i >= 0 && !agentArg) {
    io.err(MEMORY_USAGE)
    return 2
  }
  const dir = resolve(agentArg ?? process.cwd())
  let agentDir: string
  try {
    agentDir = realpathSync(dir)
    if (!statSync(agentDir).isDirectory()) throw new Error('not a folder')
  } catch {
    io.err(`${dir} is not a folder`)
    return 1
  }
  const check = parseMemoryConfig({ version: 1, enabled: true, agent_dir: agentDir, roots: [] }, env.home)
  if (!check.ok) {
    io.err(check.message)
    return 1
  }
  const tops = subdirs(agentDir, '')
  if (tops.length === 0) {
    io.err(`${agentDir} has no folders to share`)
    return 1
  }
  io.out(`Folders in ${agentDir}:`)
  const roots: MemoryRootCfg[] = []
  const taken = new Set<string>()
  for (const name of tops) {
    const s = survey(agentDir, name)
    const a = await io.prompt(`  ${name}  (${s.files.length} notes)  Share it? [y/N] `)
    if (!yes(a)) continue
    const subs = subdirs(agentDir, name)
    let exclude: string[] = []
    if (subs.length) {
      io.out(`  Subfolders of ${name}:`)
      for (const sub of subs) io.out(`    ${sub}  (${survey(agentDir, `${name}/${sub}`).files.length} notes)`)
      const ex = await io.prompt('  Exclude any? (comma-separated, Enter for none) ')
      exclude = ex
        .split(',')
        .map((x) => x.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
        .map((x) => `${x}/**`)
    }
    roots.push({ id: slug(name, taken), label: name.slice(0, 40), path: name, include: DEFAULT_INCLUDE, exclude })
  }
  if (roots.length === 0) {
    io.out('Nothing chosen; nothing written.')
    return 0
  }
  const cfg: MemoryConfig = { version: 1, enabled: true, agent_dir: agentDir, roots, max_file_kb: DEFAULT_MAX_FILE_KB }
  const parsed = parseMemoryConfig(cfg, env.home)
  if (!parsed.ok) {
    io.err(parsed.message)
    return 1
  }
  io.out('')
  io.out('This is what the app will be able to read:')
  for (const r of roots) {
    const s = survey(agentDir, r.path, r.exclude)
    io.out(`  ${r.label}: ${s.files.length} notes${r.exclude.length ? `  (excluding ${r.exclude.join(', ')})` : ''}`)
    if (s.hidden) io.out(`    ${s.hidden} files hidden by the always-on denylist (keys, .env, databases, dotfiles)`)
    for (const p of s.privateDirs)
      io.out(`    hidden: ${p === '.' ? r.path : `${r.path}/${p}`} has a ${PRIVATE_MARKER} marker`)
  }
  const ok = await io.prompt('Write it and turn the memory browser on? [y/N] ')
  if (!yes(ok)) {
    io.out('Nothing written.')
    return 0
  }
  writeMemoryConfig(env.home, parsed.config)
  if (!setSwitch(env.home, true, io)) io.out('memory.json is written; turn it on after `talos-app init`.')
  io.out(`Written ${memoryJsonPath(env.home)}. The browser is on. Check what is shared: talos-app memory show`)
  return 0
}

/** The app's own memory switch in config.json; on when there is no config yet. */
function appSwitchOn(home: string): boolean {
  try {
    const cf = new ConfigFile(paths(home).configJson, { log: cliLog() })
    cf.load()
    return cf.config.memory_browser
  } catch {
    return true // no config yet
  }
}

async function show(env: BridgeEnv, io: MemoryIO): Promise<number> {
  const r = loadMemoryConfig(env.home)
  if (!r.ok) {
    io.out(r.message === 'no memory.json' ? 'The memory browser is not set up. Run: talos-app memory init' : r.message)
    return r.message === 'no memory.json' ? 0 : 1
  }
  const phone = appSwitchOn(env.home)
  io.out(
    `memory browser: ${r.config.enabled && phone ? 'ON' : 'OFF'} (memory.json ${r.config.enabled ? 'on' : 'off'}, app switch ${phone ? 'on' : 'off'})`,
  )
  io.out(`agent dir: ${r.config.agent_dir}`)
  const scope = new MemoryScope(r.config)
  for (const root of scope.roots) {
    const w = scope.walk(root, 20_000)
    io.out(
      `${root.cfg.label} [${root.id}]: ${w.files.length} notes${w.truncated ? ' (cap reached)' : ''}${root.cfg.exclude.length ? `  excluding ${root.cfg.exclude.join(', ')}` : ''}`,
    )
    for (const f of w.files
      .map((x) => x.path)
      .sort()
      .slice(0, 20))
      io.out(`  ${f}`)
    const h = hiddenIn(root.dir)
    for (const d of h.privateDirs) io.out(`  hidden (${PRIVATE_MARKER}): ${d}`)
  }
  return 0
}

export async function cmdMemory(env: BridgeEnv, args: string[], io: MemoryIO): Promise<number> {
  const sub = args[0] ?? ''
  switch (sub) {
    case 'init':
      return await init(env, args.slice(1), io)
    case 'show':
      return await show(env, io)
    case 'on':
    case 'off': {
      const on = sub === 'on'
      const r = loadMemoryConfig(env.home)
      if (!r.ok) {
        io.err('missing' in r && r.missing ? 'The memory browser is not set up. Run: talos-app memory init' : r.message)
        return 1
      }
      if (r.config.enabled !== on) writeMemoryConfig(env.home, { ...r.config, enabled: on })
      if (!setSwitch(env.home, on, io)) return 1
      io.out(`The memory browser is ${on ? 'on' : 'off'}.`)
      return 0
    }
    case 'reindex': {
      const r = loadMemoryConfig(env.home)
      if (!r.ok) {
        io.err('The memory browser is not set up. Run: talos-app memory init')
        return 1
      }
      if (!r.config.enabled || !appSwitchOn(env.home)) {
        io.err('The memory browser is off, so there is nothing to rebuild. Turn it on first: talos-app memory on')
        return 1
      }
      const svc = new MemoryBrowser({
        home: env.home,
        clock: realClock,
        log: nullLogger,
        switchOn: () => true,
        watch: false,
        ...io.serviceOptions,
      })
      if (!svc.available) {
        io.err("This Mac's SQLite has no FTS5; the memory browser is unavailable.")
        return 1
      }
      try {
        const n = await svc.reindex()
        io.out(`Indexed ${n} notes.`)
        return 0
      } catch (e) {
        io.err(`Reindex failed. ${(e as Error).message}`)
        return 1
      } finally {
        svc.stop()
      }
    }
    default:
      io.err(MEMORY_USAGE)
      return 2
  }
}
