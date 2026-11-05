export * from './catalog.ts'
export type { ModuleExtras } from './generic/common.ts'
export { clean, safeUrl } from './generic/common.ts'
export { renderGmailScript } from './gmail/apps-script.ts'
export { assertPublicFeedUrl } from './rss/poll.ts'
export * from './standard-webhooks.ts'
export * from './types.ts'

import type { ModuleExtras } from './generic/common.ts'
import type { IntegrationModule } from './types.ts'

/** The optional extras a module may carry (toggle predicate, test sample) with the frozen interface kept as-is. */
export function moduleExtras(m: IntegrationModule): ModuleExtras {
  return m as IntegrationModule & ModuleExtras
}
