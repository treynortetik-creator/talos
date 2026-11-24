// Helpers for the old-client specs (docs/OLD-CLIENT.md). These specs run against a SAVED web bundle: the one that was live
// before the change under test, the page a phone may still have cached. So they find things only by role and visible
// name, never by test-id. A test-id renamed today is not in yesterday's bundle; a visible word a person reads usually is.
// When a spec here needs something the page has never shown, it waits one deploy, until a saved bundle has it.
import type { BrowserContext, Page } from '@playwright/test'
import { t } from '@talos-app/testkit'
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
  // Each document notes, before any page script runs, whether a service worker already controlled it. See the wait below.
  await page.addInitScript(() => {
    ;(window as unknown as { __controlledAtLoad: boolean }).__controlledAtLoad = !!navigator.serviceWorker?.controller
  })
  const cli = stack.cli(['enroll', '--label', 'phone'])
  const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/)
  await page.goto(link as string)
  await page.getByRole('button', { name: /^Continue/ }).click()
  const [, words] = await cli.waitFor(/\[([^\s\]]+ [^\s\]]+ [^\s\]]+ [^\s\]]+)\]\? \[y\/N\]/)
  await expect(page.getByText(words as string, { exact: true })).toBeVisible()
  // talos-app enroll takes a `y` under 500 ms after its question as typed ahead (enroll-cli.ts READ_MS): read first.
  await new Promise((r) => setTimeout(r, t(600)))
  cli.write('y\n')
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible({ timeout: t(15_000) })
  // A page that loaded with no service worker is taken over by the worker it just installed, and a bundle may then reload
  // itself for that (the older saved bundles do, at once; the current one holds the reload while anything is in flight or the
  // owner is active, so it may never). A click made just before such a reload (Run) loses the page's own state for it: the
  // agent still gets the Run, but the line under the button starts over empty. So the test owns that reload: it waits for
  // the worker to be active, reloads the page itself if this document did not load controlled, and goes on only in a document
  // that did. A reload the page made itself at the same moment is harmless: each step below allows for the document being
  // replaced under it, and the last wait checks the document that is left.
  const activeWorker = () =>
    page
      .evaluate(() => navigator.serviceWorker.ready.then(() => true))
      .catch(async () => {
        await page.waitForLoadState('load') // the page reloaded itself under the call
        return false
      })
  for (let i = 0; i < 3 && !(await activeWorker()); i++) {}
  const controlled = await page
    .evaluate(() => (window as unknown as { __controlledAtLoad?: boolean }).__controlledAtLoad === true)
    .catch(() => false)
  if (!controlled) await page.reload({ timeout: t(15_000) }).catch(() => {}) // a self-reload racing this one: the wait below decides
  await page.waitForFunction(
    () => (window as unknown as { __controlledAtLoad?: boolean }).__controlledAtLoad === true,
    null,
    { timeout: t(15_000) },
  )
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
