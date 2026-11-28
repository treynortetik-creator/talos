// "Add plugin to agent" (docs/OPTION-C.md "Plugins for the agent and its threads"): ONE card to the owner, and on his own signed tap the BRIDGE runs
// `claude plugin install <name>@<marketplace> --scope user` against MAIN's Claude config folder (the folder every session and the launch signature read
// plugins from: plugins/main-config-dir.ts), then makes sure it is switched on at user scope. User scope is what a thread session loads (it reads user
// settings only), so Main and every thread get it; a running thread session restarts after its turn because the enabled-plugin set is part of its launch
// (supervisor/worker-launch.ts), and Main loads it at its next restart or reload. For each thread that has an MCP list, the plugin's servers are offered
// as `plugin:<name>:<server>` through the ordinary settings proposal (a card or a direct change by its own rules). Nothing from a plugin's files is shown
// as text but the plain event names of its hooks and, when the plugin runs one at install, the command (cleaned, one line).
//
// Checked against a real Claude Code 2.1.332 (Delphi): an install from a marketplace that has not been added exits 1 and adds nothing, so a request for one is
// answered with the command to run first (`claude plugin marketplace add <source>`: not offered here, it needs a source the owner names); `plugin enable` exits 1
// when the plugin is already on and 0 for a plugin that is not installed (it writes the key anyway), so the outcome is judged from installed_plugins.json and
// settings.json after the call, never from the exit code alone; a plugin that runs a command when it installs (a marketplace entry with source.source "command", or a server
// headersHelper) asks for confirmation unless given `-y`, which is passed only for those, and the card's "Runs:" line shows it. A stdio server's `command` is not one: no flag.
//
// The card says, before the tick, the exact command, which hook events the plugin carries and, for a PermissionRequest or PreToolUse hook, or one whose hooks cannot
// be read, "This plugin can approve tool calls without asking your phone." One tick; no second box; a warning, not a refusal. On a Talos distro (the kit is root's)
// nothing is installed from the phone. Installs run one at a time, and a plugin whose card was tapped and is still installing counts as pending.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  bindingFrom,
  Card,
  type CardBinding,
  type CardT,
  clipUnits,
  newId,
  payloadHash,
  validateCard,
} from '@talos-app/protocol'
import type { LedgerRow } from '../cards-ledger.ts'
import { resolveClaude } from '../claude-path.ts'
import { type BridgeContext, defaultThreadRef } from '../context.ts'
import { type ExecResult, runArgv } from '../exec.ts'
import { cardCreateFrame, cardUpdateFrame } from '../frames-out.ts'
import {
  approvesToolCalls,
  marketplaceInfo,
  pluginCommands,
  pluginHookEvents,
  pluginServerDefs,
  pluginSource,
} from '../supervisor/plugin-hooks.ts'
import { kitAnchor } from '../supervisor/rooted-kit.ts'
import { pluginServers, readInstalledPlugins } from '../supervisor/worker-mcp.ts'
import { assertFrameFits } from '../transport.ts'
import { type MainClaudeDir, type MainDir, mainClaudeDirs } from './main-config-dir.ts'
import { PLUGIN_WORDS as W } from './plugin-words.ts'

export const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CARD_EXPIRY_MS = 24 * 3600_000
const INSTALL_MS = 180_000
/** What an install may see of this process's environment: how to find its programs, reach a network (proxies, certificates, ssh) and read the user's config, nothing else (no tokens, no keys). */
const INSTALL_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSL_CAINFO',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]

export type AddResult = { ok: boolean; text: string; cardId?: string }

export type PluginDeps = {
  /** Main's Claude config folder, and whether Main sets CLAUDE_CONFIG_DIR (the install is told the folder only then). */
  claudeDir: () => Promise<MainDir>
  /** True on a Talos distro (the kit is root's): nothing is installed from the phone there. */
  rooted: () => boolean
  /** `claude` on this computer's PATH, or undefined. */
  claudeBin: () => string | undefined
  run: (argv: string[], env: Record<string, string>, timeoutMs: number) => Promise<ExecResult>
}

type AddPayload = {
  plugin: string
  marketplace: string
  /** `install`, or `enable` for a plugin that is installed but off. */
  mode: 'install' | 'enable'
  events: string[]
  approves: boolean
  checked: boolean
  unreadable: boolean
  /** The plugin's hooks file is not in the form Claude Code loads (a bare event table): it may not load at all. */
  malformed?: boolean
  /** What its servers run (a command, a headersHelper), cleaned; non-empty means the CLI asks for confirmation unless told to accept. */
  commands?: string[]
}

export function isPluginAddCard(binding: Pick<CardBinding, 'kind' | 'payload'>): boolean {
  if (binding.kind !== 'config') return false
  const p = binding.payload as Record<string, unknown> | null | undefined
  return p !== null && typeof p === 'object' && typeof (p as { plugin_add?: unknown }).plugin_add === 'object'
}

const addOf = (row: Pick<LedgerRow, 'binding'>): AddPayload | undefined =>
  (row.binding.payload as { plugin_add?: AddPayload } | undefined)?.plugin_add

/** The environment an install runs in: the allowlist above, plus CLAUDE_CONFIG_DIR only when Main sets it. */
export function installEnv(src: Record<string, string | undefined>, main: MainDir): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of INSTALL_ENV) if (typeof src[k] === 'string') env[k] = src[k] as string
  env.PATH ??= '/usr/bin:/bin'
  env.HOME ??= homedir()
  if (main.set) env.CLAUDE_CONFIG_DIR = main.dir
  return env
}

/** The command the card names and the bridge runs, as one argv (the claude path first); `accept` is `-y`, for a plugin that runs a command when it installs and whose card showed it. */
export const commandOf = (bin: string, key: string, mode: 'install' | 'enable', accept?: '-y'): string[] => [
  bin,
  'plugin',
  mode,
  key,
  '--scope',
  'user',
  ...(accept ? [accept] : []),
]

/** `-y` for a plugin that runs a command when it installs (and mode install): the CLI asks otherwise. Nothing else gets a flag. */
const acceptFor = (add: { mode: string; commands?: string[] }): '-y' | undefined =>
  add.mode === 'install' && add.commands && add.commands.length > 0 ? '-y' : undefined

export function defaultPluginDeps(dirs: MainClaudeDir = mainClaudeDirs): PluginDeps {
  return {
    claudeDir: () => dirs.resolve(),
    rooted: () => {
      const a = kitAnchor()
      return !('mode' in a) || a.mode !== 'home'
    },
    claudeBin: () => resolveClaude(process.env.PATH),
    // its own process group, so a timeout takes the whole install down, not only its first process
    run: (argv, env, ms) => runArgv(argv, ms, env, true),
  }
}

const FLAG_TTL_MS = 60_000

const mtime = (p: string): number => {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/** The temp folders an install clones into (`plugins/cache/temp_git_*`): name to time, so what this install made can be told from what was there. */
function tempGit(dir: string): Map<string, number> {
  const out = new Map<string, number>()
  try {
    for (const n of readdirSync(join(dir, 'plugins', 'cache')))
      if (n.startsWith('temp_git_')) out.set(n, mtime(join(dir, 'plugins', 'cache', n)))
  } catch {}
  return out
}

/** Only a folder made within this long of now can be this install's: an older one is never touched, whatever the clock says. */
const TEMP_GIT_WINDOW_MS = 10 * 60_000

/** After a failed or timed-out install: removes only the temp_git_* folders that were not there before it, were made since it started, and are under 10 minutes old. */
function cleanTempGit(dir: string, before: Map<string, number>, startedAt: number, now: number): void {
  for (const [n, t] of tempGit(dir))
    if (!before.has(n) && t >= startedAt - 1000 && now - t < TEMP_GIT_WINDOW_MS)
      rmSync(join(dir, 'plugins', 'cache', n), { recursive: true, force: true })
}

/**
 * The enabled plugins of Main's config folder that may approve tool calls without asking the phone (a PermissionRequest or PreToolUse hook, or hooks that
 * cannot be read), for the Settings list. The bridge's OWN read, from where Claude Code loads the plugin (a local-folder marketplace's SOURCE folder), whatever
 * the mod says. Kept until the plugin files change (their times).
 */
export function approvingPlugins(claudeDir: () => string): () => string[] {
  let key = ''
  let at = 0
  let cached: string[] = []
  return () => {
    const dir = claudeDir()
    const list = readInstalledPlugins(dir)
    const enabled = list?.filter((p) => p.enabled) ?? []
    const memo = new Map<string, unknown>()
    const sources = enabled.map((p) => ({ p, src: pluginSource(dir, p.key, p.name, p.root, memo) }))
    const k = [
      dir,
      mtime(join(dir, 'plugins', 'installed_plugins.json')),
      mtime(join(dir, 'settings.json')),
      mtime(join(dir, 'plugins', 'known_marketplaces.json')),
      ...sources.flatMap(({ src }) => [
        src.root,
        mtime(join(src.root, 'hooks', 'hooks.json')),
        mtime(join(src.root, '.claude-plugin', 'plugin.json')),
      ]),
    ].join('|')
    // the key names the files read; their other files (marketplace.json, hook files a plugin.json names) are covered by a 60 s limit
    if (k === key && Date.now() - at < FLAG_TTL_MS) return cached
    key = k
    at = Date.now()
    try {
      cached = sources
        .filter(({ src }) => {
          const r = pluginHookEvents(src.root, src.entry)
          return approvesToolCalls(r.malformed ? [] : r.events, r.unreadable || r.malformed)
        })
        .map(({ p }) => p.key)
    } catch {
      cached = []
    }
    return cached
  }
}

export const defaultApprovingPlugins = () => approvingPlugins(() => mainClaudeDirs.sync().dir)

export class AgentPlugins {
  /** Installs run one at a time: each waits for the one before. */
  private chain: Promise<unknown> = Promise.resolve()
  /** Plugins whose card was tapped and whose install is queued or running: still "pending" for a new request. */
  private readonly running = new Set<string>()
  private readonly deps: PluginDeps

  /** With no `deps` (the live bridge) Main's config folder is read ONCE now, in the background, so the Settings flag looks in Main's folder before any request. */
  constructor(
    private readonly ctx: BridgeContext,
    deps?: PluginDeps,
    dirs: MainClaudeDir = mainClaudeDirs,
  ) {
    this.deps = deps ?? defaultPluginDeps(dirs)
    if (!deps) void dirs.resolve().catch(() => {})
  }

  /** The owner asked (his own signed frame, accepted by the caller) to add `plugin` from `marketplace`: one card, or why not. Never throws. */
  async request(plugin: string, marketplace: string): Promise<AddResult> {
    const { ctx, deps } = this
    if (!PLUGIN_NAME.test(plugin) || !PLUGIN_NAME.test(marketplace)) return { ok: false, text: W.badName }
    const key = `${plugin}@${marketplace}`
    if (deps.rooted()) return { ok: false, text: W.rooted }
    const bin = deps.claudeBin()
    if (!bin) return { ok: false, text: W.noClaude }
    const main = await deps.claudeDir()
    const list = readInstalledPlugins(main.dir)
    if (list === null) return { ok: false, text: W.failed(W.unreadableFiles) }
    const have = list.find((p) => p.key === key)
    if (have?.enabled) return { ok: false, text: W.already(key) }
    const found = marketplaceInfo(main.dir, marketplace, plugin)
    // an install from a marketplace that has not been added exits 1 and adds nothing (checked on 2.1.332): say so before the card
    if (!have && !found.known) return { ok: false, text: W.noMarketplace(marketplace) }
    const pending =
      this.running.has(key) ||
      ctx.ledger
        .list('pending')
        .some(
          (r) =>
            r.actor === 'bridge' &&
            isPluginAddCard(r.binding) &&
            `${addOf(r)?.plugin}@${addOf(r)?.marketplace}` === key,
        )
    if (pending) return { ok: false, text: W.pending(key) }
    // from where Claude Code loads it: an installed plugin's own folder (a local-folder marketplace's source), else the marketplace's copy
    const src = have
      ? pluginSource(main.dir, key, plugin, have.root)
      : found.root
        ? { root: found.root, entry: found.entry }
        : undefined
    const read = src ? pluginHookEvents(src.root, src.entry) : undefined
    const servers = src ? pluginServerDefs(src.root, src.entry) : undefined
    const entry = src?.entry ?? found.entry
    // what it runs when it installs: a command-source entry (readable from the marketplace alone) and server headersHelpers
    const cmds = pluginCommands(servers && !servers.unreadable ? servers.servers : new Map(), entry)
    const commands = cmds.length > 0 || (servers && !servers.unreadable) ? cmds : undefined
    const add: AddPayload = {
      plugin,
      marketplace,
      mode: have ? 'enable' : 'install',
      events: read?.malformed ? [] : (read?.events ?? []),
      // a hooks file that is not in a form Claude Code loads is treated as one that could not be read: it may still approve (fail closed)
      approves: approvesToolCalls(
        read?.malformed ? [] : (read?.events ?? []),
        read?.unreadable === true || read?.malformed === true,
      ),
      checked: read !== undefined,
      unreadable: read?.unreadable === true,
      ...(read?.malformed ? { malformed: true } : {}),
      ...(commands ? { commands } : {}),
    }
    const now = ctx.clock.now()
    // the argv the card shows is the one the tap runs, `-y` included, for a plugin that runs a command when it installs
    const card = this.card(add, key, commandOf(bin, key, add.mode, acceptFor(add)), now)
    if (typeof card === 'string') return { ok: false, text: W.failed(card) }
    try {
      assertFrameFits(cardCreateFrame(now, card))
    } catch (e) {
      return { ok: false, text: W.failed((e as Error).message) }
    }
    ctx.ledger.create(card, 'bridge')
    try {
      await ctx.transport.sendDurable(cardCreateFrame(now, card))
    } catch (e) {
      ctx.ledger.expire(card.id)
      ctx.expiry?.cancel(card.id)
      return { ok: false, text: W.failed(`the card could not be sent (${(e as Error).message}).`) }
    }
    ctx.expiry?.sync()
    return { ok: true, text: W.asked(key), cardId: card.id }
  }

  private card(add: AddPayload, key: string, argv: string[], now: number): CardT | string {
    const hooks = add.malformed
      ? W.hooksMalformed
      : add.unreadable
        ? W.hooksUnreadable
        : !add.checked
          ? W.hooksUnknown
          : W.hooks(add.events)
    // what a plugin runs at install: its command (the CLI asks, and the bridge accepts it only because the owner saw it here), or "could not tell"
    const runs =
      add.mode === 'enable'
        ? []
        : add.commands === undefined
          ? [W.runsUnknown]
          : add.commands.length > 0
            ? [W.runsCommand(add.commands)]
            : []
    const candidate = {
      id: newId('c'),
      thread_id: defaultThreadRef(this.ctx).id,
      kind: 'config' as const,
      title: clipUnits(W.title(add.plugin), 120),
      summary: W.summary,
      destination: [{ label: W.marketplace, value: clipUnits(add.marketplace, 80) }],
      body: [W.plugin(key), hooks, ...runs, W.command(argv)].join('\n'),
      body_format: 'plain' as const,
      fields: [],
      attachments: [],
      ...(add.approves ? { warning: W.approves } : {}),
      primary_label: W.primary,
      kill_label: W.kill,
      allow_edit: false,
      allow_revise: false,
      risk: 'high' as const,
      origin: 'background' as const,
      payload: { v: 1, plugin_add: add },
      payload_hash: `sha256:${'0'.repeat(64)}`,
      state: 'pending' as const,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + CARD_EXPIRY_MS).toISOString(),
    }
    const parsed = Card.safeParse(candidate)
    if (!parsed.success) return `the card could not be drawn (${parsed.error.issues[0]?.path.join('.')}).`
    const card: CardT = parsed.data
    const issues = validateCard(card)
    if (issues.length) return `the card could not be drawn (${issues.join(', ')}).`
    card.payload_hash = payloadHash(bindingFrom(card))
    return card
  }

  /** The owner answered (inbound has checked the signed tap and moved the ledger). Only Add plugin does anything; the work is queued behind any install running. */
  onResolved(row: LedgerRow, action: 'primary' | 'kill' | 'revise'): Promise<void> {
    const add = addOf(row)
    if (action !== 'primary' || !add) return Promise.resolve()
    const key = `${add.plugin}@${add.marketplace}`
    this.running.add(key)
    const job = this.chain.then(() => this.install(row, add, key)).finally(() => this.running.delete(key))
    this.chain = job.catch(() => {})
    return job
  }

  private async install(row: LedgerRow, add: AddPayload, key: string): Promise<void> {
    const { ctx, deps } = this
    if (!PLUGIN_NAME.test(add.plugin) || !PLUGIN_NAME.test(add.marketplace))
      return this.end(row, false, W.failed(W.badName))
    if (deps.rooted()) return this.end(row, false, W.rooted)
    const bin = deps.claudeBin()
    if (!bin) return this.end(row, false, W.noClaude)
    const main = await deps.claudeDir()
    const env = installEnv(process.env, main)
    const startedAt = ctx.clock.now()
    const before = tempGit(main.dir)
    const accept = acceptFor(add) // `-y` only when the card showed a command it runs at install: the argv on the card
    const step = (mode: 'install' | 'enable', flag?: '-y') => deps.run(commandOf(bin, key, mode, flag), env, INSTALL_MS)
    const first = await step(add.mode, add.mode === 'install' ? accept : undefined)
    // installed means: in installed_plugins.json, on in settings.json, and its folder is there
    const find = () => {
      const p = readInstalledPlugins(main.dir)?.find((x) => x.key === key)
      return p && existsSync(p.root) ? p : undefined
    }
    let now = find()
    // an exit code alone decides nothing (`enable` exits 1 when already on, 0 for a plugin that is not installed): the files after the call do
    if (!first.ok && !now?.enabled) {
      cleanTempGit(main.dir, before, startedAt, ctx.clock.now())
      const why = first.reason === 'exit' ? `exit ${first.code ?? '?'}` : first.reason
      // an install from a marketplace that is not added exits 1: name that cause
      const unknown = add.mode === 'install' && !marketplaceInfo(main.dir, add.marketplace, add.plugin).known
      return this.end(row, false, W.failed(unknown ? W.noMarketplace(add.marketplace) : W.installFailed(why)))
    }
    if (now && !now.enabled && add.mode === 'install') {
      await step('enable') // its exit code is not read: the file is
      now = find()
    }
    if (!now?.enabled) {
      cleanTempGit(main.dir, before, startedAt, ctx.clock.now())
      return this.end(row, false, W.failed(W.notThere))
    }
    const src = pluginSource(main.dir, key, add.plugin, now.root)
    const servers = [...pluginServers(main.dir, main.dir).keys()].filter((k) => k.split(':')[1] === now.name)
    const events = pluginHookEvents(src.root, src.entry)
    const offered = servers.length > 0 ? await this.offer(servers, key) : 0
    ctx.log.info('plugin added to the agent', { plugin: key, servers: String(servers.length) })
    const text = [
      W.added(key),
      servers.length > 0 ? W.servers(servers.length).trim() : '',
      offered > 0 ? W.offered(offered).trim() : '',
      approvesToolCalls(events.malformed ? [] : events.events, events.unreadable || events.malformed) ? W.approves : '',
    ]
      .filter(Boolean)
      .join(' ')
    return this.end(row, true, text)
  }

  /** For each thread with an MCP list: offer the plugin's servers (the ordinary settings proposal decides card or direct). */
  private async offer(servers: string[], key: string): Promise<number> {
    const { ctx } = this
    let n = 0
    for (const t of ctx.config.config.threads) {
      const list = (t as { session_opts?: { mcp_allow?: unknown } }).session_opts?.mcp_allow
      if (!Array.isArray(list)) continue
      const have = list.filter((x): x is string => typeof x === 'string')
      const next = [...new Set([...have, ...servers])]
      if (next.length === have.length) continue
      try {
        const r = await ctx.configProposals?.propose({
          thread_id: t.id,
          reason: clipUnits(`The owner added ${key} to the agent.`, 280),
          changes: [{ path: `threads.${t.id}.session_opts.mcp_allow`, new: next }],
        })
        if (r?.ok) n++
      } catch (e) {
        ctx.log.warn('plugin servers not offered', { thread: t.id, error: (e as Error).message })
      }
    }
    return n
  }

  /** Once per process: an install that was in flight when the bridge stopped is ended in words that say its outcome is not known, and it is never run again. */
  async recover(): Promise<void> {
    const rows = this.ctx.ledger
      .list('resolved')
      .filter((r) => r.actor === 'bridge' && isPluginAddCard(r.binding) && r.resolution?.action === 'primary')
    for (const r of rows) await this.end(r, false, W.restarted)
  }

  private async end(row: LedgerRow, ok: boolean, text: string): Promise<void> {
    const { ctx } = this
    ctx.ledger.finish(row.id, ok)
    await ctx.transport
      .sendDurable(
        cardUpdateFrame(ctx.clock.now(), {
          card_id: row.id,
          state: ok ? 'done' : 'failed',
          result: { ok, text: clipUnits(text, 500), at: new Date(ctx.clock.now()).toISOString() },
        }),
      )
      .catch((e) => ctx.log.warn('card.update not sent', { error: (e as Error).message }))
  }
}
