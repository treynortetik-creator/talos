// `url_verification` must answer before the owner clicks Verify, which is before the signing secret has been pasted, so
// this cannot require a signature. It only echoes a short, plain challenge string back as text/plain: no state, no secret.
import { decodeText, isRecord } from '../generic/common.ts'
import type { HandshakeResponse, RawDelivery, VerifyConnection } from '../types.ts'

export function slackHandshake(raw: RawDelivery, _conn: VerifyConnection): HandshakeResponse | null {
  let j: unknown = raw.json
  if (j === undefined) {
    try {
      j = JSON.parse(decodeText(raw.rawBody))
    } catch {
      return null
    }
  }
  if (!isRecord(j) || j.type !== 'url_verification') return null
  const c = j.challenge
  if (typeof c !== 'string' || c.length === 0 || c.length > 256 || !/^[\w.~-]+$/.test(c)) {
    return { status: 400, contentType: 'text/plain; charset=utf-8', body: 'bad challenge' }
  }
  return { status: 200, contentType: 'text/plain; charset=utf-8', body: c }
}
