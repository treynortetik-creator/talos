// `talos-app apps scan|list|revoke|login|logout|strict` (MCP-APPS-SPEC M5.1, M5.6). Owner at the Mac only: never driven from
// a message. Every outside dependency is injectable, so tests run it with fakes and an empty home.
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isLoopbackHost } from '@talos-app/protocol'
import type { CliIO } from '../cli-main.ts'
import type { BridgeEnv } from '../config.ts'
import { type AppCatalogT, matcherFor, readCatalog, writeCatalog } from './catalog.ts'
import { DirectConfig, type DirectConnector, realDirectConnector } from './direct.ts'
import { escapeForTerminal, type ListenFn, runLogin } from './direct-oauth.ts'
import { HOOK_MARKER, installHookSettings } from './hooks.ts'
import { type ServerSecrets, serverIdOf } from './keychain.ts'
import { appPaths } from './paths.ts'
import { type McpStatusSource, runScan, ScanStop } from './scan.ts'

export type AppsCliDeps = {
  /** Test seam: the status source (default: the Agent SDK driving the installed `claude`). */
  source?: McpStatusSource
  secrets?: ServerSecrets
  connector?: DirectConnector
  bridgeDir?: string
  agentNames?: string[]
  /** `apps login`: the loopback listener, the DNS resolver and fetch (tests). */
  listen?: ListenFn
  resolveHost?: (host: string) => Promise<string[]>
  fetch?: typeof fetch
  confirm?: (q: string) => Promise<boolean>
}

const yes = (a: string) => /^y(es)?$/i.test(a.trim())
const BRIDGE_DIR = resolve(dirname(import.meta.path), '..', '..')

/**
 * The agent folder must not be the owner's home: hooks and deny rules go into <dir>/.claude/settings.local.json, and for the
 * home folder that is the user-scope folder, which would put the gate (and its machine path) on every Claude Code session.
 */
export function homeAsAgentDir(env: BridgeEnv, dir: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  return real(dir) === real(env.userHome)
}

async function loadSecrets(deps: AppsCliDeps): Promise<ServerSecrets> {
  if (deps.secrets) return deps.secrets
  const k = await import('./keychain.ts')
  return new k.ServerSecrets(k.securityRunner())
}

function pickServer(cat: AppCatalogT, name: string) {
  const at = name.lastIndexOf('@')
  const hits = cat.servers.filter(
    (s) => s.server === name || (at > 0 && s.server === name.slice(0, at) && s.source === name.slice(at + 1)),
  )
  if (hits.length === 0) throw new Error(`no catalogued server called ${escapeForTerminal(name)}`)
  if (hits.length > 1)
    throw new Error(
      `${escapeForTerminal(name)} matches more than one source; use name@source (${hits.map((h) => h.source).join(', ')})`,
    )
  return hits[0] as AppCatalogT['servers'][number]
}

export async function cmdApps(env: BridgeEnv, argv: string[], io: CliIO, deps: AppsCliDeps = {}): Promise<number> {
  const [sub, ...rest] = argv
  const P = appPaths(env.home)
  switch (sub) {
    case 'scan': {
      const { values } = parseArgs({
        args: rest,
        options: {
          check: { type: 'boolean' },
          'agent-dir': { type: 'string' },
          'exclude-plugin': { type: 'string', multiple: true },
        },
        strict: true,
      })
      const agentDir = resolve(values['agent-dir'] ?? process.cwd())
      if (homeAsAgentDir(env, agentDir)) {
        io.err('talos-app: the agent folder is your home folder; run this from the agent folder or pass --agent-dir')
        return 1
      }
      const secrets = await loadSecrets(deps)
      let source = deps.source
      if (!source) {
        const { resolveClaude, sdkStatusSource } = await import('./sdk-source.ts')
        const claudePath = resolveClaude(process.env.PATH)
        if (!claudePath) {
          io.err('talos-app: `claude` was not found on PATH')
          return 1
        }
        source = sdkStatusSource({
          agentDir,
          claudePath,
          env: process.env,
          excludePlugins: values['exclude-plugin'] ?? [],
        })
      }
      let liveVersion: string | undefined
      try {
        liveVersion = readFileSync(P.liveVersion, 'utf8').trim() || undefined
      } catch {
        // no live session recorded
      }
      try {
        const r = await runScan({
          paths: P,
          source,
          io: {
            print: (l) => io.out(l),
            ask: async (q) => yes(await io.prompt(`${q} `)),
            askText: async (q, d) => {
              const a = (await io.prompt(`${q} [${d}]: `)).trim()
              return a || d
            },
          },
          now: io.now,
          sleep: io.sleep,
          secrets,
          connector: deps.connector ?? realDirectConnector,
          relayUrl: env.relayUrl,
          agentDir,
          bridgeDir: deps.bridgeDir ?? BRIDGE_DIR,
          liveVersion,
          check: !!values.check,
          agentNames: deps.agentNames ?? [],
        })
        return values.check && r.drift.length > 0 ? 1 : 0
      } catch (e) {
        if (e instanceof ScanStop) {
          io.err(`talos-app: ${e.message}`)
          return 1
        }
        throw e
      }
    }
    case 'list': {
      const c = readCatalog(P)
      if (!c.ok) {
        io.err(`talos-app: ${c.reason}`)
        return 1
      }
      if (!c.catalog || c.catalog.servers.length === 0) {
        io.out('No apps. Run: talos-app apps scan')
        return 0
      }
      io.out(
        `catalog rev ${c.catalog.rev}, scanned ${c.catalog.scanned_at}, Claude Code ${c.catalog.claude_code_version}${c.catalog.strict ? ', strict' : ''}`,
      )
      for (const s of c.catalog.servers)
        for (const r of s.resources)
          io.out(
            `${escapeForTerminal(r.owner.label)}  ${escapeForTerminal(s.server)} (${escapeForTerminal(s.source)})  ${r.state}  ${r.approval_key.slice(0, 16)}`,
          )
      return 0
    }
    case 'revoke': {
      const target = rest[0]
      if (!target) {
        io.err('usage: talos-app apps revoke <server|key-prefix>')
        return 2
      }
      const c = readCatalog(P)
      if (!c.ok || !c.catalog) {
        io.err('talos-app: no usable catalog')
        return 1
      }
      const cat = structuredClone(c.catalog)
      let n = 0
      for (const s of cat.servers)
        for (const r of s.resources)
          if (
            (s.server === target || (target.length >= 6 && r.approval_key.startsWith(target))) &&
            r.state === 'approved'
          ) {
            r.state = 'declined'
            n++
          }
      if (n === 0) {
        io.err(`talos-app: nothing approved matches ${escapeForTerminal(target)}`)
        return 1
      }
      cat.rev += 1
      writeCatalog(P, cat)
      io.out(`Revoked ${n} app(s). A running bridge closes their views within a few seconds.`)
      return 0
    }
    case 'strict': {
      const v = rest[0]
      if (v !== 'on' && v !== 'off') {
        io.err('usage: talos-app apps strict on|off')
        return 2
      }
      const c = readCatalog(P)
      if (!c.ok || !c.catalog) {
        io.err('talos-app: no usable catalog (run apps scan first)')
        return 1
      }
      const cat = { ...c.catalog, strict: v === 'on', rev: c.catalog.rev + 1 }
      writeCatalog(P, cat)
      io.out(v === 'on' ? "Strict on: calls to servers Talos can't re-check now ask each time." : 'Strict off.')
      return 0
    }
    case 'login':
    case 'logout': {
      const name = rest[0]
      if (!name) {
        io.err(`usage: talos-app apps ${sub} <server>`)
        return 2
      }
      const c = readCatalog(P)
      if (!c.ok || !c.catalog) {
        io.err('talos-app: no usable catalog (run apps scan first)')
        return 1
      }
      const server = pickServer(c.catalog, name)
      const id = serverIdOf(server.server, server.source)
      const secrets = await loadSecrets(deps)
      if (sub === 'logout') {
        await secrets.logout(id)
        io.out(
          `Signed out of ${escapeForTerminal(server.server)}. Its app-only buttons now need sign-in; its no-tap calls ask each time until the next apps scan.`,
        )
        return 0
      }
      if (server.direct?.type !== 'http' && server.direct?.type !== 'sse') {
        io.err('talos-app: apps login is for remote (http/sse) servers only')
        return 1
      }
      const stored = await secrets.loadConfig(id)
      const cfg = DirectConfig.safeParse(stored)
      if (!cfg.success) {
        io.err("talos-app: this server's settings are not in your Keychain; run apps scan")
        return 1
      }
      const u = new URL(cfg.data.url)
      // the approved server's own origin is allowed on a local address (a local server the owner approved at scan)
      const local = isLoopbackHost(u.hostname) ? u.origin : undefined
      const r = await runLogin({
        serverUrl: cfg.data.url,
        secrets,
        serverId: id,
        io: { print: (l) => io.out(l), confirm: deps.confirm ?? (async (q) => yes(await io.prompt(`${q} y/N `))) },
        guard: {
          ...(deps.resolveHost ? { resolve: deps.resolveHost } : {}),
          ...(deps.fetch ? { fetch: deps.fetch as never } : {}),
          allowedLocalOrigin: local,
        },
        ...(deps.listen ? { listen: deps.listen } : {}),
      })
      if (!r.ok) {
        io.err(`talos-app: sign-in stopped: ${r.reason}`)
        return 1
      }
      io.out(`Signed in to ${escapeForTerminal(server.server)}. Tokens are in your login Keychain.`)
      return 0
    }
    default:
      io.out(
        'usage: talos-app apps scan [--check] [--agent-dir <dir>] [--exclude-plugin <name>] | list | revoke <server|key-prefix> | login <server> | logout <server> | strict on|off',
      )
      return sub === undefined || sub === 'help' ? 0 : 2
  }
}

type DoctorAdd = (level: 'ok' | 'warn' | 'FAIL', name: string, detail: string) => void

/**
 * The apps part of `talos-app doctor`: the catalog reads, its Claude Code version matches the live session's, the hook entries
 * exist with the fail-closed flag, and the gate command actually runs. `--deep` also runs `apps scan --check` (the same
 * session a scan uses, no prompts, no writes) and reports drift.
 */
export async function appsDoctor(a: {
  env: BridgeEnv
  agentDir: string
  add: DoctorAdd
  io: CliIO
  deep: boolean
  deps?: AppsCliDeps
}): Promise<void> {
  const P = appPaths(a.env.home)
  const c = readCatalog(P)
  if (!c.ok) return a.add('FAIL', 'apps catalog', c.reason)
  if (!c.catalog) return a.add('ok', 'apps catalog', 'none yet (run: talos-app apps scan)')
  const eligible = c.catalog.servers.filter((s) =>
    s.resources.some((r) => r.state === 'approved' || r.state === 'needs_reapproval'),
  )
  a.add('ok', 'apps catalog', `rev ${c.catalog.rev}, ${eligible.length} server(s) with an approved app`)
  let live: string | undefined
  try {
    live = readFileSync(P.liveVersion, 'utf8').trim() || undefined
  } catch {
    // no live session recorded yet
  }
  if (live && live !== c.catalog.claude_code_version)
    a.add(
      'warn',
      'apps Claude Code version',
      `scanned with ${c.catalog.claude_code_version}, live session runs ${live}; run: talos-app apps scan`,
    )
  else a.add('ok', 'apps Claude Code version', live ? `${live}, matches the scan` : 'no live session recorded yet')
  if (c.catalog.servers.some((s) => s.resources.some((r) => r.state === 'needs_reapproval')))
    a.add('warn', 'apps re-approval', 'an app changed how it labels its tools; run: talos-app apps scan')
  if (eligible.length === 0) return
  const file = join(a.agentDir, '.claude', 'settings.local.json')
  let cfg: {
    hooks?: Record<
      string,
      Array<{ matcher?: string; hooks?: Array<{ command?: string; onFailure?: string; timeout?: number }> }>
    >
  } = {}
  try {
    cfg = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return a.add(
      'FAIL',
      'apps hooks',
      `no readable ${file}; run: apps/bridge/scripts/install.sh or talos-app apps scan`,
    )
  }
  const pre = (cfg.hooks?.PreToolUse ?? []).filter((g) => g.hooks?.some((h) => h.command?.includes(HOOK_MARKER)))
  const missing = eligible.filter((s) => !pre.some((g) => g.matcher === matcherFor(s.tool_prefix)))
  if (missing.length)
    return a.add(
      'FAIL',
      'apps hooks',
      `no gate entry for ${missing.map((s) => escapeForTerminal(s.server)).join(', ')}`,
    )
  const open = pre.find((g) =>
    g.hooks?.some((h) => h.command?.includes(HOOK_MARKER) && (h.onFailure !== 'block' || h.timeout !== 10)),
  )
  if (open)
    return a.add(
      'FAIL',
      'apps hooks',
      'the gate entry is missing "onFailure": "block" or its 10 s timeout, so it would fail open',
    )
  a.add('ok', 'apps hooks', `${pre.length} gate entr${pre.length === 1 ? 'y' : 'ies'} with onFailure block`)
  const command = pre[0]?.hooks?.find((h) => h.command?.includes(HOOK_MARKER))?.command
  if (command) {
    const sample = JSON.stringify({
      tool_name: `${eligible[0]?.tool_prefix}doctor`,
      tool_input: {},
      tool_use_id: 'toolu_doctor',
      mcp_server: { name: eligible[0]?.server, source: eligible[0]?.source },
    })
    try {
      const p = Bun.spawn(['sh', '-c', command], {
        stdin: new Blob([sample]),
        stdout: 'pipe',
        stderr: 'ignore',
        env: { PATH: process.env.PATH ?? '', HOME: a.env.userHome, TALOS_APP_BRIDGE: '1', TALOS_APP_HOME: a.env.home },
      })
      const [out, code] = await Promise.all([new Response(p.stdout as ReadableStream).text(), p.exited])
      let ok = code === 0
      if (out.trim()) {
        try {
          JSON.parse(out)
        } catch {
          ok = false
        }
      }
      a.add(
        ok ? 'ok' : 'FAIL',
        'apps gate runs',
        ok ? `exit ${code}` : `exit ${code}; the gate command does not answer cleanly`,
      )
    } catch (e) {
      a.add('FAIL', 'apps gate runs', (e as Error).message)
    }
  }
  if (a.deep) {
    const lines: string[] = []
    const quiet: CliIO = { ...a.io, out: (l) => void lines.push(l), err: (l) => void lines.push(l) }
    const code = await cmdApps(a.env, ['scan', '--check', '--agent-dir', a.agentDir], quiet, a.deps)
    a.add(
      code === 0 ? 'ok' : 'warn',
      'apps scan --check',
      code === 0
        ? 'no drift'
        : lines
            .filter((l) => l.startsWith('drift:') || l.startsWith('talos-app:'))
            .join(' | ')
            .slice(0, 400) || 'drift',
    )
  }
}

/**
 * `talos-app install-app-hooks --agent-dir <dir>`: re-writes the hook entries from the current catalog into
 * <dir>/.claude/settings.local.json (local scope; never user scope). Idempotent; foreign hooks stay. No catalog, no entries.
 */
export function cmdInstallAppHooks(env: BridgeEnv, argv: string[], io: CliIO, bridgeDir = BRIDGE_DIR): number {
  const { values } = parseArgs({
    args: argv,
    options: { 'agent-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } },
    strict: true,
  })
  const dir = values['agent-dir']
  if (!dir) {
    io.err('talos-app: --agent-dir is required')
    return 2
  }
  if (homeAsAgentDir(env, dir)) {
    io.err('talos-app: the agent folder is your home folder; hooks never go into ~/.claude')
    return 1
  }
  const c = readCatalog(appPaths(env.home))
  if (!c.ok) {
    io.err(`talos-app: ${c.reason}`)
    return 1
  }
  const eligible = (c.catalog?.servers ?? []).filter((s) =>
    s.resources.some((r) => r.state === 'approved' || r.state === 'needs_reapproval'),
  )
  const file = join(resolve(dir), '.claude', 'settings.local.json')
  if (values['dry-run']) {
    io.out(`would set ${eligible.length} app hook matcher(s) in ${file}`)
    return 0
  }
  const r = installHookSettings(
    file,
    {
      bridgeDir,
      prefixes: eligible.map((s) => s.tool_prefix),
      keychainDeny: eligible.some((s) => s.direct?.type === 'http' || s.direct?.type === 'sse'),
    },
    matcherFor,
  )
  io.out(r.changed ? `app hooks updated in ${file}` : 'app hooks already up to date')
  return 0
}
