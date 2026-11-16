// Adapters between the relay's connection-created response and the wizard's `{{...}}` variables and script steps.
// `claim_code` (Gmail, Calendar, Forward) comes straight from the relay's response; the Slack manifest link is derived
// here from `hook_url` (the owner's app, and an agent's bot app); the Apps Script text comes from the browser-safe catalog export of `@talos-app/integrations`.
import { renderSetupScript, slackBotManifestUrl, slackManifestUrl } from '@talos-app/integrations/catalog'
import type { RouteRes } from '@talos-app/protocol'
import type { TemplateContext } from './template.tsx'

type Created = RouteRes<'connectionCreate'>

function manifestUrl(hookUrl: string, make = slackManifestUrl): string | undefined {
  try {
    return make(hookUrl)
  } catch {
    return undefined
  }
}

/** Variables for `{{...}}` in setup steps. */
export function templateContext(created: Created | null): TemplateContext {
  if (!created) return {}
  return {
    HOOK_URL: created.hook_url,
    SECRET: created.secret,
    CLAIM_CODE: created.claim_code,
    MANIFEST_URL: created.integration === 'slack' ? manifestUrl(created.hook_url) : undefined,
    // an agent's bot: the bot app's manifest (bot events and scopes, a Messages tab)
    BOT_MANIFEST_URL: created.integration === 'slack' ? manifestUrl(created.hook_url, slackBotManifestUrl) : undefined,
  }
}

/** Apps Script text for a `script` step, or null when the connection has no claim code (or the template is unknown). */
export function scriptText(templateId: string, ctx: TemplateContext): string | null {
  if (!ctx.HOOK_URL || !ctx.CLAIM_CODE) return null
  try {
    return renderSetupScript(templateId, { hookUrl: ctx.HOOK_URL, claimCode: ctx.CLAIM_CODE })
  } catch {
    return null
  }
}
