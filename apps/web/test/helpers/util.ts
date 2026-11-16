import { expect, type Page } from '@playwright/test'
import type { JwkP256T } from '@talos-app/protocol'
import { newId, newUlid, verifyOwnerFrame } from '@talos-app/protocol'
import type { Harness } from './harness.ts'

/** Seeds a pinned device, opens `path`, and waits until the socket is up and the relay has the app registered. */
export async function openSignedIn(
  harness: Harness,
  page: Page,
  context: Parameters<Harness['seedDevice']>[0],
  path = '/t/general',
  opts: { pinned?: boolean } = {},
) {
  const dev = await harness.seedDevice(context, page, opts)
  await page.goto(path)
  await waitUntil(() => harness.relay.appCount > 0, 'app socket')
  // `ready` has landed (threads known) before a test starts cutting sockets: a drop before it leaves nothing to render.
  if (path.startsWith('/t/')) await page.getByTestId('thread-screen').waitFor()
  return dev
}

/**
 * Waits for `cond` for as long as the test may run, with no limit of its own: the fixed 8 s it had ran out on a loaded
 * machine before WebKit's socket was up, and the spec failed on time, not on the app. A caller can still pass `ms`.
 */
export async function waitUntil(cond: () => boolean, what = 'condition', ms?: number) {
  await expect.poll(cond, { message: `timed out waiting for ${what}`, timeout: ms ?? 0, intervals: [25] }).toBe(true)
}

export type ReplyOpts = { thread?: string; text?: string; format?: 'markdown' | 'plain'; attachments?: unknown[] }
/** What the bridge's `reply` looks like to the app. */
export function agentReply(o: ReplyOpts = {}) {
  return {
    type: 'reply',
    message: {
      id: newId('m'),
      thread_id: o.thread ?? 'general',
      author: 'agent',
      kind: 'text',
      ...(o.text !== undefined ? { text: o.text } : {}),
      format: o.format ?? 'markdown',
      attachments: o.attachments ?? [],
      via: 'app',
      created_at: new Date().toISOString(),
    },
  }
}

export const frameOfType = (harness: Harness, type: string) => harness.appFrames().filter((f) => f.raw.type === type)

export async function sigOk(raw: Record<string, unknown>, jwk: JwkP256T) {
  return verifyOwnerFrame(raw, jwk)
}
export { newId, newUlid }

/** Clicks "Retry now" only if it is still on screen: the 1 s auto-retry may reconnect first and detach the button. */
export async function clickRetryIfShown(page: Page) {
  const retry = page.getByRole('button', { name: 'Retry now' })
  if (await retry.isVisible().catch(() => false)) await retry.click({ timeout: 1000 }).catch(() => {})
}
