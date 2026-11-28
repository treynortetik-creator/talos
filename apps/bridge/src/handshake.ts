// Bridge side of the WebSocket handshake (spec 3.4, 5.4): challenge -> hello (Ed25519 over the challenge string).
import {
  AGENTS_MD_FEATURE,
  ALWAYS_ALLOW_2_FEATURE,
  ALWAYS_ALLOW_FEATURE,
  ATTEST_FEATURE,
  DRIVING_FEATURE,
  FILES_FEATURE,
  FILES_PUT_FEATURE,
  FILES_SENT_FEATURE,
  FOLDERS_FEATURE,
  type Frame,
  HEALTH_FEATURE,
  HEARTBEAT_FEATURE,
  HOST_LINUX_FEATURE,
  HOST_MAC_FEATURE,
  HOST_WINDOWS_FEATURE,
  type Host,
  MEMORY_FEATURE,
  MEMORY_GRAPH_FEATURE,
  MEMORY_ROOTS_FEATURE,
  NATIVE_ACT_FEATURE,
  newUlid,
  ORIGINAL_TS_FEATURE,
  PEER_FEATURE,
  PLUGIN_ADD_FEATURE,
  PROBLEMS_FEATURE,
  PROBLEMS_INSTALL_FEATURE,
  RUN_FEATURE,
  RUN_PANE_FEATURE,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  SEARCH_FEATURE,
  SESSION_FEATURE,
  SETTINGS_LOCK_FEATURE,
  SPEAK_FEATURE,
  SUBTHREADS_FEATURE,
  signChallenge,
  TERM_VIEW_FEATURE,
  THEMES_V2_FEATURE,
  THREAD_SESSIONS_FEATURE,
  THREADS_FEATURE,
} from '@talos-app/protocol'
import { isLoopbackUrl } from './config.ts'

import type { KeyMaterial } from './keys.ts'
import { ownerHost } from './platform.ts'

/**
 * `hello.client.features`: what THIS bridge implements right now (docs/V2-FEATURES.md V1). Search and memory need the
 * FTS5 probe; driving mode is the reply path (always on); health is advertised once WP-V1's beat runs. Most important
 * first: an older relay or app sees the first FEATURES_MAX_V1; the hello itself is cut to what the relay takes (helloFeatures).
 */
/**
 * What kind of computer this is (packages/protocol/src/host.ts): the app's wording follows it. The Windows PC is Talos's own
 * distro, by root's marker (platform.ts), not any WSL: a developer's WSL Ubuntu gets the terminal's words (Pantheon 2026-11-14).
 */
export function hostFeature(host: Host = ownerHost()): string {
  return host === 'mac' ? HOST_MAC_FEATURE : host === 'windows' ? HOST_WINDOWS_FEATURE : HOST_LINUX_FEATURE
}

export function bridgeFeatures(svc: {
  search?: { available: boolean } | undefined
  memory?: { available: boolean } | undefined
  health?: { available: boolean } | undefined
  speak?: { available: boolean } | undefined
  /** The folder picker (src/folders): present on a live main bridge, which is the one that answers `fs.list`. */
  folders?: { available: boolean } | undefined
  /** The Files pane (src/files): present on a live main bridge, which is the one that answers `files.*`. */
  files?: { available: boolean } | undefined
  /** The thread's AGENTS.md in its settings (src/files/agents-md.ts): present beside the Files pane, on a live main bridge. */
  agentsMd?: { available: boolean } | undefined
  /** Uploads into a thread's folder (src/files/put.ts): beside the Files pane, on a live main bridge. */
  filesPut?: { available: boolean } | undefined
  /** The files sent in Talos (src/files/sent.ts): from history, on the live bridge. */
  filesSent?: { available: boolean } | undefined
  /** Which folders Notes shows (src/memory/roots.ts): a live main bridge. */
  memoryRoots?: { available: boolean } | undefined
  /** Problem reports (docs/ERRORS.md): present on a live bridge, which is the one that files them. */
  problems?: unknown
  /** Linked agents (src/peer): present on a live main bridge, which is the one that takes `peer.message`. */
  peers?: unknown
  /** Run in the terminal pane (src/pane-run.ts): only while the Mac app's run channel answers. */
  paneRun?: { available: boolean } | undefined
  /** The read-only terminal view (src/term): the live main bridge with tmux. */
  term?: { available: boolean } | undefined
  /** "Add plugin to agent" (src/plugins): present on a live main bridge, which is the one that answers `plugin.add.request`. */
  agentPlugins?: unknown
  /** Sub-threads: advertised only while the Mac app reports it checks a sub-thread's folder (workers.json). */
  config?: { subthreadsSupported?(): boolean }
}): string[] {
  // Order matters: a page that reads only the first FEATURES_MAX_V1 (the relay passes an older one that many) loses the
  // tail. The keep-list comes first (APP_KEEP_FEATURES in test/features-budget.test.ts: what an older page cannot do
  // without), then the rest; a new feature goes at the end, where it is the one an older page goes without.
  return [
    hostFeature(),
    THREADS_FEATURE,
    THREAD_SESSIONS_FEATURE,
    SESSION_FEATURE,
    RUN_FEATURE,
    ORIGINAL_TS_FEATURE,
    DRIVING_FEATURE,
    ...(svc.config?.subthreadsSupported?.() ? [SUBTHREADS_FEATURE] : []),
    SCHEDULES_FEATURE,
    SCHEDULES_FEATURE_V2,
    HEARTBEAT_FEATURE,
    NATIVE_ACT_FEATURE,
    ...(svc.search?.available ? [SEARCH_FEATURE] : []),
    ...(svc.memory?.available ? [MEMORY_FEATURE] : []),
    // the 3D graph of the notes: whenever the memory browser is there to build it
    ...(svc.memory?.available ? [MEMORY_GRAPH_FEATURE] : []),
    ...(svc.health?.available ? [HEALTH_FEATURE] : []),
    // always on once installed: with no TTS command the button explains it, which needs the Mac to answer
    ...(svc.speak?.available ? [SPEAK_FEATURE] : []),
    ...(svc.problems ? [PROBLEMS_FEATURE] : []),
    ...(svc.folders?.available ? [FOLDERS_FEATURE] : []),
    ...(svc.files?.available ? [FILES_FEATURE] : []),
    ...(svc.agentsMd?.available ? [AGENTS_MD_FEATURE] : []),
    ...(svc.filesPut?.available ? [FILES_PUT_FEATURE] : []),
    ...(svc.filesSent?.available ? [FILES_SENT_FEATURE] : []),
    ...(svc.memoryRoots?.available ? [MEMORY_ROOTS_FEATURE] : []),
    SETTINGS_LOCK_FEATURE,
    ALWAYS_ALLOW_FEATURE,
    ...(svc.problems ? [PROBLEMS_INSTALL_FEATURE] : []),
    ...(svc.peers ? [PEER_FEATURE] : []),
    // the form in Settings > Plugins is shown only to a bridge that lists it (an older one would ignore the frame); before attest/1
    ...(svc.agentPlugins ? [PLUGIN_ADD_FEATURE] : []),
    // the config takes every stock theme id (iris, harbor): always on, last, where an older page goes without it
    THEMES_V2_FEATURE,
    // reads the newer Always allow kinds (generic, schedule, undo, config); before attest/1, which a test pins last
    ALWAYS_ALLOW_2_FEATURE,
    // answers a phone's attest.request (BYOR phase 4): last, where an older page goes without it
    ATTEST_FEATURE,
    // last: an older page goes without it. Only while the Mac app's run channel is connected
    ...(svc.paneRun?.available ? [RUN_PANE_FEATURE] : []),
    // after everything else: a page that reads only the first 20 goes without it, as it goes without the view
    ...(svc.term?.available ? [TERM_VIEW_FEATURE] : []),
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
  /** A replaced bridge asking back in: the relay turns it away while another bridge is connected (`BRIDGE_STANDBY_FEATURE`). */
  standby?: boolean
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
    ...(args.standby ? { standby: true as const } : {}),
  }
}
