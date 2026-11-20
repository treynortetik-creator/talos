// Linked agents: the connections THIS install made on its own relay (`talos-app peer create`), kept by the CLI and read by the
// bridge to tell which `peer.message` frames belong to a connection that still exists. A small 0600 file in the Talos home, not
// the bridge's database: the CLI writes it without the bridge running, and a `peer remove` takes effect on the next frame.
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'

export const PEERS_INBOUND_FILE = 'peers-inbound.json'
/**
 * `secret_file`: when an agent run left a secret file for this inbox, and which kind: `create` (the sender has the secret from the
 * start, so the first message proves it was carried over) or `rotate` (the old secret works for 24 hours, so a message inside that
 * window may still be signed with it and proves nothing).
 */
/** How long the old secret of a rotated inbox keeps working (the relay's rule). */
export const PEER_ROTATE_GRACE_MS = 24 * 3600_000
export type SecretFileMark = { kind: 'create' | 'rotate'; at: number }
/**
 * One-paste link state of this record. `by`: `link` (this install showed the code) or `accept` (it pasted one). `state`: `open` (the code
 * is out), `done` (linked: the other side's url and secret are stored), `closed` (ended without a link). `until` (epoch ms): the bridge
 * keeps asking the relay about the code until then, so a second use of it is noticed. `taken`: the owner was told someone else may hold it.
 */
export type LinkMark = {
  by: 'link' | 'accept'
  state: 'open' | 'done' | 'closed'
  until: number
  cap?: number
  taken?: true
  expired?: true
}
export type InboundPeer = { name: string; conn_id: string; secret_file?: SecretFileMark; link?: LinkMark }

const file = (home: string): string => join(home, PEERS_INBOUND_FILE)

export function readInboundPeers(home: string): InboundPeer[] {
  const raw = readJsonFile<{ v?: unknown; peers?: unknown }>(file(home))
  if (raw?.v !== 1 || !Array.isArray(raw.peers)) return []
  return raw.peers
    .filter(
      (p): p is InboundPeer =>
        typeof p === 'object' && p !== null && typeof p.name === 'string' && typeof p.conn_id === 'string',
    )
    .map((p) => {
      const m = (p as { secret_file?: Partial<SecretFileMark> }).secret_file
      const mark =
        m && (m.kind === 'create' || m.kind === 'rotate') && Number.isFinite(m.at)
          ? { kind: m.kind, at: m.at as number }
          : undefined
      const l = (p as { link?: Partial<LinkMark> }).link
      const link: LinkMark | undefined =
        l &&
        (l.by === 'link' || l.by === 'accept') &&
        (l.state === 'open' || l.state === 'done' || l.state === 'closed') &&
        Number.isFinite(l.until)
          ? {
              by: l.by,
              state: l.state,
              until: l.until as number,
              ...(Number.isInteger(l.cap) ? { cap: l.cap as number } : {}),
              ...(l.taken === true ? { taken: true as const } : {}),
              ...(l.expired === true ? { expired: true as const } : {}),
            }
          : undefined
      return { name: p.name, conn_id: p.conn_id, ...(mark ? { secret_file: mark } : {}), ...(link ? { link } : {}) }
    })
}

const write = (home: string, peers: InboundPeer[]): void => writeJsonAtomic(file(home), { v: 1, peers })

/** Adds the connection, replacing one of the same name. */
export function addInboundPeer(home: string, p: InboundPeer): void {
  write(home, [...readInboundPeers(home).filter((x) => x.name !== p.name), p])
}

/** True when there was one to remove. */
export function removeInboundPeer(home: string, name: string): boolean {
  const all = readInboundPeers(home)
  const rest = all.filter((x) => x.name !== name)
  if (rest.length === all.length) return false
  write(home, rest)
  return true
}

export const inboundPeerByConn = (home: string, connId: string): InboundPeer | undefined =>
  readInboundPeers(home).find((p) => p.conn_id === connId)

/** The key the signing secret of a configured peer is kept under in the SecretStore. */
export const PEER_SECRET_SERVICE = 'com.talos.app.peer'
export const peerSecretAccount = (name: string): string => `peer:${name}`
