#!/usr/bin/env bun
// Later: a wrapper package should own the `.env` and home isolation (which `.env` is read, and which home folder is used
// when `talos` runs from another directory). Not done here; `talos` reads the environment exactly as `talos-app` does.
// `talos` entry: a thin front door over the `talos-app` CLI. Every command is handed to the same handler `talos-app` uses,
// with the same arguments, so the two never disagree. Only `commands` (the list below) and `doctor --json` are new here.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { CommandEffect, CommandRisk } from '@talos-app/protocol'
import type { CliDeps, CliIO } from './cli-main.ts'
import { workerCliRefusal } from './worker/cli-refusal.ts'

export type CommandInfo = {
  /** One word, or `word subword` where the subcommand has its own rule. */
  name: string
  summary: string
  /** True when the agent may reasonably run the command on its own. False for every command that needs a terminal. */
  agent_may_run: boolean
  /** Set by `ownerTerminal` only: the command refuses unless stdin and stdout are a terminal (`terminalOnly`). */
  needs_terminal?: true
  /** The usage after the name, e.g. `[--json] | revoke <id>`. `talos-app`'s usage text is made from this and `summary`. */
  args?: string
  /** What running it touches. Set only where it is known; absent means not stated, not "nothing". */
  effects?: readonly CommandEffect[]
  /** `ask` means behind an approval card. Set only where it is known. */
  risk?: CommandRisk
}

/** A command only the owner types in Terminal. The one place that sets `needs_terminal`, and it forces `agent_may_run` false. */
const ownerTerminal = (name: string, summary: string, args?: string): CommandInfo => ({
  name,
  summary,
  ...(args ? { args } : {}),
  agent_may_run: false,
  needs_terminal: true,
})

/** `update`, `rollback` and `restore` mean the agent kit's updater under `talos`; under `talos-app`, `update` and `rollback` are the app's own (ask-gated, not terminal-only). */
const KIT_NAMES = new Set(['update', 'rollback', 'restore'])

/** The terminal-only command that `argv` runs (`devices revoke x` is `devices`), or undefined. `prog` is the program it was typed to. */
export function terminalOnly(argv: readonly string[], prog: 'talos' | 'talos-app' = 'talos-app'): string | undefined {
  const [a, b] = argv
  if (prog === 'talos' && (a === 'update' || a === 'rollback') && b === 'app') return undefined // the app's own
  return COMMANDS.find(
    (c) => c.needs_terminal && (prog === 'talos' || !KIT_NAMES.has(c.name)) && (c.name === a || c.name === `${a} ${b}`),
  )?.name
}

/** The names that are terminal-only under `prog`, for the permission deny rules. */
export function terminalOnlyNames(prog: 'talos' | 'talos-app'): string[] {
  return COMMANDS.filter((c) => c.needs_terminal && (prog === 'talos' || !KIT_NAMES.has(c.name))).map((c) => c.name)
}

/** The single list of `talos` commands. Add a command here and give it a case in cli-main.ts. */
export const COMMANDS: readonly CommandInfo[] = [
  {
    name: 'commands',
    args: '[--json]',
    summary: 'List these commands and whether the agent may run each one',
    agent_may_run: true,
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'events',
    args: '[--json]',
    summary: 'List the named events a hook can react to, with who emits each and the fields it carries',
    agent_may_run: true,
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'status',
    args: '[--json]',
    summary: 'Show relay reachability, bridge liveness, key id and queue depth',
    agent_may_run: true,
  },
  {
    name: 'doctor',
    args: '[--agent-dir <dir>] [--deep]',
    summary: 'Check this Mac setup; --json returns the checks as rows',
    agent_may_run: true,
  },
  {
    name: 'logs',
    args: '[-n <lines>] [-f]',
    summary: 'Show the bridge log (-n lines, -f to follow)',
    agent_may_run: true,
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'report',
    args: '[--agent-dir <dir>] [--lines <n>] [--out <file>]',
    summary: 'Write a redacted report for a bug report (--out writes any path)',
    agent_may_run: false,
  },
  {
    name: 'errors',
    args: 'list [--closed|--all] | show <id> | close <id>',
    summary: 'List, show and close error reports',
    agent_may_run: true,
  },
  { name: 'search reindex', summary: 'Rebuild the search index', agent_may_run: true },
  {
    name: 'schedules',
    args: '[adopt | notify <message>]',
    summary: 'Show schedules; adopting one is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  { name: 'schedules adopt', summary: 'Approve the schedules found on this Mac', agent_may_run: false },
  {
    name: 'codex',
    args: 'check | run --thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- <prompt>',
    summary: 'Check or run the Codex CLI; the agent may run both subcommands',
    agent_may_run: true,
  },
  { name: 'codex check', summary: 'Check whether the Codex CLI is installed and logged in', agent_may_run: true },
  {
    name: 'codex run',
    args: '--thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- <prompt>',
    summary: 'Run Codex on a task in a thread',
    agent_may_run: true,
  },
  { name: 'digest', args: '[--since <ISO>]', summary: 'Print the relay digest since a time', agent_may_run: true },
  { name: 'post', args: '<thread> <text>', summary: 'Send a headless reply into a thread', agent_may_run: true },
  {
    name: 'hook',
    summary: 'Claude Code hook entry for MCP apps (called by Claude Code, not by hand)',
    agent_may_run: false,
  },
  {
    name: 'subagent-tee',
    args: '[-- <your own subagentStatusLine command...>]',
    summary: 'Status-line helper Claude Code calls for subagent rows',
    agent_may_run: true,
  },
  {
    name: 'memory',
    args: 'init [--agent-dir <dir>] | on | off | show | reindex',
    summary: 'Show the memory browser or rebuild its index; the subcommands below set it up',
    agent_may_run: false,
  },
  ownerTerminal('memory init', 'Set up the memory folder for an agent', '[--agent-dir <dir>]'),
  { name: 'memory on', summary: 'Turn the memory browser on', agent_may_run: false },
  { name: 'memory off', summary: 'Turn the memory browser off', agent_may_run: false },
  {
    name: 'memory show',
    summary: 'Show whether the memory browser is on and what it covers',
    agent_may_run: true,
    effects: ['read'],
    risk: 'low',
  },
  { name: 'memory reindex', summary: 'Rebuild the memory index', agent_may_run: true },
  {
    name: 'apps',
    args: 'scan [--check] [--agent-dir <dir>] [--exclude-plugin <name>] | list | revoke <server|key-prefix> | login <server> | logout <server> | strict on|off',
    summary: 'Manage MCP apps; the subcommands below say which the agent may run',
    agent_may_run: false,
  },
  { name: 'apps list', summary: 'List the MCP apps found', agent_may_run: true, effects: ['read'], risk: 'low' },
  ownerTerminal(
    'apps scan',
    'Scan installed plugins for MCP apps',
    '[--check] [--agent-dir <dir>] [--exclude-plugin <name>]',
  ),
  { name: 'apps strict', args: 'on|off', summary: 'Turn strict mode for MCP apps on or off', agent_may_run: false },
  { name: 'apps revoke', args: '<server|key-prefix>', summary: 'Revoke an MCP app approval', agent_may_run: false },
  { name: 'apps login', args: '<server>', summary: 'Sign in to an MCP app', agent_may_run: false },
  { name: 'apps logout', args: '<server>', summary: 'Sign out of an MCP app', agent_may_run: false },
  {
    name: 'share',
    args: 'revoke <id> | shortcut [--label <label>] [--files] [--device <id>]',
    summary: 'Share links; the subcommands below are owner only',
    agent_may_run: false,
  },
  { name: 'share revoke', args: '<id>', summary: 'Revoke a share link', agent_may_run: false },
  {
    name: 'share shortcut',
    args: '[--label <label>] [--files] [--device <id>]',
    summary: 'Build and sign the share shortcut',
    agent_may_run: false,
  },
  {
    name: 'init',
    args: '--relay-url <url> [--config default|five-threads]',
    summary: 'Create the home folder, bridge key and config',
    agent_may_run: false,
  },
  ownerTerminal('enroll', 'Approve a new phone or browser', '[--label <name>] [--no-qr] [--confirm]'),
  ownerTerminal('devices', 'List approved devices or revoke one', '[revoke <id>]'),
  ownerTerminal('rotate', 'Replace the bridge key'),
  {
    name: 'start',
    args: '[--agent-dir <dir>] [--dry-run] [-- <claude flags>]',
    summary: 'Start the agent (launches Claude Code)',
    agent_may_run: false,
  },
  // `update`, `rollback` and `restore` act on the agent kit (the Talos zone of the agent folder) and run kit/bin/talos-update,
  // which holds the lock, checks the signature and does the work; they are owner terminal commands (a speed bump for an agent, not a lock). The app checkout's own pull and
  // rollback are `talos-app update` / `talos-app rollback` (also spelled `talos update app` / `talos rollback app` at the hook): ask-gated, not
  // terminal-only, so the documented phone recovery (`talos-app rollback --yes` behind a card) keeps working. The deny pattern
  // `talos rollback:*` is a prefix match and also covers `talos rollback app`, so only the `talos-app` spelling is a phone path.
  ownerTerminal(
    'update',
    'Update the agent kit to the newest signed release (--dry-run shows what would change first)',
  ),
  {
    name: 'update app',
    summary: 'Pull the latest app code and install packages (this checkout, not the agent kit)',
    agent_may_run: false,
  },
  ownerTerminal('rollback', 'Put the previous agent kit release back (a version after it names one)'),
  {
    name: 'rollback app',
    args: '[--dry-run] [--yes] [--skip-data-check]',
    summary: 'Go back to the previous recorded app version (this checkout, not the agent kit)',
    agent_may_run: false,
  },
  ownerTerminal(
    'restore',
    'Put one file back: a Talos file from the release, settings from last-good, your own from git',
  ),
  {
    name: 'restore-last-good',
    args: '[--list] [--version <n>] [--file <name>] [--newest-start] [--agent-dir <dir>] [--yes]',
    summary: 'Put back the last-good .mcp.json and .claude settings',
    agent_may_run: false,
  },
  {
    name: 'trust',
    args: 'on|off|show',
    summary: 'Turn trust mode off, or show it; turning it on is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  {
    name: 'theme',
    args: 'reset|show',
    summary: 'Show the app theme, or reset it to the default (reset is owner only)',
    agent_may_run: false,
  },
  ownerTerminal('theme reset', 'Reset the app theme to the default'),
  ownerTerminal('trust on', 'Turn trust mode on (fewer cards)'),
  {
    name: 'lead',
    args: 'init <thread-id> --folder <dir> --agent-dir <dir> [--mcp <names>] [--sandbox | --light] | check <folder> [--agent-dir <dir>]',
    summary: 'Set up or check the folder of a thread lead; making one is a separate, owner-only subcommand',
    agent_may_run: false,
  },
  ownerTerminal(
    'lead init',
    "Make a thread lead's folder (brief, board, privacy fence) and point the thread at it",
    '<thread-id> --folder <dir> --agent-dir <dir> [--mcp <names>] [--sandbox | --light]',
  ),
  {
    name: 'lead check',
    args: '<folder> [--agent-dir <dir>]',
    summary: "Check a lead folder's brief, board sizes and privacy fence",
    agent_may_run: true,
  },
  {
    name: 'install-mcp',
    args: '--agent-dir <dir> [--dry-run]',
    summary: 'Add the Talos server to an agent folder .mcp.json',
    agent_may_run: false,
  },
  ownerTerminal(
    'adopt',
    'Connect a Claude Code folder you already use (.mcp.json and app hooks only)',
    '--agent-dir <dir> [--dry-run] [--yes] [--repoint]',
  ),
  { name: 'install-app-hooks', summary: 'Install the MCP apps hooks', agent_may_run: false },
  ownerTerminal(
    'install-ask-rules',
    'Add the standard permissions.ask rules',
    '--agent-dir <dir> [--scope project|user] [--dry-run]',
  ),
  ownerTerminal(
    'install-guards',
    'Install (or --remove) the guard hook and deny rules that protect the never-change list',
    '[--remove]',
  ),
  {
    name: 'install-subagent-tee',
    args: '--agent-dir <dir> [--scope project|user] [--dry-run]',
    summary: 'Install the subagent status line',
    agent_may_run: false,
  },
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

/** The kit verbs: `talos update`, `talos rollback` and `talos restore` run the kit's own updater. `update app` and `rollback app` are the app's. */
export function isKitVerb(argv: readonly string[]): boolean {
  const [cmd, sub] = argv
  if (cmd === 'restore') return true
  return (cmd === 'update' || cmd === 'rollback') && sub !== 'app'
}

/** The kit's vendor folder (releases, `current`, the lock): the same place kit/scripts/plugin-release.py puts it. */
export function kitVendorDir(env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): string {
  const base = env.TALOS_VENDOR_DIR ?? join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'talos')
  return env.TALOS_KIT_HOME ?? join(base, 'kit')
}

/** Where the installed kit's updater is: inside the release `current` names. */
export function kitUpdateBin(env: Record<string, string | undefined>): string {
  return join(kitVendorDir(env), 'current', PLUGIN_DIR, 'bin', 'talos-update')
}
const PLUGIN_DIR = 'talos-kit'

/** Runs the kit updater with the owner's terminal as its own. Returns its exit code; never loads the rest of the CLI. */
function runKit(argv: string[], io: CliIO, env: Record<string, string | undefined>): number {
  const bin = kitUpdateBin(env)
  if (!existsSync(bin)) {
    io.err(`talos: no Talos kit release is installed here (looked for ${bin}). Run the kit's install.sh first.`)
    return 1
  }
  const r = spawnSync(bin, argv, { stdio: 'inherit', env: env as NodeJS.ProcessEnv })
  if (r.error) {
    io.err(`talos: could not run ${bin}: ${r.error.message}`)
    return 1
  }
  // A signal that ended it is 128 + the signal, like a shell reports; null status with no signal cannot happen after a spawn.
  return (
    r.status ??
    (r.signal
      ? 128 + (({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[r.signal] ?? 1)
      : 1)
  )
}

const USAGE = [
  'talos: a front door over talos-app. Every command below runs the same handler as `talos-app <command>`.',
  'Run `talos commands` for the list, or `talos commands --json` for the same list as data.',
]

/** Rows that exist under `talos` only: the list itself, and the kit's verbs (under `talos-app`, `update` and `rollback` are the `... app` rows). */
const TALOS_ONLY = new Set(['commands', ...KIT_NAMES])
/** How `talos-app` spells the app's own rows. */
const APP_SPELLING: Readonly<Record<string, string>> = { 'update app': 'update', 'rollback app': 'rollback' }

/** The text `talos-app` prints for help: one entry per COMMANDS row (name, args, then the summary), so it cannot drift from the list. */
export function usageText(version: string): string {
  const lines = [`talos-app ${version}`]
  for (const c of COMMANDS) {
    if (TALOS_ONLY.has(c.name)) continue
    lines.push(`  ${APP_SPELLING[c.name] ?? c.name}${c.args ? ` ${c.args}` : ''}  - ${c.summary}`)
  }
  return lines.join('\n')
}

async function cmdCommands(args: string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  if (values.json) {
    // loaded here, not at the top: `talos` answers rollback and restore even when the packages are broken
    const { BRIDGE_VERSION } = await import('./version.ts')
    // the rule of `commandWho` (packages/protocol), inlined so this works with the packages broken; a test keeps the two equal
    const who = (c: CommandInfo) => (c.needs_terminal ? 'owner_terminal' : c.agent_may_run ? 'agent' : 'owner')
    const commands = COMMANDS.map((c) => ({ ...c, who: who(c) }))
    io.out(
      JSON.stringify({ schema: 1, app_version: BRIDGE_VERSION, enforced: 'terminal', note: NOTE, commands }, null, 2),
    )
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
    if (cmd === 'commands') return await cmdCommands(rest, io)
    if (!COMMANDS.some((c) => c.name.split(' ')[0] === cmd)) {
      io.err(`talos: unknown command "${cmd}". Run \`talos commands\` for the list.`)
      return 2
    }
    // `doctor --json` is answered here, not by the CLI handler, so a thread session is refused here too
    const refusal = workerCliRefusal(argv, env, cliDeps.cwd)
    if (refusal) {
      io.err(refusal)
      return 1
    }
    if (cmd === 'doctor' && rest.includes('--json')) return await doctorJson(rest, io, env, cliDeps)
    if ((cmd === 'update' || cmd === 'rollback') && rest[0] === 'app') {
      return await run([cmd, ...rest.slice(1)], io, env, cliDeps)
    }
    if (isKitVerb(argv)) {
      // No terminal, no update: an agent's Bash tool has none. The updater checks again for itself (and refuses inside a Claude Code session).
      if (io.isTerminal === false) return notTerminal(cmd, io)
      return runKit(argv, io, env)
    }
    return await run(argv, io, env, cliDeps)
  } catch (e) {
    io.err(`talos: ${(e as Error).message}`)
    return 1
  }
}

function notTerminal(name: string, io: CliIO): number {
  io.err(
    `talos ${name} only runs in Terminal, typed by you. Open Terminal on your Mac and run it there; it will not run from an agent, a script or a pipe.`,
  )
  return 2
}

/** A terminal with no prompt: enough for the commands answered here, which never ask a question. */
function plainIO(): CliIO {
  return {
    isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    prompt: async () => '',
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  // before the early exits below, which never reach runTalos
  const refusal = workerCliRefusal(argv, process.env)
  if (refusal) {
    process.stderr.write(`${refusal}\n`)
    process.exit(1)
  }
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
  if (argv[0] === 'rollback' && argv[1] === 'app') {
    const r = await import('./rollback.ts')
    process.exit(await r.runRollback(argv.slice(2), r.rollbackIO()))
  }
  if (argv[0] === 'restore-last-good') {
    const l = await import('./last-good.ts')
    const r = await import('./rollback.ts')
    process.exit(await l.restoreLastGood(argv.slice(1), r.rollbackIO()))
  }
  // Everything else that needs the full CLI loads it here, once; `commands`, help, --version and an unknown name do not.
  const needsCli = argv[0] !== 'commands' && !isKitVerb(argv) && COMMANDS.some((c) => c.name.split(' ')[0] === argv[0])
  const io = needsCli ? (await import('./cli-main.ts')).terminalIO() : plainIO()
  process.exit(await runTalos(argv, io))
}
