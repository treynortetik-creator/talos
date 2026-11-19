// Where the Report a bug button (placement B, the default) sits, measured in a real browser. Nothing floats over content
// (Pantheon, 2026-11-14): on a phone thread it is one of the message box's buttons, beside + (also with a four-line
// draft), never on jump-to-latest or the newest message, and the timeline keeps no room for it; off a thread it is a slot in the phone's tab bar, which still fits an
// iPhone SE; on a computer it is a row in the sidebar's footer. The first try, a fixed button, covered all of those.
// Screenshots land in test-results/shots/<project>-bug-*.png (test/bugreport/shots with TALOS_SHOTS=1).
import { expect, type Locator, type Page } from '@playwright/test'
import { test } from '../helpers/ios-readback.ts'

const shot = (name: string, project: string) =>
  process.env.TALOS_SHOTS ? `test/bugreport/shots/${project}-${name}.png` : `test-results/shots/${project}-${name}.png`

type Talos = { store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void } }

async function open(page: Page, path: string) {
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
}

const seed = (page: Page, n: number) =>
  page.evaluate((count) => {
    const t = (window as unknown as { __talos: Talos }).__talos
    t.store.setState((s) => {
      const msgs = (s.messages as Record<string, unknown[]>) ?? {}
      return {
        messages: {
          ...msgs,
          general: Array.from({ length: count }, (_, i) => ({
            id: `m_seed_${i}`,
            thread_id: 'general',
            seq: 1000 + i,
            author: i === count - 1 ? 'owner' : 'agent', // the newest is the owner's: right-aligned, under the corner
            kind: 'text',
            text: `Sample message ${i}. ${'Long enough to wrap on a phone and fill the thread. '.repeat(2)}`,
            format: 'plain',
            attachments: [],
            via: 'app',
            created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
          })),
        },
      }
    })
  }, n)

const box = async (l: Locator) => {
  const b = await l.boundingBox()
  if (!b) throw new Error('not laid out')
  return b
}
const apart = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

test('in a thread: B is a button of the message box, clear of jump-to-latest and the newest message, also with a long draft', async ({
  page,
}, info) => {
  await open(page, '/t/general')
  await expect(page.getByTestId('composer')).toBeVisible()
  if (!phone(page)) {
    // a computer: the sidebar's row, the only one
    const row = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('button', { name: 'Report a bug' })
    await expect(row).toBeVisible()
    await expect(page.getByRole('button', { name: 'Report a bug' })).toHaveCount(1)
    await page.screenshot({ path: shot('bug-thread', info.project.name) })
    return
  }
  await seed(page, 40)
  const tl = page.getByTestId('timeline')
  await tl.evaluate((el) => {
    el.scrollTop = 0
  })
  const composer = page.getByTestId('composer')
  const bug = composer.getByRole('button', { name: 'Report a bug' })
  const jump = page.getByTestId('jump-to-latest')
  await expect(jump).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report a bug' })).toHaveCount(1) // no tab bar in a thread: just this one
  await expect(bug).toBeVisible()
  expect(apart(await box(bug), await box(jump)), 'bug button on jump-to-latest').toBe(true)
  await page.screenshot({ path: shot('bug-thread', info.project.name) })

  await composer.getByRole('textbox').fill('one\ntwo\nthree\nfour')
  await expect(bug).toBeVisible()
  expect(apart(await box(bug), await box(jump)), 'bug button on jump-to-latest (long draft)').toBe(true)
  await page.screenshot({ path: shot('bug-thread-draft', info.project.name) })

  // back at the bottom: the newest message's own row (its time, Copy and menu) has the plain 16 px under it
  await composer.getByRole('textbox').fill('')
  await page.getByTestId('jump-to-latest').click()
  await expect(jump).toHaveCount(0)
  const lastRow = tl.locator('[data-msg-id]').last()
  await expect(lastRow).toHaveAttribute('data-msg-id', 'm_seed_39')
  expect(apart(await box(bug), await box(lastRow)), 'bug button on the newest message').toBe(true)
  await page.screenshot({ path: shot('bug-thread-bottom', info.project.name) })

  await bug.click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

// the narrowest phone the app supports (an iPhone SE, 320 pt) runs these too: five slots must still fit
for (const [size, vp] of [
  ['', null],
  [' on a 320 pt phone', { width: 320, height: 568 }],
] as const)
  for (const path of ['/threads', '/settings', '/']) {
    test(`off a thread (${path})${size}: a phone's tab bar slot, a computer's sidebar row; nothing floats`, async ({
      page,
    }, info) => {
      if (vp) {
        test.skip(info.project.name === 'desktop', 'a phone width only')
        await page.setViewportSize(vp)
      }
      await open(page, path)
      const all = page.getByRole('button', { name: 'Report a bug' })
      await expect(all).toHaveCount(1)
      const where = phone(page)
        ? page.getByRole('navigation', { name: 'Main' })
        : page.getByRole('complementary', { name: 'Sidebar' })
      await expect(where.getByRole('button', { name: 'Report a bug' })).toBeVisible()
      expect(await all.evaluate((el) => getComputedStyle(el).position)).not.toBe('fixed')
      if (phone(page)) {
        // five slots still fit: none narrower than a finger, no label cut, no sideways scroll
        const bar = page.getByRole('navigation', { name: 'Main' })
        const fit = await bar.evaluate((nav) => ({
          scroll: nav.scrollWidth - nav.clientWidth,
          narrowest: Math.min(...Array.from(nav.children).map((c) => (c as HTMLElement).offsetWidth)),
          clipped: Array.from(nav.querySelectorAll('a, button')).some(
            (c) => (c as HTMLElement).scrollWidth > (c as HTMLElement).clientWidth,
          ),
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }))
        expect(fit.scroll).toBe(0)
        expect(fit.page).toBe(0)
        expect(fit.clipped).toBe(false)
        expect(fit.narrowest).toBeGreaterThanOrEqual(44)
      }
      await page.screenshot({ path: shot(`bug${path.replaceAll('/', '-')}${vp ? '-320' : ''}`, info.project.name) })
    })
  }

// screens with no tab bar and no timeline on a phone: a past conversation from search, and a card that is not here yet
for (const path of ['/t/general?m=m_00000000000000000000000130', '/card/c_00000000000000000000000000']) {
  test(`no tab bar and no timeline (${path.split('?')[0]}): still exactly one button`, async ({ page }) => {
    await open(page, path)
    await expect(page.getByRole('button', { name: 'Report a bug' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Report a bug' })).toBeVisible()
  })
}
