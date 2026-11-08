import type { IntegrationModule } from '../types.ts'
import { normalizeRss } from './normalize.ts'
import { pollRss } from './poll.ts'
import { rssSetup } from './setup.ts'
import { verifyRss } from './verify.ts'

export const integration: IntegrationModule = {
  id: 'rss',
  setup: rssSetup,
  verify: verifyRss,
  normalize: normalizeRss,
  poll: pollRss,
}
