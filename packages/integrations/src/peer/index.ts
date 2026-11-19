// Linked agents: an inert catalog entry. The relay's peer inbox does NOT go through this module (apps/relay/src/hooks/peer.ts handles
// `peer` in ingest before the generic path: the module interface can only return events for the pipeline, and a peer message must
// not become one). So verify refuses and normalize returns nothing: if a delivery ever reached the generic path, it would carry nothing.
import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { peerSetup } from './setup.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'peer',
  setup: peerSetup,
  verify: () => ({ ok: false, reason: 'peer is not available yet' }),
  normalize: () => [],
  prefilter: () => false,
}
