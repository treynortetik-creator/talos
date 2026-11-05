// One module per IntegrationId (spec 7.5). The browser-safe half of this table, the setup specs, is `setup-catalog.ts`.
import type { IntegrationIdT, SetupSpecT } from '@talos-app/protocol'
import { integration as calendly } from './calendly/index.ts'
import { integration as forward } from './forward/index.ts'
import { integration as gcal } from './gcal/index.ts'
import { integration as generic } from './generic/index.ts'
import { integration as github } from './github/index.ts'
import { integration as gmail } from './gmail/index.ts'
import { integration as gmail_work } from './gmail_work/index.ts'
import { integration as jira } from './jira/index.ts'
import { integration as linear } from './linear/index.ts'
import { integration as make } from './make/index.ts'
import { integration as n8n } from './n8n/index.ts'
import { integration as rss } from './rss/index.ts'
import { integration as salesforce } from './salesforce/index.ts'
import { integration as slack } from './slack/index.ts'
import { integration as stripe } from './stripe/index.ts'
import type { IntegrationModule } from './types.ts'
import { integration as zapier } from './zapier/index.ts'
import { integration as zoom } from './zoom/index.ts'

export const catalog: Record<IntegrationIdT, IntegrationModule> = {
  generic,
  zapier,
  make,
  n8n,
  gmail,
  forward,
  rss,
  github,
  slack,
  jira,
  gcal,
  linear,
  stripe,
  calendly,
  gmail_work,
  zoom,
  salesforce,
}

export function getIntegration(id: IntegrationIdT): IntegrationModule {
  return catalog[id]
}

export function listSetupSpecs(): SetupSpecT[] {
  return Object.values(catalog).map((m) => m.setup)
}
