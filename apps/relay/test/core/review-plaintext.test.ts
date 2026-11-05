// ---- second file (review-pr5b.test.ts) ----
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep } from '@talos-app/testkit'
import { expect, it } from 'vitest'
import { startTestRelay } from './harness.ts'
import { kit } from './helpers.ts'

it('agent-written status labels and media file names are not stored in plaintext', async () => {
  const relay = await startTestRelay()
  const k = kit(relay)
  const app = await k.connectedApp()
  const bridge = await k.bridge().connect()
  bridge.send({
    type: 'status',
    thread_id: 'general',
    state: 'working',
    label: 'MARKERLABEL drafting the layoff memo',
    since: new Date().toISOString(),
  })
  await app.expectFrame('status', (f) => f.state === 'working')
  relay.runtime.media.save({ bytes: new Uint8Array([1, 2, 3]), name: 'MARKERNAME-offer-letter.pdf', origin: 'app' })
  await sleep(50)
  relay.runtime.store.db.pragma('wal_checkpoint(FULL)')
  const hits = readdirSync(relay.dir)
    .filter((f) => f.startsWith('relay.sqlite'))
    .flatMap((f) => {
      const b = readFileSync(join(relay.dir, f))
      return [b.includes('MARKERLABEL') ? `${f}:label` : '', b.includes('MARKERNAME') ? `${f}:name` : ''].filter(
        Boolean,
      )
    })
  await relay.stop()
  expect(hits).toEqual([])
})
