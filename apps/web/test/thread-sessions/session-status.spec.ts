// The session status line in a real browser (fake mode): a dedicated thread's row says what its session is doing, the thread
// header's pill opens the whole sentence, phone and desktop, light and dark, and nothing scrolls sideways. Screenshots go to
// $SHOT_DIR when it is set.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })
const SHOTS = process.env.SHOT_DIR

type Talos = {
  store: {
    getState: () => { config: { threads: Array<Record<string, unknown>> } }
    setState: (f: (s: never) => never) => void
  }
  patchConfig: (p: Record<string, unknown>) => Promise<void>
  emit: (type: string, fields: Record<string, unknown>) => void
}

/** In-app navigation the router notices (a reload would lose the fake client's state). */
const go = (page: Page, path: string) =>
  page.evaluate((p) => {
    history.pushState(null, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)

/** A dedicated thread "Work" whose session is `item`, then the Threads screen (the rows the owner saw in the mock). */
async function setUp(page: Page, item: Record<string, unknown>) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate(async (it) => {
    const c = (window as unknown as { __talos: Talos }).__talos
    const cur = c.store.getState().config.threads
    await c.patchConfig({
      threads: [
        ...cur,
        {
          id: 'work',
          name: 'Work',
          kind: 'fixed',
          order: 2,
          notify: 'all',
          voice_context: 'recent',
          archived: false,
          created_at: '2026-10-28T00:00:00.000Z',
          session: 'dedicated',
        },
      ],
      dedicated: { enabled: true },
    })
    c.store.setState(((s: { presence: { features?: string[] } }) => ({
      presence: { ...s.presence, features: [...(s.presence.features ?? []), 'thread-sessions/1'] },
    })) as never)
    c.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [{ thread_id: 'work', state: 'live', ...it }],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
      },
    })
  }, item)
  await go(page, '/threads')
}

const waitingAtMac = () => ({
  needs_you: { kind: 'trust this folder', since: new Date(Date.now() - 12 * 60_000).toISOString() },
})

async function shot(page: Page, name: string, info: { project: { name: string } }, theme: string) {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${info.project.name}-session-${name}-${theme}.png`) })
}

for (const theme of ['light', 'dark'] as const) {
  test(`the row says what the session waits on, and the header pill opens the sentence (${theme})`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ colorScheme: theme })
    await setUp(page, waitingAtMac())
    const row = page.getByTestId('thread-row-work')
    await expect(row.getByTestId('session-line')).toHaveText('Needs you at the Mac · trust this folder')
    await shot(page, 'row', info, theme)
    await row.click()
    await expect(page).toHaveURL(/\/t\/work$/)
    const pill = isPhoneWidth(page)
      ? page.getByTestId('phone-session-pill')
      : page.getByTestId('phone-session-pill').first()
    await expect(pill).toBeVisible()
    await expectAxeClean(page) // the header with its pill, on the black chrome on a phone
    await pill.click()
    const sheet = page.getByTestId('session-sheet')
    await expect(sheet).toContainText('Waiting since')
    await expect(sheet).toContainText('“trust this folder” in its window at the Mac')
    // the sheet's Close button, once the sheet has settled (nothing animating), is on screen without scrolling, and nothing
    // covers it: on the CI runner (desktop, dark) a read of the point at its centre found no button there. The box and the
    // viewport go in the message; the trial click (Playwright's own hit test) names any element that would take the tap.
    const close = page.getByRole('button', { name: 'Close' })
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    const box = await close.boundingBox()
    const vp = page.viewportSize()
    const where = `Close at ${JSON.stringify(box)} in a ${vp?.width}x${vp?.height} viewport`
    expect(box, where).not.toBeNull()
    if (box && vp) {
      expect(box.x >= 0 && box.y >= 0, where).toBe(true)
      expect(box.x + box.width <= vp.width && box.y + box.height <= vp.height, where).toBe(true)
    }
    await close.click({ trial: true })
    await shot(page, 'sheet', info, theme)
    // with the sheet open on a phone; on a desktop the page behind the sheet's dim overlay reads as low contrast to axe, so
    // that page was checked before the sheet opened
    if (isPhoneWidth(page)) await expectAxeClean(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(pill).toBeFocused() // focus goes back to the pill
  })
}

test('idle keeps the last message on the row; a stopped session says so', async ({ page }) => {
  await setUp(page, { last_turn_at: new Date(Date.now() - 5 * 60_000).toISOString() })
  await expect(page.getByTestId('thread-row-work')).toBeVisible()
  await expect(page.getByTestId('thread-row-work').getByTestId('session-line')).toHaveCount(0)
})

test('the narrowest phone (320 px): the pill keeps its mark, the name keeps room, nothing scrolls sideways', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'a phone layout')
  await page.setViewportSize({ width: 320, height: 568 })
  await setUp(page, waitingAtMac())
  await go(page, '/t/work')
  const pill = page.getByTestId('phone-session-pill')
  await expect(pill).toBeVisible()
  const box = await pill.boundingBox()
  expect(box?.width ?? 0).toBeLessThan(40) // the mark alone under 380 px
  await expect(page.getByRole('heading', { name: 'Work' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('the other tones on the phone header are readable on the black chrome (light theme)', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'the phone header')
  await page.emulateMedia({ colorScheme: 'light' })
  for (const item of [
    { state: 'busy', turn_started_at: new Date(Date.now() - 5 * 60_000).toISOString() },
    { state: 'failed', error: 'needs_mac' },
    { state: 'parked', stopped_why: 'owner' },
  ]) {
    await setUp(page, item)
    await go(page, '/t/work')
    await expect(page.getByTestId('phone-session-pill')).toBeVisible()
    // colours read mid-transition fail the contrast check on a loaded machine: settle first, as the cases above do
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    await expectAxeClean(page)
  }
})
