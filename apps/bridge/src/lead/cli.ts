// `talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--disable-mcp a,b]` and `lead check <folder>`.
// Owner-terminal only for `init` (it changes where a session runs). It sets the thread's session_opts.cwd through the
// config file, like any other session change, and does not switch the thread to its own session: that stays the owner's tap.
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { canBeDedicated } from '@talos-app/protocol'
import type { BridgeEnv } from '../config.ts'
import { paths } from '../config.ts'
import { ConfigFile } from '../config-file.ts'
import { checkWorkerFolder } from '../worker/patch-check.ts'
import { claudeConfigDir } from './fence.ts'
import { checkLeadFolder, initLeadFolder, LeadError } from './init.ts'

export const LEAD_USAGE =
  'usage: talos-app lead init <thread-id> --folder <dir> [--agent-dir <dir>] [--protect <dir>]... [--disable-mcp <name,name>] | lead check <folder> [--agent-dir <dir>]'

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
  let parsed: { values: Record<string, string | string[] | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        folder: { type: 'string' },
        'agent-dir': { type: 'string' },
        'disable-mcp': { type: 'string' },
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
    const problems = checkLeadFolder(folder, values['agent-dir'], talosHome, home, claudeDir)
    for (const p of problems) io.err(`lead check: ${p}`)
    if (!problems.length) io.out(`lead check: ${folder} is fine (brief, board, decisions, sandbox and fence in place)`)
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
      ...(values['disable-mcp']
        ? {
            disableMcp: values['disable-mcp']
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
      ...(deps.templates ? { templates: deps.templates } : {}),
    })
    // the folder exists now: the same on-disk check the app makes before it starts a session there
    const why = checkWorkerFolder(res.folder, { home, talosHome })
    if (why) throw new LeadError(`the folder ${res.folder} cannot be a thread folder: ${why}`)
    if (thread.session_opts?.cwd !== res.folder)
      file.update((c) => ({
        ...c,
        threads: c.threads.map((t) =>
          t.id === threadId ? ({ ...t, session_opts: { ...(t.session_opts ?? {}), cwd: res.folder } } as typeof t) : t,
        ),
      }))
    io.out(`lead folder ready: ${res.folder}`)
    if (res.created.length) io.out(`  wrote ${res.created.join(', ')}`)
    if (res.kept.length) io.out(`  kept (yours): ${res.kept.join(', ')}`)
    io.out('  rewrote .claude/settings.json (the privacy fence and sandbox) and the BOARD.md Stop hook')
    io.out(
      `thread "${threadId}" now starts its session there. Fill in CLAUDE.md (job, authority, rules from main), then turn on Own session for the thread in the app.`,
    )
    return 0
  } catch (e) {
    io.err(`talos-app: ${(e as Error).message}`)
    return 1
  }
}
