// `talos-app peer create|add|list|remove|rotate|secret-forget` and `talos-app devices list|revoke` for the agent (owner ruling
// 2026-11-19: "while we're in dev, I want all the agents to have as much autonomy as possible"). The pattern is on-request-cli.ts:
// "Lock Talos settings" refuses every agent run; a terminal is the owner's own and runs as it always did, lock on or off. A terminal can
// be faked (`script`): that skips the lock and every check here (a terminal returns before them), so against a faked terminal only the
// guards (install-guards) hold;
// anything else is an agent session and is judged here from the bridge's own records. These stay terminal-only: `enroll`, `rotate`
// (the bridge key), `trust on`, `install-guards --remove`. The guards, when installed, still deny these commands (talos.ts).
//
// (A) link, accept, create, add, rotate and revoke are refused while outside text reached ANY thread, a lead handed main anything, or the peer taint
//     stands, since the owner's latest words; one rule for every session, whatever it says it is (the session name is only for the audit line): Main's rule, and also outside text in a thread with its own session since his latest words in that thread. (B) revoke never takes the last approved device nor the one his
//     latest message came from. Every agent run writes one audit line to bridge.log; the CLI posts no thread row (the bridge posts
//     the rows for what it sees change: peer/changes.ts).
import { existsSync, readFileSync } from 'node:fs'
import { type AgentConfigT, DeviceId, PeerName, readWorkersFile, threadSessionMode } from '@talos-app/protocol'
import { LAST_OWNER_DEVICE_KEY, outsideRefusalForCli } from './agent-quiet.ts'
import { type BridgeEnv, paths } from './config.ts'
import { ConfigFile } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { type HistoryStore, openHistory } from './history-store.ts'
import { createLogger } from './log.ts'
import { type AGENT_UNLESS_LOCKED, agentUnlessLocked } from './talos.ts'
import { SETTINGS_LOCKED } from './trust.ts'
import { threadOfCaller } from './worker/cli-refusal.ts'
import { workersJsonPath } from './worker/files.ts'

/** Why `argv` may not run now, or undefined. Only an agent session (no terminal) is looked at beyond the lock. Writes the audit line. */
export function agentCliRefusal(
  env: BridgeEnv,
  argv: readonly string[],
  opts: { terminal: boolean; raw?: Record<string, string | undefined>; cwd?: string; now?: number },
): string | undefined {
  const name = agentUnlessLocked(argv)
  if (!name) return undefined
  const raw = opts.raw ?? process.env
  const caller = threadOfCaller(raw, opts.cwd)
  const session = caller === null ? 'main' : (caller ?? 'unknown')
  const target = [argv[2]].find(
    (t) => t !== undefined && (PeerName.safeParse(t).success || DeviceId.safeParse(t).success),
  )
  const verdict = judge(env, name, argv, opts.terminal, opts.now ?? Date.now())
  if (!opts.terminal) {
    try {
      createLogger(env.home, 'info').info('agent cli', {
        session,
        command: name,
        ...(target ? { target } : {}),
        outcome: verdict ? 'refused' : 'allowed',
      })
    } catch {
      // an audit line that cannot be written never stops the command; the bridge log is best effort
    }
  }
  return verdict
}

function judge(
  env: BridgeEnv,
  name: (typeof AGENT_UNLESS_LOCKED)[number],
  argv: readonly string[],
  terminal: boolean,
  now: number,
): string | undefined {
  // turning the relay's auto-update off only ever does less: always allowed
  if (name === 'relay auto' && argv[2] === 'off') return undefined
  const p = paths(env.home)
  const file = new ConfigFile(p.configJson, { log: { warn: () => {} } })
  try {
    file.load()
  } catch (e) {
    // no readable config.json: there is no lock to hold, so typed in a terminal the command goes on to its own handler; from the
    // agent the lock can't be read, so it is refused
    return terminal ? undefined : `talos-app: ${(e as Error).message}`
  }
  // A terminal runs exactly as today, the lock on or off (owner ruling on R2: the desktop app's Revoke-this-device runs the CLI under
  // a pty, and enroll and the bridge-key rotate are terminal-reachable already, so refusing a terminal protects nothing). The lock
  // holds against every agent run.
  if (terminal) return undefined
  if (file.config.settings_lock === true) return SETTINGS_LOCKED
  const gated =
    name === 'peer link' ||
    name === 'peer accept' ||
    name === 'peer create' ||
    name === 'peer add' ||
    name === 'peer rotate' ||
    name === 'devices revoke' ||
    name === 'relay update' ||
    name === 'relay auto' ||
    name === 'relay disconnect' ||
    name === 'sandbox off'
  if (!gated) return undefined
  // history.sqlite is where the outside text, the hand-offs and the taint are kept: without it nothing can be checked (fails closed)
  if (!existsSync(p.historyDb))
    return `talos-app ${name}: the message history is missing, so the agent cannot be checked and it is not run for the agent. The owner can run it in a terminal.`
  let store: HistoryStore | undefined
  try {
    store = openHistory(p.historyDb)
    const outside = outsideRefusalForCli(store, now, sessionThreads(env.home, file.config))
    if (outside) return `talos-app ${name}: ${outside}`
    if (name !== 'devices revoke') return undefined
    return revokeRefusal(p.devicesJson, argv[2], store)
  } catch (e) {
    return `talos-app ${name}: the message history can't be read (${(e as Error).message}), so it is not run for the agent.`
  } finally {
    store?.close()
  }
}

/** (B). Revoking the last approved device, or the one his latest message came from, is refused; so is anything with no record to check. */
export function revokeRefusal(
  devicesJson: string,
  id: string | undefined,
  store: HistoryStore | undefined,
): string | undefined {
  if (!id || !DeviceId.safeParse(id).success) return undefined // the command's own usage error
  const devices = new DeviceStore(devicesJson)
  if (devices.isCorrupt())
    return 'talos-app devices revoke: devices.json is unreadable, so it is not run for the agent.'
  const target = devices.get(id)
  if (!target || target.revoked_at) return undefined // never approved, or already revoked: nothing to lock out
  if (!devices.list().some((d) => d.id !== id && !d.revoked_at))
    return 'talos-app devices revoke: that is the last approved device; revoking it would lock the owner out. He can do it in a terminal.'
  let latest: string | undefined
  try {
    latest = (JSON.parse(store?.kvGet(LAST_OWNER_DEVICE_KEY) ?? 'null') as { device_id?: unknown } | null)?.device_id as
      | string
      | undefined
  } catch {
    latest = undefined
  }
  if (typeof latest !== 'string')
    return "talos-app devices revoke: I can't tell which device the owner's latest message came from, so no approved device is revoked for the agent. He can do it in a terminal."
  if (latest === id)
    return "talos-app devices revoke: that is the device the owner's latest message came from; revoking it would lock him out. He can do it in a terminal."
  return undefined
}

/** Of workers.json, the states of a session that is still there: it may run a tool, then it parks. */
const LIVE_STATES = new Set(['starting', 'live', 'busy', 'parking', 'stopping'])

/**
 * The threads that may have a session talking right now: the config's dedicated, non-archived threads, PLUS every thread the
 * supervisor's status file (workers.json) still lists as not stopped, since a session finishes its turn after its thread was switched
 * to shared, archived, or the master switch went off (supervisor/workers.ts). A status file that exists but cannot be read or parsed
 * fails closed: every thread. No file at all means no supervisor ever ran here, so no session.
 */
export function sessionThreads(home: string, config: AgentConfigT): string[] | 'all' {
  const ids = new Set(
    config.threads.filter((t) => !t.archived && threadSessionMode(config, t.id) === 'dedicated').map((t) => t.id),
  )
  const path = workersJsonPath(home)
  if (!existsSync(path)) return [...ids]
  let file: ReturnType<typeof readWorkersFile> = null
  try {
    file = readWorkersFile(readFileSync(path, 'utf8'))
  } catch {
    return 'all'
  }
  if (!file) return 'all'
  for (const [id, e] of Object.entries(file.threads)) if (LIVE_STATES.has(e.state)) ids.add(id)
  for (const id of file.unavailable) ids.add(id) // an entry this build can't read may be a running session
  return [...ids]
}
