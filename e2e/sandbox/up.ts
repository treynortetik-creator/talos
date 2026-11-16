// `sandbox up`, `down` and `status`: one isolated Talos beside the owner's own.
//
// What a sandbox is made of, all of it under its own root and none of it the owner's:
//   - the real relay (the built bundle) on 127.0.0.1 and a free port, with its own database and keys;
//   - its own Talos home (`talos-app init`), agent folder and `.mcp.json`;
//   - the real supervisor (`talos-app supervise`) on its own tmux server, running Main: the fake `claude` of
//     fake-claude.ts, or the real one with channel plugins, claude.ai connectors and the owner's user settings switched off;
//   - a phone: a device key enrolled through the setup-code sign-in a native shell uses (no passkey), confirmed at the
//     `talos-app enroll` prompt as the owner would.
// `down` signals only what `up` recorded (pid and start time, the tmux server on the sandbox's own socket) and removes the
// root. Nothing here reads or writes the owner's Talos home, their `tmux -L talos` server or a relay on the internet.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_CHANNEL_SCREEN } from '@talos-app/protocol'
import { classify, liveDevChannels, liveDialog } from '../../apps/bridge/src/supervisor/screen.ts'
import { BRIDGE_CLI, BRIDGE_DIR, RELAY_DIST, ROOT } from '../harness/paths.ts'
import { freePort } from '../harness/stack.ts'
import { enrollPhone } from './phone.ts'
import {
  cleanEnv,
  files,
  groupAlive,
  isAlive,
  loadRecord,
  newId,
  type PhoneRecord,
  type Proc,
  procOf,
  readJson,
  rootOf,
  SandboxError,
  type SandboxRecord,
  saveRecord,
  signalGroup,
  sleep,
  socketOf,
  stopProc,
  waitUntil,
  writeJson,
} from './state.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RELAY_MAIN = join(HERE, 'relay-main.ts')
const FAKE_CLAUDE = join(HERE, 'fake-claude.ts')
/** The repo's TypeScript (constructor parameter properties, in the protocol and the testkit) needs more than type stripping. */
export const NODE_TS = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
/** Main's tmux session, the supervisor's own name for it. */
const MAIN_SESSION = 'agent'
/**
 * The name the real `claude` knows the sandbox's bridge by. Not `talos-app` on purpose: the Mac app refuses to start or
 * restart the owner's own Main while any other Claude session runs with the channel `server:talos-app`, and a sandbox
 * holds nothing of the owner's (its relay, home and bridge are its own), so it must not look like that session.
 */
const REAL_SERVER = 'talos-sandbox'
const REAL_PROMPT = `You are the agent behind a test copy of the Talos app. The owner reads only the Talos app, never this terminal. Every message that arrives from the ${REAL_SERVER} channel must be answered by calling that server's reply tool with the thread_id from the message; text you write here is seen by nobody. Keep replies short. Do not read or change anything outside this folder.`
/** The two channel plugins a sandbox session must never load (a second poller takes the owner's bot offline). */
const CHANNEL_PLUGINS = ['telegram@claude-plugins-official', 'imessage@claude-plugins-official']

export type UpOptions = {
  mode: 'fake' | 'real'
  model: string
  build: boolean
  keepOnFail: boolean
  /** Answer the development-channels warning after every restart too, not only at `up` (SandboxRecord.auto_dev_channels). */
  autoDevChannels?: boolean
}

function which(name: string, env: Record<string, string>): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const p = join(dir, name)
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK)
        return p
      }
    } catch {
      // not here
    }
  }
  return null
}

function need(name: string, env: Record<string, string>): string {
  const p = which(name, env)
  if (!p) throw new SandboxError('missing_tool', `${name} was not found on PATH (the sandbox needs node, bun and tmux)`)
  return p
}

const cli = (home: string, args: string[], env: Record<string, string>) =>
  spawnSync('bun', ['run', BRIDGE_CLI, ...args], {
    cwd: BRIDGE_DIR,
    env: { ...env, TALOS_APP_HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  })

export const tmux = (rec: Pick<SandboxRecord, 'tmux'>, args: string[]) =>
  spawnSync(rec.tmux.bin, ['-L', rec.tmux.socket, ...args], { encoding: 'utf8', timeout: 10_000, env: cleanEnv() })

/** The rows of Main's pane as the supervisor reads them, or null when there is no pane. */
export function screen(rec: SandboxRecord, scrollback = 0): string[] | null {
  const r = tmux(rec, [
    'capture-pane',
    '-p',
    '-J',
    ...(scrollback > 0 ? ['-S', `-${scrollback}`] : []),
    '-t',
    `=${MAIN_SESSION}:`,
  ])
  return r.status === 0 ? r.stdout.replace(/\n+$/, '').split('\n') : null
}

function startDetached(cmd: string, args: string[], env: Record<string, string>, logPath: string, cwd: string): Proc {
  const fd = openSync(logPath, 'a', 0o600)
  try {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    const proc = procOf(child.pid)
    if (!proc) throw new SandboxError('start_failed', `${basename(cmd)} did not start (see ${logPath})`)
    return proc
  } finally {
    closeSync(fd)
  }
}

export function startRelay(rec: SandboxRecord): Proc {
  const f = files(rec.root)
  return startDetached(process.execPath, [...NODE_TS, RELAY_MAIN, rec.root], cleanEnv(), f.relayLog, ROOT)
}

export async function relayHealthy(rec: SandboxRecord): Promise<boolean> {
  try {
    const r = await fetch(`${rec.relay.origin}/healthz`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

function supervisorEnv(rec: SandboxRecord): Record<string, string> {
  const f = files(rec.root)
  return {
    ...cleanEnv(),
    TALOS_APP_HOME: rec.home,
    TALOS_SUPERVISOR_TMUX_SOCKET: rec.tmux.socket,
    // The login shell a session's environment is read from. With the fake, HOME is the sandbox's own (no profile of the
    // owner's is read) and a real shell lets thread sessions start (their environment is the login shell's). With the real
    // claude, HOME is the owner's: no login shell, so Main's environment is only this one, never what their profile exports.
    SHELL: rec.mode === 'fake' ? '/bin/sh' : '/usr/bin/false',
    // A fake session needs nothing of the owner's; the real `claude` needs their sign-in, which lives under their home.
    ...(rec.mode === 'fake' ? { HOME: f.userHome } : {}),
  }
}

export function startSupervisor(rec: SandboxRecord): Proc {
  return startDetached(
    'bun',
    ['run', BRIDGE_CLI, 'supervise'],
    supervisorEnv(rec),
    files(rec.root).supervisorOut,
    BRIDGE_DIR,
  )
}

type SupervisorStatus = {
  phase?: string
  stopReason?: string
  panePid?: number | null
  sessionId?: string | null
  restarts?: string[]
  needsYou?: { kind: string }
  bridgeLive?: boolean
  supervisor?: { pid: number; updated: string }
}

export const supervisorStatus = (rec: SandboxRecord): SupervisorStatus | null =>
  readJson<SupervisorStatus>(join(rec.home, 'supervisor-status.json'))

type BridgeStatus = { pid?: number; mode?: string; relay?: { connected?: boolean }; updated_at?: string }

export const bridgeStatus = (rec: SandboxRecord): BridgeStatus | null =>
  readJson<BridgeStatus>(join(rec.home, 'status.json'))

/**
 * Main is up: the supervisor says running, this start's bridge is live, and it holds its relay socket; and the processes
 * those files name are alive. The files outlive a crash, so on their own they kept calling a dead Main healthy.
 */
export function mainReady(rec: SandboxRecord): boolean {
  const s = supervisorStatus(rec)
  const b = bridgeStatus(rec)
  return (
    s?.phase === 'running' &&
    s.bridgeLive === true &&
    b?.mode === 'live' &&
    b.relay?.connected === true &&
    typeof s.panePid === 'number' &&
    groupAlive(s.panePid) &&
    procOf(b.pid) !== null
  )
}

/**
 * Answers the two start-up dialogs a sandbox's own `claude` shows, and nothing else: "trust this folder" (the folder is
 * the sandbox's, made a moment ago) and the development-channels warning, only when the row under the cursor is the
 * "local development" one. Any other dialog is left on screen for `drive <id> screen` / `drive <id> keys`.
 */
export function answerStartDialog(rec: SandboxRecord): 'trust' | 'dev_channels' | null {
  const rows = screen(rec)
  if (!rows) return null
  const enter = () => tmux(rec, ['send-keys', '-t', `=${MAIN_SESSION}:`, 'Enter'])
  if (liveDevChannels(rows)) {
    const s = classify(rows.slice(-DEV_CHANNEL_SCREEN.titleWithinRows))
    if (s.kind === 'dev_channels' && s.dev.highlighted === DEV_CHANNEL_SCREEN.confirmRow) {
      enter()
      return 'dev_channels'
    }
    return null
  }
  if (liveDialog(rows).kind === 'trust') {
    // Enter confirms the row under the cursor, and for a folder under /tmp that row starts out as "No, exit": move down
    // until the cursor is on the trusting answer, and only then confirm.
    const cursor = rows.map((r) => r.trim()).find((r) => r.startsWith(DEV_CHANNEL_SCREEN.cursor)) ?? ''
    if (/^❯\s*(\d+\.\s*)?Yes, I trust/.test(cursor)) {
      enter()
      return 'trust'
    }
    tmux(rec, ['send-keys', '-t', `=${MAIN_SESSION}:`, 'Down'])
  }
  return null
}

function writeAgentFolder(rec: SandboxRecord, env: Record<string, string>): void {
  const f = files(rec.root)
  writeFileSync(
    join(rec.agent_dir, 'CLAUDE.md'),
    [
      '# Talos sandbox agent',
      '',
      'This folder belongs to a throwaway Talos sandbox. You are the agent behind a test copy of the Talos app.',
      'Answer every message with the `reply` tool of the Talos server, in the thread it came from, in one short',
      'sentence. Do not read or change anything outside this folder.',
      '',
    ].join('\n'),
  )
  const r = cli(rec.home, ['install-mcp', '--agent-dir', rec.agent_dir], env)
  if (r.status !== 0)
    throw new SandboxError('install_mcp_failed', `talos-app install-mcp failed: ${r.stdout}${r.stderr}`)
  // The bridge runs with the sandbox's own home folder: whatever it looks up under `~` is the sandbox's, never the owner's.
  const path = join(rec.agent_dir, '.mcp.json')
  const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> }
  const entry = cfg.mcpServers['talos-app']
  if (!entry) throw new SandboxError('install_mcp_failed', `${path} has no talos-app server`)
  entry.env = { ...entry.env, HOME: f.userHome, TALOS_INBOX_ROOT: f.inbox }
  if (rec.mode === 'real') {
    delete cfg.mcpServers['talos-app']
    cfg.mcpServers[REAL_SERVER] = entry
  }
  writeJson(path, cfg)
}

function writeSupervisorConfig(rec: SandboxRecord, env: Record<string, string>): void {
  const f = files(rec.root)
  const noChannel = join(rec.home, 'workers', '_nochannel')
  mkdirSync(noChannel, { recursive: true, mode: 0o700 })
  const common = {
    TALOS_SANDBOX_ROOT: rec.root,
    // a channel plugin that starts anyway finds no token in these and exits before it touches anything
    TELEGRAM_STATE_DIR: noChannel,
    IMESSAGE_STATE_DIR: noChannel,
    ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    DISABLE_AUTOUPDATER: '1',
  }
  if (rec.mode === 'fake') {
    writeJson(join(rec.home, 'supervisor.json'), {
      agent_dir: rec.agent_dir,
      claude_path: rec.claude_path,
      // no development-channels flag: the supervisor would wait for a warning the fake never shows
      args: ['--model', rec.model],
      env: {
        ...common,
        SHELL: '/bin/sh',
        HOME: f.userHome,
        CLAUDE_CONFIG_DIR: join(f.userHome, '.claude'),
        // a thread session's fake starts its real bridge and answers its pointer (Main's fake, no thread, ignores this)
        TALOS_SANDBOX_FAKE_MODE: 'worker-hello',
      },
    })
    return
  }
  const settings = join(rec.root, 'claude-settings.json')
  writeJson(settings, {
    enabledPlugins: Object.fromEntries(CHANNEL_PLUGINS.map((p) => [p, false])),
    disableClaudeAiConnectors: true,
    disableAllHooks: true,
    deniedMcpServers: [{ serverName: 'claude-in-chrome' }, { serverName: 'computer-use' }],
    // the agent answers through the bridge's own tools without a prompt; everything else still asks (as a card)
    permissions: { allow: [`mcp__${REAL_SERVER}`], defaultMode: 'default' },
  })
  writeJson(join(rec.home, 'supervisor.json'), {
    agent_dir: rec.agent_dir,
    claude_path: rec.claude_path,
    args: [
      '--dangerously-load-development-channels',
      `server:${REAL_SERVER}`,
      '--model',
      rec.model,
      // only the sandbox's bridge: no user, project or plugin MCP server, no browser
      '--strict-mcp-config',
      '--mcp-config',
      join(rec.agent_dir, '.mcp.json'),
      '--no-chrome',
      // the owner's user settings (their hooks, plugins, env) are not read at all
      '--setting-sources',
      'project',
      '--settings',
      settings,
      // The agent folder's CLAUDE.md is switched off with the owner's (one switch covers both), so the one rule an agent
      // behind Talos must know rides here: without it a small model answers in its own terminal, where no owner looks.
      '--append-system-prompt',
      REAL_PROMPT,
    ],
    env: {
      ...common,
      SHELL: env.SHELL && isAbsolute(env.SHELL) ? env.SHELL : '/bin/sh',
      // none of the owner's CLAUDE.md or memory files reach the sandbox's model
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  })
}

export async function up(opts: UpOptions, note: (line: string) => void = () => {}): Promise<Record<string, unknown>> {
  const env = cleanEnv()
  const node = process.execPath
  need('bun', env)
  const tmuxBin = need('tmux', env)
  if (opts.build || !existsSync(RELAY_DIST)) {
    note('building the relay bundle')
    const b = spawnSync('pnpm', ['--filter', '@talos-app/relay', 'build'], { cwd: ROOT, env, encoding: 'utf8' })
    if (b.status !== 0)
      throw new SandboxError('build_failed', `the relay build failed: ${b.stdout}${b.stderr}`.slice(-2000))
  }
  let id = newId()
  while (existsSync(rootOf(id))) id = newId()
  const root = rootOf(id)
  const f = files(root)
  mkdirSync(root, { mode: 0o700 })
  for (const d of [f.home, f.agent, f.userHome, f.inbox, f.relayData, f.bin]) mkdirSync(d, { mode: 0o700 })
  const port = await freePort()
  const origin = `http://localhost:${port}`

  let claudePath: string
  if (opts.mode === 'fake') {
    claudePath = join(f.bin, 'claude')
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
    writeFileSync(claudePath, `#!/bin/sh\nexec ${q(node)} ${NODE_TS.join(' ')} ${q(FAKE_CLAUDE)} "$@"\n`)
    chmodSync(claudePath, 0o755)
  } else {
    claudePath = need('claude', env)
  }
  const rec: SandboxRecord = {
    v: 1,
    id,
    root,
    created_at: new Date().toISOString(),
    mode: opts.mode,
    model: opts.model,
    ...(opts.autoDevChannels ? { auto_dev_channels: true } : {}),
    relay: { port, origin, proc: null },
    supervisor: { proc: null },
    tmux: { bin: tmuxBin, socket: socketOf(id) },
    home: f.home,
    agent_dir: f.agent,
    claude_path: claudePath,
  }
  saveRecord(rec)
  try {
    // The Mac side: key, config and bridge.env.
    const init = cli(rec.home, ['init', '--relay-url', origin], env)
    const pubkey = /BRIDGE_PUBKEY=([A-Za-z0-9_-]{43})/.exec(init.stdout)?.[1]
    if (init.status !== 0 || !pubkey)
      throw new SandboxError('init_failed', `talos-app init failed: ${init.stdout}${init.stderr}`)
    // Nothing of the owner's scheduler or speech tools, and no model call to explain a permission card.
    const envFile = join(rec.home, 'bridge.env')
    writeFileSync(
      envFile,
      `${readFileSync(envFile, 'utf8').replace(/\n*$/, '\n')}${[
        'TALOS_APP_SCHEDULER=off',
        'TALOS_APP_CHRONOS_AUTODISCOVER=off',
        'TALOS_EXPLAINER=off',
        `TALOS_INBOX_ROOT=${f.inbox}`,
      ].join('\n')}\n`,
      { mode: 0o600 },
    )
    writeAgentFolder(rec, env)
    writeSupervisorConfig(rec, env)

    writeJson(f.relayEnv, {
      port,
      env: {
        NODE_ENV: 'development',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        RP_ID: 'localhost',
        DATA_DIR: f.relayData,
        DATA_KEY: randomBytes(32).toString('base64'),
        BRIDGE_PUBKEY: pubkey,
        TRUST_PROXY_HOPS: '0',
        LOG_LEVEL: 'info',
      },
    })
    note(`starting the relay on ${origin}`)
    rec.relay.proc = startRelay(rec)
    saveRecord(rec)
    await waitUntil(
      async () => {
        if (!isAlive(rec.relay.proc))
          throw new SandboxError('relay_died', `the relay exited at once: ${tail(f.relayLog)}`)
        return relayHealthy(rec)
      },
      'the relay to answer /healthz',
      30_000,
    )

    note(`starting the supervisor (tmux -L ${rec.tmux.socket})`)
    rec.supervisor.proc = startSupervisor(rec)
    saveRecord(rec)
    const answered: string[] = []
    await waitUntil(
      () => {
        if (!isAlive(rec.supervisor.proc))
          throw new SandboxError('supervisor_died', `the supervisor exited: ${tail(f.supervisorOut)}`)
        const s = supervisorStatus(rec)
        if (s?.phase === 'stopped')
          throw new SandboxError(
            'main_stopped',
            `Main stopped at start (${s.stopReason ?? 'no reason'}): ${tail(join(rec.home, 'supervisor.log'))}`,
          )
        if (rec.mode === 'real') {
          const a = answerStartDialog(rec)
          if (a) {
            answered.push(a)
            note(`answered Claude Code's ${a === 'trust' ? 'folder trust' : 'development channels'} dialog`)
          }
        }
        return mainReady(rec)
      },
      `Main to be running with a live bridge (screen: ${JSON.stringify((screen(rec) ?? []).slice(-12))})`,
      rec.mode === 'real' ? 180_000 : 60_000,
      500,
    ).catch((e) => {
      // the screen at the moment it gave up, not at the moment the wait began
      if (e instanceof SandboxError && e.code === 'timeout')
        throw new SandboxError(
          'main_not_ready',
          `Main did not come up: supervisor ${JSON.stringify(supervisorStatus(rec))}, bridge ${JSON.stringify(bridgeStatus(rec))}, screen ${JSON.stringify((screen(rec) ?? []).slice(-15))}`,
        )
      throw e
    })

    note('enrolling the phone')
    await enrollPhone(rec)
    return { ...(await status(rec.id)), answered_dialogs: answered }
  } catch (e) {
    if (!opts.keepOnFail) await down(id).catch(() => {})
    throw e
  }
}

function tail(path: string, chars = 1500): string {
  try {
    return readFileSync(path, 'utf8').slice(-chars).trim() || '(empty)'
  } catch {
    return '(no log)'
  }
}

/** Every pane process on the sandbox's own tmux server (Main, and any thread session). */
function panePids(rec: SandboxRecord): number[] {
  const r = tmux(rec, ['list-panes', '-a', '-F', '#{pane_pid}'])
  if (r.status !== 0) return []
  return r.stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 1)
}

export async function status(id: string): Promise<Record<string, unknown>> {
  const rec = loadRecord(id)
  const f = files(rec.root)
  const sup = supervisorStatus(rec)
  const bridge = bridgeStatus(rec)
  const phone = readJson<PhoneRecord>(f.phone)
  const pane = sup?.panePid ?? null
  return {
    id: rec.id,
    root: rec.root,
    mode: rec.mode,
    model: rec.model,
    created_at: rec.created_at,
    relay: {
      origin: rec.relay.origin,
      pid: rec.relay.proc?.pid ?? null,
      alive: isAlive(rec.relay.proc),
      healthy: await relayHealthy(rec),
      log: f.relayLog,
    },
    supervisor: {
      pid: rec.supervisor.proc?.pid ?? null,
      alive: isAlive(rec.supervisor.proc),
      status: sup,
      log: join(rec.home, 'supervisor.log'),
    },
    main: { pane_pid: pane, alive: pane !== null && groupAlive(pane), ready: mainReady(rec) },
    bridge: {
      pid: bridge?.pid ?? null,
      alive: procOf(bridge?.pid) !== null,
      // what status.json says is only true while that pid lives; a dead bridge's file is reported as stale
      mode: procOf(bridge?.pid) ? (bridge?.mode ?? null) : null,
      relay_connected: procOf(bridge?.pid) ? (bridge?.relay?.connected ?? null) : false,
      ...(bridge && !procOf(bridge.pid)
        ? { stale_file: { mode: bridge.mode ?? null, updated_at: bridge.updated_at ?? null } }
        : {}),
      updated_at: bridge?.updated_at ?? null,
      log: join(rec.home, 'bridge.log'),
    },
    tmux: {
      socket: rec.tmux.socket,
      watch: `${rec.tmux.bin} -L ${rec.tmux.socket} attach -r -t =${MAIN_SESSION}`,
    },
    home: rec.home,
    agent_dir: rec.agent_dir,
    phone: phone ? { device_id: phone.device_id, enrolled: true } : { enrolled: false },
  }
}

/** Claude Code's transcript folder for a path: every non-alphanumeric character becomes `-`. */
const projectFolder = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-')

export async function down(id: string): Promise<Record<string, unknown>> {
  const root = rootOf(id)
  if (!existsSync(root)) throw new SandboxError('no_sandbox', `no sandbox ${id} (looked for ${root})`)
  const rec = readJson<SandboxRecord>(files(root).record)
  const stopped: string[] = []
  const leftovers: string[] = []
  if (rec && rec.id === id && rec.root === root) {
    // The supervisor first: once it is gone nothing restarts Main behind this.
    if (rec.supervisor.proc) {
      if (await stopProc(rec.supervisor.proc, 8000)) stopped.push('supervisor')
      else leftovers.push(`supervisor pid ${rec.supervisor.proc.pid}`)
    }
    // Main and any thread session: every pane on the sandbox's own tmux server, each with its process group (the bridge
    // and whatever else the agent started). The pids are read before the server goes.
    const panes = panePids(rec)
    const bridgePid = bridgeStatus(rec)?.pid
    tmux(rec, ['kill-server'])
    for (const pid of panes) {
      if (groupAlive(pid)) signalGroup(pid, 'SIGTERM')
    }
    const end = Date.now() + 5000
    while (panes.some(groupAlive) && Date.now() < end) await sleep(100)
    for (const pid of panes) {
      if (groupAlive(pid)) signalGroup(pid, 'SIGKILL')
    }
    await sleep(panes.length > 0 ? 200 : 0)
    for (const pid of panes) {
      if (groupAlive(pid)) leftovers.push(`process group ${pid}`)
    }
    if (panes.length > 0) stopped.push('main')
    if (bridgePid && panes.length > 0 && procOf(bridgePid) === null) stopped.push('bridge')
    // tmux leaves the socket file behind
    const socketFile = join('/tmp', `tmux-${process.getuid?.() ?? 0}`, rec.tmux.socket)
    if (rec.tmux.socket === socketOf(id)) rmSync(socketFile, { force: true })
    if (existsSync(socketFile)) leftovers.push(`tmux socket ${socketFile}`)
    else stopped.push('tmux')
    if (rec.relay.proc) {
      if (await stopProc(rec.relay.proc, 8000)) stopped.push('relay')
      else leftovers.push(`relay pid ${rec.relay.proc.pid}`)
    }
    // The real `claude` saved this session's transcript under the owner's Claude folder, in a folder named after the
    // sandbox's own agent path: that one folder goes too.
    if (rec.mode === 'real') {
      for (const dir of new Set([rec.agent_dir, safeRealpath(rec.agent_dir)])) {
        const name = projectFolder(dir)
        if (name.includes(`talos-sandbox-${id}`))
          rmSync(join(homedir(), '.claude', 'projects', name), { recursive: true, force: true })
      }
    }
  } else {
    leftovers.push('sandbox.json was unreadable: no process could be identified, only the folder is removed')
  }
  rmSync(root, { recursive: true, force: true })
  return { id, removed: !existsSync(root), stopped, leftovers }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
