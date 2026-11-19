// Report a bug during a live call on a phone. The call bar replaces the message box (which holds the bug button on a phone),
// so the bar carries its own: a small icon right after Mute (or Hands-free), without crowding End or the talk area.
// The page under test is ./harness (the real call bar, the real bug reporter, a scripted peer). Phone sizes: 375 x 812 and the
// narrowest supported, 320 x 568, in both themes, in both talk modes. On a desktop the sidebar holds the button instead.
import { expect, type Locator, type Page, test } from '@playwright/test'

const SESSION = 'v_01JBF3V7Q8K2M4N6P8R0S2T426'

type Box = { x: number; y: number; width: number; height: number }
const box = async (loc: Locator): Promise<Box> => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('no box')
  return b
}
const centreY = (b: Box) => b.y + b.height / 2
const right = (b: Box) => b.x + b.width
const overlap = (a: Box, b: Box) =>
  a.x < right(b) - 0.5 && b.x < right(a) - 0.5 && a.y < b.y + b.height && b.y < a.y + a.height

async function startCall(page: Page, mode: 'hands_free' | 'hold' = 'hands_free', query = '') {
  const requests: string[] = []
  await page.addInitScript((m) => localStorage.setItem('talos.voice.mode', m), mode)
  await page.route('**/api/voice/session', async (route) => {
    requests.push('create')
    await route.fulfill({ json: { voice_session_id: SESSION, sdp_answer: 'v=0\r\na=answer\r\n', max_minutes: 30 } })
  })
  await page.route('**/api/voice/session/*/close', async (route) => {
    requests.push('close')
    await route.fulfill({ status: 204 })
  })
  await page.goto(`/test/voice/harness/index.html${query}`)
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/voice/session'))
  await page.getByRole('button', { name: 'Start a live call' }).click()
  await answered
  await page.evaluate(() => window.__voice.emit({ type: 'session.started' }))
  const toolbar = page.getByRole('toolbar', { name: 'Call controls' })
  await expect(toolbar.getByTestId('talk-area')).toBeEnabled()
  return { toolbar, requests }
}

const phones = [
  { name: '375 px phone', width: 375, height: 812, talkMin: 100 },
  { name: '320 px phone', width: 320, height: 568, talkMin: 80 },
] as const

for (const size of phones) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true })

    for (const colorScheme of ['light', 'dark'] as const) {
      for (const mode of ['hands_free', 'hold'] as const) {
        test.describe(`${colorScheme}, ${mode}`, () => {
          test.beforeEach(async ({ page }) => {
            await page.emulateMedia({ colorScheme })
          })

          test('the bug button is in the call bar, beside the talk-mode control, and nothing covers it', async ({
            page,
          }) => {
            const { toolbar } = await startCall(page, mode)
            const bug = toolbar.getByTestId('bug-button')
            await expect(bug).toHaveCount(1)
            await expect(bug).toBeVisible()
            await expect(bug).toHaveAttribute('aria-label', 'Report a bug')
            await expect(bug).toHaveAttribute('data-no-capture', '')
            const lead = toolbar.getByRole('button', { name: mode === 'hold' ? 'Hands-free' : 'Mute' })
            const b = await box(bug)
            const l = await box(lead)
            expect(Math.abs(centreY(b) - centreY(l)), 'not on the Mute row').toBeLessThanOrEqual(4)
            expect(b.x, 'not to the right of Mute').toBeGreaterThanOrEqual(right(l) - 0.5)
            expect(b.x - right(l), 'not next to Mute').toBeLessThanOrEqual(16)
            expect(b.x + b.width, 'not left of the talk area').toBeLessThanOrEqual(
              (await box(toolbar.getByTestId('talk-area'))).x + 0.5,
            )
            expect(b.width).toBeGreaterThanOrEqual(44)
            expect(b.height).toBeGreaterThanOrEqual(44)
            const covered = await bug.evaluate((el) => {
              const r = el.getBoundingClientRect()
              const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
              return hit === null || !el.contains(hit)
            })
            expect(covered, 'something covers the bug button').toBe(false)
          })

          test('a tap opens the bug report and the call goes on', async ({ page }) => {
            const { toolbar, requests } = await startCall(page, mode)
            await toolbar.getByTestId('bug-button').click()
            await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible()
            expect(await page.evaluate(() => window.__voice.trackState()), 'the call lost its microphone').toBe('live')
            expect(requests, 'the call was closed').toEqual(['create'])
            await expect(page.locator('[role=toolbar][aria-label="Call controls"]')).toHaveCount(1)
          })

          test('End stays a full 44 x 44 target, the talk area keeps its width, and nothing overlaps', async ({
            page,
          }) => {
            const { toolbar } = await startCall(page, mode)
            const bar = await box(toolbar)
            expect(bar.height, 'the bar wrapped or grew').toBe(72)
            const end = toolbar.getByRole('button', { name: 'End call' })
            const e = await box(end)
            expect(e.width).toBeGreaterThanOrEqual(44)
            expect(e.height).toBeGreaterThanOrEqual(44)
            const talk = await box(toolbar.getByTestId('talk-area'))
            expect(talk.width, 'the talk area is too narrow').toBeGreaterThanOrEqual(size.talkMin)
            const parts: Array<[string, Box]> = [
              ['mute', await box(toolbar.getByRole('button', { name: mode === 'hold' ? 'Hands-free' : 'Mute' }))],
              ['bug', await box(toolbar.getByTestId('bug-button'))],
              ['talk', talk],
              ['end', e],
            ]
            for (let i = 0; i < parts.length; i++) {
              const [n, p] = parts[i] as [string, Box]
              expect(p.x, `${n} sticks out on the left`).toBeGreaterThanOrEqual(bar.x - 0.5)
              expect(right(p), `${n} sticks out on the right`).toBeLessThanOrEqual(right(bar) + 0.5)
              for (const [m, q] of parts.slice(i + 1)) expect(overlap(p, q), `${n} overlaps ${m}`).toBe(false)
            }
            const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
            expect(noScroll, 'the page scrolls sideways').toBe(true)
            // End is what the finger finds: nothing sits on top of it
            const hit = await end.evaluate((el) => {
              const r = el.getBoundingClientRect()
              return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            })
            expect(hit).toBe(true)
          })
        })
      }
    }
  })
}

// What a button draws, apart from its words: every path it holds, so two different glyphs differ.
const glyph = (loc: Locator) =>
  loc.evaluate((el) => [...el.querySelectorAll('svg *')].map((n) => n.getAttribute('d') ?? n.tagName).join('|'))

test.describe('the compact Hands-free icon', () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true })
  test('is not the microphone Mute shows', async ({ page, context }) => {
    const { toolbar } = await startCall(page, 'hands_free')
    const mute = await glyph(toolbar.getByRole('button', { name: 'Mute' }))
    const other = await context.newPage()
    const held = await startCall(other, 'hold')
    const hands = held.toolbar.getByRole('button', { name: 'Hands-free' })
    await expect(hands).toHaveAttribute('title', 'Hands-free')
    expect(await glyph(hands)).not.toBe(mute)
    expect(await glyph(hands), 'no icon at all').not.toBe('')
  })
})

// The full-screen call (a setting) has a dark field in both themes; its controls must stay readable on it.
const luminance = (rgb: string) => {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrastOf = async (loc: Locator) => {
  const { fg, bg } = await loc.evaluate((el) => {
    let node: Element | null = el
    let bg = 'rgba(0, 0, 0, 0)'
    while (node) {
      const c = getComputedStyle(node).backgroundColor
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') {
        bg = c
        break
      }
      node = node.parentElement
    }
    return { fg: getComputedStyle(el).color, bg }
  })
  const [a, b] = [luminance(fg), luminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test.describe('full-screen call, 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${colorScheme}: the bug button is readable on the dark field, and a tap does not end the call`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme })
      const { toolbar, requests } = await startCall(page, 'hands_free', '?screen=1')
      await expect(page.getByRole('region', { name: 'Call in progress' })).toBeVisible()
      const bug = toolbar.getByTestId('bug-button')
      await expect(bug).toBeVisible()
      expect(await contrastOf(bug), 'Report a bug is hard to see').toBeGreaterThanOrEqual(3)
      expect(
        await contrastOf(toolbar.getByRole('button', { name: 'Mute' })),
        'Mute is hard to see',
      ).toBeGreaterThanOrEqual(3)
      await bug.click()
      await expect(page.getByRole('dialog', { name: 'Report a bug' })).toBeVisible()
      expect(await page.evaluate(() => window.__voice.trackState())).toBe('live')
      expect(requests).toEqual(['create'])
    })
  }
})

test.describe('desktop width', () => {
  test.use({ viewport: { width: 1440, height: 900 } })
  test('the call bar has no bug button (the sidebar keeps it)', async ({ page }) => {
    const { toolbar } = await startCall(page)
    await expect(toolbar.getByTestId('bug-button')).toBeHidden()
  })
})
