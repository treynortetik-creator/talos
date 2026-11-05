import type { IntegrationIdT, SetupSpecT } from '@talos-app/protocol'
import { SetupSpec } from '@talos-app/protocol'
import type { IntegrationModule } from '../types.ts'
import type { ModuleExtras } from './common.ts'
import { normalizeGeneric } from './normalize.ts'
import { genericAppSetup } from './setup.ts'
import { verifyGeneric } from './verify.ts'

/** A `generic`-style module: same verifier and normalizer, its own setup copy (zapier, make, n8n reuse this). */
export function genericFamilyModule(setup: SetupSpecT): IntegrationModule & ModuleExtras {
  const spec = SetupSpec.parse(setup)
  const id: IntegrationIdT = spec.id
  return {
    id,
    setup: spec,
    verify: verifyGeneric,
    normalize: (raw, conn) => normalizeGeneric(id, raw, conn),
    sample: () => ({
      title: 'Test event from Talos',
      summary: 'If you can read this in your Inbox, the connection works.',
      url: 'https://example.com/talos-test',
      priority: 'normal',
    }),
  }
}

export const integration: IntegrationModule & ModuleExtras = genericFamilyModule(genericAppSetup)
