// Browser-safe setup catalog: the wizard copy for every integration, with no verifier, poller or node:* import behind it.
// The web app imports this through `@talos-app/integrations/catalog`; the relay's full catalog (catalog.ts) must agree
// with it, which test/setup-catalog.test.ts checks.
import type { IntegrationIdT, SetupSpecT } from '@talos-app/protocol'
import { calendlySetup } from './calendly/setup.ts'
import { renderForwardScript } from './forward/apps-script.ts'
import { forwardSetup } from './forward/setup.ts'
import { renderGcalScript } from './gcal/apps-script.ts'
import { gcalSetup } from './gcal/setup.ts'
import { genericAppSetup } from './generic/setup.ts'
import { githubSetup } from './github/setup.ts'
import { renderGmailScript } from './gmail/apps-script.ts'
import { gmailPersonalSetup } from './gmail/setup.ts'
import { gmailWorkSetup } from './gmail_work/setup.ts'
import { jiraSetup } from './jira/setup.ts'
import { linearSetup } from './linear/setup.ts'
import { makeSetup } from './make/setup.ts'
import { n8nSetup } from './n8n/setup.ts'
import { rssSetup } from './rss/setup.ts'
import { salesforceSetup } from './salesforce/setup.ts'
import { slackSetup } from './slack/setup.ts'
import { stripeSetup } from './stripe/setup.ts'
import { zapierSetup } from './zapier/setup.ts'
import { zoomSetup } from './zoom/setup.ts'

export const setupCatalog: Record<IntegrationIdT, SetupSpecT> = {
  generic: genericAppSetup,
  zapier: zapierSetup,
  make: makeSetup,
  n8n: n8nSetup,
  gmail: gmailPersonalSetup,
  forward: forwardSetup,
  rss: rssSetup,
  github: githubSetup,
  slack: slackSetup,
  jira: jiraSetup,
  gcal: gcalSetup,
  linear: linearSetup,
  stripe: stripeSetup,
  calendly: calendlySetup,
  gmail_work: gmailWorkSetup,
  zoom: zoomSetup,
  salesforce: salesforceSetup,
}

export function listSetupSpecs(): SetupSpecT[] {
  return Object.values(setupCatalog)
}

export { slackManifestUrl } from './slack/manifest.ts'

export type ScriptVars = { hookUrl: string; claimCode: string }

/** The Apps Script text for a `script` setup step (`template_id`), or null for an unknown template. */
export function renderSetupScript(templateId: string, vars: ScriptVars): string | null {
  switch (templateId) {
    case 'gmail':
    case 'gmail_work':
      return renderGmailScript(vars)
    case 'gcal':
      return renderGcalScript(vars)
    case 'forward':
      return renderForwardScript(vars)
    default:
      return null
  }
}
