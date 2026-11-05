// GitHub: notifications poll (WP3). Webhook deliveries (the `x-github-event` header is present) go to `./webhooks.ts`,
// which WP3b owns; the two packages meet at two function signatures.
import type { ModuleExtras } from '../generic/common.ts'
import type { IntegrationModule } from '../types.ts'
import { githubToggle, normalizeNotification } from './normalize.ts'
import { pollGithub } from './poll.ts'
import { githubSetup } from './setup.ts'
import { verifyPollOnly } from './verify.ts'
import { normalizeWebhook, webhookVerify } from './webhooks.ts'

export const integration: IntegrationModule & ModuleExtras = {
  id: 'github',
  setup: githubSetup,
  verify: (req, conn) => (req.headers['x-github-event'] ? webhookVerify(req, conn) : verifyPollOnly()),
  normalize: (raw, conn) =>
    raw.headers['x-github-event'] ? normalizeWebhook(raw, conn) : normalizeNotification(raw, conn),
  poll: pollGithub,
  toggle: githubToggle,
}
