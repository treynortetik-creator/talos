// Linked agents: the connections THIS install made on its own relay (`talos-app peer create`), kept by the CLI and read by the
// bridge to tell which `peer.message` frames belong to a connection that still exists. A small 0600 file in the Talos home, not
// the bridge's database: the CLI writes it without the bridge running, and a `peer remove` takes effect on the next frame.
import { join } from 'node:path'
import { readJsonFile, writeJsonAtomic } from '../fsutil.ts'

export const PEERS_INBOUND_FILE = 'peers-inbound.json'
export type InboundPeer = { name: string; conn_id: string }

const file = (home: string): string => join(home, PEERS_INBOUND_FILE)

export function readInboundPeers(home: string): InboundPeer[] {
  const raw = readJsonFile<{ v?: unknown; peers?: unknown }>(file(home))
  if (raw?.v !== 1 || !Array.isArray(raw.peers)) return []
  return raw.peers.filter(
    (p): p is InboundPeer =>
      typeof p === 'object' && p !== null && typeof p.name === 'string' && typeof p.conn_id === 'string',
  )
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
