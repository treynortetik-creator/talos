// Slack (work): Events API user events, one-click manifest link. Ships disabled (spec 7.5).
import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { slackHandshake } from './handshake.ts'
import { slackLearn, slackSiblingExtra } from './identity.ts'
import { normalizeSlack, slackToggle } from './normalize.ts'
import { slackPrefilter } from './prefilter.ts'
import { slackSetup } from './setup.ts'
import { verifySlack } from './verify.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'slack',
  setup: slackSetup,
  verify: verifySlack,
  normalize: normalizeSlack,
  prefilter: slackPrefilter,
  handshake: slackHandshake,
  toggle: slackToggle,
  learn: slackLearn,
  siblingExtra: slackSiblingExtra,
  verifySecretField: 'signing_secret',
}
