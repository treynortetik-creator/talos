import type { ModuleExtras } from '../generic/common.ts'
import { verifyStandard } from '../standard-webhooks.ts'
import type { IntegrationModule } from '../types.ts'
import { gcalToggle, normalizeGcal } from './normalize.ts'
import { gcalSetup } from './setup.ts'

export { GCAL_SCRIPT_TEMPLATE, renderGcalScript } from './apps-script.ts'

export const integration: IntegrationModule & ModuleExtras = {
  claim: true,
  id: 'gcal',
  setup: gcalSetup,
  verify: verifyStandard,
  normalize: normalizeGcal,
  toggle: gcalToggle,
  sample: () => ({
    v: 1,
    account: 'owner@example.com',
    items: [
      {
        change: 'invite',
        event_key: 'testkey00001',
        version: 'v1',
        title: 'Test event from Talos',
        start: new Date(Date.now() + 3_600_000).toISOString(),
        end: new Date(Date.now() + 7_200_000).toISOString(),
        location: '',
        status: 'INVITED',
        organizer: 'test@example.com',
      },
    ],
  }),
}
