// `talos-app` CLI (spec 4.8). Never opens the bridge socket (4.10): everything goes over the signed HTTP API or files.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { DeviceId, type Frame, HookDigestFrame, isIanaZone, signRotation } from '@talos-app/protocol'
import { Bridge } from './bridge.ts'
import { launchEnv } from './claude-env.ts'
import { checkCodex, runCodex } from './codex.ts'
import { assertSecureRelayUrl, type BridgeEnv, defaultHome, loadEnv, paths } from './config.ts'
import { parseConfig } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { cmdEnroll, type EnrollCli } from './enroll-cli.ts'
import { cmdEvents } from './events.ts'
import { ensureDir, readJsonFile, writeFileAtomic, writeJsonAtomic } from './fsutil.ts'
import { withGuardsSettings } from './guards/install.ts'
import { openHistory } from './history-store.ts'
import { commitRotation, ensureBridgeKey, loadBridgeKey, loadKeyFile, prepareRotation } from './keys.ts'
import { formatLogLine, tailLines } from './log-tail.ts'
import { installMcp, mcpEntry, mcpProtectedRoots, readMcpEntry } from './mcp-config.ts'
import { hookDigestNotification } from './notify.ts'
import { say } from './owner-words.ts'
import {
  AskRulesError,
  describePlan,
  headlessWarning,
  planAskRules,
  settingsPath,
  writePlan,
} from './permission/ask-rules.ts'
import { ownerHost } from './platform.ts'
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
import { terminalOnly, usageText } from './talos.ts'
import { cmdTheme } from './theme-cli.ts'
import { cmdTrust } from './trust-cli.ts'
import { cmdV2 } from './v2-cli.ts'
import { BRIDGE_COMMIT, BRIDGE_VERSION, commitReport, resolveVersion, versionSkew } from './version.ts'
import { isThreadCaller, threadOfCaller, workerCliRefusal } from './worker/cli-refusal.ts'

export type CliIO = {
  /** False when stdin or stdout is not a terminal. Absent (a test's io) counts as a terminal. */
  isTerminal?: boolean
  out(line: string): void
  err(line: string): void
  /** Asks a question on the terminal and returns the answer line. */
  prompt(question: string): Promise<string>
  sleep(ms: number): Promise<void>
  now(): number
  /** `enroll --json`: one event line, written at once. Absent: a synchronous write to stdout (enroll-cli.ts). */
  emit?(line: string): void
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
      return say({
        mac: `The relay turned away this Mac's request, and this Mac's clock is about ${mins} minute${mins === 1 ? '' : 's'} ${skew > 0 ? 'ahead of' : 'behind'} the relay's. The relay refuses requests more than 2 minutes off. Fix: set this Mac's date and time to automatic (System Settings > General > Date & Time), then run this again. The key itself is probably fine.`,
        linux: `The relay turned away this computer's request, and this computer's clock is about ${mins} minute${mins === 1 ? '' : 's'} ${skew > 0 ? 'ahead of' : 'behind'} the relay's. The relay refuses requests more than 2 minutes off. Fix: set this computer's date and time to automatic (timedatectl set-ntp true), then run this again. The key itself is probably fine.`,
      })
    }
  }
  const key = await loadKeyFile(paths(env.home).bridgeKey).catch(() => undefined)
  const line = key ? `BRIDGE_PUBKEY=${key.publicKeyB64}` : 'BRIDGE_PUBKEY=<run: talos-app init>'
  return `The relay turned away ${say({ mac: "this Mac's", linux: "this computer's" })} key. Most likely fix: in Railway open your relay service, set the variable ${line} and press Deploy (if you have run \`talos-app rotate\`, also set BRIDGE_PUBKEY_FORCE=1 for that one deploy, then remove it). If that line is already there, check ${say({ mac: "this Mac's", linux: "this computer's" })} date and time is set to automatic: the relay also answers 401 when the clock is more than 2 minutes off.`
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

const yes = (a: string) => /^\s*y(es)?\s*$/i.test(a)

// ---- enroll (enroll-cli.ts) ------------------------------------------------------------------------------------

function enrollCli(env: BridgeEnv, io: CliIO, deps: CliDeps): EnrollCli {
  const p = paths(env.home)
  return {
    http: () => httpFor(env),
    relayUrl: () => needRelay(env),
    bridge: () => describeBridge(bridgeLiveness(p.status, io.now(), deps.alive)),
    renderQr: (t) => renderQr(t),
    keyRefusedHint: (e) => keyRefusedHint(env, e),
    fail: (m) => new CliError(m),
  }
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

async function cmdRotate(env: BridgeEnv, args: string[], io: CliIO) {
  // nothing is written or sent for a call that is not exactly `rotate`: a new key pair is the first thing it makes
  if (args.length > 0) {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      io.out(
        'usage: talos-app rotate   (no arguments: makes a new bridge key, has the relay accept it, then switches to it)',
      )
      return
    }
    throw new CliError('usage: talos-app rotate (it takes no arguments)')
  }
  const p = paths(env.home)
  const http = await httpFor(env)
  const nowS = Math.floor(io.now() / 1000)
  const switched = (keyId: string, newPubkey: string) => {
    io.out(
      `rotated; new key id ${keyId}. The live bridge reconnects with it on its own; the old key stays valid at the relay for 5 minutes.`,
    )
    // The relay keeps the rotated key in its database, but its BRIDGE_PUBKEY variable on Railway still holds the OLD one.
    // If the volume is ever lost or restored, the relay falls back to that variable and trusts a dead key (audit D58).
    io.out('')
    io.out('Now update the relay: in Railway set BRIDGE_PUBKEY to this line, then press Deploy.')
    io.out(`BRIDGE_PUBKEY=${newPubkey}`)
    io.out(
      'Until you do, Railway still trusts the OLD key, and a restored or emptied relay volume would bring it back.',
    )
  }
  const commit = (keyId: string, newPubkey: string) => {
    try {
      commitRotation(p)
    } catch (e) {
      // the relay has switched; a running bridge may have finished the switch on its own (it tries bridge.key.next when
      // refused), so bridge.key may already be the new key
      throw new CliError(
        say({
          mac: `the relay switched to key ${keyId}, but this Mac could not finish the switch: ${(e as Error).message}. If the bridge is running it finishes it itself; otherwise run talos-app rotate again.`,
          linux: `the relay switched to key ${keyId}, but this computer could not finish the switch: ${(e as Error).message}. If the bridge is running it finishes it itself; otherwise run talos-app rotate again.`,
        }),
      )
    }
    switched(keyId, newPubkey)
  }

  // A bridge.key.next left by an earlier try (bug hunt core #9): the relay may have switched to it although its answer never
  // arrived. It is only CHECKED, signed with itself: the relay says yes only if it is already its active key. It is never the
  // target of a new rotation: a key that sat on disk may be as exposed as the one being replaced.
  let leftover: Awaited<ReturnType<typeof loadKeyFile>>
  try {
    leftover = await loadKeyFile(p.bridgeKeyNext)
  } catch {
    leftover = undefined // damaged: a fresh key replaces it below
  }
  const current = await loadBridgeKey(p)
  if (leftover && leftover.publicKeyB64 !== current.publicKeyB64) {
    const body = {
      new_pubkey: leftover.publicKeyB64,
      sig_new: await signRotation(leftover.privateKey, leftover.publicKeyB64, nowS),
      ts: nowS,
    }
    const kept = leftover
    try {
      const res = await new RelayHttp(needRelay(env), () => kept).rotate(body)
      return commit(res.key_id, leftover.publicKeyB64)
    } catch (e) {
      if (e instanceof CliError) throw e
      if (!(e instanceof RelayHttpError && e.status === 401))
        throw new CliError(
          `could not check the key an earlier rotation left (bridge.key.next): ${(e as Error).message}. bridge.key is unchanged; try again when the relay is reachable.`,
        )
      // 401: the relay does not trust it, so it never switched: a fresh key, as for a first try
    }
  }
  const prepared = await prepareRotation(p, nowS)
  let res: { key_id: string }
  try {
    res = await http.rotate({ new_pubkey: prepared.newPubkey, sig_new: prepared.sigNew, ts: prepared.ts })
  } catch (e) {
    throw new CliError(
      `rotation failed, bridge.key is unchanged: ${(e as Error).message}. If the relay switched without answering, the next talos-app rotate finds out and finishes it.`,
    )
  }
  commit(res.key_id, prepared.newPubkey)
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
    say({
      mac: `relay accepts this Mac: ${auth ? (auth.ok ? 'yes' : `NO. ${auth.message}`) : reachableBool === false ? 'unknown (relay not reachable)' : 'unknown'}`,
      linux: `relay accepts this computer: ${auth ? (auth.ok ? 'yes' : `NO. ${auth.message}`) : reachableBool === false ? 'unknown (relay not reachable)' : 'unknown'}`,
    }),
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
  /** `doctor` on WSL: what the WSL rows read (default: this machine); tests that print the whole doctor turn them off. */
  wsl?: import('./doctor-wsl.ts').WslProbe
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
    options: {
      'agent-dir': { type: 'string' },
      'claude-dir': { type: 'string' },
      deep: { type: 'boolean' },
      json: { type: 'boolean' },
    },
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
  // --json (the Windows tray's "Check Talos"): the rows only, one JSON line, exit 0 whatever they say (the levels carry it).
  // No key line: the tray copies the relay key from root's own record (talos-wsl.sh relay-key), never from talos's output.
  if (values.json) {
    io.out(JSON.stringify({ checks: checks.map((c) => ({ level: c.level, name: c.name, detail: c.detail })) }))
    return
  }
  for (const c of checks) io.out(`${c.level.padEnd(4)}  ${c.name}: ${c.detail}`)
  // The line the server needs when it turns this Mac's key away (the app's "key refused" banner points here).
  if (key) {
    io.out(
      `If the app says the server turned away ${say({ mac: "this Mac's", linux: "this computer's" })} key, put this line in the relay variables on Railway and deploy:`,
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

export { formatLogLine }

function parseCount(v: string | undefined, dflt: number, name: string): number {
  if (v === undefined) return dflt
  // digits only: Number() also reads 0x10, 1e1 and " 7 "
  if (!/^[0-9]+$/.test(v)) throw new CliError(`${name} needs a whole number from 1 to 5000`)
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new CliError(`${name} needs a whole number from 1 to 5000`)
  return n
}

/**
 * The bridge's log. Run from a thread session (a lead, Pantheon 2026-11-15) it shows only the lines that name that thread
 * (`thread` or `thread_id`); a session whose thread can't be told is refused.
 */
async function cmdLogs(env: BridgeEnv, args: string[], io: CliIO, deps: CliDeps, own: string | undefined | null) {
  const { values } = parseArgs({
    args,
    options: { lines: { type: 'string', short: 'n' }, follow: { type: 'boolean', short: 'f' } },
    strict: true,
  })
  const file = paths(env.home).log
  if (!existsSync(file))
    throw new CliError(`no log yet at ${file}. The bridge creates it when it starts (talos-app start).`)
  const n = parseCount(values.lines, 50, '-n')
  if (own === undefined)
    throw new CliError("this thread session's thread can't be told, so no log lines are shown. Ask the owner.")
  const mine = (l: string) => {
    if (own === null) return true
    try {
      const o = JSON.parse(l) as { thread?: unknown; thread_id?: unknown }
      return o.thread === own || o.thread_id === own
    } catch {
      return false
    }
  }
  const show = (l: string) => {
    if (mine(l)) io.out(redact(formatLogLine(l), { userHome: homedir(), appHome: env.home }))
  }
  for (const l of own === null ? tailLines(file, n) : tailLines(file, Number.MAX_SAFE_INTEGER).filter(mine).slice(-n))
    show(l)
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
  if (values.out && existsSync(values.out) && statSync(values.out).isDirectory())
    throw new CliError(
      `--out ${resolve(values.out)} is a folder; give a file path, for example ${join(resolve(values.out), 'talos-report.txt')}`,
    )
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
  const r = installMcp(
    agentDir,
    mcpEntry(BRIDGE_DIR, env.home, agentDir),
    Boolean(values['dry-run']),
    mcpProtectedRoots(env.home),
  )
  const where = r.target === r.path ? r.path : `${r.target} (through the link ${r.path})`
  io.out(`${r.changed ? (values['dry-run'] ? 'would write' : 'wrote') : 'already up to date:'} ${where}`)
  if (r.droppedEnv.length)
    io.out(
      `dropped env key${r.droppedEnv.length > 1 ? 's' : ''} ${r.droppedEnv.join(', ')}: the value is not a string (every string-valued key was kept)`,
    )
  if (values['dry-run']) io.out(JSON.stringify(r.config, null, 2))
}

async function cmdInstallAskRules(env: BridgeEnv, args: string[], io: CliIO) {
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
  // the project scope's file is in the agent's own folder, where the agent can make links: one into the Claude config folder
  // or the Talos home is refused (the user scope is the owner's own file)
  const claudeDir = values['claude-dir']
    ? resolve(values['claude-dir'])
    : (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'))
  const guard =
    scope === 'project'
      ? {
          root: resolve(values['agent-dir']),
          // the ones this shell names, and the defaults: the bridge may run with another TALOS_APP_HOME or CLAUDE_CONFIG_DIR
          protectedRoots: [...new Set([claudeDir, join(homedir(), '.claude'), env.home, defaultHome()])],
        }
      : { root: claudeDir }
  let plan: ReturnType<typeof planAskRules>
  try {
    plan = planAskRules(path, undefined, guard)
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
    `Write ${plan.added.length} rule${plan.added.length === 1 ? '' : 's'} to ${plan.target === plan.path ? plan.path : `${plan.target} (through the link ${plan.path})`}? [y/N] `,
  )
  if (!yes(answer)) return io.out('Not written.')
  try {
    writePlan(plan, guard)
  } catch (e) {
    if (e instanceof AskRulesError) throw new CliError(e.message)
    throw e
  }
  io.out(`wrote ${plan.target === plan.path ? plan.path : `${plan.target} (through the link ${plan.path})`}`)
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

// for folders only: a file's real path goes through realFileSync (real-file.ts), as realpath can name a hard-linked file by another of its names
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
/** The kit's release updater by its path, where plugin-release.py puts releases: no installer puts a `talos` command on PATH. */
function kitUpdater(e: Record<string, string | undefined> = process.env): string {
  const vendor =
    e.TALOS_KIT_HOME ||
    join(e.TALOS_VENDOR_DIR || join(e.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'talos'), 'kit')
  return join(resolve(vendor), 'current', 'talos-kit', 'bin', 'talos-update')
}

async function cmdUpdate(
  args: string[],
  io: CliIO,
  deps: CliDeps,
  procEnv: Record<string, string | undefined> = process.env,
) {
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
  // The pulled code's own Bun check, run by this Bun (the one the agent's bridge runs on): a newer floor arrives with the code.
  const floorCheck = join(repo, 'apps', 'bridge', 'src', 'bun-floor.ts')
  if (existsSync(floorCheck)) {
    const bun = run([process.execPath, '--no-env-file', floorCheck], repo)
    if (bun.code !== 0) {
      throw new CliError(
        bun.out.includes('is older than')
          ? `the code is now at ${after.version}, but this Bun is too old to run it. Do not restart the agent yet.\n${bun.out}`
          : `the code is now at ${after.version}, but its Bun check failed (${bun.out}). Run talos-app doctor before restarting the agent.`,
      )
    }
  }
  io.out(
    moved
      ? `updated: ${before.version} -> ${after.version}`
      : `already up to date: ${after.version} (packages checked)`,
  )
  io.out('')
  io.out('What is left (this command changed the code on disk only; nothing was restarted):')
  io.out(
    "  0. Sync your fork first, if you have not: the relay builds from your fork, and this command pulls the branch your clone follows. git fetch upstream, git switch main, git merge --ff-only upstream/main, git push origin main (or GitHub's Sync fork button, then git pull --ff-only), then run this again.",
  )
  io.out(
    '  1. Restart the agent. A bridge that was already running keeps its old code in memory until the agent restarts. Stop it, then run talos-app start --agent-dir <dir> again. talos-app never restarts the agent for you: that would end the live conversation.',
  )
  io.out(
    say({
      mac: '  2. The relay deploys from Railway, not from this Mac. Check Railway after you push or merge, then run talos-app doctor.',
      linux:
        '  2. The relay deploys from Railway, not from this computer. Check Railway after you push or merge, then run talos-app doctor.',
    }),
  )
  // the Mac app is a Mac's; elsewhere the supervisor runs the bridge's code, so it is what restarts for it
  if (ownerHost() === 'mac')
    io.out(
      `  3. Mac app: run ${join(repo, 'apps', 'desktop', 'scripts', 'build-app.sh')}, then ${join(repo, 'apps', 'desktop', 'scripts', 'install.sh')} (it copies the new app to ~/Applications and opens it). build-app.sh alone leaves the old app in place.`,
    )
  else
    io.out(
      '  3. The supervisor: restart it so it runs the new code: systemctl --user restart talos-supervisor (the thread sessions keep running).',
    )
  io.out(
    `  4. Agent folder (the kit): not changed by this command. An agent on the plugin layout (every new install) updates with ${kitUpdater(procEnv)} update --agent <your agent folder> --dry-run, then the same without --dry-run (the talos update of docs/SETUP.md; the first time, a release signing key is trusted once with talos-update trust-key <public-key-file>): it checks the release's signature, swaps it, runs the migrations and rolls back by itself if the agent does not load it. An older agent (hooks/ is a folder, not a link) uses ${join(repo, 'kit', 'scripts', 'upgrade.sh')} --into <your agent folder> --dry-run, then again without --dry-run; it backs the folder up first and never touches your memory or wiki.`,
  )
  io.out(
    '  5. iPhone: the web app (the Home Screen icon) picks up web changes on its next launch. A native iPhone app is one you built yourself (docs/ios.md): rebuild and install it again after a native change, or if you use TestFlight, upload a new build.',
  )
}

const CODEX_USAGE =
  'usage: talos-app codex check | codex run --thread <id> [--dir <abs>] [--sandbox read-only|workspace-write] [--image <abs>]... -- "<prompt>"'

const USAGE = usageText(BRIDGE_VERSION)

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
  // `adopt --dry-run` writes nothing and asks nothing, so it runs without a terminal: an installer checks adopt's refusals with
  // it before it writes anything. adopt itself (the write) stays terminal-only.
  const readOnly = cmd === 'adopt' && rest.includes('--dry-run')
  const gated = io.isTerminal === false && !readOnly ? terminalOnly(argv) : undefined
  // the three the agent runs when the owner asked (on-request-cli.ts); typed in a terminal they are the owner's own
  {
    const no = (await import('./on-request-cli.ts')).onRequestRefusal(env, argv, Date.now(), {
      terminal: io.isTerminal !== false,
    })
    if (no) {
      io.err(no)
      return 1
    }
  }
  if (gated) {
    io.err(
      say({
        mac: `talos-app ${gated} only runs in Terminal, typed by you. Open Terminal on your Mac and run it there; it will not run from an agent, a script or a pipe.`,
        linux: `talos-app ${gated} only runs in a terminal, typed by you. Open a terminal on this computer and run it there; it will not run from an agent, a script or a pipe.`,
        windows: `talos-app ${gated} needs a terminal, which Talos on a Windows PC doesn't offer.`,
      }),
    )
    return 1
  }
  try {
    switch (cmd) {
      case 'init':
        await cmdInit(env, rest, io)
        break
      case 'enroll':
        return await cmdEnroll(env, rest, io, enrollCli(env, io, deps))
      case 'devices':
        await cmdDevices(env, rest, io)
        break
      case 'rotate':
        await cmdRotate(env, rest, io)
        break
      case 'status':
        await cmdStatus(env, rest, io, deps)
        break
      case 'start':
        return await cmdStart(rest, io, deps, env.home)
      case 'logs':
        await cmdLogs(env, rest, io, deps, threadOfCaller(raw, deps.cwd))
        break
      case 'report':
        await cmdReport(env, rest, io, deps)
        break
      case 'doctor':
        await cmdDoctor(env, rest, io, deps)
        break
      case 'update':
        await cmdUpdate(rest, io, deps, envOverride ?? process.env)
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
      case 'supervise':
        return await (await import('./supervisor/cli.ts')).cmdSupervise(env, rest, io)
      case 'update-check':
        return (await import('./supervisor/update-check.ts')).cmdUpdateCheck(env, rest, io)
      case 'install-guards':
        return (await import('./guards/install.ts')).cmdInstallGuards(env, rest, io)
      case 'guard-hook':
        return await (await import('./guards/hook.ts')).mainGuardHook(rest)
      case 'guards':
        return (await import('./guards/refresh.ts')).cmdGuards(env, rest, io)
      case 'install-ask-rules':
        await cmdInstallAskRules(env, rest, io)
        break
      case 'install-subagent-tee':
        await cmdInstallSubagentTee(env, rest, io)
        break
      case 'subagent-tee':
        return mainTee(rest) // normally dispatched by cli.ts before this module loads (docs/SUBAGENTS.md 5.2)
      case 'events':
        return cmdEvents(rest, io)
      case 'errors':
        return (await import('./problems/cli.ts')).cmdErrors(env, rest, io, isThreadCaller(raw, deps.cwd))
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
