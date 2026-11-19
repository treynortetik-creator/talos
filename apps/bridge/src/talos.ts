#!/usr/bin/env bun
// Later: a wrapper package should own the `.env` and home isolation (which `.env` is read, and which home folder is used
// when `talos` runs from another directory). Not done here; `talos` reads the environment exactly as `talos-app` does.
// `talos` entry: a thin front door over the `talos-app` CLI. Every command is handed to the same handler `talos-app` uses,
// with the same arguments, so the two never disagree. Only `commands` (the list below) and `doctor --json` are new here.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { CommandEffect, CommandRisk } from '@talos-app/protocol'
import type { CliDeps, CliIO } from './cli-main.ts'
import { say } from './owner-words.ts'
import { workerCliRefusal } from './worker/cli-refusal.ts'

export type CommandInfo = {
  /** One word, or `word subword` where the subcommand has its own rule. */
  name: string
  summary: string
  /**
   * `internal`: run by Talos itself (the supervisor, the Mac app, Claude Code's hook), never by a person; help says so and
   * nothing enforces it. Absent: a person may run it, or ask the agent to (owner ruling 2026-11-14). `needs_terminal` rows
   * are the owner's at a terminal.
   */
  who?: 'internal'
  /** Set by `ownerTerminal` only: the command refuses unless stdin and stdout are a terminal (`terminalOnly`). */
  needs_terminal?: true
  /** The usage after the name, e.g. `[--json] | revoke <id>`. `talos-app`'s usage text is made from this and `summary`. */
  args?: string
  /** What running it touches. Set only where it is known; absent means not stated, not "nothing". */
  effects?: readonly CommandEffect[]
  /** `ask` means behind an approval card. Set only where it is known. */
  risk?: CommandRisk
}

/** A command only the owner types in Terminal. The one place that sets `needs_terminal`. */
const ownerTerminal = (name: string, summary: string, args?: string): CommandInfo => ({
  name,
  summary,
  ...(args ? { args } : {}),
  needs_terminal: true,
})

/** `update`, `rollback` and `restore` mean the agent kit's updater under `talos`; under `talos-app`, `update` and `rollback` are the app's own (ask-gated, not terminal-only). */
const KIT_NAMES = new Set(['update', 'rollback', 'restore'])

/** The terminal-only command that `argv` runs (`devices revoke x` is `devices`), or undefined. `prog` is the program it was typed to. */
export function terminalOnly(argv: readonly string[], prog: 'talos' | 'talos-app' = 'talos-app'): string | undefined {
  const [a, b] = argv
  // --remove anywhere in its arguments: turning the guards off is the owner's
  if (a === 'install-guards' && argv.includes('--remove')) return 'install-guards --remove'
  if (prog === 'talos' && (a === 'update' || a === 'rollback') && b === 'app') return undefined // the app's own
  return COMMANDS.find(
    (c) => c.needs_terminal && (prog === 'talos' || !KIT_NAMES.has(c.name)) && (c.name === a || c.name === `${a} ${b}`),
  )?.name
}

/**
 * Commands only the Talos app runs, never a session: `guards refresh` (the Mac app, before each start of Main). Not terminal-only
 * (the app has no terminal), so they are kept from a session by the guards instead: the hook and a deny rule (guards/rules.ts).
 * The name of the one `argv` runs, or undefined.
 */
export function appOnly(argv: readonly string[]): string | undefined {
  return argv[0] === 'guards' ? 'guards refresh' : undefined
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
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'events',
    args: '[--json]',
    summary: 'List the named events a hook can react to, with who emits each and the fields it carries',
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'status',
    args: '[--json]',
    summary: 'Show relay reachability, bridge liveness, key id and queue depth',
  },
  {
    name: 'doctor',
    args: '[--agent-dir <dir>] [--no-kit] [--deep]',
    summary: say({
      mac: 'Check this Mac setup; --json returns the checks as rows',
      linux: 'Check this computer setup; --json returns the checks as rows',
    }),
  },
  {
    name: 'logs',
    args: '[-n <lines>] [-f]',
    summary: 'Show the bridge log (-n lines, -f to follow)',
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'report',
    args: '[--agent-dir <dir>] [--lines <n>] [--out <file>]',
    summary: 'Write a redacted report for a bug report (--out writes any path)',
  },
  {
    name: 'errors',
    args: 'list [--closed|--all] | show <id> | close <id> | requeue-bug-report <report id>',
    summary: 'List, show and close error reports; send one bug report from your own device again',
  },
  { name: 'search reindex', summary: 'Rebuild the search index' },
  {
    name: 'schedules',
    args: '[adopt | notify <message>]',
    summary: 'Show schedules; adopting one is a separate, owner-only subcommand',
  },
  {
    name: 'schedules adopt',
    summary: say({
      mac: 'Approve the schedules found on this Mac',
      linux: 'Approve the schedules found on this computer',
    }),
  },
  {
    name: 'codex',
    args: 'check | run --thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- <prompt>',
    summary: 'Check or run the Codex CLI; the agent may run both subcommands',
  },
  { name: 'codex check', summary: 'Check whether the Codex CLI is installed and logged in' },
  {
    name: 'codex run',
    args: '--thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- <prompt>',
    summary: 'Run Codex on a task in a thread',
  },
  { name: 'digest', args: '[--since <ISO>]', summary: 'Print the relay digest since a time' },
  { name: 'post', args: '<thread> <text>', summary: 'Send a headless reply into a thread' },
  {
    name: 'hook',
    who: 'internal',
    summary: 'Claude Code hook entry for MCP apps (called by Claude Code, not by hand)',
  },
  {
    name: 'subagent-tee',
    args: '[-- <your own subagentStatusLine command...>]',
    summary: 'Status-line helper Claude Code calls for subagent rows',
  },
  {
    name: 'memory',
    args: 'init [--agent-dir <dir>] | set-root <name> <path> | on | off | show | reindex',
    summary: 'Show the memory browser or rebuild its index; the subcommands below set it up',
  },
  {
    name: 'memory init',
    args: '[--agent-dir <dir>]',
    summary:
      'Set up the memory folder for an agent (the agent: only when the owner asked, and his settings are not locked)',
  },
  {
    name: 'memory set-root',
    args: '<name> <path> [--agent-dir <dir>]',
    summary:
      'Share one memory folder: creates memory.json with only it, or adds/updates that root (the agent: only when the owner asked, and his settings are not locked)',
  },
  { name: 'memory on', summary: 'Turn the memory browser on' },
  { name: 'memory off', summary: 'Turn the memory browser off' },
  {
    name: 'memory show',
    summary: 'Show whether the memory browser is on and what it covers',
    effects: ['read'],
    risk: 'low',
  },
  { name: 'memory reindex', summary: 'Rebuild the memory index' },
  {
    name: 'apps',
    args: 'scan [--check] [--agent-dir <dir>] [--exclude-plugin <name>] | list | revoke <server|key-prefix> | login <server> | logout <server> | strict on|off',
    summary: 'Manage MCP apps; the subcommands below say which the agent may run',
  },
  { name: 'apps list', summary: 'List the MCP apps found', effects: ['read'], risk: 'low' },
  // no longer terminal-only (owner ruling 2026-11-14: what a person could ask the agent to do, it may)
  {
    name: 'apps scan',
    summary: 'Scan installed plugins for MCP apps',
    args: '[--check] [--agent-dir <dir>] [--exclude-plugin <name>]',
  },
  { name: 'apps strict', args: 'on|off', summary: 'Turn strict mode for MCP apps on or off' },
  { name: 'apps revoke', args: '<server|key-prefix>', summary: 'Revoke an MCP app approval' },
  { name: 'apps login', args: '<server>', summary: 'Sign in to an MCP app' },
  { name: 'apps logout', args: '<server>', summary: 'Sign out of an MCP app' },
  {
    name: 'share',
    args: 'revoke <id> | shortcut [--label <label>] [--files] [--device <id>]',
    summary: 'Share links; the subcommands below are owner only',
  },
  { name: 'share revoke', args: '<id>', summary: 'Revoke a share link' },
  {
    name: 'share shortcut',
    args: '[--label <label>] [--files] [--device <id>]',
    summary: 'Build and sign the share shortcut',
  },
  {
    name: 'init',
    args: '--relay-url <url> [--config default|five-threads]',
    summary: 'Create the home folder, bridge key and config',
  },
  ownerTerminal('enroll', 'Approve a new phone or browser', '[--label <name>] [--no-qr] [--confirm] [--json]'),
  ownerTerminal('devices', 'List approved devices or revoke one', '[revoke <id>]'),
  ownerTerminal('rotate', 'Replace the bridge key'),
  ownerTerminal(
    'peer',
    'Link this Talos to another of yours: create, add, list, remove or rotate a peer',
    'create <name> | add <name> --url <https url> | list | remove <name> | rotate <name>',
  ),
  {
    name: 'start',
    who: 'internal',
    args: '[--agent-dir <dir>] [--no-kit] [--dry-run] [-- <claude flags>]',
    summary: 'Start the agent (launches Claude Code)',
  },
  // `update`, `rollback` and `restore` act on the agent kit (the Talos zone of the agent folder) and run kit/bin/talos-update,
  // which holds the lock, checks the signature and does the work; they are owner terminal commands (a speed bump for an agent, not a lock). The app checkout's own pull and
  // rollback are `talos-app update` / `talos-app rollback` (also spelled `talos update app` / `talos rollback app` at the hook): ask-gated, not
  // terminal-only, so the documented phone recovery (`talos-app rollback --yes` behind a card) keeps working. The deny pattern
  // `talos rollback:*` is a prefix match and also covers `talos rollback app`, so only the `talos-app` spelling is a phone path.
  {
    name: 'update',
    summary: 'Update the agent kit to the newest signed release (--dry-run shows what would change first)',
  },
  {
    name: 'update app',
    summary: 'Pull the latest app code and install packages (this checkout, not the agent kit)',
  },
  { name: 'rollback', summary: 'Put the previous agent kit release back (a version after it names one)' },
  {
    name: 'rollback app',
    args: '[--dry-run] [--yes] [--skip-data-check]',
    summary: 'Go back to the previous recorded app version (this checkout, not the agent kit)',
  },
  {
    name: 'restore',
    summary: 'Put one file back: a Talos file from the release, settings from last-good, your own from git',
  },
  {
    name: 'restore-last-good',
    args: '[--list] [--version <n>] [--file <name>] [--newest-start] [--agent-dir <dir>] [--yes]',
    summary: 'Put back the last-good .mcp.json and .claude settings',
  },
  {
    name: 'trust',
    args: 'on|off|show',
    summary: 'Turn trust mode off, or show it; turning it on is a separate, owner-only subcommand',
  },
  {
    name: 'theme',
    args: 'reset|show',
    summary: 'Show the app theme, or reset it to the default',
  },
  {
    name: 'theme reset',
    summary:
      'Reset the app theme to the default (the agent: only when the owner asked, and his settings are not locked)',
  },
  ownerTerminal('trust on', 'Turn trust mode on (fewer cards)'),
  {
    name: 'lead',
    args: 'init <thread-id> --folder <dir> --agent-dir <dir> [--mcp <names>] [--sandbox | --light] | check <folder> [--agent-dir <dir>]',
    summary: 'Set up or check the folder of a thread lead',
  },
  {
    name: 'lead init',
    args: '<thread-id> --folder <dir> --agent-dir <dir> [--mcp <names>] [--sandbox | --light]',
    summary:
      "Make a thread lead's folder (brief, board, privacy fence) and point the thread at it (the agent: only when the owner asked, in that thread or the default one, and his settings are not locked)",
  },
  {
    name: 'lead check',
    args: '<folder> [--agent-dir <dir>]',
    summary: "Check a lead folder's brief, board sizes and privacy fence",
  },
  {
    name: 'install-mcp',
    args: '--agent-dir <dir> [--dry-run]',
    summary: 'Add the Talos server to an agent folder .mcp.json',
  },
  // no longer terminal-only (owner ruling 2026-11-14: what a person could ask the agent to do, it may)
  {
    name: 'adopt',
    summary: 'Connect a Claude Code folder you already use (.mcp.json and app hooks only)',
    args: '--agent-dir <dir> [--dry-run] [--yes] [--repoint]',
  },
  { name: 'install-app-hooks', summary: 'Install the MCP apps hooks' },
  // no longer terminal-only (owner ruling 2026-11-14: what a person could ask the agent to do, it may)
  {
    name: 'install-ask-rules',
    summary: 'Add the standard permissions.ask rules',
    args: '--agent-dir <dir> [--scope project|user] [--dry-run]',
  },
  // no longer terminal-only (owner ruling 2026-11-14: what a person could ask the agent to do, it may)
  {
    name: 'install-guards',
    summary: 'Install (or --remove) the guard hook and deny rules that protect the never-change list',
    args: '[--remove]',
  },
  // turning the guards OFF stays the owner's, at a terminal (Pantheon 2026-11-14, as with settings_lock: an agent may turn a lock
  // on when asked, never off); `install-guards` itself is the agent's
  ownerTerminal('install-guards --remove', 'Remove the guard hook and deny rules (owner only, in a terminal)'),
  {
    name: 'guards refresh',
    who: 'internal',
    summary:
      'Rebuild the installed guards from this version, pinned to this bun and checkout (the Mac app runs it at each start of Main; it never installs or removes them)',
  },
  {
    name: 'supervise',
    who: 'internal',
    args: '[status | unit | start | stop]',
    summary: 'Linux: run the supervisor that keeps your agent running (what the systemd user unit runs)',
  },
  // the owner's Stop and Start of Main: never from a session, which runs with no terminal (a session that ran `start --anyway`
  // would undo the owner's Stop and start Main past every restart check; Fable R1-1 on the guard entries)
  {
    name: 'supervise start',
    summary: 'Linux: start Main again after your Stop (--anyway: past another session holding the channels, once)',
  },
  { name: 'supervise stop', summary: 'Linux: stop Main; it stays stopped, across restarts, until you start it' },
  {
    name: 'update-check',
    args: '[--dry]',
    summary:
      'Linux: say, without changing anything, which running thread sessions an update would restart (thread ids and states only)',
    // the owner's look: a session has no use for it, and it must never be a way for one to probe the Talos home
    effects: ['read'],
    risk: 'low',
  },
  {
    name: 'install-subagent-tee',
    args: '--agent-dir <dir> [--scope project|user] [--dry-run]',
    summary: 'Install the subagent status line',
  },
]

const NOTE =
  'commands that need a terminal refuse when stdin or stdout is not one; "internal" ones are run by Talos itself (nothing enforces that); the agent may run the rest when the owner asks. agent_may_run is who = agent, kept for older readers.'

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

/**
 * Why the kit folder may not be chosen here, or undefined. Since the agent may run `talos update|rollback|restore` (2026-11-14),
 * the folder the trusted signers and releases are read from must be the installed one unless the owner is at a real terminal
 * (not inside Claude Code): `--vendor`, TALOS_KIT_HOME, TALOS_VENDOR_DIR or a moved XDG_DATA_HOME would let a caller bring its
 * own signer and its own updater (Fable R1-1). The kit updater checks the same (_update_common.py vendor_choice_check).
 */
export function kitVendorChoiceRefusal(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  ownerTerminal: boolean,
  home: string | null = accountHome(),
): string | undefined {
  if (ownerTerminal) return undefined
  if (home === null)
    return `talos: the account's home folder can't be read, so the installed kit can't be told apart from another; run it in a terminal.`
  // the home is the account's own (the passwd entry), never $HOME: a session that set HOME would otherwise choose the folder
  // the kit, and so its trusted signers, are read from (Fable/Lemnos review of the relabel)
  const moved = [
    ...(argv.some((a) => a === '--vendor' || a.startsWith('--vendor=')) ? ['--vendor'] : []),
    ...(env.HOME && resolve(env.HOME) !== resolve(home) ? ['HOME'] : []),
    ...(['TALOS_KIT_HOME', 'TALOS_VENDOR_DIR'] as const).filter((k) => env[k]),
    ...(env.XDG_DATA_HOME && resolve(env.XDG_DATA_HOME) !== resolve(home, '.local', 'share') ? ['XDG_DATA_HOME'] : []),
  ]
  return moved.length
    ? `talos: choosing which kit folder to use (${moved.join(', ')}) needs the owner at a terminal; the agent updates only the installed kit.`
    : undefined
}

/**
 * The account's home from the passwd entry, which a session cannot change by setting HOME. `ACCOUNT_HOME_TEST` is a seam for
 * tests in this process only (like OWNER_HOST_TEST); the agent runs `talos` as its own process, where it is never set.
 */
export const ACCOUNT_HOME_TEST: { home: string | null } = { home: null }

/**
 * The account's home from the password database, read so that $HOME cannot change it: under Bun, os.userInfo().homedir and
 * os.homedir() follow $HOME (Fable on 2beef7b0, confirmed by a run). Linux: this uid's line in /etc/passwd, else
 * `/usr/bin/getent passwd <uid>` (an LDAP or sssd account); macOS: `/usr/bin/id -P`. Absolute paths and an empty environment, so
 * a program planted on PATH cannot answer. Null when it can't be read: the caller then refuses (fails closed).
 */
export function passwdHome(): string | null {
  const uid = process.getuid?.()
  if (uid === undefined) return null
  const field = (line: string | undefined, i: number): string | null => {
    const f = (line ?? '').trim().split(':')
    return f[i] ? (f[i] as string) : null
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/bin/id', ['-P'], { encoding: 'utf8', env: {} })
    return r.status === 0 ? field(r.stdout, 8) : null
  }
  try {
    for (const line of readFileSync('/etc/passwd', 'utf8').split('\n'))
      if (line.split(':')[2] === String(uid)) return field(line, 5)
  } catch {
    // no readable /etc/passwd: ask the name service
  }
  const r = spawnSync('/usr/bin/getent', ['passwd', String(uid)], { encoding: 'utf8', env: {} })
  return r.status === 0 ? field(r.stdout, 5) : null
}
export const accountHome = (): string | null => ACCOUNT_HOME_TEST.home ?? passwdHome()

/** Runs the kit updater with the owner's terminal as its own. Returns its exit code; never loads the rest of the CLI. */
function runKit(argv: string[], io: CliIO, env: Record<string, string | undefined>): number {
  const no = kitVendorChoiceRefusal(argv, env, io.isTerminal !== false && !env.CLAUDECODE)
  if (no) {
    io.err(no)
    return 2
  }
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
    const who = (c: CommandInfo) => (c.needs_terminal ? 'owner_terminal' : c.who === 'internal' ? 'internal' : 'agent')
    // agent_may_run where it always stood (after the summary), for readers of schema 1
    const commands = COMMANDS.map(({ name, summary, ...rest }) => {
      const w = who({ name, summary, ...rest })
      return { name, summary, agent_may_run: w === 'agent', ...rest, who: w }
    })
    io.out(
      JSON.stringify({ schema: 1, app_version: BRIDGE_VERSION, enforced: 'terminal', note: NOTE, commands }, null, 2),
    )
    return 0
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  for (const c of COMMANDS)
    io.out(
      `${c.name.padEnd(width)}  ${(c.needs_terminal ? 'terminal' : c.who === 'internal' ? 'Talos only' : 'agent ok').padEnd(10)}  ${c.summary}`,
    )
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
      'no-kit': { type: 'boolean' },
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
      ...(values['no-kit'] ? { noKit: true } : {}),
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
      // open to the agent since 2026-11-14 (signed releases only); runKit keeps the kit folder the installed one off a terminal
      return runKit(argv, io, env)
    }
    return await run(argv, io, env, cliDeps)
  } catch (e) {
    io.err(`talos: ${(e as Error).message}`)
    return 1
  }
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
