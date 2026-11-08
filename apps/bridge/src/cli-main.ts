// `talos-app` CLI (spec 4.8). Never opens the bridge socket (4.10): everything goes over the signed HTTP API or files.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DeviceId,
  deriveEnrollAuth,
  enrollAuthHash,
  enrollCodeId,
  type Frame,
  fingerprintWords,
  HookDigestFrame,
  isIanaZone,
  newEnrollCode,
} from '@talos-app/protocol'
import { Bridge } from './bridge.ts'
import { launchEnv } from './claude-env.ts'
import { checkCodex, runCodex } from './codex.ts'
import { assertSecureRelayUrl, type BridgeEnv, loadEnv, paths } from './config.ts'
import { parseConfig } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { EnrollFiles } from './enroll-files.ts'
import { cleanDeviceName } from './enrollment.ts'
import { ensureDir, readJsonFile, writeFileAtomic, writeJsonAtomic } from './fsutil.ts'
import { withGuardsSettings } from './guards/install.ts'
import { openHistory } from './history-store.ts'
import { commitRotation, ensureBridgeKey, loadBridgeKey, loadKeyFile, prepareRotation } from './keys.ts'
import { installMcp, mcpEntry, readMcpEntry } from './mcp-config.ts'
import { hookDigestNotification } from './notify.ts'
import {
  AskRulesError,
  describePlan,
  headlessWarning,
  planAskRules,
  settingsPath,
  writePlan,
} from './permission/ask-rules.ts'
import { redact } from './redact.ts'
import { RelayHttp, RelayHttpError } from './relay-http.ts'
import { runCommand } from './run-command.ts'
import { cmdSchedules } from './schedules/cli.ts'
import { type BridgeLiveness, bridgeLiveness, runningBridge } from './status-file.ts'
import { mainTee } from './subagent-tee.ts'
import {
  describeTeePlan,
  planSubagentTee,
  TeeInstallError,
  type TeePlan,
  teeCommand,
  writeTeePlan,
} from './subagent-tee-install.ts'
import { terminalOnly } from './talos.ts'
import { cmdTheme } from './theme-cli.ts'
import { cmdTrust } from './trust-cli.ts'
import { cmdV2, V2_USAGE } from './v2-cli.ts'
import { BRIDGE_COMMIT, BRIDGE_VERSION, commitReport, resolveVersion, versionSkew } from './version.ts'
import { workerCliRefusal } from './worker/cli-refusal.ts'

export type CliIO = {
  /** False when stdin or stdout is not a terminal. Absent (a test's io) counts as a terminal. */
  isTerminal?: boolean
  out(line: string): void
  err(line: string): void
  /** Asks a question on the terminal and returns the answer line. */
  prompt(question: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
}

const BRIDGE_DIR = resolve(dirname(import.meta.path), '..')
const REPO_DIR = resolve(BRIDGE_DIR, '..', '..')
const EXAMPLES_DIR = join(REPO_DIR, 'examples')

class CliError extends Error {}

export function systemTimezone(): string {
  const z = Intl.DateTimeFormat().resolvedOptions().timeZone
  return z && isIanaZone(z) ? z : 'UTC'
}

function needRelay(env: BridgeEnv): string {
  if (!env.relayUrl) throw new CliError('TALOS_APP_RELAY_URL is not set (run: talos-app init --relay-url <url>)')
  try {
    assertSecureRelayUrl(env.relayUrl)
  } catch (e) {
    throw new CliError((e as Error).message)
  }
  return env.relayUrl
}

async function httpFor(env: BridgeEnv) {
  const key = await loadBridgeKey(paths(env.home))
  return new RelayHttp(needRelay(env), () => key)
}

// ---- the bridge and the relay, as this Mac sees them (D55, D56) -------------------------------------------------------

type Level = 'ok' | 'warn'

/** One plain sentence on what status.json says, and whether it is good news. */
export function describeBridge(l: BridgeLiveness): { level: Level; text: string } {
  const ago = (ms: number) =>
    ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`
  switch (l.state) {
    case 'none':
      return {
        level: 'warn',
        text: 'no status.json: no bridge has run here since this update, or none is running. Start your agent with: talos-app start (a bridge that was already running needs a restart to start writing it)',
      }
    case 'live':
      return l.relayConnected
        ? {
            level: 'ok',
            text: `live (pid ${l.status.pid}), connected to the relay${l.status.relay.last_connect_at ? ` since ${l.status.relay.last_connect_at}` : ''}, ${l.status.queue_depth} queued`,
          }
        : {
            level: 'warn',
            text: `live (pid ${l.status.pid}) but not connected to the relay${l.status.relay.last_close_code != null ? ` (last close code ${l.status.relay.last_close_code})` : ''}. It retries on its own; if this stays, run: talos-app doctor`,
          }
    case 'stale':
      return {
        level: 'warn',
        text: `status.json stopped updating ${ago(l.ageMs)} ago while pid ${l.status.pid} is still running. The bridge is stuck or your agent is frozen; restart it`,
      }
    case 'dead':
      return {
        level: 'warn',
        text: `the bridge is not running (pid ${l.status.pid} is gone; last wrote ${ago(l.ageMs)} ago). Start it with: talos-app start`,
      }
    case 'superseded':
      return {
        level: 'warn',
        text: `pid ${l.status.pid} was replaced by another bridge with the same key. Only the newest one receives app messages`,
      }
  }
}

/** The relay refuses a signature more than 2 minutes off; past this much difference we blame the clock, not the key. */
const CLOCK_SKEW_LIMIT_MS = 90_000

/**
 * What to tell the owner when the relay answers 401 to this Mac's signed call. Every signed-call failure is the same bare 401
 * (unknown key, a clock past 120 s off, a replayed nonce), so the relay's own `Date` header decides: if this Mac's clock
 * disagrees with it, the clock is the problem and redeploying Railway would not help.
 */
export async function keyRefusedHint(env: BridgeEnv, e?: RelayHttpError, localNowMs = Date.now()): Promise<string> {
  if (e?.serverDate !== undefined) {
    const skew = localNowMs - e.serverDate
    if (Math.abs(skew) > CLOCK_SKEW_LIMIT_MS) {
      const mins = Math.round(Math.abs(skew) / 60_000)
      return `The relay turned away this Mac's request, and this Mac's clock is about ${mins} minute${mins === 1 ? '' : 's'} ${skew > 0 ? 'ahead of' : 'behind'} the relay's. The relay refuses requests more than 2 minutes off. Fix: set this Mac's date and time to automatic (System Settings > General > Date & Time), then run this again. The key itself is probably fine.`
    }
  }
  const key = await loadKeyFile(paths(env.home).bridgeKey).catch(() => undefined)
  const line = key ? `BRIDGE_PUBKEY=${key.publicKeyB64}` : 'BRIDGE_PUBKEY=<run: talos-app init>'
  return `The relay turned away this Mac's key. Most likely fix: in Railway open your relay service, set the variable ${line} and press Deploy (if you have run \`talos-app rotate\`, also set BRIDGE_PUBKEY_FORCE=1 for that one deploy, then remove it). If that line is already there, check this Mac's date and time is set to automatic: the relay also answers 401 when the clock is more than 2 minutes off.`
}

export type RelayAuth = { ok: true } | { ok: false; refused: boolean; message: string }

/** Proves the relay accepts THIS Mac: one signed, read-only call (GET /bridge/digest?since=<now>, 401 on a refused key). */
export async function probeRelayAuth(env: BridgeEnv, nowMs: number): Promise<RelayAuth> {
  if (!env.relayUrl) return { ok: false, refused: false, message: 'TALOS_APP_RELAY_URL is not set' }
  let http: RelayHttp
  try {
    http = await httpFor(env)
  } catch (e) {
    return { ok: false, refused: false, message: (e as Error).message }
  }
  try {
    await http.getDigest(new Date(nowMs).toISOString())
    return { ok: true }
  } catch (e) {
    if (e instanceof RelayHttpError && e.status === 401)
      return { ok: false, refused: true, message: await keyRefusedHint(env, e) }
    if (e instanceof RelayHttpError)
      return { ok: false, refused: false, message: `the relay answered ${e.status} to a signed call` }
    return { ok: false, refused: false, message: `could not ask the relay: ${(e as Error).message}` }
  }
}

/**
 * The QR as text lines, or undefined when it cannot be drawn. `uqr` is loaded only here: an install that pulled this
 * code without running `pnpm install` has no uqr in node_modules, and every other command (doctor, status, post, the Mac
 * app's sign-in, scheduled jobs) must keep working.
 */
export async function renderQr(
  link: string,
  load: () => Promise<typeof import('uqr')> = () => import('uqr'),
): Promise<string[] | undefined> {
  try {
    const { renderUnicodeCompact } = await load()
    return renderUnicodeCompact(link, { border: 1 }).split('\n')
  } catch {
    return undefined
  }
}

// ---- init ------------------------------------------------------------------------------------------------------

async function cmdInit(env: BridgeEnv, args: string[], io: CliIO) {
  const { values } = parseArgs({
    args,
    options: { 'relay-url': { type: 'string' }, config: { type: 'string' } },
    strict: true,
  })
  const relayUrl = values['relay-url'] ?? env.relayUrl
  if (!relayUrl) throw new CliError('usage: talos-app init --relay-url <url> [--config default|five-threads]')
  try {
    assertSecureRelayUrl(relayUrl)
  } catch (e) {
    throw new CliError((e as Error).message)
  }
  const which = values.config ?? 'default'
  if (which !== 'default' && which !== 'five-threads') throw new CliError('--config must be default or five-threads')
  const p = paths(env.home)
  for (const d of [p.home, p.media, p.approved, p.enrollPending]) ensureDir(d)
  const key = await ensureBridgeKey(p)
  if (!existsSync(p.configJson)) {
    const example = JSON.parse(readFileSync(join(EXAMPLES_DIR, `config.${which}.json`), 'utf8')) as Record<
      string,
      unknown
    >
    const now = new Date(io.now()).toISOString()
    const cfg = {
      ...example,
      timezone: systemTimezone(),
      permission_relay: true, // a fresh install starts with tool prompts as approval cards; an existing file is never touched
      threads: (example.threads as Array<Record<string, unknown>>).map((t) => ({ ...t, created_at: now })),
    }
    const checked = parseConfig(cfg)
    if (!checked.ok) throw new CliError(`example config invalid: ${checked.message}`)
    writeJsonAtomic(p.configJson, checked.config, 0o600)
    io.out(`wrote ${p.configJson}`)
  } else {
    io.out(`kept ${p.configJson} (already there)`)
  }
  // bridge.env: set TALOS_APP_RELAY_URL, keep every other line
  const lines = existsSync(p.envFile)
    ? readFileSync(p.envFile, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l !== '')
    : []
  const kept = lines.filter((l) => !/^\s*(export\s+)?TALOS_APP_RELAY_URL\s*=/.test(l))
  writeFileAtomic(p.envFile, `${[...kept, `TALOS_APP_RELAY_URL=${relayUrl.replace(/\/+$/, '')}`].join('\n')}\n`, 0o600)
  io.out(key.created ? 'created bridge key' : 'kept the existing bridge key')
  io.out('Paste this into the relay environment (BRIDGE_PUBKEY):')
  io.out(`BRIDGE_PUBKEY=${key.publicKeyB64}`)
}

// ---- enroll ----------------------------------------------------------------------------------------------------

const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a)

async function promptPending(files: EnrollFiles, codeId: string, io: CliIO) {
  const c = files.readConfirm(codeId)
  if (!c) return
  const words = c.fingerprint.length ? c.fingerprint : [...fingerprintWords(c.device_id)]
  const answer = await io.prompt(`Pin ${JSON.stringify(cleanDeviceName(c.name))} [${words.join(' ')}]? [y/N] `)
  files.writeAnswer(codeId, { yes: yes(answer), device_id: c.device_id })
  io.out(
    yes(answer) ? 'Answered yes; the live bridge will pin the device.' : 'Answered no; the device will not be pinned.',
  )
}

async function cmdEnroll(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps = {}) {
  const { values } = parseArgs({
    args,
    options: { label: { type: 'string' }, confirm: { type: 'boolean' }, 'no-qr': { type: 'boolean' } },
    strict: true,
  })
  const p = paths(env.home)
  const files = new EnrollFiles(p.enrollPending)
  if (values.confirm) {
    const ids = files.awaitingAnswer()
    if (!ids.length) io.out('nothing is waiting for confirmation')
    for (const id of ids) await promptPending(files, id, io)
    return
  }
  const http = await httpFor(env)
  const relayUrl = needRelay(env)
  // D56: the phone's four words only reach a live bridge. Say so BEFORE the one-use code is made and shown.
  const bridge = describeBridge(bridgeLiveness(p.status, io.now(), deps.alive))
  if (bridge.level !== 'ok') {
    io.out(`Warning: ${bridge.text}`)
    io.out(
      'Nobody can pin the new device until a live bridge is running, and this link works only once. Start the agent first if you can; continuing.',
    )
  }
  const code = newEnrollCode()
  const hash = enrollAuthHash(deriveEnrollAuth(code))
  const codeId = enrollCodeId(hash)
  const now = io.now()
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + 10 * 60_000).toISOString()
  ensureDir(p.enrollPending)
  files.writePending(codeId, {
    code,
    ...(values.label ? { label: values.label } : {}),
    created_at: createdAt,
    expires_at: expiresAt,
  })
  // only the hash goes to the relay; the code itself stays on this Mac and in the link fragment
  try {
    await http.enroll({
      code_id: codeId,
      code_auth_hash: hash,
      expires_at: expiresAt,
      ...(values.label ? { label: values.label } : {}),
    })
  } catch (e) {
    // the file above holds a code the relay never heard of: take it back
    files.removeAll(codeId)
    if (e instanceof RelayHttpError && e.status === 401) throw new CliError(await keyRefusedHint(env, e))
    throw e
  }
  const link = `${relayUrl}/enroll#${code}`
  io.out('Open this link on the device you want to add (it works once, for 10 minutes):')
  io.out(link)
  if (!values['no-qr']) {
    io.out('Or point the phone camera at this code:')
    const lines = await renderQr(link)
    if (lines) for (const l of lines) io.out(l)
    else io.out('(The code could not be drawn here; use the link above.)')
  }
  io.out('Waiting for the device… (Ctrl-C to stop; `talos-app enroll --confirm` answers later)')
  while (io.now() - now < 10 * 60_000) {
    if (files.readConfirm(codeId)) {
      await promptPending(files, codeId, io)
      return
    }
    if (!files.readPending(codeId)) {
      io.out('This code was used or removed.')
      return
    }
    await io.sleep(500)
  }
  io.out('Timed out. Run `talos-app enroll` again for a new link.')
}

// ---- devices / rotate --------------------------------------------------------------------------------------------

async function cmdDevices(env: BridgeEnv, args: string[], io: CliIO) {
  const store = new DeviceStore(paths(env.home).devicesJson)
  if (args[0] === 'revoke') {
    const id = args[1]
    if (!id || !DeviceId.safeParse(id).success) throw new CliError('usage: talos-app devices revoke <device id>')
    try {
      store.revoke(id, new Date(io.now()).toISOString())
    } catch (e) {
      throw new CliError((e as Error).message)
    }
    io.out(`marked ${id} revoked in devices.json`)
    try {
      const r = await (await httpFor(env)).revokeDevice(id)
      io.out("the relay ended that device's sessions")
      // Only a relay that reports it says so; an older one is silent, which this does not read as "not shared".
      if (r?.shared_passkey === true)
        io.out(
          'Warning: that device shares its passkey with another device of yours. The passkey is NOT revoked: it still signs in for the other device, and for anyone who can unlock it (a synced keychain). To remove the passkey, revoke every device that uses it, then set them up again.',
        )
    } catch (e) {
      throw new CliError(
        `revoked locally, but the relay call failed: ${(e as Error).message}. Run it again when the relay is reachable.`,
      )
    }
    return
  }
  if (store.isCorrupt())
    throw new CliError('devices.json is unreadable; fix or restore it (no device is trusted until then)')
  const list = store.list()
  if (!list.length) io.out('no devices pinned')
  for (const d of list) {
    const words = d.fingerprint?.join(' ') ?? ''
    io.out(
      `${d.id}  ${d.revoked_at ? 'REVOKED ' : 'pinned  '} ${d.name}${words ? `  [${words}]` : ''}${d.pinned_at ? `  ${d.pinned_at}` : ''}`,
    )
  }
}

async function cmdRotate(env: BridgeEnv, io: CliIO) {
  const p = paths(env.home)
  const http = await httpFor(env)
  const prepared = await prepareRotation(p, Math.floor(io.now() / 1000))
  try {
    const res = await http.rotate({ new_pubkey: prepared.newPubkey, sig_new: prepared.sigNew, ts: prepared.ts })
    commitRotation(p)
    io.out(
      `rotated; new key id ${res.key_id}. The live bridge reconnects with it on its own; the old key stays valid at the relay for 5 minutes.`,
    )
    // The relay keeps the rotated key in its database, but its BRIDGE_PUBKEY variable on Railway still holds the OLD one.
    // If the volume is ever lost or restored, the relay falls back to that variable and trusts a dead key (audit D58).
    io.out('')
    io.out('Now update the relay: in Railway set BRIDGE_PUBKEY to this line, then press Deploy.')
    io.out(`BRIDGE_PUBKEY=${prepared.newPubkey}`)
    io.out(
      'Until you do, Railway still trusts the OLD key, and a restored or emptied relay volume would bring it back.',
    )
  } catch (e) {
    throw new CliError(`rotation failed, bridge.key is unchanged: ${(e as Error).message}`)
  }
}

// ---- status / doctor ----------------------------------------------------------------------------------------------

async function cmdStatus(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps = {}) {
  const { values } = parseArgs({ args, options: { json: { type: 'boolean' } }, strict: true })
  const p = paths(env.home)
  let reachable = 'no relay URL'
  let reachableBool: boolean | null = null
  let relayVersion: string | undefined
  if (env.relayUrl) {
    try {
      const h = await new RelayHttp(env.relayUrl, () => {
        throw new Error('no key needed')
      }).healthz()
      reachable = h.ok ? `yes (${h.version ?? 'unknown version'})` : 'answered, but not ok'
      reachableBool = h.ok
      relayVersion = h.version
    } catch (e) {
      reachable = `no (${(e as Error).message})`
      reachableBool = false
    }
  }
  // D55: reachable is not the same as accepted. Ask once with a signed, read-only call (only when the relay answered).
  const auth = reachableBool ? await probeRelayAuth(env, io.now()) : undefined
  const live = bridgeLiveness(p.status, io.now(), deps.alive)
  const cr = commitReport(runningBridge(live), BRIDGE_COMMIT)
  if (values.json) {
    // DESKTOP-SPEC 6.2: the status.json fields as the live bridge wrote them, plus what only the CLI can know.
    const base = live.state === 'none' ? { v: 1 } : live.status
    io.out(
      JSON.stringify(
        {
          ...base,
          liveness: live.state,
          relay_reachable: reachableBool,
          relay_accepts_key: auth ? auth.ok : null,
          bridge_version: BRIDGE_VERSION,
          bridge_commit: cr.commit ?? null,
          disk_commit: BRIDGE_COMMIT ?? null,
          needs_restart: cr.note !== undefined,
          relay_version: relayVersion ?? null,
          version_skew: versionSkew(cr.commit, relayVersion)?.level === 'warn',
        },
        null,
        2,
      ),
    )
    return
  }
  const key = await loadKeyFile(p.bridgeKey).catch(() => undefined)
  let lastConnect = 'never'
  let queue = 0
  if (existsSync(p.historyDb)) {
    const s = openHistory(p.historyDb)
    lastConnect = s.kvGet('last_connect_at') ?? 'never'
    queue = s.outboxCount()
    s.close()
  }
  io.out(`relay reachable: ${reachable}`)
  io.out(
    `relay accepts this Mac: ${auth ? (auth.ok ? 'yes' : `NO. ${auth.message}`) : reachableBool === false ? 'unknown (relay not reachable)' : 'unknown'}`,
  )
  io.out(`bridge: ${describeBridge(live).text}`)
  if (!runningBridge(live).running) io.out(`bridge version: ${BRIDGE_VERSION} (the code on disk; no bridge is running)`)
  else if (cr.commit && !cr.note) io.out(`bridge version: ${BRIDGE_VERSION} (running)`)
  else if (cr.commit) io.out(`bridge version: ${cr.commit} (running); this folder is now at ${BRIDGE_VERSION}`)
  else
    io.out(
      `bridge version: unknown (the running bridge started before it recorded one); this folder is at ${BRIDGE_VERSION}`,
    )
  if (cr.note) io.out(`WARNING: ${cr.note}`)
  const skew = versionSkew(cr.commit, relayVersion)
  if (skew?.level === 'warn') io.out(`WARNING: ${skew.text}`)
  io.out(`bridge key id: ${key?.keyId ?? 'none (run talos-app init)'}`)
  io.out(`last connect: ${lastConnect}`)
  io.out(`queue depth: ${queue}`)
  io.out(`STT: ${env.sttCmd ? 'configured' : 'not configured'}  TTS: ${env.ttsCmd ? 'configured' : 'not configured'}`)
}

/** Injection points for tests; the real CLI passes none. */
export type CliDeps = {
  processes?: () => string[]
  codexTimeoutMs?: number
  /** `share shortcut`: the OS (default `process.platform`) and the signer (default `shortcuts sign`); tests inject both. */
  platform?: NodeJS.Platform
  sign?: (input: string, output: string) => Promise<{ ok: true } | { ok: false; error: string }>
  /** `apps ...` (MCP apps): the status source, Keychain, connector and so on; tests inject all of them. */
  apps?: import('./apps/cli.ts').AppsCliDeps
  /** `update`: the checkout to update (default: the one this CLI runs from) and how to run a command there; tests inject both. */
  update?: { repoDir?: string; run?: (cmd: string[], cwd: string) => { code: number; out: string } }
  /** `rollback`: the checkout and the command runner (default this checkout, real git and pnpm); tests inject both. */
  rollback?: { repoDir?: string; run?: (cmd: string[], cwd: string) => { code: number; out: string } }
  /** `start`: runs the command and resolves with its exit code (default Bun.spawn with the terminal attached). */
  spawn?: (cmd: string[], opts: { cwd: string; env: Record<string, string> }) => Promise<number>
  /** `start`: where `claude` is (default Bun.which). */
  which?: (name: string) => string | null | undefined
  /** `logs --follow`: stop when this returns true (default never; Ctrl-C ends it). */
  followUntil?: () => boolean
  /** `status`, `doctor`, `enroll`: whether a pid is alive (default signal 0). */
  alive?: (pid: number) => boolean
  /** `digest`, `post`, `inbox*`: the folder to look in for a `.talos-lead` marker (default `process.cwd()`). */
  cwd?: string
}

async function cmdDoctor(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps) {
  const { values } = parseArgs({
    args,
    options: { 'agent-dir': { type: 'string' }, 'claude-dir': { type: 'string' }, deep: { type: 'boolean' } },
    strict: true,
  })
  const { runDoctorChecks } = await import('./doctor-checks.ts')
  const { checks, key } = await runDoctorChecks(
    env,
    {
      ...(values['agent-dir'] ? { agentDir: values['agent-dir'] } : {}),
      ...(values['claude-dir'] ? { claudeDir: values['claude-dir'] } : {}),
      ...(values.deep ? { deep: true } : {}),
    },
    io,
    deps,
  )
  for (const c of checks) io.out(`${c.level.padEnd(4)}  ${c.name}: ${c.detail}`)
  // The line the server needs when it turns this Mac's key away (the app's "key refused" banner points here).
  if (key) {
    io.out(
      "If the app says the server turned away this Mac's key, put this line in the relay variables on Railway and deploy:",
    )
    io.out(`BRIDGE_PUBKEY=${key.publicKeyB64}`)
    io.out('If you have run `talos-app rotate`, also set BRIDGE_PUBKEY_FORCE=1 for that one deploy, then remove it.')
  }
  if (checks.some((c) => c.level === 'FAIL')) throw new CliError('doctor found problems')
}

// ---- start (D54) ------------------------------------------------------------------------------------------------

async function cmdStart(args: string[], io: CliIO, deps: CliDeps, home: string): Promise<number> {
  const dd = args.indexOf('--')
  const own = dd < 0 ? args : args.slice(0, dd)
  const claudeFlags = dd < 0 ? [] : args.slice(dd + 1)
  const { values } = parseArgs({
    args: own,
    options: { 'agent-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } },
    strict: true,
  })
  const agentDir = resolve(values['agent-dir'] ?? process.cwd())
  const usage = 'usage: talos-app start [--agent-dir <dir>] [--dry-run] [-- <your claude flags>]'
  if (!existsSync(agentDir)) throw new CliError(`agent folder does not exist: ${agentDir}\n${usage}`)
  if (!readMcpEntry(agentDir))
    throw new CliError(
      `no talos-app server in ${join(agentDir, '.mcp.json')}. Run: apps/bridge/scripts/install.sh --agent-dir ${agentDir} --relay-url <url>`,
    )
  const claude = (deps.which ?? ((n: string) => Bun.which(n)))('claude')
  if (!claude && !values['dry-run'])
    throw new CliError(
      '`claude` is not on your PATH. Install Claude Code (https://claude.com/claude-code), then run this again.',
    )
  const flags = claudeFlags.includes('server:talos-app')
    ? claudeFlags
    : [...claudeFlags, '--dangerously-load-development-channels', 'server:talos-app']
  // Guards exist only if the owner ran `talos-app install-guards`; then every start carries them.
  const guarded = withGuardsSettings(flags, home)
  if (guarded.warning) io.err(guarded.warning)
  const withGuards = guarded.flags
  const cmd = [claude ?? 'claude', ...withGuards]
  const childEnv = { TALOS_APP_BRIDGE: '1', MCP_PROTOCOL_NEGOTIATION: 'legacy' }
  io.out(`in ${agentDir}: TALOS_APP_BRIDGE=1 MCP_PROTOCOL_NEGOTIATION=legacy ${cmd.join(' ')}`)
  if (values['dry-run']) return 0
  const spawn =
    deps.spawn ??
    (async (c, o) => {
      const proc = Bun.spawn(c, {
        cwd: o.cwd,
        env: launchEnv(process.env, o.env),
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      return await proc.exited
    })
  return await spawn(cmd, { cwd: agentDir, env: childEnv })
}

// ---- logs / report (D62) -----------------------------------------------------------------------------------------

/** One bridge.log line (pino-style JSON) as a readable line; anything that is not JSON is passed through. */
export function formatLogLine(line: string): string {
  try {
    const { level, time, msg, ...rest } = JSON.parse(line) as Record<string, unknown>
    const when = typeof time === 'number' ? new Date(time).toISOString() : '?'
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
    return `${when} ${String(level ?? '').padEnd(8)} ${String(msg ?? '')}${extra}`
  } catch {
    return line
  }
}

function tailLines(file: string, n: number): string[] {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n').filter((l) => l !== '')
  return lines.slice(-n)
}

function parseCount(v: string | undefined, dflt: number, name: string): number {
  if (v === undefined) return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new CliError(`${name} needs a whole number from 1 to 5000`)
  return n
}

async function cmdLogs(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps) {
  const { values } = parseArgs({
    args,
    options: { lines: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } },
    strict: true,
  })
  const file = paths(env.home).log
  if (!existsSync(file))
    throw new CliError(`no log yet at ${file}. The bridge creates it when it starts (talos-app start).`)
  const n = parseCount(values.lines, 50, '-n')
  const show = (l: string) => io.out(redact(formatLogLine(l), { userHome: homedir(), appHome: env.home }))
  for (const l of tailLines(file, n)) show(l)
  if (!values.follow) return
  let offset = statSync(file).size
  let partial = ''
  while (!deps.followUntil?.()) {
    await io.sleep(1000)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue
    }
    if (size < offset) offset = 0 // rotated: the new file starts over
    if (size === offset) continue
    const chunk = await Bun.file(file).slice(offset, size).text()
    offset = size
    const parts = (partial + chunk).split('\n')
    partial = parts.pop() ?? ''
    for (const l of parts) if (l !== '') show(l)
  }
}

async function cmdReport(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps) {
  const { values } = parseArgs({
    args,
    options: {
      'agent-dir': { type: 'string' },
      'claude-dir': { type: 'string' },
      lines: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  })
  const n = parseCount(values.lines, 100, '--lines')
  const buf: string[] = []
  const cap: CliIO = { ...io, out: (l) => buf.push(l), err: (l) => buf.push(l) }
  buf.push(
    `talos-app report: talos-app ${BRIDGE_VERSION}, bun ${Bun.version}, ${process.platform} ${process.arch}, ${new Date(io.now()).toISOString()}`,
  )
  buf.push('', '== doctor ==')
  const doctorArgs = [
    ...(values['agent-dir'] ? ['--agent-dir', values['agent-dir']] : []),
    ...(values['claude-dir'] ? ['--claude-dir', values['claude-dir']] : []),
  ]
  try {
    await cmdDoctor(env, doctorArgs, cap, deps)
  } catch (e) {
    buf.push(`(doctor stopped: ${(e as Error).message})`)
  }
  buf.push('', '== status --json ==')
  try {
    await cmdStatus(env, ['--json'], cap, deps)
  } catch (e) {
    buf.push(`(status stopped: ${(e as Error).message})`)
  }
  buf.push('', `== bridge.log (last ${n} lines) ==`)
  const logFile = paths(env.home).log
  if (existsSync(logFile)) for (const l of tailLines(logFile, n)) buf.push(formatLogLine(l))
  else buf.push('(no log file)')
  const text = `${redact(buf.join('\n'), { userHome: homedir(), appHome: env.home })}\n`
  if (values.out) {
    writeFileAtomic(resolve(values.out), text, 0o600)
    io.out(`wrote ${resolve(values.out)}`)
  } else io.out(text.trimEnd())
  io.out('Keys, tokens, setup codes and your home folder are removed. Read it once before you share it.')
}

// ---- post / digest / install-mcp -------------------------------------------------------------------------------------

async function cmdPost(env: BridgeEnv, args: string[], io: CliIO) {
  const [thread, ...rest] = args
  const text = rest.join(' ')
  if (!thread || !text) throw new CliError('usage: talos-app post <thread> <text>')
  const bridge = await Bridge.create({ env, headless: true })
  try {
    const res = await bridge.callTool('reply', { thread_id: thread, text })
    io.out(res.content[0]?.text ?? '')
    if (res.isError) throw new CliError('post failed')
  } finally {
    await bridge.stop()
  }
}

async function cmdDigest(env: BridgeEnv, args: string[], io: CliIO) {
  const { values } = parseArgs({ args, options: { since: { type: 'string' } }, strict: true })
  const body = await (await httpFor(env)).getDigest(values.since)
  const parsed = HookDigestFrame.safeParse(body)
  if (!parsed.success) throw new CliError('the relay sent a digest that does not match the protocol')
  const cfg = parseConfig(readJsonFile(paths(env.home).configJson))
  const name = cfg.ok ? (cfg.config.threads.find((t) => t.id === 'inbox')?.name ?? 'Inbox') : 'Inbox'
  // external data: always printed inside the untrusted wrapper
  io.out(
    hookDigestNotification({
      thread: { id: 'inbox', name },
      frame: parsed.data as Extract<Frame, { type: 'hook.digest' }>,
    }).content,
  )
}

function cmdInstallMcp(env: BridgeEnv, args: string[], io: CliIO) {
  const { values } = parseArgs({
    args,
    options: { 'agent-dir': { type: 'string' }, 'dry-run': { type: 'boolean' } },
    strict: true,
  })
  if (!values['agent-dir']) throw new CliError('usage: talos-app install-mcp --agent-dir <dir> [--dry-run]')
  const agentDir = resolve(values['agent-dir'])
  const r = installMcp(agentDir, mcpEntry(BRIDGE_DIR, env.home, agentDir), Boolean(values['dry-run']))
  io.out(`${r.changed ? (values['dry-run'] ? 'would write' : 'wrote') : 'already up to date:'} ${r.path}`)
  if (r.droppedEnv.length)
    io.out(
      `dropped env key${r.droppedEnv.length > 1 ? 's' : ''} ${r.droppedEnv.join(', ')}: the value is not a string (every string-valued key was kept)`,
    )
  if (values['dry-run']) io.out(JSON.stringify(r.config, null, 2))
}

async function cmdInstallAskRules(args: string[], io: CliIO) {
  const { values } = parseArgs({
    args,
    options: {
      'agent-dir': { type: 'string' },
      scope: { type: 'string' },
      'claude-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  })
  const usage = 'usage: talos-app install-ask-rules --agent-dir <dir> [--scope project|user] [--dry-run]'
  if (!values['agent-dir']) throw new CliError(usage)
  const scope = values.scope ?? 'project'
  if (scope !== 'project' && scope !== 'user') throw new CliError(usage)
  const path = settingsPath(
    scope,
    resolve(values['agent-dir']),
    values['claude-dir'] ? resolve(values['claude-dir']) : undefined,
  )
  let plan: ReturnType<typeof planAskRules>
  try {
    plan = planAskRules(path)
  } catch (e) {
    if (e instanceof AskRulesError) throw new CliError(e.message)
    throw e
  }
  for (const l of describePlan(plan)) io.out(l)
  io.out(
    'Ask rules still prompt when Claude Code runs with bypass permissions. They catch the common forms, not every spelling; edit the file afterwards to fit your work.',
  )
  for (const l of headlessWarning([...plan.present, ...plan.added])) io.out(l)
  if (values['dry-run']) return io.out('dry run: nothing was written')
  if (plan.added.length === 0) return io.out('already up to date')
  const answer = await io.prompt(
    `Write ${plan.added.length} rule${plan.added.length === 1 ? '' : 's'} to ${plan.path}? [y/N] `,
  )
  if (!yes(answer)) return io.out('Not written.')
  try {
    writePlan(plan)
  } catch (e) {
    if (e instanceof AskRulesError) throw new CliError(e.message)
    throw e
  }
  io.out(`wrote ${plan.path}`)
}

// ---- subagent tee (docs/SUBAGENTS.md 5.2) ------------------------------------------------------------------------

async function cmdInstallSubagentTee(env: BridgeEnv, args: string[], io: CliIO) {
  const { values } = parseArgs({
    args,
    options: {
      'agent-dir': { type: 'string' },
      scope: { type: 'string' },
      'claude-dir': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  })
  const usage = 'usage: talos-app install-subagent-tee --agent-dir <dir> [--scope project|user] [--dry-run]'
  if (!values['agent-dir']) throw new CliError(usage)
  const scope = values.scope ?? 'project'
  if (scope !== 'project' && scope !== 'user') throw new CliError(usage)
  const path = settingsPath(
    scope,
    resolve(values['agent-dir']),
    values['claude-dir'] ? resolve(values['claude-dir']) : undefined,
  )
  let plan: TeePlan
  try {
    plan = planSubagentTee(path, teeCommand(env.home))
  } catch (e) {
    if (e instanceof TeeInstallError) throw new CliError(e.message)
    throw e
  }
  for (const l of describeTeePlan(plan)) io.out(l)
  io.out(
    'The tee keeps the CLI subagent rows (label, tokens, start, model) in $TALOS_APP_HOME/state/agents-tee/<session>.json for the Talos mod. It runs only while subagent rows are on screen in the terminal.',
  )
  if (values['dry-run']) return io.out('dry run: nothing was written')
  if (!plan.after) return io.out('already up to date')
  const answer = await io.prompt(`Write subagentStatusLine to ${plan.path}? [y/N] `)
  if (!yes(answer)) return io.out('Not written.')
  try {
    writeTeePlan(plan)
  } catch (e) {
    if (e instanceof TeeInstallError) throw new CliError(e.message)
    throw e
  }
  io.out(`wrote ${plan.path}; restart Claude Code to pick it up`)
}

// ---- codex -----------------------------------------------------------------------------------------------------

async function cmdCodex(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps) {
  const [sub, ...rest] = args
  if (sub === 'check') {
    const c = await checkCodex()
    if (!c.ok) throw new CliError(c.message)
    return io.out(`codex ready (${c.version})`)
  }
  if (sub !== 'run') throw new CliError(CODEX_USAGE)
  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      thread: { type: 'string' },
      dir: { type: 'string' },
      sandbox: { type: 'string' },
      image: { type: 'string', multiple: true },
    },
    allowPositionals: true,
    strict: true,
  })
  const prompt = positionals.join(' ')
  if (!values.thread || !prompt) throw new CliError(CODEX_USAGE)
  const sandbox = values.sandbox ?? 'read-only'
  if (sandbox !== 'read-only' && sandbox !== 'workspace-write')
    throw new CliError('--sandbox must be read-only or workspace-write')
  for (const p of [values.dir, ...(values.image ?? [])])
    if (p !== undefined && !p.startsWith('/')) throw new CliError('--dir and --image need absolute paths')
  const bridge = await Bridge.create({ env, headless: true })
  try {
    const summary = await runCodex(
      {
        thread: values.thread,
        ...(values.dir ? { dir: values.dir } : {}),
        sandbox,
        images: values.image ?? [],
        prompt,
      },
      {
        call: async (tool, a) => {
          const r = await bridge.callTool(tool, a)
          return { text: r.content[0]?.text ?? '', isError: Boolean(r.isError) }
        },
        now: io.now,
        ...(deps.codexTimeoutMs ? { timeoutMs: deps.codexTimeoutMs } : {}),
      },
    )
    io.out(JSON.stringify(summary))
    if (!summary.ok) throw new CliError(summary.error ?? 'codex failed')
  } finally {
    await bridge.stop()
  }
}

// ---- entry ---------------------------------------------------------------------------------------------------------

// ---- update -------------------------------------------------------------------------------------------------------

/** A symlinked folder (/var -> /private/var) must compare equal to the path git prints. */
function realpathOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

/**
 * `talos-app update`: fast-forward this checkout and reinstall its packages, then say what is still left. It never restarts
 * the agent (a restart drops the live conversation) and never touches Railway, the Mac app or the phone.
 */
async function cmdUpdate(args: string[], io: CliIO, deps: CliDeps) {
  parseArgs({ args, options: {}, strict: true })
  const repo = deps.update?.repoDir ?? REPO_DIR
  const run = deps.update?.run ?? runCommand
  const git = (...a: string[]) => run(['git', ...a], repo)
  const top = git('rev-parse', '--show-toplevel')
  if (
    top.code !== 0 ||
    !existsSync(join(repo, 'apps', 'bridge', 'package.json')) ||
    realpathOr(top.out) !== realpathOr(repo)
  ) {
    throw new CliError(
      `this talos-app is not running from its own git checkout (${repo}), so it cannot update itself. Update the folder you cloned it from.`,
    )
  }
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD')
  if (branch.code !== 0 || !branch.out) {
    throw new CliError(
      `${repo} is on a detached HEAD (a worktree or a checked-out commit), so there is no branch to pull. Check out a branch first (git switch main), then run this again.`,
    )
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no')
  if (dirty.code !== 0) throw new CliError(`could not read the state of ${repo}: ${dirty.out}`)
  if (dirty.out) {
    throw new CliError(
      `${repo} has changes that are not committed, so it was left alone. Commit or stash them (git stash), then run this again.`,
    )
  }
  const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  if (upstream.code !== 0) {
    throw new CliError(`the branch ${branch.out} does not follow a remote branch, so there is nothing to pull from.`)
  }
  const version = () =>
    resolveVersion(repo, {
      run: (c, a, cwd) => {
        const r = run([c, ...a], cwd)
        return r.code === 0 ? r.out.trim() || undefined : undefined
      },
    })
  const before = version()
  const pull = git('pull', '--ff-only')
  if (pull.code !== 0) {
    throw new CliError(
      `git pull --ff-only failed, nothing was changed: ${pull.out.split('\n').slice(-3).join(' ')}\nIf your branch has commits of its own, merge or rebase by hand.`,
    )
  }
  const after = version()
  const moved = before.commit !== after.commit
  // Always install: a first run can pull and then fail at pnpm, and the commit has not moved on the second run (or after a hand
  // `git pull`). pnpm with a frozen lockfile and nothing to do is quick, and it is the only thing that proves node_modules matches.
  const install = run(['pnpm', 'install', '--frozen-lockfile'], repo)
  if (install.code !== 0) {
    throw new CliError(
      `the code is now at ${after.version}, but pnpm install --frozen-lockfile failed (${install.code === 127 ? 'pnpm is not installed: run corepack enable' : install.out.split('\n').slice(-3).join(' ')}). Fix that and run it in ${repo} before restarting the agent.`,
    )
  }
  io.out(
    moved
      ? `updated: ${before.version} -> ${after.version}`
      : `already up to date: ${after.version} (packages checked)`,
  )
  io.out('')
  io.out('What is left (this command changed the code on disk only; nothing was restarted):')
  io.out(
    '  1. Restart the agent. A bridge that was already running keeps its old code in memory until the agent restarts. Stop it, then run talos-app start --agent-dir <dir> again. talos-app never restarts the agent for you: that would end the live conversation.',
  )
  io.out(
    '  2. The relay deploys from Railway, not from this Mac. Check Railway after you push or merge, then run talos-app doctor.',
  )
  io.out(
    `  3. Mac app: run ${join(repo, 'apps', 'desktop', 'scripts', 'build-app.sh')}, then ${join(repo, 'apps', 'desktop', 'scripts', 'install.sh')} (it copies the new app to ~/Applications and opens it). build-app.sh alone leaves the old app in place.`,
  )
  io.out(
    `  4. Agent folder (the kit: hooks, scripts, skills, migrations): run ${join(repo, 'kit', 'scripts', 'upgrade.sh')} --into <your agent folder> --dry-run, read the plan, then run it again without --dry-run. It backs the folder up first and never touches your memory or wiki. The agent folder is not changed by this command.`,
  )
  io.out(
    '  5. iPhone: the web app (the Home Screen icon) picks up web changes on its next launch. A native iPhone app is one you built yourself (docs/ios.md): rebuild and install it again after a native change, or if you use TestFlight, upload a new build.',
  )
}

const CODEX_USAGE =
  'usage: talos-app codex check | codex run --thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- "<prompt>"'

const USAGE = `talos-app ${BRIDGE_VERSION}
  init --relay-url <url> [--config default|five-threads]
  enroll [--label <name>] [--no-qr] [--confirm]
  devices [revoke <id>]
  rotate
  start [--agent-dir <dir>] [--dry-run] [-- <claude flags>]
  status [--json]
  doctor [--agent-dir <dir>] [--deep]
  update
  rollback [--dry-run] [--yes] [--skip-data-check]
  restore-last-good [--list] [--version <n>] [--file <name>] [--newest-start] [--agent-dir <dir>] [--yes]
  logs [-n <lines>] [-f]
  trust on|off|show
  theme reset|show
  lead init <thread-id> --folder <dir> --agent-dir <dir> [--mcp <names>] [--sandbox | --light] | lead check <folder> [--agent-dir <dir>]
  report [--agent-dir <dir>] [--lines <n>] [--out <file>]
  post <thread> <text>
  digest [--since <ISO>]
  install-mcp --agent-dir <dir> [--dry-run]
  adopt --agent-dir <dir> [--dry-run] [--yes] [--repoint]
  install-ask-rules --agent-dir <dir> [--scope project|user] [--dry-run]
  install-guards [--remove]
  install-subagent-tee --agent-dir <dir> [--scope project|user] [--dry-run]
  subagent-tee [-- <your own subagentStatusLine command...>]
  codex check | codex run --thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- <prompt>
  schedules [adopt | notify <message>]
  errors list [--closed|--all] | show <id> | close <id>
  apps scan [--check] [--agent-dir <dir>] [--exclude-plugin <name>] | list | revoke <server|key-prefix> | login <server> | logout <server> | strict on|off
${V2_USAGE}`

export async function runCli(
  argv: string[],
  io: CliIO,
  envOverride?: Record<string, string | undefined>,
  deps: CliDeps = {},
): Promise<number> {
  const [cmd, ...rest] = argv
  // A thread's own session (a lead) works through its own tools: the mailbox commands read and write across threads.
  const raw = envOverride ?? process.env
  const refusal = workerCliRefusal(argv, raw, deps.cwd)
  if (refusal) {
    io.err(refusal)
    return 1
  }
  const env = loadEnv(raw)
  const gated = io.isTerminal === false ? terminalOnly(argv) : undefined
  if (gated) {
    io.err(
      `talos-app ${gated} only runs in Terminal, typed by you. Open Terminal on your Mac and run it there; it will not run from an agent, a script or a pipe.`,
    )
    return 1
  }
  try {
    switch (cmd) {
      case 'init':
        await cmdInit(env, rest, io)
        break
      case 'enroll':
        await cmdEnroll(env, rest, io, deps)
        break
      case 'devices':
        await cmdDevices(env, rest, io)
        break
      case 'rotate':
        await cmdRotate(env, io)
        break
      case 'status':
        await cmdStatus(env, rest, io, deps)
        break
      case 'start':
        return await cmdStart(rest, io, deps, env.home)
      case 'logs':
        await cmdLogs(env, rest, io, deps)
        break
      case 'report':
        await cmdReport(env, rest, io, deps)
        break
      case 'doctor':
        await cmdDoctor(env, rest, io, deps)
        break
      case 'update':
        await cmdUpdate(rest, io, deps)
        break
      case 'restore-last-good':
        return await (await import('./last-good.ts')).restoreLastGood(rest, io, envOverride) // normally dispatched by cli.ts
      case 'rollback':
        return await (await import('./rollback.ts')).runRollback(rest, io, envOverride, deps.rollback) // normally dispatched by cli.ts, which loads without this file
      case 'post':
        await cmdPost(env, rest, io)
        break
      case 'digest':
        await cmdDigest(env, rest, io)
        break
      case 'install-mcp':
        cmdInstallMcp(env, rest, io)
        break
      case 'adopt':
        return await (await import('./adopt.ts')).cmdAdopt(env, rest, io)
      case 'codex':
        await cmdCodex(env, rest, io, deps)
        break
      case 'trust':
        return cmdTrust(env, rest, io)
      case 'theme':
        return cmdTheme(env, rest, io)
      case 'lead':
        return (await import('./lead/cli.ts')).cmdLead(env, rest, io)
      case 'schedules':
        await cmdSchedules(env, rest, io)
        break
      case 'install-app-hooks':
        return (await import('./apps/cli.ts')).cmdInstallAppHooks(env, rest, io)
      case 'apps':
        return await (await import('./apps/cli.ts')).cmdApps(env, rest, io, deps.apps)
      case 'install-guards':
        return (await import('./guards/install.ts')).cmdInstallGuards(env, rest, io)
      case 'guard-hook':
        return await (await import('./guards/hook.ts')).mainGuardHook(rest)
      case 'install-ask-rules':
        await cmdInstallAskRules(rest, io)
        break
      case 'install-subagent-tee':
        await cmdInstallSubagentTee(env, rest, io)
        break
      case 'subagent-tee':
        return mainTee(rest) // normally dispatched by cli.ts before this module loads (docs/SUBAGENTS.md 5.2)
      case 'errors':
        return (await import('./problems/cli.ts')).cmdErrors(env, rest, io)
      case 'search':
      case 'memory':
      case 'share':
        return await cmdV2(cmd, env, rest, io, deps)
      default:
        io.out(USAGE)
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2
    }
    return 0
  } catch (e) {
    io.err(
      `talos-app: ${e instanceof RelayHttpError ? `relay said ${e.status}${e.detail ? `: ${e.detail}` : ''}` : (e as Error).message}`,
    )
    return 1
  }
}

export function terminalIO(): CliIO {
  return {
    isTerminal: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    async prompt(q) {
      process.stdout.write(q)
      for await (const line of console) return String(line)
      return ''
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  }
}
