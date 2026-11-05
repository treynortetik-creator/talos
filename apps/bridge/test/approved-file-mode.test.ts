// The approved binding of a card (approved/<card id>.json) holds what the owner agreed to send, to whom and with what
// body. Only the owner's own account may read it, whatever the process umask is.
import { afterEach, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { CardT } from '@talos-app/protocol'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
let oldUmask: number | undefined
afterEach(async () => {
  if (oldUmask !== undefined) process.umask(oldUmask)
  oldUmask = undefined
  await h?.stop()
  h = undefined
})

async function approvedCard(x: Harness): Promise<CardT> {
  const res = await x.bridge.callTool('card', {
    thread_id: 'general',
    kind: 'message',
    title: 'Send the update',
    primary_label: 'Send',
    kill_label: 'Kill draft',
    risk: 'low',
    origin: 'chat',
    destination: [{ label: 'To', value: 'someone@example.com' }],
    body: 'Draft body',
    fields: [],
  })
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26})/.exec(res.content[0]?.text ?? '')?.[1]
  const card = (await x.relay.expectFrame('card.create', (f) => f.card.id === id, { direction: 'from_bridge' })).card
  await x.app.resolveCard(card, 'primary', card.payload_hash)
  await x.waitNotes(1)
  return card
}

test('approved/<id>.json is readable by its owner only, even when the process umask allows everyone', async () => {
  h = await startHarness()
  oldUmask = process.umask(0) // a permissive umask must not widen the file
  const card = await approvedCard(h)
  const mode = statSync(join(h.home, 'approved', `${card.id}.json`)).mode & 0o777
  expect(mode).toBe(0o600)
  expect(statSync(join(h.home, 'approved')).mode & 0o777).toBe(0o700)
})
