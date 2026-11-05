// Heartbeat (work gate only): never an inbound source. Every delivery is refused, so a connection for it can carry nothing.
import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { heartbeatSetup } from './setup.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'heartbeat',
  setup: heartbeatSetup,
  verify: () => ({ ok: false, reason: 'heartbeat is not an inbound integration' }),
  normalize: () => [],
  prefilter: () => false,
}
