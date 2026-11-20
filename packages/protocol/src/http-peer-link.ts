// The three one-paste link routes of the route table (http.ts spreads them into `routes`; kept here so http.ts stays under its size limit).
import { z } from 'zod'
import type { RouteDef } from './http.ts'
import { PeerLinkMinted, PeerLinkRedeem, PeerLinkRedeemed, PeerLinkState } from './peer-link.ts'

const Empty = z.object({})

export const peerLinkRouteDefs = {
  peerLinkMint: {
    id: 'peerLinkMint',
    method: 'POST',
    path: '/bridge/peers/:name/link',
    auth: 'bridge-sig',
    owner: 'WP3',
    req: Empty,
    res: PeerLinkMinted,
    note: 'one-paste link: a single-use code (15 min) for this inbox; a new one replaces the open one. 404 not_found; 409 link_origin (the relay origin cannot make a code) | link_pending (a redeemed code is not collected yet)',
  },
  peerLinkGet: {
    id: 'peerLinkGet',
    method: 'GET',
    path: '/bridge/peers/:name/link',
    auth: 'bridge-sig',
    owner: 'WP3',
    res: PeerLinkState,
    note: 'state of the latest code; after a redeem the first GET returns back_url and back_secret ONCE and the state becomes collected. 404 not_found',
  },
  peerLinkRedeem: {
    id: 'peerLinkRedeem',
    method: 'POST',
    path: '/peer-link/redeem',
    auth: 'none',
    owner: 'WP3',
    req: PeerLinkRedeem,
    res: PeerLinkRedeemed,
    note: 'the other install redeems a code: returns this inbox secret once and stores its back url and secret. Every failure is one 404 link_unusable; failures are rate limited (429)',
  },
} as const satisfies Record<string, RouteDef>
