// `:shortcode:` emoji in an agent reply, driven through the real agent reply tool, the relay and the built web app: desktop and phone width, light and dark.
import { enrollDevice, expect, signedIn, test } from '../harness/fixtures.ts'

const SHOT_DIR = process.env.EMOJI_SHOT_DIR
const REPLY =
  'Shipped :rocket: and :tada:\n\n- tests green :white_check_mark:\n- unknown :not_an_emoji: stays\n\nCode `:fire:` and [link :smile:](https://example.com/:fire:)\n\n```\n:fire: in a block\n```'

for (const [name, viewport, mobile] of [
  ['desktop', { width: 1280, height: 800 }, false],
  ['iphone', { width: 390, height: 844 }, true],
] as const) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${name} ${scheme}`, () => {
      test.use({ viewport, isMobile: mobile, hasTouch: mobile, colorScheme: scheme })

      test('an agent reply shows emoji in text and keeps shortcodes literal in code and links', async ({
        stack,
        page,
        context,
      }) => {
        if (mobile) {
          // the phone has no sidebar: General opens from the Threads list
          await stack.startBridge()
          await enrollDevice(stack, page, context)
          await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Threads' }).click()
          await page
            .getByRole('link', { name: /^General/ })
            .first()
            .click()
          await expect(page.getByLabel('Message', { exact: true })).toBeVisible()
        } else await signedIn(stack, page, context)
        const res = await stack.claude.callTool('reply', { thread_id: 'general', text: REPLY })
        expect(res.isError).toBeFalsy()
        const msg = page.getByTestId('msg-agent').filter({ hasText: 'Shipped' })
        await expect(msg).toBeVisible()
        await expect(msg).toContainText('Shipped 🚀 and 🎉')
        await expect(msg).toContainText('tests green ✅')
        await expect(msg).toContainText('unknown :not_an_emoji: stays')
        await expect(msg.locator('p code')).toHaveText(':fire:')
        await expect(msg.locator('pre')).toContainText(':fire: in a block')
        const link = msg.getByRole('link')
        await expect(link).toHaveText('link :smile:')
        await expect(link).toHaveAttribute('href', 'https://example.com/:fire:')
        // no horizontal overflow at phone width
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
        if (SHOT_DIR) await page.screenshot({ path: `${SHOT_DIR}/emoji-${name}-${scheme}.png` })
      })
    })
  }
}
