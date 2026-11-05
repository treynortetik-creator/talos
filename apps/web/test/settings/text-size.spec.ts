// D53 + D32 in a real browser, on the fake-mode build: the largest text size must not clip or push the page sideways at
// phone width, and the Agent draft must survive the phone's Back button.
import { expect, type Page, test } from '@playwright/test'

const PHONE = { width: 393, height: 852 }

async function overflow(page: Page) {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement
    const clipped: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('button, a, input, select, [role=radio], [role=switch]')) {
      if (el.getClientRects().length === 0) continue
      const r = el.getBoundingClientRect()
      if (r.right > innerWidth + 0.5 || r.left < -0.5)
        clipped.push(`${el.tagName} ${el.textContent?.trim().slice(0, 20)}`)
    }
    return { pageSideways: se.scrollWidth > se.clientWidth, clipped }
  })
}

test.describe('Text size at phone width', () => {
  test.use({ viewport: PHONE })

  test('Largest scales the app and nothing is clipped on Settings, Appearance, Notifications and Agent', async ({
    page,
  }) => {
    await page.goto('/settings/appearance')
    const base = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))
    await page.getByRole('radio', { name: 'Largest' }).click()
    const big = await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))
    expect(big).toBeCloseTo(base * 1.5, 1)
    // the choice is a device setting: it is still there after a reload
    await page.reload()
    expect(await page.evaluate(() => parseFloat(getComputedStyle(document.body).fontSize))).toBeCloseTo(base * 1.5, 1)
    for (const path of [
      '/settings',
      '/settings/appearance',
      '/settings/notifications',
      '/settings/agent',
      '/settings/health',
    ]) {
      await page.goto(path)
      await page.waitForLoadState('networkidle')
      const o = await overflow(page)
      expect(o, path).toEqual({ pageSideways: false, clipped: [] })
    }
  })
})

test.describe('Composer at Largest on a phone', () => {
  test.use({ viewport: PHONE })

  test('the box is wide enough for its own placeholder, controls stay on screen, and the 6-line cap follows the text size', async ({
    page,
  }) => {
    await page.goto('/settings/appearance')
    await page.getByRole('radio', { name: 'Largest' }).click()
    await page.goto('/t/general')
    const box = page.getByRole('textbox', { name: 'Message', exact: true })
    await expect(box).toBeVisible()
    const m = await box.evaluate((el) => {
      const ta = el as HTMLTextAreaElement
      const cs = getComputedStyle(ta)
      const probe = document.createElement('span')
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`
      probe.textContent = ta.placeholder.split(' ')[0] ?? '' // the longest unbreakable word: it must not split mid-word
      document.body.appendChild(probe)
      const need = probe.getBoundingClientRect().width
      probe.remove()
      const text = ta.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      return { need, text, height: ta.getBoundingClientRect().height, line: parseFloat(cs.lineHeight) }
    })
    // the first word of the placeholder must fit on one line (no 'Mess / age'), and the empty box stays one line tall
    expect(m.text).toBeGreaterThanOrEqual(m.need)
    expect(m.height).toBeLessThan(m.line * 2)
    // typing 20 lines grows the box to 6 lines at this text size, not 4
    await box.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
    const grown = await box.evaluate((el) => {
      const cs = getComputedStyle(el)
      return {
        h: el.getBoundingClientRect().height,
        line: parseFloat(cs.lineHeight),
        pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
      }
    })
    expect(grown.h).toBeGreaterThanOrEqual(grown.line * 6 + grown.pad - 2)
    const o = await overflow(page)
    expect(o).toEqual({ pageSideways: false, clipped: [] })
  })
})

test.describe('Agent draft on a phone', () => {
  test.use({ viewport: PHONE })
  test('Back keeps the edit and the Agent row says Unsaved changes', async ({ page }) => {
    await page.goto('/settings/agent')
    const name = page.getByLabel('Agent name')
    await name.fill('Zed')
    await page.getByRole('button', { name: 'Back to settings' }).click()
    await expect(page.getByRole('link', { name: /Agent/ })).toContainText('Unsaved changes')
    await page.getByRole('link', { name: /Agent/ }).click()
    await expect(page.getByLabel('Agent name')).toHaveValue('Zed')
    await expect(page.getByTestId('agent-unsaved')).toBeVisible()
  })
})
