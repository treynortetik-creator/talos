// `talos-app peer create|add|list|remove|rotate|secret-forget` and `talos-app devices list|revoke` for the agent (owner ruling
// 2026-11-19: "while we're in dev, I want all the agents to have as much autonomy as possible"). The pattern is on-request-cli.ts:
// "Lock Talos settings" refuses every agent run; a terminal is the owner's own and runs as it always did, lock on or off. A terminal can
// be faked (`script`): that skips the lock and every check here (a terminal returns before them), so against a faked terminal only the
// guards (install-guards) hold;
// anything else is an agent session and is judged here from the bridge's own records. These stay terminal-only: `enroll`, `rotate`
// (the bridge key), `trust on`, `install-guards --remove`. The guards, when installed, still deny these commands (talos.ts).
//
// (A) link, accept, create, add, rotate and revoke are refused while outside text reached ANY thread, a lead handed main anything, or the peer taint
//     stands, since the owner's latest words; one rule for every session (the session name is only for the audit line). (B) revoke never takes the last approved device nor the one his
//     latest message came from. Every agent run writes one audit line to bridge.log; the CLI posts no thread row (the bridge posts
//     the rows for what it sees change: peer/changes.ts).
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DeviceId, PeerName } from '@talos-app/protocol'
import { type BridgeEnv, paths } from './config.ts'
import { ConfigFile } from './config-file.ts'
import { DeviceStore } from './devices.ts'
import { type HistoryStore, openHistory } from './history-store.ts'
import { createLogger } from './log.ts'
import { readTaint } from './peer/taint.ts'
import { isShareOnly } from './share-only.ts'
import { type AGENT_UNLESS_LOCKED, accountHome, agentUnlessLocked } from './talos.ts'
import { outsideTextAt, SETTINGS_LOCKED } from './trust.ts'
import { threadOfCaller } from './worker/cli-refusal.ts'
import { anyLeadSpokeSince } from './worker/handoff.ts'

/** kv key: the device the owner's most recent message came from, `{device_id, at}` (inbound-messages.ts `noteOwnerDevice`). */
export const LAST_OWNER_DEVICE_KEY = 'last_owner_device'

const OUTSIDE_WHY =
  'outside text (a message from a linked agent, a hook, a shared page) or a hand-off from another session reached the agent since the owner last spoke, so it is not run for the agent now. The owner can ask again in his own words, or run it in a terminal.'

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
    name === 'devices revoke'
  if (!gated) return undefined
  // history.sqlite is where the outside text, the hand-offs and the taint are kept: without it nothing can be checked (fails closed)
  if (!existsSync(p.historyDb))
    return `talos-app ${name}: the message history is missing, so the agent cannot be checked and it is not run for the agent. The owner can run it in a terminal.`
  let store: HistoryStore | undefined
  try {
    store = openHistory(p.historyDb)
    const outside = outsideRefusal(store, now)
    if (outside) return `talos-app ${name}: ${outside}`
    if (name !== 'devices revoke') return undefined
    return revokeRefusal(p.devicesJson, argv[2], store)
  } catch (e) {
    return `talos-app ${name}: the message history can't be read (${(e as Error).message}), so it is not run for the agent.`
  } finally {
    store?.close()
  }
}

/**
 * (A), one rule for every agent session, main or a thread's own (modelled on config-propose/service.ts `fenceQuiet`): since the
 * owner's latest words in ANY thread (a share is not him speaking), nothing outside may have reached ANY thread (outside text, a
 * sub-thread's included), no lead may have handed main anything (a hand-off is trust agent, so it never sets outside text, and a
 * thread that was hit by a hook can ask main to do it), and the peer taint must be empty. The session label (env variable, marker)
 * is never an input here: a session that lies about it gains nothing. With no record of him speaking, anything outside refuses.
 */
function outsideRefusal(store: HistoryStore, now: number): string | undefined {
  const spoke = ownerWordsAt(store, now)
  // every thread that ever got outside text has a kv key, whether or not the thread is still in config.json
  const threads = store.kvKeys(OUTSIDE_PREFIX).map((k) => k.slice(OUTSIDE_PREFIX.length))
  for (const t of threads) {
    const at = outsideTextAt({ store }, t)
    if (at !== undefined && at >= spoke) return OUTSIDE_WHY
  }
  // a hand-off query that errors refuses (fails closed); a table that is not there yet is simply no hand-off
  if (anyLeadSpokeSince(store.db, spoke, now, true)) return OUTSIDE_WHY
  if (readTaint({ store }))
    return 'a message from a linked agent may still be what the main session is working on, so it is not run for the agent now. The owner can ask again in his own words, or run it in a terminal.'
  return undefined
}

const OUTSIDE_PREFIX = 'outside_text_at:'

/**
 * When the owner last spoke, on the bridge's own clock. What is used, exactly: the time the bridge RECEIVED his latest message
 * (kv `last_owner_device`.at, written by `noteOwnerDevice` for every signed message that is not a share), never the time the phone
 * put on it, so a phone clock that runs fast cannot hide outside text that arrived after his words. A bridge that has not yet
 * received a message since this was added has no such time: then the newest non-share owner row's own time is used, never later than
 * now (a row from a fast phone is clamped to now, which can still be too late for that one message). 0 when he never spoke.
 */
function ownerWordsAt(store: HistoryStore, now: number): number {
  try {
    const at = (JSON.parse(store.kvGet(LAST_OWNER_DEVICE_KEY) ?? 'null') as { at?: unknown } | null)?.at
    if (typeof at === 'number' && Number.isFinite(at)) return at
  } catch {
    // unreadable: fall back to the rows
  }
  for (const m of store.ownerRowsSince(new Date(0).toISOString(), 500)) {
    if (isShareOnly(m)) continue
    return Math.min(Date.parse(m.created_at), now) // newest first: the first one that counts
  }
  return 0
}

/**
 * Keychain-wide stores (the macOS Keychain, the Secret Service) key a peer secret by name only, not by Talos home: an agent run
 * that points TALOS_APP_HOME at a home of its own, with no lock and no history, would otherwise write over the real peer's secret.
 * So from an agent run the home must be the account's default one when the store is not the per-home file store.
 */
export function agentKeyStoreRefusal(home: string, backend: string): string | undefined {
  if (backend === 'file_0600') return undefined
  const mine = accountHome()
  if (mine !== null && resolve(home) === join(mine, '.config', 'talos', 'app')) return undefined
  return "talos-app: this computer's key store is shared by every Talos home, so the agent runs this only on the default home (TALOS_APP_HOME unset or the default). The owner can run it in a terminal."
}

/** (B). Revoking the last approved device, or the one his latest message came from, is refused; so is anything with no record to check. */
function revokeRefusal(
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
