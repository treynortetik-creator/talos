// Jira (work): polls JQL with the owner's own API token (no admin), plus an optional Automation "Send web request" rule.
import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { jiraPrefilter, jiraToggle, normalizeJira } from './normalize.ts'
import { pollJira } from './poll.ts'
import { jiraSetup } from './setup.ts'
import { verifyJira } from './verify.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'jira',
  setup: jiraSetup,
  verify: verifyJira,
  normalize: normalizeJira,
  prefilter: jiraPrefilter,
  poll: pollJira,
  toggle: jiraToggle,
}
