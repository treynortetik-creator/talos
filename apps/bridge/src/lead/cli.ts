// `talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--mcp a,b] [--sandbox | --light]` and `lead check <folder>`.
// Owner-terminal only for `init` (it changes where a session runs). It sets the thread's session_opts.cwd through the
// config file, like any other session change, and does not switch the thread to its own session: that stays the owner's tap.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { canBeDedicated, McpAllowList } from '@talos-app/protocol'
import type { BridgeEnv } from '../config.ts'
import { paths } from '../config.ts'
import { ConfigFile } from '../config-file.ts'
import { checkWorkerFolder } from '../worker/patch-check.ts'
import { claudeConfigDir } from './fence.ts'
import { checkLeadFolder, initLeadFolder, LEAD_MARKER, LeadError, leadCheckNotes } from './init.ts'
import { isClaudeAiConnector, LEAD_NEVER_MCP, type LeadProfile } from './settings.ts'

export const LEAD_USAGE =
  'usage: talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--mcp <name,name>] [--sandbox | --light] [--remove-stopgap] | lead check <folder> [--agent-dir <dir>]'

type Out = { out(line: string): void; err(line: string): void }

export function cmdLead(
  env: BridgeEnv,
  args: string[],
  io: Out,
  deps: {
    home?: string
    templates?: string
    agentDir?: string
    claudeDir?: string
    configDirEnv?: string
    pathDirs?: string[]
    tmpDirs?: string[]
  } = {},
): number {
  const [sub, ...rest] = args
  if (sub !== 'init' && sub !== 'check') {
    io.err(LEAD_USAGE)
    return 2
  }
  let parsed: { values: Record<string, string | string[] | boolean | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        folder: { type: 'string' },
        'agent-dir': { type: 'string' },
        'disable-mcp': { type: 'string' },
        mcp: { type: 'string' },
        sandbox: { type: 'boolean' },
        light: { type: 'boolean' },
        'remove-stopgap': { type: 'boolean' },
        protect: { type: 'string', multiple: true },
      },
    })
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}\n${LEAD_USAGE}`)
    return 2
  }
  const { positionals } = parsed
  const values = parsed.values as unknown as {
    folder?: string
    'agent-dir'?: string
    'disable-mcp'?: string
    mcp?: string
    sandbox?: boolean
    light?: boolean
    'remove-stopgap'?: boolean
    protect?: string[]
  }
  const home = deps.home ?? homedir()
  const talosHome = env.home
  // Claude Code's config folder, read once here and passed down. A CLAUDE_CONFIG_DIR that is not absolute is an error.
  let claudeDir: string
  try {
    claudeDir =
      deps.claudeDir ??
      claudeConfigDir(home, 'configDirEnv' in deps ? deps.configDirEnv : process.env.CLAUDE_CONFIG_DIR)
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
  if (sub === 'check') {
    const folder = positionals[0]
    if (!folder || positionals.length > 1) {
      io.err(LEAD_USAGE)
      return 2
    }
    const problems = checkLeadFolder(
      folder,
      values['agent-dir'],
      talosHome,
      home,
      claudeDir,
      allowListOf(folder, env.home, home, talosHome),
    )
    for (const p of problems) io.err(`lead check: ${p}`)
    const { profile, notes } = leadCheckNotes(folder)
    if (!problems.length)
      io.out(
        `lead check: ${folder} is fine (brief, board, decisions, ${profile === 'sandbox' ? 'sandbox and fence' : 'fence'} in place)`,
      )
    for (const n of notes) io.out(`lead check: ${n}`)
    return problems.length ? 1 : 0
  }

  const [threadId] = positionals
  const folder = values.folder
  // the agent folder: the flag, else the one the supervisor and `talos-app start` export
  const agentDir = values['agent-dir'] ?? deps.agentDir ?? process.env.TALOS_AGENT_DIR
  const protect = values.protect ?? []
  if (
    !threadId ||
    positionals.length > 1 ||
    !folder ||
    !agentDir ||
    !folder.startsWith('/') ||
    !agentDir.startsWith('/')
  ) {
    io.err(
      `talos-app: init needs a thread id, an absolute --folder and an absolute --agent-dir (or TALOS_AGENT_DIR)\n${LEAD_USAGE}`,
    )
    return 2
  }
  if (values['disable-mcp'] !== undefined) {
    io.err(
      `talos-app: --disable-mcp is gone: which MCP servers a thread may use is now its one allow list. Name the ones to allow with --mcp <name,name> (talos-app is always allowed), or edit the list in the app.\n${LEAD_USAGE}`,
    )
    return 2
  }
  if (values.sandbox && values.light) {
    io.err(`talos-app: pick one of --sandbox and --light\n${LEAD_USAGE}`)
    return 2
  }
  // `--mcp ""` is a list too: the empty one, which clears it
  const picks =
    values.mcp === undefined
      ? undefined
      : values.mcp
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x && x !== 'talos-app')
  const parsedPicks = picks ? McpAllowList.safeParse(picks) : undefined
  if (parsedPicks && !parsedPicks.success) {
    io.err(
      `talos-app: --mcp needs up to 32 different server names of up to 80 characters, with no commas or control characters\n${LEAD_USAGE}`,
    )
    return 2
  }
  const connector = picks?.find(isClaudeAiConnector)
  if (connector) {
    io.err(
      `talos-app: claude.ai connectors cannot be on a lead's list (${connector}): a lead's settings turn them all off with disableClaudeAiConnectors, which holds from every settings scope, so nothing can turn one back on. Use a server from your own MCP config instead.\n${LEAD_USAGE}`,
    )
    return 2
  }
  const never = picks?.find((n) => (LEAD_NEVER_MCP as readonly string[]).includes(n))
  if (never) {
    io.err(
      `talos-app: ${never} can never be on a lead's list: the browser and screen tools are always denied.\n${LEAD_USAGE}`,
    )
    return 2
  }
  const profile: LeadProfile | undefined = values.sandbox ? 'sandbox' : values.light ? 'light' : undefined
  if (protect.some((p) => !p.startsWith('/'))) {
    io.err(`talos-app: every --protect must be an absolute path\n${LEAD_USAGE}`)
    return 2
  }
  const file = new ConfigFile(paths(env.home).configJson, {
    roots: { home, talosHome },
    log: { warn: (m, f) => io.err(`talos-app: ${m}${f?.error ? `: ${String(f.error)}` : ''}`) },
  })
  try {
    const cfg = file.load()
    const thread = cfg.threads.find((t) => t.id === threadId)
    if (!thread || thread.archived) throw new LeadError(`no thread "${threadId}" (see the thread ids in the app)`)
    if (!canBeDedicated(cfg, threadId))
      throw new LeadError(
        `thread "${threadId}" is the default, a system thread or otherwise always answered by the main session`,
      )
    // the thread's one MCP allow list: what --mcp named, else what it already has, else only talos-app (an empty list)
    const mcpAllow = picks ?? thread.session_opts?.mcp_allow ?? []
    const res = initLeadFolder({
      threadId,
      threadName: thread.name,
      folder,
      agentDir,
      talosHome,
      home,
      claudeDir,
      // PATH and TMPDIR are read once, here
      pathDirs: deps.pathDirs ?? (process.env.PATH ?? '').split(':').filter(Boolean),
      tmpDirs: deps.tmpDirs ?? (process.env.TMPDIR ? [process.env.TMPDIR] : []),
      ...(protect.length ? { protect } : {}),
      ...(profile ? { profile } : {}),
      ...(values['remove-stopgap'] ? { removeStopgap: true } : {}),
      ...(deps.templates ? { templates: deps.templates } : {}),
    })
    // the folder exists now: the same on-disk check the app makes before it starts a session there
    const why = checkWorkerFolder(res.folder, { home, talosHome })
    if (why) throw new LeadError(`the folder ${res.folder} cannot be a thread folder: ${why}`)
    if (
      thread.session_opts?.cwd !== res.folder ||
      JSON.stringify(thread.session_opts?.mcp_allow) !== JSON.stringify(mcpAllow)
    )
      file.update((c) => ({
        ...c,
        threads: c.threads.map((t) =>
          t.id === threadId
            ? ({ ...t, session_opts: { ...(t.session_opts ?? {}), cwd: res.folder, mcp_allow: mcpAllow } } as typeof t)
            : t,
        ),
      }))
    io.out(`lead folder ready: ${res.folder}`)
    if (res.created.length) io.out(`  wrote ${res.created.join(', ')}`)
    if (res.kept.length) io.out(`  kept (yours): ${res.kept.join(', ')}`)
    io.out(
      `  rewrote .claude/settings.json (the privacy fence${res.profile === 'sandbox' ? ' and sandbox' : ''}) and the BOARD.md Stop hook`,
    )
    io.out(
      `  profile: ${res.profile}${res.switched ? ' (changed, as you asked)' : ''}. ${res.profile === 'light' ? 'Light stops accidents, not a determined process; add --sandbox for the OS sandbox.' : 'The OS sandbox is on; add --light to switch it off.'}`,
    )
    io.out(
      `  MCP: ${mcpAllow.length ? `talos-app and ${mcpAllow.join(', ')}` : 'talos-app only'} (the thread's allow list; the Mac app applies it when the session starts)`,
    )
    if (res.stopgapRemoved.length)
      io.out(
        `  removed ${res.stopgapRemoved.length} MCP deny rule(s) the first version of the allow list wrote (recorded in .talos-lead as stopgap_removed)`,
      )
    io.out(
      `thread "${threadId}" now starts its session there. Fill in CLAUDE.md (job, authority, rules from main), then turn on Own session for the thread in the app.`,
    )
    return 0
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
}

/** The thread's MCP allow list, read from the config through the lead folder's marker. None known reads as the empty list. */
function allowListOf(folder: string, talosHomePath: string, home: string, talosHome: string): string[] {
  try {
    const marker = JSON.parse(readFileSync(join(folder, LEAD_MARKER), 'utf8')) as { thread?: string }
    const file = new ConfigFile(paths(talosHomePath).configJson, { roots: { home, talosHome } })
    return file.load().threads.find((t) => t.id === marker.thread)?.session_opts?.mcp_allow ?? []
  } catch {
    return []
  }
}
