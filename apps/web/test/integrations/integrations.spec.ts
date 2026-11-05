import { expect, test } from '@playwright/test'
import { listSetupSpecs } from '@talos-app/integrations/catalog'
import { expectAxeClean, open, sentFrames } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

test('the work tile is locked and shows the config ask_note', async ({ page }) => {
  await open(page, '/settings/integrations')
  const note = await page.evaluate(() => window.__talos.store.getState().config?.work.ask_note ?? '')
  const tile = page.locator('[data-tile="slack"]')
  await expect(tile).toHaveAttribute('data-locked', 'true')
  await expect(tile).toContainText(note)
  await expect(tile).toContainText('🔒')
})

test('enabling a work integration requires step-up and sends a config.patch touching work.enabled', async ({
  page,
}) => {
  await open(page, '/settings/integrations')
  await page.evaluate(() => {
    const c = window.__talos
    const orig = c.stepup.bind(c)
    c.stepup = async (purpose: string) => {
      window.__order.push(`${purpose}:sent=${c.sent.length}`)
      return orig(purpose)
    }
  })
  await page.locator('[data-tile="slack"]').click()
  await page.getByRole('button', { name: /^Confirm (it's you|with Face ID)$/ }).click()
  await expect(page.locator('[data-tile="slack"]')).toHaveAttribute('data-locked', 'false')
  expect(await page.evaluate(() => window.__order)).toEqual(['config:work:sent=0'])
  const frame = (await sentFrames(page)).at(-1) as Record<string, unknown>
  expect(frame.type).toBe('config.patch')
  expect(frame.patch).toEqual({ work: { enabled: ['slack'] } })
})

test('the wizard renders all 5 screens for every catalog entry (fake mode)', async ({ page }) => {
  test.setTimeout(240_000)
  for (const entry of listSetupSpecs()) {
    await open(page, `/wizard/${entry.id}`)
    if (entry.category === 'work') {
      await page.evaluate((id) => {
        const c = window.__talos
        const cfg = c.store.getState().config
        if (cfg)
          c.store.setState({ ...c.store.getState(), config: { ...cfg, work: { ...cfg.work, enabled: [id as never] } } })
      }, entry.id)
    }
    await expect(page.getByText('Step 2 of 5')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'What should reach you?' })).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('heading', { name: 'Connect', exact: true })).toBeVisible()
    await expect(page.getByText('Setting up…')).toHaveCount(0)
    for (const f of entry.connect.filter((s) => s.type === 'field')) {
      const input = page.getByLabel(f.label)
      for (const candidate of [
        'x',
        'xoxp-abc',
        'alex@example.com',
        'https://example.com',
        '1',
        `ghp_${'a'.repeat(36)}`,
        '/a', // JSON pointer (generic webhook mapping fields)
        '0123456789abcdef0123456789abcdef', // Slack signing secret
        'example.atlassian.net', // Jira site
        `lin_api_${'a'.repeat(24)}`, // Linear API key
        'whsec_EXAMPLEexampleEXAMPLE0001', // Stripe signing secret
        '00D000000000062EAA', // Salesforce org id
      ]) {
        await input.fill(candidate)
        if (!f.pattern || new RegExp(f.pattern).test(candidate)) break
      }
    }
    const save = page.getByRole('button', { name: 'Save and continue' })
    if (await save.count()) {
      await save.click()
      await expect(page.getByRole('button', { name: 'Next' })).toBeVisible()
    }
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('heading', { name: 'Test' })).toBeVisible()
    await expect(page.getByText('Waiting for the first event…')).toBeVisible()
    await page.evaluate((name) => {
      const c = window.__talos
      const s = c.store.getState()
      c.api.connections.list().then(([conn]) => {
        const item = {
          ...s.inbox[0],
          id: 'e_01JBF3V7Q8K2M4N6P8R0S9ZZZZ',
          connection: conn?.id,
          title: `Event from ${name}`,
          ts: new Date().toISOString(),
        }
        c.store.setState({ ...c.store.getState(), inbox: [item as never, ...c.store.getState().inbox] })
      })
    }, entry.name)
    await page.getByRole('button', { name: 'Looks right' }).click()
    await expect(page.getByRole('heading', { name: 'Connected' })).toBeVisible()
    await expect(page.getByTestId('conn-status')).toContainText('connected')
  }
})

test('axe: integrations list and the wizard are clean in light and dark', async ({ page }) => {
  await open(page, '/settings/integrations')
  await expectAxeClean(page)
  await open(page, '/wizard/generic')
  await expectAxeClean(page)
})
