// Helpers for the old-client specs (docs/OLD-CLIENT.md). These specs run against a SAVED web bundle: the one that was live
// before the change under test, the page a phone may still have cached. So they find things only by role and visible
// name, never by test-id. A test-id renamed today is not in yesterday's bundle; a visible word a person reads usually is.
// When a spec here needs something the page has never shown, it waits one deploy, until a saved bundle has it.
import type { BrowserContext, Page } from '@playwright/test'
import { expect, virtualAuthenticator } from '../../harness/fixtures.ts'
import type { Stack } from '../../harness/stack.ts'

/** The features the page heard from the relay (the `ready` frame's presence, then every `presence` frame). */
export function heardFeatures(page: Page): () => string[] | undefined {
  let last: string[] | undefined
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') return
      try {
        const j = JSON.parse(f.payload) as { type?: string; features?: unknown; presence?: { features?: unknown } }
        const list = j.type === 'presence' ? j.features : j.type === 'ready' ? j.presence?.features : undefined
        if (Array.isArray(list)) last = list.filter((x): x is string => typeof x === 'string')
      } catch {}
    })
  })
  return () => last
}

/** Pairs this page with `talos-app enroll` the way a person does: the link, Continue, the same four words, `y`. */
export async function enroll(stack: Stack, page: Page, context: BrowserContext): Promise<void> {
  await virtualAuthenticator(context, page)
  const cli = stack.cli(['enroll', '--label', 'phone'])
  const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/)
  await page.goto(link as string)
  await page.getByRole('button', { name: /^Continue/ }).click()
  const [, words] = await cli.waitFor(/\[([^\s\]]+ [^\s\]]+ [^\s\]]+ [^\s\]]+)\]\? \[y\/N\]/)
  await expect(page.getByText(words as string, { exact: true })).toBeVisible()
  // talos-app enroll takes a `y` under 500 ms after its question as typed ahead (enroll-cli.ts READ_MS): read first.
  await new Promise((r) => setTimeout(r, 600))
  cli.write('y\n')
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible({ timeout: 15_000 })
}

export async function openThread(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: new RegExp(`^${name}`, 'i') })
    .click()
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`^${name}`, 'i') }).first()).toBeVisible()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

export async function sendText(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

/** A signed-in page on General with the bridge running. */
export async function oldClientSignedIn(
  stack: Stack,
  page: Page,
  context: BrowserContext,
  opts: { autoReply?: boolean } = {},
): Promise<void> {
  await stack.startBridge(opts.autoReply === false ? { autoReply: false } : {})
  await enroll(stack, page, context)
  await openThread(page, 'General')
}
