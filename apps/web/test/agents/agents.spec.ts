// Agents panel WP-A2 in a real browser (iphone, pixel, desktop): the docked rail at >= 1280 px, the header chip and its
// sheets below, Stop, and the empty / offline / mod-absent states, against the scripted fake session
// (`VITE_FAKE=1`; `?fake_agents=demo|empty`, `?fake_mod=offline|absent`).
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

/** expectAxeClean scoped to the rail (the header around it is other packages' and covered by their specs). */
async function expectRailAxeClean(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const res = await new AxeBuilder({ page }).include('[data-testid="agents-rail"]').analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(bad.map((v) => `${colorScheme}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  }
}

type Fake = {
  sent: Array<Record<string, unknown>>
  setMacOnline(on: boolean): void
  session: { setAgents(rows: unknown[] | null, over?: Record<string, unknown>): void }
}
const fake = <T>(page: Page, fn: (t: Fake) => T) => page.evaluate(`(${fn.toString()})(window.__talos)`) as Promise<T>
const agentStops = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __talos: Fake }).__talos.sent.filter(
      (f) => f.type === 'session.control' && f.action === 'agent_stop',
    ),
  )

async function openThread(page: Page, q = 'fake_agents=demo') {
  await page.goto(`/t/general${q ? `?${q}` : ''}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}
const isDesktop = (name: string) => name === 'desktop'

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(over).toBeLessThanOrEqual(0)
}

test('desktop: the rail sits right of the timeline, open, with rows like the CLI', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'the rail is >= 1280 px')
  await openThread(page)
  const rail = page.getByTestId('agents-rail')
  await expect(rail).toHaveAttribute('data-state', 'open')
  await expect(page.getByTestId('agents-chip')).toBeHidden()
  // beyond the context and metering: the session chip stays in the header, the rail is to its right
  const chip = await page.getByTestId('session-chip').boundingBox()
  const box = await rail.boundingBox()
  expect(chip && box && box.x >= chip.x + chip.width).toBe(true)
  expect(Math.round(box?.width ?? 0)).toBe(320)
  await expect(rail.getByRole('list', { name: 'Agents' }).getByRole('listitem')).toHaveCount(4)
  await expect(rail.getByText('Explore · research mods API')).toBeVisible()
  await expect(rail.getByText('Running memory and search vitest suites')).toBeVisible()
  await expect(rail.getByTestId('agents-shells-toggle')).toContainText('2 shells · 1 monitor')
  await rail.getByTestId('agents-shells-toggle').click()
  await rail.getByRole('button', { name: /research mods API/ }).click()
  await expectRailAxeClean(page)
})

test('desktop: tap expands inline, Stop sends a signed agent_stop and the row ends', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'the rail is >= 1280 px')
  await openThread(page)
  const rail = page.getByTestId('agents-rail')
  const row = rail.getByRole('button', { name: /research mods API/ })
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(rail.getByTestId('agent-recent')).toContainText('Run vitest suites')
  await rail.getByTestId('agent-stop').click()
  await expect(rail.getByTestId('agent-outcome')).toHaveText('Stopped.')
  const sent = await agentStops(page)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ action: 'agent_stop', agent_id: 'a00f4f30ac1399f7f', thread_id: 'general' })
  expect(typeof sent[0]?.osig).toBe('string')
  await expect(rail.locator('[data-id="a00f4f30ac1399f7f"]')).toHaveAttribute('data-status', 'killed')
  await expect(rail.getByTestId('agent-stop')).toHaveCount(0)
})

test('desktop: collapsing persists across a reload and beats new rows', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'the rail is >= 1280 px')
  await openThread(page)
  await page.getByRole('button', { name: 'Hide agents' }).click()
  const rail = page.getByTestId('agents-rail')
  await expect(rail).toHaveAttribute('data-state', 'collapsed')
  expect(Math.round((await rail.boundingBox())?.width ?? 0)).toBe(44)
  await page.reload()
  await expect(page.getByTestId('agents-rail')).toHaveAttribute('data-state', 'collapsed')
  await fake(page, (t) => t.session.setAgents([{ id: 'fresh', title: 'a new one', status: 'running' }]))
  await expect(page.getByTestId('agents-rail')).toHaveAttribute('data-state', 'collapsed')
  await expect(page.getByTestId('agents-count')).toHaveText('1 agent')
  await page.getByRole('button', { name: /Show agents/ }).click()
  await expect(page.getByTestId('agents-rail')).toHaveAttribute('data-state', 'open')
})

test('1024 px: the chip opens the session sheet, Agents right under the meters', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'a desktop browser resized')
  await page.setViewportSize({ width: 1024, height: 800 })
  await openThread(page)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  await page.getByTestId('agents-chip').click()
  const sheet = page.getByTestId('session-sheet')
  await expect(sheet).toBeVisible()
  const agents = sheet.getByTestId('session-agents')
  await expect(agents).toContainText('3 active')
  await agents.getByRole('button', { name: /research mods API/ }).click()
  await expect(agents.getByTestId('agent-detail')).toBeVisible()
  await agents.getByRole('button', { name: /All agents/ }).click()
  await expect(agents.getByRole('list', { name: 'Agents' })).toBeVisible()
  await noHorizontalScroll(page)
})

test('phone: the ring opens the session panel; tap pushes the detail; Stop works', async ({ page }, info) => {
  test.skip(isDesktop(info.project.name), 'phones only')
  await openThread(page)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  // the slim phone header carries no agents chip: agents live in the session panel
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  const name = await page.locator('h1').evaluate((h) => h.scrollWidth - h.clientWidth)
  expect(name).toBeLessThanOrEqual(0)
  await noHorizontalScroll(page)
  await page.getByTestId('session-trigger').click()
  const sheet = page.getByTestId('session-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('list', { name: 'Agents' }).getByRole('listitem')).toHaveCount(4)
  await sheet.getByRole('button', { name: /research mods API/ }).click()
  await expect(sheet.getByTestId('agent-recent')).toContainText('Run vitest suites')
  await sheet.getByTestId('agent-stop').click()
  await expect(sheet.getByTestId('agent-outcome')).toHaveText('Stopped.')
  expect(await agentStops(page)).toHaveLength(1)
  await sheet.getByRole('button', { name: /All agents/ }).click()
  await expect(sheet.locator('[data-id="a00f4f30ac1399f7f"]')).toHaveAttribute('data-status', 'killed')
  await noHorizontalScroll(page)
  await expectAxeClean(page)
})

test('phone: shells and monitors open from their count', async ({ page }, info) => {
  test.skip(isDesktop(info.project.name), 'phones only')
  await openThread(page)
  await page.getByTestId('session-trigger').click()
  const sheet = page.getByTestId('session-sheet')
  await sheet.getByTestId('agents-shells-toggle').click()
  await expect(sheet.getByRole('list', { name: 'Shells and monitors' }).getByRole('listitem')).toHaveCount(3)
  await expect(sheet.getByText('shell · Run the dev server')).toBeVisible()
})

test('empty: "No agents running."', async ({ page }, info) => {
  await openThread(page, 'fake_agents=empty')
  if (isDesktop(info.project.name)) {
    await page.getByRole('button', { name: /Show agents/ }).click()
    await expect(page.getByTestId('agents-rail').getByTestId('agents-empty')).toHaveText('No agents running.')
  } else {
    await page.getByTestId('session-trigger').click()
    await expect(page.getByTestId('session-sheet').getByTestId('agents-empty')).toHaveText('No agents running.')
  }
})

test('mod absent (or an old relay/bridge): no chip, no rail, no claim about the mod', async ({ page }) => {
  await openThread(page, 'fake_agents=demo&fake_mod=absent')
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  await openThread(page, '') // a live mod whose snapshot never arrives
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
})

test('mod offline: rows greyed as unknown, "Mod offline", no Stop', async ({ page }, info) => {
  await openThread(page, 'fake_agents=demo&fake_mod=offline')
  const where = isDesktop(info.project.name) ? page.getByTestId('agents-rail') : page.getByTestId('session-sheet')
  if (!isDesktop(info.project.name)) await page.getByTestId('session-trigger').click()
  await expect(where.getByTestId('agents-offline')).toHaveText('Mod offline')
  await expect(where.getByTestId('agents-list')).toHaveAttribute('data-offline', 'mod')
  await where.getByRole('button', { name: /research mods API/ }).click()
  await expect(where.getByTestId('agent-detail')).toContainText('unknown')
  await expect(where.getByTestId('agent-stop')).toHaveCount(0)
  if (isDesktop(info.project.name)) await expectRailAxeClean(page)
  else await expectAxeClean(page)
})

test('Mac offline: the panel greys and Stop hides', async ({ page }, info) => {
  await openThread(page)
  await fake(page, (t) => t.setMacOnline(false))
  const where = isDesktop(info.project.name) ? page.getByTestId('agents-rail') : page.getByTestId('session-sheet')
  if (!isDesktop(info.project.name)) await page.getByTestId('session-trigger').click()
  await expect(where.getByTestId('agents-offline')).toHaveText('Mac offline')
  await where.getByRole('button', { name: /research mods API/ }).click()
  await expect(where.getByTestId('agent-stop')).toHaveCount(0)
})
