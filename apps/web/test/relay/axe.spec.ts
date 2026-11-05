import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'thread', path: '/t/general' },
  { name: 'threads', path: '/threads' },
  { name: 'settings', path: '/settings/account' },
  { name: 'notifications', path: '/settings/notifications' },
  { name: 'appearance', path: '/settings/appearance' },
] as const

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
      await page.waitForTimeout(400)
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
    await page.waitForTimeout(300)
    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
    ).toEqual([])
  }
})
