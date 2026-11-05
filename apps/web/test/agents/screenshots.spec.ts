// Agents panel screenshots for review (docs/screenshots/subagents/): phone (iPhone 15 project) and desktop (1440x900),
// light and dark (the app follows the system scheme unless the owner picked one).
import { expect, type Page, test } from '@playwright/test'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

const DIR = '../../docs/screenshots/subagents'
// These rewrite tracked PNGs, so they run only on request (TALOS_SHOTS=1), like shell/phone-chat.spec.ts.
test.beforeEach(({ page: _page }, info) => {
  test.skip(!process.env.TALOS_SHOTS, 'screenshots are rewritten only with TALOS_SHOTS=1')
  test.skip(info.project.name === 'pixel', 'phone shots come from the iPhone project')
})
const kind = (name: string) => (name === 'iphone' ? 'phone' : 'desktop')

async function settle(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  await page.waitForTimeout(250)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(scheme, () => {
    test.use({ colorScheme: scheme })

    test('panel', async ({ page }, info) => {
      await page.goto('/t/general?fake_agents=demo')
      if (kind(info.project.name) === 'desktop') {
        const rail = page.getByTestId('agents-rail')
        await expect(rail).toHaveAttribute('data-state', 'open')
        await rail.getByTestId('agents-shells-toggle').click()
      } else {
        await page.getByTestId('session-trigger').click()
        await expect(page.getByTestId('session-sheet')).toBeVisible()
      }
      await settle(page)
      await page.screenshot({ path: `${DIR}/panel-${kind(info.project.name)}-${scheme}.png` })
    })

    test('detail', async ({ page }, info) => {
      await page.goto('/t/general?fake_agents=demo')
      const where =
        kind(info.project.name) === 'desktop' ? page.getByTestId('agents-rail') : page.getByTestId('session-sheet')
      if (kind(info.project.name) !== 'desktop') await page.getByTestId('session-trigger').click()
      await where.getByRole('button', { name: /research mods API/ }).click()
      await expect(where.getByTestId('agent-stop')).toBeVisible()
      await settle(page)
      await page.screenshot({ path: `${DIR}/detail-${kind(info.project.name)}-${scheme}.png` })
    })
  })
}

test('1024 px: session sheet with Agents under the meters', async ({ page }, info) => {
  test.skip(kind(info.project.name) !== 'desktop', 'desktop only')
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.goto('/t/general?fake_agents=demo')
  await page.getByTestId('agents-chip').click()
  await expect(page.getByTestId('session-agents')).toBeVisible()
  await settle(page)
  await page.screenshot({ path: `${DIR}/sheet-1024-light.png` })
})

for (const [name, q] of [
  ['empty', 'fake_agents=empty'],
  ['offline', 'fake_agents=demo&fake_mod=offline'],
  ['absent', 'fake_mod=absent'],
] as const) {
  test(`state: ${name}`, async ({ page }, info) => {
    test.skip(name === 'absent' && kind(info.project.name) === 'phone', 'no chip on a phone without the mod')
    await page.goto(`/t/general?${q}`)
    if (kind(info.project.name) === 'desktop') {
      const rail = page.getByTestId('agents-rail')
      if (name === 'absent')
        await expect(rail).toHaveCount(0) // no snapshot: no rail at all
      else if ((await rail.getAttribute('data-state')) === 'collapsed')
        await page.getByRole('button', { name: /Show agents/ }).click()
      if (name !== 'absent') await expect(rail).toHaveAttribute('data-state', 'open')
    } else {
      await page.getByTestId('session-trigger').click()
      await expect(page.getByTestId('session-sheet')).toBeVisible()
    }
    await settle(page)
    await page.screenshot({ path: `${DIR}/${name}-${kind(info.project.name)}-light.png` })
  })
}
