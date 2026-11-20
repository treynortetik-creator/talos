import type { BrowserContext, Page } from '@playwright/test'
import { test as base, expect } from '@playwright/test'
import { signStandard } from '@talos-app/integrations'
import { shiftBrowserClock } from './hostile.ts'
import { type Stack, startStack } from './stack.ts'

export { waitUntil } from './stack.ts'
export { expect }

export const test = base.extend<{ stack: Stack; worldAt: string | undefined }>({
  // a drop of the link or the Mac is said at once here (the app waits 30 s for an owner: lib/linkShown.ts)
  context: async ({ context }, use) => {
    await shiftBrowserClock(context)
    await context.addInitScript(() => {
      ;(window as unknown as { __talosLinkGraceMs: number }).__talosLinkGraceMs = 0
    })
    await use(context)
  },
  /** The instant the whole stack's clock starts at. A spec overrides this; unset means E2E_NOW, or the wall clock. */
  worldAt: [undefined, { option: true }],
  stack: async ({ worldAt }, use, testInfo) => {
    const stack = await startStack({ at: worldAt })
    try {
      await use(stack)
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('relay.log', { body: stack.relayLog.join('\n'), contentType: 'text/plain' })
        await testInfo.attach('bridge.log', { body: stack.bridgeLog(), contentType: 'text/plain' })
      }
      await stack.stop()
    }
  },
})

/** A virtual platform authenticator (Face ID stand-in): discoverable credentials, user verification always passes. */
export async function virtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

export const MAIN_NAV = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' }))

/**
 * Scenario 1: `talos-app enroll` on the Mac, the link in the browser, the passkey, the device key, the same four words on
 * both screens, `y` at the Mac. Returns once the app is open and signed in.
 */
export async function enrollDevice(
  stack: Stack,
  page: Page,
  context: BrowserContext,
  opts: { answer?: 'y' | 'N'; label?: string } = {},
): Promise<{ deviceId: string; words: string[]; cli: ReturnType<Stack['cli']> }> {
  await virtualAuthenticator(context, page)
  const cli = stack.cli(['enroll', '--label', opts.label ?? 'phone'])
  const [link] = await cli.waitFor(/https?:\/\/\S+\/enroll#\S+/)
  await page.goto(link)
  await expect(page.getByRole('heading', { name: 'Set up Talos on this device' })).toBeVisible()
  await page.getByRole('button', { name: /^Continue/ }).click()
  const shown = ((await page.getByTestId('fingerprint').textContent()) ?? '').trim().split(/\s+/)
  expect(shown).toHaveLength(4)
  const [, words] = await cli.waitFor(/\[([^\s\]]+ [^\s\]]+ [^\s\]]+ [^\s\]]+)\]\? \[y\/N\]/).catch((e: Error) => {
    throw new Error(
      `${e.message}\n--- bridge.log\n${stack.bridgeLog().slice(-1500)}\n--- relay.log\n${stack.relayLog.slice(-12).join('\n')}`,
    )
  })
  expect((words as string).split(' ')).toEqual(shown)
  // A person reads the four words before answering: talos-app enroll takes an answer that comes under 500 ms after its
  // question as typed ahead, a no (apps/bridge/src/enroll-cli.ts, READ_MS), so the harness waits as a person would.
  await new Promise((r) => setTimeout(r, 600))
  cli.write(`${opts.answer ?? 'y'}\n`)
  if ((opts.answer ?? 'y') === 'y') {
    await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible({ timeout: 20_000 }) // pairing under a full gate's load can pass 10 s
    await expect(MAIN_NAV(page)).toBeVisible({ timeout: 15_000 })
  }
  const devices = (await (await page.request.get(`${stack.origin}/api/devices`)).json().catch(() => [])) as Array<{
    id: string
  }>
  const deviceId = devices[0]?.id ?? ''
  return { deviceId, words: shown, cli }
}

const wire = new WeakMap<Page, { sent: string[]; received: string[] }>()

/** Starts recording every WebSocket frame the page sends and receives (call before the app connects). */
export function recordWire(page: Page): void {
  const sent: string[] = []
  const received: string[] = []
  wire.set(page, { sent, received })
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => {
      if (typeof e.payload === 'string') sent.push(e.payload)
    })
    ws.on('framereceived', (e) => {
      if (typeof e.payload === 'string') received.push(e.payload)
    })
  })
}

export function sentFrames(page: Page, type?: string): Array<{ text: string; json: Record<string, unknown> }> {
  return (wire.get(page)?.sent ?? [])
    .map((text) => ({ text, json: JSON.parse(text) as Record<string, unknown> }))
    .filter((f) => !type || f.json.type === type)
}

/**
 * The JSON frames the page received, oldest first: the signal that a chain through the relay and the Mac has answered, which
 * an assertion on the screen alone cannot tell apart from a slow render.
 */
export function receivedFrames(page: Page, type?: string): Array<{ text: string; json: Record<string, unknown> }> {
  const out: Array<{ text: string; json: Record<string, unknown> }> = []
  for (const text of wire.get(page)?.received ?? []) {
    try {
      const json = JSON.parse(text) as Record<string, unknown>
      if (!type || json.type === type) out.push({ text, json })
    } catch {}
  }
  return out
}

/**
 * Opens a second socket from the page (same cookie, same Origin), sends the given raw frames in order and returns what
 * came back within `waitMs`. This is what an attacker who captured the bytes could do.
 */
export async function rawSocket(page: Page, frames: string[], waitMs = 2500): Promise<Array<Record<string, unknown>>> {
  const got = await page.evaluate(
    ({ frames, waitMs }) =>
      new Promise<string[]>((resolve) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
        const seen: string[] = []
        ws.onmessage = (e) => seen.push(String(e.data))
        ws.onopen = () => {
          for (const f of frames) ws.send(f)
          setTimeout(() => {
            ws.close()
            resolve(seen)
          }, waitMs)
        }
        ws.onerror = () => resolve(seen)
      }),
    { frames, waitMs },
  )
  return got.map((t) => JSON.parse(t) as Record<string, unknown>)
}

/** A signed-in browser on the `general` thread with the bridge running and the device pinned. */
export async function signedIn(stack: Stack, page: Page, context: BrowserContext) {
  recordWire(page)
  await stack.startBridge()
  const dev = await enrollDevice(stack, page, context)
  await openThread(page, 'General')
  return dev
}

/** Opens a thread the way a person does: from the sidebar or thread list (a cold load of /t/<id> races the first sync). */
export async function openThread(page: Page, name: string): Promise<void> {
  const link = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: new RegExp(`^${name}`, 'i') })
  await link.click()
  // The previous thread's composer is on screen until the route changes: wait for the new thread's own header first.
  await expect(
    page.getByTestId('thread-screen').getByRole('heading', { level: 1, name: new RegExp(`^${name}`, 'i') }),
  ).toBeVisible()
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
}

export async function sendText(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message', { exact: true }).fill(text)
  await page.getByTestId('composer').getByRole('button', { name: 'Send', exact: true }).click()
}

export const card = (page: Page, id: string) => page.locator(`[data-card-id="${id}"]`)

export function cardIdFrom(result: { content: Array<{ text?: string }> }): string {
  const id = /\bc_[0-9A-HJKMNP-TV-Z]{26}\b/.exec(result.content[0]?.text ?? '')?.[0]
  if (!id) throw new Error(`no card id in ${JSON.stringify(result)}`)
  return id
}

/**
 * `create_thread` and `archive_thread` show the owner a settings card in the default thread (docs/bridge.md). Tap Apply on the
 * card the tool just made, then wait for the card to settle, so the change is in the app before the test goes on.
 */
export async function applySettingsCard(page: Page, result: { content: Array<{ text?: string }> }): Promise<void> {
  const article = card(page, cardIdFrom(result))
  await article.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(article.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0)
}

export const HIGH_RISK_CARD = {
  thread_id: 'general',
  kind: 'publish',
  title: 'Publish the release notes',
  primary_label: 'Publish',
  kill_label: 'Kill publish',
  risk: 'high',
  origin: 'chat',
  destination: [{ label: 'Site', value: 'https://example.com/releases' }],
  body: 'Version 1.2 notes.',
  warning: "Goes outside this app. Can't be unsent.",
} as const

export const LOW_RISK_CARD = {
  thread_id: 'general',
  kind: 'decision',
  title: 'Use the shorter intro?',
  primary_label: 'Yes, shorter',
  kill_label: 'Keep the long one',
  risk: 'low',
  origin: 'chat',
} as const

/** Creates an integration connection through the signed-in browser's session (what the wizard does). */
export async function createConnection(
  stack: Stack,
  page: Page,
  integration: string,
  name = 'Test connection',
): Promise<{ id: string; hook_url: string; secret: string }> {
  const res = await page.request.post(`${stack.origin}/api/connections`, {
    headers: { origin: stack.origin, 'x-talos-csrf': '1', 'content-type': 'application/json' },
    data: { integration, name },
  })
  expect(res.status()).toBe(201)
  return (await res.json()) as { id: string; hook_url: string; secret: string }
}

/** POSTs a correctly signed Standard Webhooks delivery to a connection's hook URL. */
export async function sendHook(
  stack: Stack,
  conn: { hook_url: string; secret: string },
  body: Record<string, unknown>,
  over: { id?: string } = {},
): Promise<number> {
  const raw = JSON.stringify(body)
  const headers = signStandard({
    secret: conn.secret,
    id: over.id ?? `msg_${Math.random().toString(36).slice(2)}`,
    timestampS: Math.floor(stack.now() / 1000),
    body: raw,
  })
  const res = await fetch(conn.hook_url.replace(/^https?:\/\/[^/]+/, stack.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  })
  return res.status
}

/**
 * A hard app kill: the renderer is crashed through CDP (`Page.crash`), so no `pagehide` or `beforeunload` handler runs and
 * nothing is saved on the way out. Then a new tab opens in the same browser context (same storage), like reopening the app.
 * The virtual authenticator belonged to the dead page, so a step-up needs `virtualAuthenticator` again on the new one.
 */
export async function killApp(page: Page, context: BrowserContext): Promise<Page> {
  const cdp = await context.newCDPSession(page)
  const crashed = page.waitForEvent('crash')
  void cdp.send('Page.crash').catch(() => {}) // never answers: the renderer is gone
  await crashed
  await page.close().catch(() => {})
  return await context.newPage()
}
