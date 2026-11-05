// Forwarded-email script: the Gmail template without the inbox query step. Browser-safe (no node:* imports).
import { GMAIL_SCRIPT_TEMPLATE, jsLiteral } from '../gmail/apps-script.ts'

const FORWARD_LABEL = 'Talos/Inbound'
const INBOX_STEP = '    add(TALOS.QUERY, false)\n'

/** The Gmail template with the primary-inbox search removed. Throws if the Gmail template ever changes shape. */
export function forwardScriptTemplate(): string {
  if (!GMAIL_SCRIPT_TEMPLATE.includes(INBOX_STEP)) throw new Error('gmail script template changed: update forward')
  return GMAIL_SCRIPT_TEMPLATE.replace(INBOX_STEP, '').replace(
    '/** Talos Inbox: Gmail → your Talos relay.',
    '/** Talos Forward: mail you label Talos/Inbound → your Talos relay.',
  )
}

export function renderForwardScript(vars: { hookUrl: string; claimCode: string; label?: string }): string {
  let url: URL
  try {
    url = new URL(vars.hookUrl)
  } catch {
    throw new Error('hookUrl is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('hookUrl must be http(s)')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(vars.claimCode)) throw new Error('claimCode has an unexpected shape')
  const label = vars.label ?? FORWARD_LABEL
  if (!label || label.length > 100) throw new Error('label must be 1 to 100 characters')
  const values: Record<string, string> = {
    HOOK_URL: vars.hookUrl,
    CLAIM_CODE: vars.claimCode,
    QUERY: '',
    FORWARD_LABEL: label,
  }
  return forwardScriptTemplate().replace(/'\{\{(HOOK_URL|CLAIM_CODE|QUERY|FORWARD_LABEL)\}\}'/g, (_m, k: string) =>
    jsLiteral(values[k] as string),
  )
}
