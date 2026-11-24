// The checks behind `talos-app doctor` and `talos doctor`, as rows. Printing and the exit code stay with the caller.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { bunDoctorRow } from './bun-floor.ts'
import { CHANNEL_OFF_TEXT } from './claude-env.ts'
import { type CliDeps, type CliIO, describeBridge, probeRelayAuth } from './cli-main.ts'
import { checkCodex } from './codex.ts'
import type { BridgeEnv } from './config.ts'
import { paths } from './config.ts'
import { parseConfig } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { deafThreadChecks } from './doctor-deaf.ts'
import { actionRulesUnreadableCheck, guardTimeoutsCheck } from './doctor-guards.ts'
import { memorySearchCheck } from './doctor-memory.ts'
import { modDoctorChecks } from './doctor-mods.ts'
import { osSandboxCheck } from './doctor-sandbox.ts'
import { wslDoctorChecks } from './doctor-wsl.ts'
import { fileMode, readJsonFile } from './fsutil.ts'
import { readOsSandboxSwitch } from './guards/os-sandbox.ts'
import { loadKeyFile } from './keys.ts'
import { hasTalosKit, isPlainFolder, noKitMessage, plainFolderWarning } from './kit-marker.ts'
import { installMcp, mcpEntry, mcpEntryState, mcpProtectedRoots, readMcpEntry } from './mcp-config.ts'
import { say } from './owner-words.ts'
import { linkedAgentsCheck } from './peer/relink.ts'
import { askRuleFiles, askRulesIn, DEFAULT_ASK_RULES, normalizeRule, settingsPath } from './permission/ask-rules.ts'
import { findOtherChannels } from './permission/doctor.ts'
import { isConnected, relayConnectRow } from './relay/doctor.ts'
import { RelayHttp } from './relay-http.ts'
import { feedDeps, relayReleaseReport } from './release-feed.ts'
import { probeFts5 } from './search/schema.ts'
import { bridgeLiveness, runningBridge } from './status-file.ts'
import { BRIDGE_COMMIT, commitReport, versionSkew } from './version.ts'

const BRIDGE_DIR = resolve(dirname(import.meta.path), '..')

export type Check = { level: 'ok' | 'warn' | 'FAIL'; name: string; detail: string }

/** noKit: the agent folder is a plain Claude Code folder on purpose (`--no-kit`, as start takes it). */
export type DoctorOptions = {
  agentDir?: string
  claudeDir?: string
  deep?: boolean
  noKit?: boolean
  /** Rewrite the talos-app entry in the agent folder's .mcp.json in the current form (the fix the older-entry row names). */
  fixMcp?: boolean
}

/** What the checks found: the rows, and the bridge key when there is one (the caller prints the relay line for it). */
export type DoctorResult = { checks: Check[]; key?: { keyId: string; publicKeyB64: string } }

/** C3.5: another relaying channel can answer a prompt first. C3.1: without ask rules a bypass-mode agent never prompts. */
function permissionChecks(
  relayOn: boolean,
  agentDir: string,
  claudeDirArg: string | undefined,
  deps: CliDeps,
  add: (level: Check['level'], name: string, detail: string) => void,
) {
  const claudeDir = claudeDirArg ? resolve(claudeDirArg) : dirname(settingsPath('user', agentDir))
  const other = findOtherChannels({
    claudeDir,
    agentDir,
    ...(deps.processes ? { processes: deps.processes } : {}),
  })
  if (other.names.length > 0)
    add(
      'warn',
      'other relaying channels',
      `${other.names.join(', ')} loaded (${other.where.join(', ')}). A permission prompt goes to every channel that declares the relay and the first answer wins, so a phone approval is only as strong as the weakest one. If you rely on Talos for approvals, launch without ${other.names.map((n) => `plugin:${n}@…`).join(' or ')} in --channels.${relayOn ? '' : ' (permission_relay is off, so this only matters once you turn it on.)'}`,
    )
  else add('ok', 'other relaying channels', 'none found')
  if (relayOn) {
    const have = new Set(askRuleFiles(agentDir, claudeDir).flatMap((f) => askRulesIn(f).map(normalizeRule)))
    const missing = DEFAULT_ASK_RULES.filter((r) => !have.has(normalizeRule(r)))
    if (have.size === 0)
      add(
        'warn',
        'ask rules',
        'permission_relay is on but no permissions.ask rules were found. In bypass mode nothing prompts, so nothing reaches the phone. Run: talos-app install-ask-rules --agent-dir <dir> --dry-run',
      )
    else if (missing.length)
      add(
        'warn',
        'ask rules',
        `permissions.ask is missing ${missing.length} of the standard rules, so those commands reach nobody${ownerOnlyNote(missing)} (an older install, or rules added since; ignore this if you left them out on purpose). Run talos-app install-ask-rules --agent-dir <dir> again; it only adds what is missing. Missing: ${missing.join(', ')}`,
      )
    else add('ok', 'ask rules', 'permissions.ask is set')
  }
}

/** The owner-only commands among the missing rules, named: an agent could run them with no card. */
function ownerOnlyNote(missing: readonly string[]): string {
  const names = ['rollback', 'restore-last-good'].filter((n) => missing.some((r) => r.includes(n)))
  return names.length
    ? ` (${names.join(' and ')} among them: an agent could run ${names.length > 1 ? 'them' : 'it'} with no card)`
    : ''
}

/** Runs every check. Never throws for a failed check: that is a row with level FAIL. */
export async function runDoctorChecks(
  env: BridgeEnv,
  opts: DoctorOptions,
  io: CliIO,
  deps: CliDeps = {},
): Promise<DoctorResult> {
  const p = paths(env.home)
  const doctorCommit = commitReport(runningBridge(bridgeLiveness(p.status, io.now(), deps.alive)), BRIDGE_COMMIT)
  const checks: Check[] = []
  const add = (level: Check['level'], name: string, detail: string) => checks.push({ level, name, detail })
  const bun = bunDoctorRow(Bun.version)
  add(bun.level, 'bun version', bun.detail)
  try {
    const v = (
      JSON.parse(readFileSync(join(BRIDGE_DIR, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8')) as {
        version: string
      }
    ).version
    add(v.startsWith('1.') ? 'ok' : 'FAIL', 'MCP SDK version', `${v} (must be 1.x, never 2.x)`)
  } catch {
    add('warn', 'MCP SDK version', 'could not read it; run pnpm install')
  }
  const agentDir = opts.agentDir ? resolve(opts.agentDir) : process.cwd()
  // start refuses such a folder unless --no-kit, so the doctor fails it unless told the same: the bridge alone, with none of
  // Talos around it
  if (hasTalosKit(agentDir)) add('ok', 'Talos kit', `installed in ${agentDir}`)
  else if (opts.noKit || isPlainFolder(env.home, agentDir)) add('warn', 'Talos kit', plainFolderWarning(agentDir))
  else add('FAIL', 'Talos kit', noKitMessage(agentDir))
  // `doctor --fix-mcp`: the one fix for the older entry, written the way install-mcp writes it (other servers kept)
  if (opts.fixMcp) {
    try {
      const r = installMcp(agentDir, mcpEntry(BRIDGE_DIR, env.home, agentDir), false, mcpProtectedRoots(env.home))
      add(
        'ok',
        '.mcp.json entry fix',
        r.changed ? `rewrote the talos-app entry in ${r.target}` : 'the entry was already current',
      )
    } catch (e) {
      add('FAIL', '.mcp.json entry fix', (e as Error).message)
    }
  }
  const entry = readMcpEntry(agentDir) as
    | { command?: string; args?: string[]; env?: Record<string, unknown> }
    | undefined
  if (!entry)
    add(
      'FAIL',
      '.mcp.json entry',
      `no talos-app server in ${join(agentDir, '.mcp.json')} (run apps/bridge/scripts/install.sh)`,
    )
  else {
    const absolute = typeof entry.command === 'string' && isAbsolute(entry.command)
    const here = entry.args?.some((a) => typeof a === 'string' && (a === BRIDGE_DIR || a.includes(`${BRIDGE_DIR}/`)))
    add(
      absolute && here ? 'ok' : 'warn',
      '.mcp.json entry',
      `command ${entry.command}, points at ${here ? 'this checkout' : 'another path'}` +
        (absolute
          ? ''
          : `. The command is not an absolute path, so Claude Code needs it on the PATH of the session, and Main can start without it (the bridge then never starts). Run talos-app install-mcp --agent-dir ${agentDir} to write the full path of bun.`),
    )
  }
  // the entry written before the sandbox's launch check (`run --cwd ...`): fine with the extra lock off, refused with it on
  if (entry && mcpEntryState(entry, BRIDGE_DIR) === 'old') {
    const locked = readOsSandboxSwitch(env.home)
    add(
      locked ? 'FAIL' : 'warn',
      '.mcp.json entry form',
      `the talos-app entry is the older form (it starts bun in the bridge folder${locked ? ', and the extra lock refuses it' : ''}). Fix it with one command: talos-app doctor --fix-mcp --agent-dir ${agentDir}`,
    )
  }
  const memory = memorySearchCheck(agentDir)
  if (memory) checks.push(memory)
  checks.push(...deafThreadChecks(env.home))
  const guards = guardTimeoutsCheck(agentDir)
  if (guards) checks.push(guards)
  const sandbox = osSandboxCheck(env.home, agentDir)
  if (sandbox) checks.push(sandbox)
  const ruleFiles = actionRulesUnreadableCheck(agentDir)
  if (ruleFiles) checks.push(ruleFiles)
  if (entry && !(typeof entry.env?.TALOS_AGENT_DIR === 'string' && entry.env.TALOS_AGENT_DIR !== ''))
    add(
      'warn',
      'last-good',
      'the talos-app entry in .mcp.json has no TALOS_AGENT_DIR, so last-good is not saving your setup. Run talos-app install-mcp --agent-dir <dir> again.',
    )
  const modeCheck = (name: string, path: string, want: number) => {
    const m = fileMode(path)
    if (m === undefined) return add(name === 'bridge.env' ? 'ok' : 'FAIL', `${name} mode`, 'missing')
    add((m & 0o077) === 0 ? 'ok' : 'FAIL', `${name} mode`, `${m.toString(8)} (want ${want.toString(8)})`)
  }
  modeCheck('home dir', p.home, 0o700)
  modeCheck('bridge.key', p.bridgeKey, 0o600)
  modeCheck('config.json', p.configJson, 0o600)
  if (fileMode(p.devicesJson) === undefined) add('ok', 'devices.json', 'none pinned yet')
  else {
    modeCheck('devices.json', p.devicesJson, 0o600)
    if (new DeviceStore(p.devicesJson).isCorrupt())
      add('FAIL', 'devices.json', 'cannot be read; nobody is trusted until it is fixed')
  }
  modeCheck('bridge.env', p.envFile, 0o600)
  wslDoctorChecks(
    add,
    [
      { name: 'Talos home', path: p.home },
      { name: 'agent folder', path: agentDir },
    ],
    deps.wsl,
  )
  const key = await loadKeyFile(p.bridgeKey).catch((e: Error) => {
    add('FAIL', 'bridge key', e.message)
    return undefined
  })
  if (key) add('ok', 'bridge key', `id ${key.keyId}`)
  const cfg = readJsonFile(p.configJson)
  const parsed = cfg ? parseConfig(cfg) : undefined
  add(
    parsed?.ok ? 'ok' : 'FAIL',
    'config.json',
    parsed?.ok ? `rev ${parsed.config.rev}` : (parsed?.message ?? 'missing'),
  )
  const fts = new Database(':memory:')
  const hasFts5 = probeFts5(fts)
  fts.close()
  add(
    hasFts5 ? 'ok' : 'warn',
    'search (FTS5)',
    hasFts5
      ? 'available'
      : say({
          mac: "This Mac's SQLite has no FTS5; search and the memory browser are off",
          linux: "This computer's SQLite has no FTS5; search and the memory browser are off",
        }),
  )
  const linked = await linkedAgentsCheck(env, deps.peer?.secrets ? { secrets: deps.peer.secrets } : {})
  if (linked) add(linked.level, linked.name, linked.detail)
  const cx = await checkCodex()
  add('ok', 'codex (optional)', cx.ok ? cx.version : `off: ${cx.message}`)
  permissionChecks(parsed?.ok ? parsed.config.permission_relay : false, agentDir, opts.claudeDir, deps, add)
  // Only an explicit --claude-dir is passed on: setting CLAUDE_CONFIG_DIR to the default moves where claude reads its
  // global config from (~/.claude/.claude.json instead of ~/.claude.json).
  await modDoctorChecks(agentDir, add, opts.claudeDir ? resolve(opts.claudeDir) : undefined)
  // MCP apps: only when they are on or a catalog exists (docs/bridge.md "MCP apps")
  if (env.apps || existsSync(join(env.home, 'apps', 'catalog.json')))
    await (await import('./apps/cli.ts')).appsDoctor({
      env,
      agentDir,
      add,
      io,
      deep: !!opts.deep,
      ...(deps.apps ? { deps: deps.apps } : {}),
    })
  if (env.relayUrl) {
    let reachable = false
    try {
      const h = await new RelayHttp(env.relayUrl, () => {
        throw new Error('no key needed')
      }).healthz()
      reachable = h.ok
      add(h.ok ? 'ok' : 'FAIL', 'relay /healthz', h.version ?? 'ok')
      if (h.ok) {
        const connected = isConnected(env.home)
        const rr = await relayReleaseReport(
          feedDeps(env, io.now),
          { release: h.release, version: h.version },
          { connected },
        )
        add(rr.level, 'relay release', rr.text)
        const cr = await relayConnectRow(env, deps.relay?.secrets)
        if (cr) add(cr.level, 'relay connect', cr.detail)
      }
      const skew = versionSkew(doctorCommit.commit, h.version)
      if (h.ok && skew) add(skew.level, 'bridge and relay versions', skew.text)
    } catch (e) {
      add('FAIL', 'relay /healthz', (e as Error).message)
    }
    // D55: /healthz answers anybody. A signed read-only call proves the relay accepts THIS Mac's key.
    if (reachable) {
      const auth = await probeRelayAuth(env, io.now())
      if (auth.ok)
        add(
          'ok',
          say({ mac: 'relay accepts this Mac', linux: 'relay accepts this computer' }),
          'a signed read-only call was accepted',
        )
      else
        add(
          auth.refused ? 'FAIL' : 'warn',
          say({ mac: 'relay accepts this Mac', linux: 'relay accepts this computer' }),
          auth.message,
        )
    }
  } else add('FAIL', 'relay URL', 'TALOS_APP_RELAY_URL is not set')
  const liveness = bridgeLiveness(p.status, io.now(), deps.alive)
  const bridge = describeBridge(liveness)
  add(bridge.level, 'live bridge (status.json)', bridge.text)
  // Started without the Talos channel: outbound tools work and nothing the owner sends is pushed in (Dante's setup, 2026-11-19).
  if (liveness.state === 'live' || liveness.state === 'stale') {
    if (liveness.status.talos_channel === 'off') add('FAIL', 'Talos channel', CHANNEL_OFF_TEXT)
    else if (liveness.status.talos_channel === 'on')
      add('ok', 'Talos channel', "on: the owner's messages are pushed in")
  }
  // Claude Code stops saving the transcript of a session that inherited CLAUDE_CODE_CHILD_SESSION (seen 2026-11-03).
  const marker =
    liveness.state === 'live' || liveness.state === 'stale' ? liveness.status.claude_session_marker_inherited : false
  if (marker === 'unknown')
    add(
      'warn',
      'transcript saving',
      say({
        mac: "couldn't check whether transcripts are saved (this Mac doesn't show process environments)",
        linux: "couldn't check whether transcripts are saved (this computer doesn't show process environments)",
      }),
    )
  else if (marker)
    add(
      'warn',
      'transcript saving',
      'transcripts are not being saved: the running session inherited CLAUDE_CODE_CHILD_SESSION from another Claude session, so Claude Code turned saving off. ' +
        say({
          mac: 'Restart the session from the Mac app (Restart session).',
          linux: 'Restart Main from the phone (Restart agent).',
        }),
    )
  // Claude Code sends prompts only to a server that declared the capability at start; a switch turned on later waits for a restart.
  if (
    parsed?.ok &&
    parsed.config.permission_relay &&
    (liveness.state === 'live' || liveness.state === 'stale') &&
    liveness.status.permission_relay_declared === false
  )
    add(
      'warn',
      'permission_relay',
      'permission_relay is on but this session started before it was turned on: restart the session',
    )
  if (doctorCommit.note) add('warn', 'running code', doctorCommit.note)
  return { checks, ...(key ? { key: { keyId: key.keyId, publicKeyB64: key.publicKeyB64 } } : {}) }
}
