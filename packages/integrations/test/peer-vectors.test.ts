import { readFileSync } from 'node:fs'
import { parsePeerMessage } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { signStandard, verifyStandard } from '../src/standard-webhooks.ts'

type Case = {
  name: string
  now_ms: number
  headers: Record<string, string>
  body: string
  seen_ids: string[]
  secrets?: Array<'current' | 'previous'>
  expect: { result: 'accepted' | 'refused' | 'duplicate'; reason?: string; delivery_key?: string }
}
const file = JSON.parse(
  readFileSync(new URL('../../protocol/fixtures/peer-message/headers.json', import.meta.url), 'utf8'),
) as { secret: string; secret_previous: string; cases: Case[] }

describe('peer-message header vectors (Standard Webhooks v1)', () => {
  it('the valid vector is exactly what signStandard makes', () => {
    const c = file.cases[0] as Case
    expect(
      signStandard({
        secret: file.secret,
        id: c.headers['webhook-id'] as string,
        timestampS: Number(c.headers['webhook-timestamp']),
        body: c.body,
      }),
    ).toEqual(c.headers)
  })
  for (const c of file.cases)
    it(c.name, () => {
      const v = verifyStandard(
        {
          headers: c.headers,
          rawBody: new TextEncoder().encode(c.body),
          url: 'https://relay.example.com/hook/peer/x',
          now: c.now_ms,
        },
        { secrets: (c.secrets ?? ['current']).map((w) => (w === 'current' ? file.secret : file.secret_previous)) },
      )
      let result: string
      let reason: string | undefined
      if (!v.ok) {
        result = 'refused'
        reason = v.reason
      } else {
        const msg = parsePeerMessage(JSON.parse(c.body))
        if (!msg.success) {
          result = 'refused'
          reason = 'bad_body'
        } else if (msg.data.id !== c.headers['webhook-id']) {
          result = 'refused'
          reason = 'id_mismatch'
        } else if (c.seen_ids.includes(c.headers['webhook-id'] as string)) {
          result = 'duplicate'
        } else result = 'accepted'
        if (result !== 'refused') expect(v.deliveryKey).toBe(c.expect.delivery_key)
      }
      expect(result).toBe(c.expect.result)
      if (c.expect.reason) expect(reason).toBe(c.expect.reason)
    })
})
