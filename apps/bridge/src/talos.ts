#!/usr/bin/env bun
// Later: a wrapper package should own the `.env` and home isolation (which `.env` is read, and which home folder is used
// when `talos` runs from another directory). Not done here; `talos` reads the environment exactly as `talos-app` does.
// `talos` entry: a thin front door over the `talos-app` CLI. Every command is handed to the same handler `talos-app` uses,
// with the same arguments, so the two never disagree. Only `commands` (the list below) and `doctor --json` are new here.
import { parseArgs } from 'node:util'
import type { CliDeps, CliIO } from './cli-main.ts'

export type CommandInfo = {
  /** One word, or `word subword` where the subcommand has its own rule. */
  name: string
  summary: string
  /** True when the agent may reasonably run the command on its own. False for every command that needs a terminal. */
  agent_may_run: boolean
  /** Set by `ownerTerminal` only: the command refuses unless stdin and stdout are a terminal (`terminalOnly`). */
  needs_terminal?: true
}

/** A command only the owner types in Terminal. The one place that sets `needs_terminal`, and it forces `agent_may_run` false. */
const ownerTerminal = (name: string, summary: string): CommandInfo => ({
  name,
  summary,
  agent_may_run: false,
  needs_terminal: true,
})

/** The terminal-only command that `argv` runs (`devices revoke x` is `devices`), or undefined. */
export function terminalOnly(argv: readonly string[]): string | undefined {
  const [a, b] = argv
  return COMMANDS.find((c) => c.needs_terminal && (c.name === a || c.name === `${a} ${b}`))?.name
}

/** The single list of `talos` commands. Add a command here and give it a case in cli-main.ts. */
export const COMMANDS: readonly CommandInfo[] = [
  { name: 'commands', summary: 'List these commands and whether the agent may run each one', agent_may_run: true },
  { name: 'status', summary: 'Show relay reachability, bridge liveness, key id and queue depth', agent_may_run: true },
  { name: 'doctor', summary: 'Check this Mac setup; --json returns the checks as rows', agent_may_run: true },
  { name: 'logs', summary: 'Show the bridge log (-n lines, -f to follow)', agent_may_run: true },
  { name: 'report', summary: 'Write a redacted report for a bug report (--out writes any path)', agent_may_run: false },
  { name: 'errors', summary: 'List, show and close error reports', agent_may_run: true },
  { name: 'search reindex', summary: 'Rebuild the search index', agent_may_run: true },
  {
    name: 'schedules',
    summary: 'Show schedules; adopting one is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  { name: 'schedules adopt', summary: 'Approve the schedules found on this Mac', agent_may_run: false },
  {
    name: 'codex',
    summary: 'Check or run the Codex CLI; the subcommands below say which the agent may run',
    agent_may_run: false,
  },
  { name: 'codex check', summary: 'Check whether the Codex CLI is installed and logged in', agent_may_run: true },
  { name: 'codex run', summary: 'Run Codex on a task in a thread', agent_may_run: false },
  { name: 'digest', summary: 'Print the relay digest since a time', agent_may_run: true },
  { name: 'post', summary: 'Send a headless reply into a thread', agent_may_run: true },
  {
    name: 'hook',
    summary: 'Claude Code hook entry for MCP apps (called by Claude Code, not by hand)',
    agent_may_run: false,
  },
  { name: 'subagent-tee', summary: 'Status-line helper Claude Code calls for subagent rows', agent_may_run: true },
  {
    name: 'memory',
    summary: 'Show the memory browser or rebuild its index; the subcommands below set it up',
    agent_may_run: false,
  },
  ownerTerminal('memory init', 'Set up the memory folder for an agent'),
  { name: 'memory on', summary: 'Turn the memory browser on', agent_may_run: false },
  { name: 'memory off', summary: 'Turn the memory browser off', agent_may_run: false },
  { name: 'memory show', summary: 'Show whether the memory browser is on and what it covers', agent_may_run: true },
  { name: 'memory reindex', summary: 'Rebuild the memory index', agent_may_run: true },
  { name: 'apps', summary: 'Manage MCP apps; the subcommands below say which the agent may run', agent_may_run: false },
  { name: 'apps list', summary: 'List the MCP apps found', agent_may_run: true },
  ownerTerminal('apps scan', 'Scan installed plugins for MCP apps'),
  { name: 'apps strict', summary: 'Turn strict mode for MCP apps on or off', agent_may_run: false },
  { name: 'apps revoke', summary: 'Revoke an MCP app approval', agent_may_run: false },
  { name: 'apps login', summary: 'Sign in to an MCP app', agent_may_run: false },
  { name: 'apps logout', summary: 'Sign out of an MCP app', agent_may_run: false },
  { name: 'share', summary: 'Share links; the subcommands below are owner only', agent_may_run: false },
  { name: 'share revoke', summary: 'Revoke a share link', agent_may_run: false },
  { name: 'share shortcut', summary: 'Build and sign the share shortcut', agent_may_run: false },
  { name: 'init', summary: 'Create the home folder, bridge key and config', agent_may_run: false },
  ownerTerminal('enroll', 'Approve a new phone or browser'),
  ownerTerminal('devices', 'List approved devices or revoke one'),
  ownerTerminal('rotate', 'Replace the bridge key'),
  { name: 'start', summary: 'Start the agent (launches Claude Code)', agent_may_run: false },
  { name: 'update', summary: 'Pull the latest code and install packages', agent_may_run: false },
  { name: 'rollback', summary: 'Go back to the previous recorded version', agent_may_run: false },
  { name: 'restore-last-good', summary: 'Put back the last-good .mcp.json and .claude settings', agent_may_run: false },
  {
    name: 'trust',
    summary: 'Turn trust mode off, or show it; turning it on is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  {
    name: 'theme',
    summary: 'Show the app theme, or reset it to the default (reset is owner only)',
    agent_may_run: false,
  },
  ownerTerminal('theme reset', 'Reset the app theme to the default'),
  ownerTerminal('trust on', 'Turn trust mode on (fewer cards)'),
  {
    name: 'lead',
    summary: 'Set up or check the folder of a thread lead; making one is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  ownerTerminal('lead init', "Make a thread lead's folder (brief, board, privacy fence) and point the thread at it"),
  { name: 'lead check', summary: "Check a lead folder's brief, board sizes and privacy fence", agent_may_run: true },
  { name: 'install-mcp', summary: 'Add the Talos server to an agent folder .mcp.json', agent_may_run: false },
  ownerTerminal('adopt', 'Connect a Claude Code folder you already use (.mcp.json and app hooks only)'),
  { name: 'install-app-hooks', summary: 'Install the MCP apps hooks', agent_may_run: false },
  ownerTerminal('install-ask-rules', 'Add the standard permissions.ask rules'),
  ownerTerminal(
    'install-guards',
    'Install (or --remove) the guard hook and deny rules that protect the never-change list',
  ),
  { name: 'install-subagent-tee', summary: 'Install the subagent status line', agent_may_run: false },
]

const NOTE =
  'owner only commands that need a terminal refuse when stdin or stdout is not one; for the rest, agent_may_run is advice.'

/** Runs a `talos-app` command; tests replace it. */
export type RunCli = (
  argv: string[],
  io: CliIO,
  env?: Record<string, string | undefined>,
  deps?: CliDeps,
) => Promise<number>

const defaultRun: RunCli = async (argv, io, env, deps) => (await import('./cli.ts')).runCli(argv, io, env, deps)

export type TalosDeps = CliDeps & { run?: RunCli }

const USAGE = [
  'talos: a front door over talos-app. Every command below runs the same handler as `talos-app <command>`.',
  'Run `talos commands` for the list, or `talos commands --json` for the same list as data.',
]

function cmdCommands(args: string[], io: CliIO): number {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  if (values.json) {
    io.out(JSON.stringify({ enforced: 'terminal', note: NOTE, commands: COMMANDS }, null, 2))
    return 0
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  for (const c of COMMANDS)
    io.out(`${c.name.padEnd(width)}  ${(c.agent_may_run ? 'agent ok' : 'owner only').padEnd(10)}  ${c.summary}`)
  io.out('')
  io.out(`Note: ${NOTE}`)
  return 0
}

async function doctorJson(
  args: string[],
  io: CliIO,
  env: Record<string, string | undefined>,
  deps: CliDeps,
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: 'boolean' },
      'agent-dir': { type: 'string' },
      'claude-dir': { type: 'string' },
      deep: { type: 'boolean' },
    },
    strict: true,
  })
  const { loadEnv } = await import('./config.ts')
  const { runDoctorChecks } = await import('./doctor-checks.ts')
  const { checks } = await runDoctorChecks(
    loadEnv(env),
    {
      ...(values['agent-dir'] ? { agentDir: values['agent-dir'] } : {}),
      ...(values['claude-dir'] ? { claudeDir: values['claude-dir'] } : {}),
      ...(values.deep ? { deep: true } : {}),
    },
    io,
    deps,
  )
  const ok = !checks.some((c) => c.level === 'FAIL')
  io.out(JSON.stringify({ ok, rows: checks }, null, 2))
  return ok ? 0 : 1
}

/** Returns the exit code. */
export async function runTalos(
  argv: string[],
  io: CliIO,
  env: Record<string, string | undefined> = process.env,
  deps: TalosDeps = {},
): Promise<number> {
  const { run = defaultRun, ...cliDeps } = deps
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    for (const l of USAGE) io.out(l)
    return 0
  }
  if (cmd === '--version') {
    io.out(`talos ${(await import('./version.ts')).BRIDGE_VERSION}`)
    return 0
  }
  try {
    if (cmd === 'commands') return cmdCommands(rest, io)
    if (!COMMANDS.some((c) => c.name.split(' ')[0] === cmd)) {
      io.err(`talos: unknown command "${cmd}". Run \`talos commands\` for the list.`)
      return 2
    }
    if (cmd === 'doctor' && rest.includes('--json')) return await doctorJson(rest, io, env, cliDeps)
    return await run(argv, io, env, cliDeps)
  } catch (e) {
    io.err(`talos: ${(e as Error).message}`)
    return 1
  }
}

/** A terminal with no prompt: enough for the commands answered here, which never ask a question. */
function plainIO(): CliIO {
  return {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    prompt: async () => '',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  // The same early exits `talos-app` (cli.ts) keeps, for the same reasons: `subagent-tee` runs every few seconds and must
  // exit in under 100 ms (docs/SUBAGENTS.md 5.2), `hook` is Claude Code's per-call process, and `rollback` is the way back
  // when an update left the packages broken. None of them may load cli-main.ts (the relay, sqlite, the MCP SDK).
  if (argv[0] === 'subagent-tee') {
    const { mainTee } = await import('./subagent-tee.ts')
    process.exit(mainTee(argv.slice(1)))
  }
  if (argv[0] === 'hook') {
    const h = await import('./apps/hook-cli.ts')
    process.exit(await h.mainHook(argv.slice(1), h.processHookIO()))
  }
  if (argv[0] === 'rollback') {
    const r = await import('./rollback.ts')
    process.exit(await r.runRollback(argv.slice(1), r.rollbackIO()))
  }
  if (argv[0] === 'restore-last-good') {
    const l = await import('./last-good.ts')
    const r = await import('./rollback.ts')
    process.exit(await l.restoreLastGood(argv.slice(1), r.rollbackIO()))
  }
  // Everything else that needs the full CLI loads it here, once; `commands`, help, --version and an unknown name do not.
  const needsCli = argv[0] !== 'commands' && COMMANDS.some((c) => c.name.split(' ')[0] === argv[0])
  const io = needsCli ? (await import('./cli-main.ts')).terminalIO() : plainIO()
  process.exit(await runTalos(argv, io))
}
