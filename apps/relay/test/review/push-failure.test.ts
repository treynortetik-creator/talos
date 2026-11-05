// Review fix #25: a push that throws must never become an unhandled rejection (Node 24 exits on one).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type RealRelay, startRealRelay } from './real-relay.ts'

vi.setConfig({ testTimeout: 20_000 })

let r: RealRelay | null = null
afterEach(async () => {
  await r?.stop()
  r = null
})

describe('push failures', () => {
  it('a reply and a card still arrive when the push path throws, and nothing is left unhandled', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      r = await startRealRelay()
      const templates: string[] = []
      r.runtime.push.notify = async (intent) => {
        templates.push(intent.template)
        throw new Error('push store exploded')
      }
      const owner = await r.owner()
      const app = r.app(owner)
      await app.connect()
      const bridge = await r.bridge().connect()
      bridge.reply('general', 'hello from the Mac')
      await app.expectFrame('reply')
      bridge.createCard({ thread_id: 'general', title: 'Needs a decision' })
      await app.expectFrame('card.create')
      // A later frame arriving shows the hub kept working after both failed pushes.
      bridge.reply('general', 'still here')
      await app.expectFrame('reply', (f) => f.message.text === 'still here')
      // Both the reply and the card branch tried to push (so both failures really happened) ...
      expect(templates).toContain('needs_you')
      expect(templates.length).toBeGreaterThanOrEqual(3)
      // ... and a rejection, if any, surfaces on the next event-loop turns.
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
