// PR #8 review: failing tests for findings. Place in apps/web/test/review/ and run with
//   pnpm exec playwright test test/review/pr8-findings.spec.ts --project=pixel --project=iphone
import { mkFrame } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, newId, openSignedIn } from '../helpers/util.ts'

type H = { relay: { sendToApps(f: Record<string, unknown>): void } }
/** Waits for `ready` (the Mac-offline banner from FakeRelay's presence), then marks the Mac online. */
async function online(h: H, page: import('@playwright/test').Page) {
  await expect(page.getByText(/Your Mac is offline/)).toBeVisible()
  h.relay.sendToApps(mkFrame('presence', { bridge_online: true, last_seen: new Date().toISOString(), queue_depth: 0 }))
  await expect(page.getByText(/Your Mac is offline/)).toHaveCount(0)
}

// F-UX1 (HIGH): opening the installed app with no network leaves the splash mascot up forever.
test('cold start offline shows the cached thread and the offline banner, not an endless splash', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  harness.relay.sendToApps(agentReply({ text: 'Cached before going offline.' }))
  await expect(page.getByTestId('msg-agent').getByText('Cached before going offline.')).toBeVisible()
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null)
  await page.waitForTimeout(600) // render-cache save (250 ms debounce)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText("You're offline. Messages will send when you're back.")).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('msg-agent').getByText('Cached before going offline.')).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
})

// F-REL1 (MEDIUM): the timeline sorts by created_at, which mixes three clocks (phone, relay, Mac). An agent answer
// stamped by a Mac clock 5 s behind renders ABOVE the question it answers, though its seq is later.
test('timeline order follows seq, not cross-clock created_at', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  await page.getByRole('textbox', { name: 'Message' }).fill('question first')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('msg-owner').getByRole('img', { name: 'Sent' })).toBeVisible()
  const r = agentReply({ text: 'answer second' })
  const m = r.message as Record<string, unknown>
  m.created_at = new Date(Date.now() - 5000).toISOString() // Mac clock slightly behind
  m.seq = 10_000 // stored after the question
  harness.relay.sendToApps(r)
  await expect(page.getByTestId('msg-agent').getByText('answer second')).toBeVisible()
  const order = await page
    .getByTestId('timeline')
    .locator('[data-testid^="msg-"]')
    .evaluateAll((els) => els.map((e) => e.textContent ?? ''))
  expect(order.findIndex((t) => t.includes('question first'))).toBeLessThan(
    order.findIndex((t) => t.includes('answer second')),
  )
})

// F-REL2 (MEDIUM): a stored owner frame in a catch-up batch is rendered without validation. A message with no
// `attachments` array (or a voice_note with no attachment) throws in MessageView and blanks the whole app.
test('a malformed stored owner frame in catch-up does not crash the thread view', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  harness.relay.sendToApps(
    mkFrame('catchup.batch', {
      from_seq: 1,
      to_seq: 2,
      more: false,
      frames: [
        { v: 1, type: 'message', id: 'x', thread_id: 'general', client_msg_id: newId('m'), text: 'no attachments' },
        { v: 1, type: 'voice_note', id: 'y', thread_id: 'general', client_msg_id: newId('m') },
      ],
    }),
  )
  await page.waitForTimeout(500)
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible()
})

// F-VN2 (MEDIUM): 64 fixed-width bars overflow the voice-note bubble on a phone and run under the duration and the
// speed button (and past the bubble edge).
test('voice-note waveform fits inside its bubble on a phone', async ({ page, context, harness }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  const wf = Buffer.from(Uint8Array.from({ length: 64 }, (_, i) => 40 + ((i * 37) % 200))).toString('base64')
  harness.relay.sendToApps(
    agentReply({
      text: 'voice reply',
      attachments: [
        {
          media_id: newId('md'),
          kind: 'voice_note',
          role: 'attachment',
          mime: 'audio/mp4',
          name: 'r.m4a',
          size: 10,
          sha256: 'a'.repeat(64),
          duration_ms: 7000,
          waveform: wf,
        },
      ],
    }),
  )
  const vn = page.getByTestId('voice-note')
  await expect(vn).toBeVisible()
  const overflow = await vn.evaluate((root) => {
    const bars = root.querySelector('div.flex-1[aria-hidden="true"]') as HTMLElement
    const bubble = bars.parentElement as HTMLElement
    const last = bars.lastElementChild as HTMLElement
    // the last bar must end before the duration label starts, and inside the bubble
    const label = bars.nextElementSibling as HTMLElement
    return Math.max(
      last.getBoundingClientRect().right - label.getBoundingClientRect().left,
      last.getBoundingClientRect().right - bubble.getBoundingClientRect().right,
    )
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

// F-REL3 (MEDIUM): relay `reply` frames carry the seq in `frame.relay.seq`, not `message.seq`. The client never copies
// it, so the open thread's "last seq" never moves on agent replies, `thread.read` is never sent, and the thread you
// are looking at keeps an unread badge (and inflates the app badge) for every reply that arrives while it is open.
test('a live agent reply in the open thread is marked read', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context, '/t/general')
  await online(harness, page)
  harness.relay.sendToApps(agentReply({ text: 'live reply while open' }))
  await expect(page.getByTestId('msg-agent').getByText('live reply while open')).toBeVisible()
  await expect(page.getByRole('img', { name: /unread/ })).toHaveCount(0)
})
