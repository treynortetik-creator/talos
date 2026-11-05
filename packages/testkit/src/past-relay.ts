// Owner frames handed to the Mac WITHOUT passing the relay's checks. FakeRelay refuses what the real relay refuses (an
// expired card, a wrong hash, a second tap on a decided card), so a test of the Mac's own refusal would otherwise stop at
// the relay and never reach the code it names. This plays a relay that lets the frame through (a hostile one, or a stale
// one), signed by the paired app exactly as the real thing would be.
import type { FakeApp } from './fake-app.ts'
import type { FakeRelay } from './fake-relay.ts'
import { mkFrame } from './frame-utils.ts'

/** Signs `frame` as `app` and sends it straight to the Mac. The relay stores nothing and answers nothing; read the Mac's reply from `relay.frames` (direction 'from_bridge'). */
export async function pushOwnerFramePastRelay(relay: FakeRelay, app: FakeApp, frame: Record<string, unknown>) {
  const signed = await app.sign(frame)
  const sent = relay.sendToBridge(signed)
  return { ...sent, id: String(sent.id) }
}

/** A card.resolve the app would send, delivered past the relay's card checks. */
export function resolvePastRelay(
  relay: FakeRelay,
  app: FakeApp,
  card: { id: string },
  payload_hash: string,
  action: 'primary' | 'kill' | 'revise' = 'primary',
  extra: Record<string, unknown> = {},
) {
  return pushOwnerFramePastRelay(relay, app, {
    ...mkFrame('card.resolve'),
    card_id: card.id,
    action,
    payload_hash,
    ...extra,
  })
}
