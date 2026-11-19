// The sender's signature is the one the receiver's verifier reads: P1's header vectors, signed with the vectors' own secret.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { signPeerMessage } from '../../src/peer/sign.ts'

type Case = {
  name: string
  headers: Record<string, string>
  body: string
  secrets?: string[]
  expect: { result: string; reason?: string }
}
const file = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../../packages/protocol/fixtures/peer-message/headers.json'), 'utf8'),
) as { secret: string; cases: Case[] }

describe('signPeerMessage against the shared vectors', () => {
  test('the first vector (a valid delivery) is reproduced exactly', () => {
    const c = file.cases[0] as Case
    const got = signPeerMessage({
      secret: file.secret,
      id: c.headers['webhook-id'] as string,
      timestampS: Number(c.headers['webhook-timestamp']),
      body: c.body,
    })
    expect(got).toEqual(c.headers)
  })

  test('every vector whose signature is valid for the vectors secret is produced by it', () => {
    let checked = 0
    for (const c of file.cases) {
      const h = c.headers
      if (c.secrets || !h['webhook-id'] || !h['webhook-timestamp'] || !h['webhook-signature']) continue
      const valid =
        ['accepted', 'duplicate'].includes(c.expect.result) ||
        ['id_mismatch', 'bad_body'].includes(c.expect.reason ?? '')
      if (!valid) continue
      const got = signPeerMessage({
        secret: file.secret,
        id: h['webhook-id'],
        timestampS: Number(h['webhook-timestamp']),
        body: c.body,
      })
      expect(h['webhook-signature'].split(' '), c.name).toContain(got['webhook-signature'] as string)
      checked++
    }
    expect(checked).toBeGreaterThanOrEqual(4)
  })
})
