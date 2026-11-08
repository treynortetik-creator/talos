// The Agents section of the Session panel in a real browser (iphone, pixel, desktop): docked beside the chat on a desktop,
// a sheet below 1024 px, Stop, and the empty / offline / mod-absent states, against the scripted fake session
// (`VITE_FAKE=1`; `?fake_agents=demo|empty`, `?fake_mod=offline|absent`).
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { openSessionPanel } from '../helpers/phone.ts'

// The page-motion helpers inject a <style> (test-only CSS). The service worker stamps the real CSP (style-src 'self') on
// precached HTML, so once it controls the page that injection is refused. bypassCSP lets the test harness inject; the app's
// CSP itself is asserted in test/relay/sw-csp.spec.ts.
test.use({ bypassCSP: true })

/** expectAxeClean scoped to the docked panel (the header around it is other packages' and covered by their specs). */
async function expectPanelAxeClean(page: Page) {
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const res = await new AxeBuilder({ page }).include('[data-testid="session-dock"]').analyze()
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
/** The panel's own accessibility check: the docked panel on a desktop, the whole page behind a sheet on a phone. */
const axe = (page: Page, project: string) => (isDesktop(project) ? expectPanelAxeClean(page) : expectAxeClean(page))

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(over).toBeLessThanOrEqual(0)
}

test('desktop: the docked panel lists the agents like the CLI, right of the timeline', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'the panel docks at >= 1024 px')
  await openThread(page)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  const dock = await openSessionPanel(page)
  const box = await dock.boundingBox()
  const timeline = await page.getByTestId('thread-screen').boundingBox()
  expect(box && timeline && box.x >= timeline.x + timeline.width).toBe(true)
  expect(Math.round(box?.width ?? 0)).toBe(360)
  const agents = dock.getByTestId('session-agents')
  await expect(agents.getByRole('list', { name: 'Agents' }).getByRole('listitem')).toHaveCount(4)
  await expect(agents.getByText('Explore · research mods API')).toBeVisible()
  await expect(agents.getByText('Running memory and search vitest suites')).toBeVisible()
  await expect(agents.getByTestId('agents-shells-toggle')).toContainText('2 shells · 1 monitor')
  await agents.getByTestId('agents-shells-toggle').click()
  await agents.getByRole('button', { name: /research mods API/ }).click()
  await expectPanelAxeClean(page)
})

test('1023 px: the chip opens the session sheet, Agents right under the meters', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'a desktop browser resized')
  await page.setViewportSize({ width: 1023, height: 800 })
  await openThread(page)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  const sheet = await openSessionPanel(page)
  await expect(page.getByTestId('session-dock')).toHaveCount(0)
  const agents = sheet.getByTestId('session-agents')
  await expect(agents).toContainText('3 active')
  await agents.getByRole('button', { name: /research mods API/ }).click()
  await expect(agents.getByTestId('agent-detail')).toBeVisible()
  await agents.getByRole('button', { name: /All agents/ }).click()
  await expect(agents.getByRole('list', { name: 'Agents' })).toBeVisible()
  await noHorizontalScroll(page)
})

test('the panel: tap pushes the detail; Stop sends a signed agent_stop and the row ends', async ({ page }, info) => {
  await openThread(page)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  // no agents chip anywhere: agents are a section of the Session panel
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  const name = await page.locator('h1').evaluate((h) => h.scrollWidth - h.clientWidth)
  expect(name).toBeLessThanOrEqual(0)
  await noHorizontalScroll(page)
  const sheet = await openSessionPanel(page)
  await expect(sheet.getByRole('list', { name: 'Agents' }).getByRole('listitem')).toHaveCount(4)
  await sheet.getByRole('button', { name: /research mods API/ }).click()
  await expect(sheet.getByTestId('agent-recent')).toContainText('Run vitest suites')
  await sheet.getByTestId('agent-stop').click()
  await expect(sheet.getByTestId('agent-outcome')).toHaveText('Stopped.')
  const sent = await agentStops(page)
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({ action: 'agent_stop', agent_id: 'a00f4f30ac1399f7f', thread_id: 'general' })
  expect(typeof sent[0]?.osig).toBe('string')
  await sheet.getByRole('button', { name: /All agents/ }).click()
  await expect(sheet.locator('[data-id="a00f4f30ac1399f7f"]')).toHaveAttribute('data-status', 'killed')
  await expect(sheet.getByTestId('agent-stop')).toHaveCount(0)
  await noHorizontalScroll(page)
  await axe(page, info.project.name)
})

test('shells and monitors open from their count', async ({ page }) => {
  await openThread(page)
  const sheet = await openSessionPanel(page)
  await sheet.getByTestId('agents-shells-toggle').click()
  await expect(sheet.getByRole('list', { name: 'Shells and monitors' }).getByRole('listitem')).toHaveCount(3)
  await expect(sheet.getByText('shell · Run the dev server')).toBeVisible()
})

test('empty: "No agents running."', async ({ page }) => {
  await openThread(page, 'fake_agents=empty')
  const panel = await openSessionPanel(page)
  await expect(panel.getByTestId('agents-empty')).toHaveText('No agents running.')
})

test('mod absent (or an old relay/bridge): the Agents section is there and empty, with no claim about the mod', async ({
  page,
}) => {
  await openThread(page, 'fake_agents=demo&fake_mod=absent')
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  await expect(page.getByTestId('agents-rail')).toHaveCount(0)
  const absent = await openSessionPanel(page)
  await expect(absent.getByTestId('session-agents').getByText('No agents running.')).toBeVisible()
  await expect(absent.getByText(/Needs the Talos mod \(/)).toHaveCount(0)
  await openThread(page, '') // a live mod whose snapshot never arrives
  const none = await openSessionPanel(page)
  await expect(none.getByTestId('session-agents').getByText('No agents running.')).toBeVisible()
})

test('mod offline: rows greyed as unknown, "Mod offline", no Stop', async ({ page }, info) => {
  await openThread(page, 'fake_agents=demo&fake_mod=offline')
  const where = await openSessionPanel(page)
  await expect(where.getByTestId('agents-offline')).toHaveText('Mod offline')
  await expect(where.getByTestId('agents-list')).toHaveAttribute('data-offline', 'mod')
  await where.getByRole('button', { name: /research mods API/ }).click()
  await expect(where.getByTestId('agent-detail')).toContainText('unknown')
  await expect(where.getByTestId('agent-stop')).toHaveCount(0)
  await axe(page, info.project.name)
})

test('Mac offline: the panel greys and Stop hides', async ({ page }) => {
  await openThread(page)
  await fake(page, (t) => t.setMacOnline(false))
  const where = await openSessionPanel(page)
  await expect(where.getByTestId('agents-offline')).toHaveText('Mac offline')
  await where.getByRole('button', { name: /research mods API/ }).click()
  await expect(where.getByTestId('agent-stop')).toHaveCount(0)
})
