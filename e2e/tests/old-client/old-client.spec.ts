// Old clients are tested (room decision 4, docs/OLD-CLIENT.md): the saved bundle that was live before a change is served by
// this tree's relay, next to this tree's bridge, and a person's main paths still work on it. Run against the current bundle
// too (the plain e2e run), so a spec that drifts from the page shows up at once, not on the day it gates a change.
// Role and visible name only: see helpers.ts.

import type { Page } from '@playwright/test'
import {
  DRIVING_FEATURE,
  ORIGINAL_TS_FEATURE,
  RUN_FEATURE,
  SESSION_FEATURE,
  THREAD_SESSIONS_FEATURE,
  THREADS_FEATURE,
} from '@talos-app/protocol'
import { expect, test } from '../../harness/fixtures.ts'
import { enroll, heardFeatures, oldClientSignedIn, openThread, sendText } from './helpers.ts'

/**
 * What an older page must always get (apps/bridge/test/features-budget.test.ts keeps these in its first 20), with the host
 * feature checked apart (it names the machine the stack runs on). subthreads/1
 * is there too, but only when the config supports it, which this stack's does not; the budget test covers it.
 */
const KEEP = [
  THREADS_FEATURE,
  THREAD_SESSIONS_FEATURE,
  SESSION_FEATURE,
  RUN_FEATURE,
  ORIGINAL_TS_FEATURE,
  DRIVING_FEATURE,
]
const NEEDS_UPDATE = /newer than this app/i
/** A message on screen (its article), not the screen reader's live copy of it. */
const said = (page: Page, text: string) => page.getByRole('article').getByText(text, { exact: true })

test('old client: pairing, the hello, and every keep-list feature reach the page', async ({ stack, page, context }) => {
  const heard = heardFeatures(page)
  await stack.startBridge({})
  await enroll(stack, page, context)
  await expect.poll(() => KEEP.filter((f) => !(heard() ?? []).includes(f)), { timeout: 15_000 }).toEqual([])
  // and the host feature, whichever this machine is (host/mac here, host/linux on CI's runner; see packages/protocol/src/host.ts)
  expect((heard() ?? []).some((f) => /^host\/(mac|windows|linux)$/.test(f))).toBe(true)
  // no "newer than this app" note, given a moment to appear after the hello
  await page.waitForTimeout(1000)
  await expect(page.getByText(NEEDS_UPDATE)).toHaveCount(0)
})

test('old client: a message reaches the agent in its thread and the reply comes back; threads stay apart', async ({
  stack,
  page,
  context,
}) => {
  await oldClientSignedIn(stack, page, context)
  await sendText(page, 'hello')
  const note = await stack.claude.waitForNotification((n) => n.content === 'hello')
  expect(note.meta).toMatchObject({ thread_id: 'general', trust: 'owner', kind: 'text' })
  await expect(said(page, 'ack: hello')).toBeVisible()

  const made = await stack.claude.callTool('create_thread', { name: 'Errands' })
  expect(made.isError).toBeFalsy()
  // the owner spoke in General just now, so the new thread is made at once (settings on request, 2026-11-14): no card to
  // approve. The old phone gets it like any thread and the owner is told in General how to undo it.
  expect(made.content[0]?.text ?? '').toContain('created thread errands')
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)
  await openThread(page, 'Errands')
  await sendText(page, 'over here')
  expect((await stack.claude.waitForNotification((n) => n.content === 'over here')).meta.thread_id).toBe('errands')
  await expect(said(page, 'ack: over here')).toBeVisible()
  await openThread(page, 'General')
  await expect(said(page, 'ack: over here')).toHaveCount(0)
  await expect(said(page, 'ack: hello')).toBeVisible()
  await expect(page.getByText(NEEDS_UPDATE)).toHaveCount(0)
})

test('old client: Run hands the agent the script once', async ({ stack, page, context }) => {
  await oldClientSignedIn(stack, page, context, { autoReply: false })
  const res = await stack.claude.callTool('reply', {
    thread_id: 'general',
    text: 'Cleanup:\n\n```sh\necho old-client run\n```\n',
  })
  expect(res.isError).toBeFalsy()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: /^Sent to your Mac/ })).toBeVisible()
  const note = await stack.claude.waitForNotification((n) => n.meta.run === 'tap')
  expect(note.content).toContain('echo old-client run')
  expect(stack.claude.notifications.filter((n) => n.meta.run === 'tap')).toHaveLength(1)
})

test('old client: a message written offline waits and is delivered once on reconnect', async ({
  stack,
  page,
  context,
}) => {
  await oldClientSignedIn(stack, page, context)
  await context.setOffline(true)
  stack.dropAppSockets()
  await expect(page.getByText(/You're offline/).first()).toBeVisible()
  await sendText(page, 'sent while offline')
  await expect(page.getByRole('img', { name: 'Waiting to send' })).toBeVisible()
  await context.setOffline(false)
  const retry = page.getByRole('button', { name: /^Retry/ })
  if (await retry.isVisible().catch(() => false)) await retry.click().catch(() => {})
  await stack.claude.waitForNotification((n) => n.content === 'sent while offline', 20_000)
  await expect(said(page, 'ack: sent while offline')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Waiting to send' })).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(stack.claude.notifications.filter((n) => n.content === 'sent while offline')).toHaveLength(1)
})
