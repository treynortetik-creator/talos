// The usage chip (all percent USED), no mascot in the header, and drag-and-drop attach on desktop.
import { expect, type Page, test } from '@playwright/test'
import { sessionPanel } from '../helpers/phone.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

// Rewritten into the tracked docs folder only on request (TALOS_SHOTS=1), so a plain run leaves tracked files alone.
const DIR = process.env.TALOS_SHOTS ? '../../docs/screenshots/header-drop' : 'test-results/shots/header-drop'
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768

async function settle(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.waitForTimeout(250)
}

test('chip reads percent used for week and context; the chip is the tap target', async ({ page }, info) => {
  await page.goto('/t/general')
  const phone = isPhone(page)
  const chip = page.getByTestId(phone ? 'session-trigger' : 'session-chip')
  const label = 'weekly usage 60% used, context 31% used'
  if (phone) {
    // the slim phone header: a ring and one number; the full reading is the label and the panel
    await expect(chip).toContainText('31%')
    await expect(chip).toHaveAttribute('aria-label', `Session: ${label}`)
  } else {
    await expect(chip).not.toContainText('5h')
    await expect(chip).toContainText('ctx 31% used')
    // No label of its own: the button is named by the words on screen (see label-content-name-mismatch).
    await expect(chip).not.toHaveAttribute('aria-label', /.*/)
    await expect(page.getByTestId('session-trigger')).toHaveAccessibleName(/^Session: wk 60% used\s+ctx 31% used/)
    await expect(chip).toContainText('wk 60% used')
    await expect(chip).not.toContainText('left')
  }
  await settle(page)
  await page
    .getByTestId(phone ? 'phone-header' : 'thread-screen')
    .locator(phone ? 'xpath=.' : 'header')
    .screenshot({ path: `${DIR}/header-${info.project.name}.png` })
  await chip.click()
  await expect(sessionPanel(page)).toBeVisible()
})

test('mascot: gone from the header on phones (the slim row has none) and on desktop (the sidebar has the logo)', async ({
  page,
}) => {
  await page.goto('/t/general')
  await page.evaluate(() =>
    (window as never as { __talos: { session: { patch(p: object): void } } }).__talos.session.patch({
      busy: true,
      turn_id: 't1',
    }),
  )
  const trigger = page.getByTestId('session-trigger')
  await expect(trigger).toBeVisible()
  await expect(trigger.locator('video')).toHaveCount(0)
  await expect(trigger.locator('.mascot')).toBeHidden()
  await expect(page.getByTestId('thread-screen').locator('.mascot:visible')).toHaveCount(0)
  // Both start with "Session" so voice control's "click Session" finds the button; on desktop the usage text it shows follows.
  await expect(trigger).toHaveAccessibleName(isPhone(page) ? /^Session: / : /^Session: wk 60% used/)
})

test('desktop: dropping files adds chips through the attach flow, with an overlay', async ({ page }, info) => {
  await page.goto('/t/general')
  const screen = page.getByTestId('thread-screen')
  await expect(screen).toBeVisible()
  const send = (type: string) =>
    screen.evaluate((el, t) => {
      const dt = new DataTransfer()
      if (t === 'drop' || t === 'dragenter') {
        dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
        dt.items.add(new File([new Uint8Array(4)], 'pic.png', { type: 'image/png' }))
      }
      el.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, type)
  await send('dragenter')
  if (isPhone(page)) {
    await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
    return
  }
  await expect(page.getByTestId('drop-overlay')).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIR}/drop-overlay-${info.project.name}.png` })
  await send('drop')
  await expect(page.getByTestId('drop-overlay')).toHaveCount(0)
  const composer = page.getByTestId('composer')
  await expect(composer.getByText('notes.txt')).toBeVisible()
  await expect(composer.getByText('pic.png')).toBeVisible()
  await expect(composer.getByRole('button', { name: 'Send' })).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIR}/dropped-${info.project.name}.png` })
})
