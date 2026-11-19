// Standard Webhooks signing for a peer message: `webhook-id` (the message id), `webhook-timestamp` (unix seconds, fresh each
// attempt) and `webhook-signature` = `v1,` + base64(HMAC-SHA256(key, "<id>.<timestamp>." + body)). The same bytes the relay's
// verifier reads (packages/integrations standard-webhooks.ts); packages/protocol/fixtures/peer-message/headers.json pins them.
import { createHmac } from 'node:crypto'

/** `whsec_` + standard base64 of 24 to 64 bytes, the way the relay mints it. */
export function peerSecretKey(secret: string): Buffer | null {
  if (!secret.startsWith('whsec_')) return null
  const b64 = secret.slice(6)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  const key = Buffer.from(b64, 'base64')
  return key.length >= 24 && key.length <= 64 ? key : null
}

export const validPeerSecret = (secret: string): boolean => peerSecretKey(secret) !== null

export function signPeerMessage(a: {
  secret: string
  id: string
  timestampS: number
  body: string
}): Record<string, string> {
  const key = peerSecretKey(a.secret)
  if (!key) throw new Error('invalid peer secret')
  const mac = createHmac('sha256', key).update(`${a.id}.${a.timestampS}.`).update(a.body).digest('base64')
  return { 'webhook-id': a.id, 'webhook-timestamp': String(a.timestampS), 'webhook-signature': `v1,${mac}` }
}
