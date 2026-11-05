import { buildCard } from '@talos-app/testkit'
import { card, cardIdFrom, expect, LOW_RISK_CARD, sendText, signedIn, test } from '../harness/fixtures.ts'

// A newer peer can send a card kind (or a frame type) this build has never heard of. The app shows one plain note in that
// thread, once, and everything else keeps working. The relay in this stack is the current build, so the newer peer is played
// by handing the relay's socket hub a frame the app's parser does not know, as a newer relay would send it.

const NOTE = "Something arrived that this version of Talos can't show. Update the app to see it."

test('15. a newer peer’s card kind shows one "needs an update" note in its thread and nothing else breaks', async ({
  stack,
  page,
  context,
}) => {
  await signedIn(stack, page, context)
  const notes = page.getByRole('status').filter({ hasText: NOTE })

  // A well-formed card of a kind this build does not list.
  const future = (title: string) => ({
    type: 'card.create',
    card: { ...buildCard({ thread_id: 'general', title }, new Date(stack.now())), kind: 'hologram' },
  })
  await stack.relay.services.bus.toApps(future('Pickup for Alex Example'))
  await expect(notes).toHaveCount(1)
  // No card appears for it, and another card of the same kind in the same thread adds no second note.
  await expect(page.locator('[data-card-id]')).toHaveCount(0)
  await stack.relay.services.bus.toApps(future('Second pickup for Alex Example'))
  await stack.relay.services.bus.toApps({ type: 'hologram.update', thread_id: 'general' })

  // Nothing else breaks: a message goes to the agent and its answer comes back, and a known card still works.
  await sendText(page, 'still here')
  await stack.claude.waitForNotification((n) => n.content === 'still here')
  await expect(page.getByTestId('msg-agent').filter({ hasText: 'ack: still here' })).toBeVisible()
  const id = cardIdFrom(await stack.claude.callTool('card', { ...LOW_RISK_CARD }))
  await card(page, id).getByRole('button', { name: 'Keep the long one' }).click()
  await expect(card(page, id).getByTestId('collapse-line')).toHaveText(/^✕ Killed/)

  // Still exactly one note for the card kind, plus one for the unknown frame type (a different kind), and no more.
  await expect(notes).toHaveCount(2)
  await expect(page.getByTestId('msg-broken')).toHaveCount(0)
})
