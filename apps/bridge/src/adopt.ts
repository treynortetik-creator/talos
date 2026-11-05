// `talos-app adopt --agent-dir <dir>`: connect a Claude Code folder you already use. It may change two things: the
// `talos-app` server in <dir>/.mcp.json (other servers are kept) and, when an MCP-apps catalog exists, the catalog hooks in
// <dir>/.claude/settings.local.json. Nothing else in the folder is read for writing, so CLAUDE.md, memory/, wiki/ and the
// owner's skills stay as they are. A kit 1.x folder (`.talos-version` starting "1.") is recognized and the update path is
// printed; it is never run from here. Owner only: the terminal gate in cli-main.ts covers this command (see talos.ts).
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { readCatalog } from './apps/catalog.ts'
import { cmdInstallAppHooks, homeAsAgentDir } from './apps/cli.ts'
import { appPaths } from './apps/paths.ts'
import type { CliIO } from './cli-main.ts'
import { type BridgeEnv, defaultHome } from './config.ts'
import { installMcp, mcpEntry } from './mcp-config.ts'

const BRIDGE_DIR = resolve(import.meta.dir, '..')
const REPO = resolve(BRIDGE_DIR, '..', '..')
const real = (p: string) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Exit codes: 0 done, 1 refused (nothing changed), 3 the folder's talos-app entry points elsewhere and `--repoint` was not given. */
type Refusal = { code: 1 | 3; message: string }

/** Why an existing JSON file cannot be merged into, or undefined when it can (a missing file is fine). */
function unusable(path: string, what: string): string | undefined {
  if (!existsSync(path)) return undefined
  if (statSync(path).isDirectory()) return `${path} is a folder, not a file (nothing was changed)`
  try {
    if (!isObject(JSON.parse(readFileSync(path, 'utf8')))) return `${path} is not a JSON object, so ${what}`
  } catch {
    return `${path} is not valid JSON; fix it by hand first (nothing was changed)`
  }
  return undefined
}

/** Where the folder's own talos-app entry points, when that is not this clone and home. undefined = nothing foreign. */
function foreignEntry(dir: string, home: string): string | undefined {
  const path = join(dir, '.mcp.json')
  if (!existsSync(path)) return undefined
  const entry = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.[
    'talos-app'
  ]
  if (entry === undefined) return undefined
  const args = isObject(entry) && Array.isArray(entry.args) ? entry.args : []
  const at = args.indexOf('--cwd')
  const cwd = at >= 0 ? args[at + 1] : undefined
  if (typeof cwd !== 'string' || !cwd) return 'a clone it cannot tell'
  if (real(cwd) !== real(BRIDGE_DIR)) return cwd
  // An entry with no TALOS_APP_HOME runs the bridge on the default home.
  const given = isObject(entry) && isObject(entry.env) ? entry.env.TALOS_APP_HOME : undefined
  const entryHome = typeof given === 'string' ? given : defaultHome()
  if (real(entryHome) !== real(home)) return `${cwd} with TALOS_APP_HOME ${entryHome}`
  return undefined
}

/** A path adopt would write through that is a link: the write would land outside the folder. */
function linkProblem(dir: string, hooks: boolean): string | undefined {
  const paths = [
    join(dir, '.mcp.json'),
    ...(hooks ? [join(dir, '.claude'), join(dir, '.claude', 'settings.local.json')] : []),
  ]
  for (const p of paths) {
    try {
      const st = lstatSync(p)
      if (st.isSymbolicLink()) return `${p} is a link; adopt will not write through a link (nothing was changed)`
      if (p.endsWith('.claude') && !st.isDirectory()) return `${p} is a file, not a folder (nothing was changed)`
    } catch {
      // not there yet
    }
  }
  return undefined
}

/** The first file or folder adopt must write that it cannot, so a failure never comes after .mcp.json is written. */
function unwritable(dir: string, hooks: boolean): string | undefined {
  const claude = join(dir, '.claude')
  const targets = [dir, join(dir, '.mcp.json')]
  if (hooks) targets.push(existsSync(claude) ? claude : dir, join(claude, 'settings.local.json'))
  for (const p of targets) {
    if (!existsSync(p)) continue
    try {
      accessSync(p, constants.W_OK)
    } catch {
      return `${p} cannot be written by you (nothing was changed)`
    }
  }
  return undefined
}

function refusal(env: BridgeEnv, dir: string, repoint: boolean, hooks: boolean): Refusal | undefined {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { code: 1, message: `${dir} is not a folder` }
  if (homeAsAgentDir(env, dir))
    return { code: 1, message: 'that is your home folder; adopt a folder inside it, never the home folder itself' }
  const bad =
    linkProblem(dir, hooks) ??
    unwritable(dir, hooks) ??
    unusable(join(dir, '.mcp.json'), 'it was left alone') ??
    (hooks ? unusable(join(dir, '.claude', 'settings.local.json'), 'it was left alone') : undefined)
  if (bad) return { code: 1, message: bad }
  const mcp = existsSync(join(dir, '.mcp.json'))
    ? (JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')) as { mcpServers?: unknown })
    : {}
  if (mcp.mcpServers !== undefined && !isObject(mcp.mcpServers))
    return {
      code: 1,
      message: `${join(dir, '.mcp.json')} has an mcpServers that is not an object; fix it by hand first (nothing was changed)`,
    }
  const foreign = foreignEntry(dir, env.home)
  if (foreign && !repoint)
    return {
      code: 3,
      message: `${join(dir, '.mcp.json')} already has a talos-app server that runs ${foreign}, not this clone (${BRIDGE_DIR}). Nothing was changed. Run again with --repoint to point it here.`,
    }
  return undefined
}

function kitVersion(dir: string): string | undefined {
  try {
    const v = readFileSync(join(dir, '.talos-version'), 'utf8').trim()
    return v.startsWith('1.') ? v : undefined
  } catch {
    return undefined
  }
}

export async function cmdAdopt(env: BridgeEnv, argv: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'agent-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
      repoint: { type: 'boolean' },
    },
    strict: true,
  })
  if (!values['agent-dir']) {
    io.err('talos-app: usage: talos-app adopt --agent-dir <dir> [--dry-run] [--yes] [--repoint]')
    return 1
  }
  const dir = resolve(values['agent-dir'])
  const cat = readCatalog(appPaths(env.home))
  if (!cat.ok) {
    io.err(`talos-app: ${cat.reason}; fix the MCP-apps catalog first (nothing was changed)`)
    return 1
  }
  const hooks = cat.catalog !== undefined
  const refused = refusal(env, dir, Boolean(values.repoint), hooks)
  if (refused) {
    io.err(`talos-app: ${refused.message}`)
    return refused.code
  }
  const entry = mcpEntry(BRIDGE_DIR, env.home, dir)
  const plan = installMcp(dir, entry, true)
  io.out(`agent folder: ${dir}`)
  io.out(
    plan.changed
      ? `${values['dry-run'] ? 'would write' : 'will write'} the talos-app server into ${plan.path} (other servers are kept)`
      : `${plan.path} is already up to date`,
  )
  io.out(
    hooks
      ? `${values['dry-run'] ? 'would set' : 'will set'} the MCP-apps hooks in ${join(dir, '.claude', 'settings.local.json')}`
      : 'no MCP-apps catalog yet, so no hooks are written',
  )
  io.out('CLAUDE.md, memory/, wiki/ and your skills are not touched.')
  const kit = kitVersion(dir)
  if (kit) {
    io.out(`kit 1.x install (${kit}). To see what an update would change, run:`)
    io.out(`  bash ${join(REPO, 'kit', 'scripts', 'upgrade.sh')} --into ${dir} --dry-run`)
  }
  if (values['dry-run']) return 0
  if (!values.yes) {
    const a = await io.prompt(`Connect ${dir}? [y/N] `)
    if (!/^y(es)?$/i.test(a.trim())) {
      io.out('Not written.')
      return 0
    }
  }
  installMcp(dir, entry, false)
  if (hooks) {
    let rc: number
    try {
      rc = cmdInstallAppHooks(env, ['--agent-dir', dir], io, BRIDGE_DIR)
    } catch (e) {
      io.err(`talos-app: ${(e as Error).message}`)
      rc = 1
    }
    if (rc !== 0) {
      io.err(
        `talos-app: ${plan.path} was written but the app hooks were not. Run: talos-app install-app-hooks --agent-dir ${dir}`,
      )
      return 1
    }
  }
  io.out(`connected: ${dir}`)
  return 0
}
