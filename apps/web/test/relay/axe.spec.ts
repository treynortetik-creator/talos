import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// What each page draws once it has what it needs: axe reads the page after that, not after a fixed pause.
const PAGES = [
  { name: 'home', path: '/', ready: (page: Page) => page.getByRole('tablist', { name: 'Home' }) },
  { name: 'thread', path: '/t/general', ready: (page: Page) => page.getByTestId('thread-screen') },
  { name: 'threads', path: '/threads', ready: (page: Page) => page.getByTestId('thread-row-general') },
  { name: 'settings', path: '/settings/account', ready: (page: Page) => page.getByTestId('settings-body') },
  { name: 'notifications', path: '/settings/notifications', ready: (page: Page) => page.getByTestId('settings-body') },
  { name: 'appearance', path: '/settings/appearance', ready: (page: Page) => page.getByTestId('settings-body') },
] as const

/** The page has drawn its content: no "Loading…" left, the fonts are in and no animation or transition is still running. */
async function settled(page: Page) {
  await expect(page.locator('#main').getByText('Loading…')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.ready
        return document.getAnimations().filter((a) => a.playState === 'running').length
      }),
    )
    .toBe(0)
}

for (const scheme of ['light', 'dark'] as const) {
  for (const p of PAGES) {
    test(`axe: ${p.name} has no serious or critical violations (${scheme})`, async ({ page, context, harness }) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      await openSignedIn(harness, page, context, p.path)
      if (p.name === 'thread') {
        harness.relay.sendToApps(
          agentReply({ text: '## Heading\n\nSome **bold** text and a [link](https://example.com).\n\n- one\n- two' }),
        )
        await expect(page.getByTestId('msg-agent')).toBeVisible()
      }
      await expect(p.ready(page)).toBeVisible()
      await settled(page)
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()
      const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    })
  }
}

test('axe: the enroll and login pages', async ({ page, harness }) => {
  for (const path of ['/login', `/enroll#${harness.armEnroll().code}`]) {
    await page.goto(`${harness.url}${path}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await settled(page)
    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([])
  }
})
