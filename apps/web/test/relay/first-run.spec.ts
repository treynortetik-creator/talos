// First run at phone width: pairing the agent's first device on an agent never set up (device.pinned `first`) opens the
// Setup thread with its kickoff sent once; the card fits the screen and skips with one tap; a reload brings nothing back.
import type { BrowserContext, Page } from '@playwright/test'
import { mkFrame } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { waitUntil } from '../helpers/util.ts'

test.beforeEach(({ browserName }) => test.skip(browserName !== 'chromium', 'virtual authenticator is Chromium-only'))

const SETUP = 'talos__setup'
const KICKOFF = 'Set up my agent. Start the setup interview, or pick it up where we left off.'
const SKIP = 'Skip the setup interview for now. I can start it later from Settings → Agent.'

async function virtualAuthenticator(context: BrowserContext, page: Page) {
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

async function pair(page: Page, context: BrowserContext, harness: Harness, first: boolean) {
  await virtualAuthenticator(context, page)
  const { link } = harness.armEnroll()
  await page.goto(link)
  await page.getByRole('button', { name: /^Continue/ }).click()
  await waitUntil(() => harness.devices.size === 1, 'device registered')
  const [deviceId] = [...harness.devices.keys()]
  if (!deviceId) throw new Error('no device')
  harness.pinDevice(deviceId, true, undefined, { first })
  await expect(page.getByRole('heading', { name: 'This device is ready' })).toBeVisible()
}
const sentText = (
  harness: { relay: { frames: Array<{ direction: string; raw: Record<string, unknown> }> } },
  text: string,
) =>
  harness.relay.frames.filter((f) => f.direction === 'from_app' && f.raw.type === 'message' && f.raw.text === text)
    .length

/**
 * Plays the computer's side of a config patch, as the live bridge does: applies each `config.patch` the app sends (a merge
 * patch; `threads` merged by id) and answers with the `config.sync` that names it.
 */
function playComputer(harness: Harness): () => void {
  const seen = new Set<string>()
  const timer = setInterval(() => {
    for (const f of harness.relay.frames) {
      if (f.direction !== 'from_app' || f.raw.type !== 'config.patch') continue
      const id = String(f.raw.id)
      if (seen.has(id)) continue
      seen.add(id)
      const rev = harness.relay.config.rev + 1
      const patch = f.raw.patch as { threads?: Array<Record<string, unknown>> } & Record<string, unknown>
      const config = { ...harness.relay.config, ...patch, rev } as typeof harness.relay.config
      // threads are merged by id, as the bridge does: a known thread's entry carries only its changed keys
      if (patch.threads) {
        const was = new Map(harness.relay.config.threads.map((t) => [t.id, t as Record<string, unknown>]))
        config.threads = patch.threads.map((t) => {
          const merged = { ...(was.get(String(t.id)) ?? {}), ...t }
          for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k]
          return merged
        }) as typeof config.threads
      }
      harness.relay.config = config
      harness.relay.sendToApps(mkFrame('config.sync', { config: harness.relay.config, rev, applied: id }))
    }
  }, 50)
  return () => clearInterval(timer)
}

test('the first pairing opens Setup once; Skip is one tap, says where setup lives, and does not come back', async ({
  page,
  context,
  harness,
}) => {
  const stop = playComputer(harness)
  await pair(page, context, harness, true)
  await expect(page).toHaveURL(new RegExp(`/t/${SETUP}$`), { timeout: 10_000 })
  const card = page.getByTestId('first-run-card')
  await expect(card).toBeVisible()
  await expect(card.getByText('You can start setup any time from Settings → Agent.')).toBeVisible()
  // at phone width the card fits: no sideways scroll, the Skip button inside the screen
  const width = page.viewportSize()?.width ?? 0
  const box = await card.boundingBox()
  expect(box && box.x >= 0 && box.x + box.width <= width).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await waitUntil(() => sentText(harness, KICKOFF) === 1, 'the kickoff')
  await page.getByTestId('first-run-skip').click()
  await expect(card).toHaveCount(0)
  await waitUntil(() => sentText(harness, SKIP) === 1, 'the skip')
  await page.reload()
  await page.goto('/')
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible()
  await page.waitForTimeout(1000)
  expect(page.url()).not.toContain(SETUP)
  expect(sentText(harness, KICKOFF)).toBe(1)
  stop()
})

test('a pairing without `first` (a second phone, a set-up agent) never opens Setup', async ({
  page,
  context,
  harness,
}) => {
  await pair(page, context, harness, false)
  await expect(
    page.getByRole('navigation', { name: 'Main' }).or(page.getByRole('complementary', { name: 'Sidebar' })),
  ).toBeVisible({ timeout: 8000 })
  await page.waitForTimeout(1500)
  expect(page.url()).not.toContain(SETUP)
  expect(sentText(harness, KICKOFF)).toBe(0)
})

test.describe('at iPhone width (375 px), in Chromium: passkeys cannot be automated on WebKit', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  test('the Setup card fits and skips with one tap', async ({ page, context, harness }) => {
    const stop = playComputer(harness)
    await pair(page, context, harness, true)
    const card = page.getByTestId('first-run-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    const box = await card.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const skip = await page.getByTestId('first-run-skip').boundingBox()
    expect(skip && skip.height >= 44).toBe(true) // a thumb-sized target
    await page.getByTestId('first-run-skip').tap()
    await expect(card).toHaveCount(0)
    stop()
  })
})
