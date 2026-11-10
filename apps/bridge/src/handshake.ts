// Bridge side of the WebSocket handshake (spec 3.4, 5.4): challenge -> hello (Ed25519 over the challenge string).
import {
  DRIVING_FEATURE,
  FOLDERS_FEATURE,
  type Frame,
  HEALTH_FEATURE,
  HEARTBEAT_FEATURE,
  MEMORY_FEATURE,
  NATIVE_ACT_FEATURE,
  newUlid,
  ORIGINAL_TS_FEATURE,
  PROBLEMS_FEATURE,
  RUN_FEATURE,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  SEARCH_FEATURE,
  SESSION_FEATURE,
  SPEAK_FEATURE,
  signChallenge,
  THREAD_SESSIONS_FEATURE,
  THREADS_FEATURE,
} from '@talos-app/protocol'
import { isLoopbackUrl } from './config.ts'
import type { KeyMaterial } from './keys.ts'

/**
 * `hello.client.features`: what THIS bridge implements right now (docs/V2-FEATURES.md V1). Search and memory need the
 * FTS5 probe; driving mode is the reply path (always on); health is advertised once WP-V1's beat runs. Max 20 entries.
 */
export function bridgeFeatures(svc: {
  search?: { available: boolean } | undefined
  memory?: { available: boolean } | undefined
  health?: { available: boolean } | undefined
  speak?: { available: boolean } | undefined
  /** The folder picker (src/folders): present on a live main bridge, which is the one that answers `fs.list`. */
  folders?: { available: boolean } | undefined
  /** Problem reports (docs/ERRORS.md): present on a live bridge, which is the one that files them. */
  problems?: unknown
}): string[] {
  return [
    SCHEDULES_FEATURE,
    SCHEDULES_FEATURE_V2,
    HEARTBEAT_FEATURE,
    NATIVE_ACT_FEATURE,
    SESSION_FEATURE,
    DRIVING_FEATURE,
    ORIGINAL_TS_FEATURE,
    RUN_FEATURE,
    THREADS_FEATURE,
    THREAD_SESSIONS_FEATURE,
    ...(svc.search?.available ? [SEARCH_FEATURE] : []),
    ...(svc.memory?.available ? [MEMORY_FEATURE] : []),
    ...(svc.health?.available ? [HEALTH_FEATURE] : []),
    // always on once installed: with no TTS command the button explains it, which needs the Mac to answer
    ...(svc.speak?.available ? [SPEAK_FEATURE] : []),
    ...(svc.problems ? [PROBLEMS_FEATURE] : []),
    ...(svc.folders?.available ? [FOLDERS_FEATURE] : []),
  ]
}

type Challenge = Extract<Frame, { type: 'challenge' }>

/**
 * The signature covers `relay_host`, so a challenge naming another host would let a rogue server obtain a signature
 * that is valid there. Refuse it. Loopback URLs (dev and tests) are exempt: their host is never the public name.
 */
export function challengeHostOk(relayUrl: string, challenge: Pick<Challenge, 'relay_host'>): boolean {
  if (isLoopbackUrl(relayUrl)) return true
  const u = new URL(relayUrl)
  const want = u.host.toLowerCase()
  const got = challenge.relay_host.toLowerCase()
  return got === want || got === u.hostname.toLowerCase()
}

export async function buildHello(args: {
  challenge: Challenge
  key: KeyMaterial
  client: { name: string; version: string }
  /** Optional capabilities for `hello.client.features`, e.g. 'schedules/1' (docs/SCHEDULES.md S1.5). */
  features?: readonly string[]
  agentConfigRev: number
  now: () => number
}) {
  const sig = await signChallenge(args.key.privateKey, {
    nonce: args.challenge.nonce,
    relay_host: args.challenge.relay_host,
    server_time: args.challenge.server_time,
  })
  return {
    v: 1 as const,
    type: 'hello' as const,
    id: newUlid(),
    ts: new Date(args.now()).toISOString(),
    role: 'bridge' as const,
    key_id: args.key.keyId,
    sig,
    client: args.features?.length ? { ...args.client, features: [...args.features] } : args.client,
    agent_config_rev: args.agentConfigRev,
  }
}
