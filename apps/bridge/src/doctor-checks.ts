// The checks behind `talos-app doctor` and `talos doctor`, as rows. Printing and the exit code stay with the caller.
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { type CliDeps, type CliIO, describeBridge, probeRelayAuth } from './cli-main.ts'
import { checkCodex } from './codex.ts'
import type { BridgeEnv } from './config.ts'
import { paths } from './config.ts'
import { parseConfig } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { modDoctorChecks } from './doctor-mods.ts'
import { fileMode, readJsonFile } from './fsutil.ts'
import { loadKeyFile } from './keys.ts'
import { readMcpEntry } from './mcp-config.ts'
import { askRuleFiles, askRulesIn, DEFAULT_ASK_RULES, normalizeRule, settingsPath } from './permission/ask-rules.ts'
import { findOtherChannels } from './permission/doctor.ts'
import { RelayHttp } from './relay-http.ts'
import { probeFts5 } from './search/schema.ts'
import { bridgeLiveness, runningBridge } from './status-file.ts'
import { BRIDGE_COMMIT, commitReport, versionSkew } from './version.ts'

const BRIDGE_DIR = resolve(dirname(import.meta.path), '..')

export type Check = { level: 'ok' | 'warn' | 'FAIL'; name: string; detail: string }

export type DoctorOptions = { agentDir?: string; claudeDir?: string; deep?: boolean }

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

function bunAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
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
  add(bunAtLeast(Bun.version, '1.3.11') ? 'ok' : 'FAIL', 'bun version', `${Bun.version} (needs >= 1.3.11)`)
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
  const entry = readMcpEntry(agentDir) as
    | { command?: string; args?: string[]; env?: Record<string, unknown> }
    | undefined
  if (!entry)
    add(
      'FAIL',
      '.mcp.json entry',
      `no talos-app server in ${join(agentDir, '.mcp.json')} (run apps/bridge/scripts/install.sh)`,
    )
  else
    add(
      entry.command === 'bun' && entry.args?.includes(BRIDGE_DIR) ? 'ok' : 'warn',
      '.mcp.json entry',
      `command ${entry.command}, points at ${entry.args?.includes(BRIDGE_DIR) ? 'this checkout' : 'another path'}`,
    )
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
    hasFts5 ? 'available' : "This Mac's SQLite has no FTS5; search and the memory browser are off",
  )
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
      const skew = versionSkew(doctorCommit.commit, h.version)
      if (h.ok && skew) add(skew.level, 'bridge and relay versions', skew.text)
    } catch (e) {
      add('FAIL', 'relay /healthz', (e as Error).message)
    }
    // D55: /healthz answers anybody. A signed read-only call proves the relay accepts THIS Mac's key.
    if (reachable) {
      const auth = await probeRelayAuth(env, io.now())
      if (auth.ok) add('ok', 'relay accepts this Mac', 'a signed read-only call was accepted')
      else add(auth.refused ? 'FAIL' : 'warn', 'relay accepts this Mac', auth.message)
    }
  } else add('FAIL', 'relay URL', 'TALOS_APP_RELAY_URL is not set')
  const liveness = bridgeLiveness(p.status, io.now(), deps.alive)
  const bridge = describeBridge(liveness)
  add(bridge.level, 'live bridge (status.json)', bridge.text)
  // Claude Code stops saving the transcript of a session that inherited CLAUDE_CODE_CHILD_SESSION (seen 2026-11-03).
  const marker =
    liveness.state === 'live' || liveness.state === 'stale' ? liveness.status.claude_session_marker_inherited : false
  if (marker === 'unknown')
    add(
      'warn',
      'transcript saving',
      "couldn't check whether transcripts are saved (this Mac doesn't show process environments)",
    )
  else if (marker)
    add(
      'warn',
      'transcript saving',
      'transcripts are not being saved: the running session inherited CLAUDE_CODE_CHILD_SESSION from another Claude session, so Claude Code turned saving off. Restart the session from the Mac app (Restart session).',
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
