// The Session panel on a desktop: docked beside the chat (not a modal), opened and closed by the usage chip in the far
// top-right corner or the panel's own cross, remembered per device. Commands, MCP servers and plugins are in Settings.
import { expect, type Page, test } from '@playwright/test'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

const chip = (page: Page) => page.getByTestId('session-trigger')
const dock = (page: Page) => page.getByTestId('session-dock')
const closeBtn = (page: Page) => dock(page).getByRole('button', { name: 'Close session panel' })

test.describe('docked panel', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'the docked panel is a desktop control')

  test('closed: the usage chip is small, in the far top-right corner, and there is no rail', async ({ page }) => {
    await page.goto('/t/general')
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    const vw = page.viewportSize()?.width ?? 0
    const b = await chip(page).boundingBox()
    expect(b).not.toBeNull()
    expect((b?.x ?? 0) + (b?.width ?? 0)).toBeGreaterThan(vw - 24)
    expect(b?.y ?? 99).toBeLessThan(24)
    expect(b?.height ?? 99).toBeLessThan(44) // small, out of the reading line
    await expect(chip(page)).toContainText('wk 60% used')
    await expect(dock(page)).toHaveCount(0)
    await expect(page.getByTestId('agents-rail')).toHaveCount(0)
    await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  })

  test('the chip opens the panel, which stays open while typing and clicking in the chat', async ({ page }) => {
    await page.goto('/t/general')
    await chip(page).click()
    await expect(dock(page)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0) // docked, not modal
    const box = page.getByLabel('Message', { exact: true })
    await box.click()
    await box.pressSequentially('still typing here')
    await expect(box).toHaveValue('still typing here')
    await expect(dock(page)).toBeVisible()
    await page.getByTestId('msg-agent').first().click()
    await page.keyboard.press('Escape')
    await expect(dock(page)).toBeVisible()
    await expect(box).toHaveValue('still typing here')
  })

  test('it closes on its cross or on the chip, and only those', async ({ page }) => {
    await page.goto('/t/general')
    await chip(page).click()
    await expect(dock(page)).toBeVisible()
    await closeBtn(page).click()
    await expect(dock(page)).toHaveCount(0)
    await chip(page).click()
    await expect(dock(page)).toBeVisible()
    await chip(page).click()
    await expect(dock(page)).toHaveCount(0)
  })

  test('open or closed is remembered on this device', async ({ page }) => {
    await page.goto('/t/general')
    await chip(page).click()
    await expect(dock(page)).toBeVisible()
    await page.reload()
    await expect(dock(page)).toBeVisible()
    await closeBtn(page).click()
    await page.reload()
    await expect(page.getByTestId('thread-screen')).toBeVisible()
    await expect(dock(page)).toHaveCount(0)
  })

  test('sections: Context with Compact, Usage with the week, Agents; no tabs; a link to Settings', async ({ page }) => {
    await page.goto('/t/general?fake_agents=demo')
    await chip(page).click()
    const d = dock(page)
    await expect(d.getByTestId('meter-context')).toContainText('31% used')
    await expect(d.getByRole('button', { name: 'Compact' })).toBeVisible()
    await expect(d.getByTestId('session-usage').getByTestId('meter-week')).toContainText('60% used')
    await expect(d).not.toContainText('5-hour')
    await expect(d.getByTestId('session-agents')).toBeVisible()
    await expect(d.getByRole('tab')).toHaveCount(0)
    await expect(d.getByRole('tab', { name: 'Commands' })).toHaveCount(0)
    await d.getByRole('link', { name: /Settings.*Session/ }).click()
    await expect(page).toHaveURL(/\/settings\/session$/)
    // Settings › Session keeps the lists that left the panel
    for (const t of ['Commands', 'MCP servers', 'Plugins'])
      await expect(page.getByRole('tab', { name: t })).toBeVisible()
  })

  test('Agents: this session, thread sessions with their state; no remote-builders group (nothing in the app feeds one)', async ({
    page,
  }) => {
    await page.goto('/t/general?fake_agents=demo')
    await page.evaluate(() => {
      const c = (window as unknown as { __talos: { emit(t: string, f: unknown): void } }).__talos
      c.emit('workers.status', {
        status: {
          supported: true,
          supervisor_online: true,
          threads: [{ thread_id: 'general', state: 'parked' }],
          governor: { state: 'ok' },
          at: new Date().toISOString(),
        },
      })
    })
    await chip(page).click()
    const agents = dock(page).getByTestId('session-agents')
    await expect(agents.getByText('This session')).toBeVisible()
    await expect(agents.getByText('Thread sessions')).toBeVisible()
    await expect(agents.getByTestId('session-thread-sessions')).toContainText('General')
    await expect(agents.getByTestId('session-thread-sessions')).toContainText('Parked')
    await expect(agents.getByText(/builders/i)).toHaveCount(0)
  })
})

test.describe('docked panel: Agents, focus, the usage chip beside the thread menu', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'the docked panel is a desktop control')

  for (const [q, label] of [
    ['', 'no snapshot at all'],
    ['?fake_agents=empty', 'an empty snapshot'],
  ] as const) {
    test(`Agents is always shown: ${label} reads "No agents running."`, async ({ page }) => {
      await page.goto(`/t/general${q}`)
      await chip(page).click()
      const agents = dock(page).getByTestId('session-agents')
      await expect(agents).toBeVisible()
      await expect(agents.getByText('No agents running.')).toBeVisible()
    })
  }

  test('Agents with the demo roster lists its rows under "This session"', async ({ page }) => {
    await page.goto('/t/general?fake_agents=demo')
    await chip(page).click()
    const agents = dock(page).getByTestId('session-agents')
    await expect(agents.getByText('This session')).toBeVisible()
    await expect(agents.getByTestId('agents-count')).toContainText('3 active')
  })

  test('the panel cross puts focus on the chip, not on the page', async ({ page }) => {
    await page.goto('/t/general')
    await chip(page).click()
    await closeBtn(page).click()
    await expect(dock(page)).toHaveCount(0)
    await expect(chip(page)).toBeFocused()
  })

  test('opened at tablet width, the sheet does not come back after widening past 1024 and narrowing again', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await page.goto('/t/general')
    await chip(page).click()
    await expect(page.getByTestId('session-sheet')).toBeVisible()
    await page.setViewportSize({ width: 1300, height: 900 })
    await expect(page.getByTestId('session-sheet')).toHaveCount(0)
    await page.setViewportSize({ width: 900, height: 900 })
    await expect(page.getByTestId('session-sheet')).toHaveCount(0)
  })

  for (const [width, openPanel, what] of [
    [1440, false, '1440 px, panel closed'],
    [1440, true, '1440 px, panel open (a narrow column)'],
    [1100, false, '1100 px (a column under 992 px)'],
    [1024, true, '1024 px, panel open'],
  ] as const) {
    test(`mod offline, ${what}: the chip leaves the thread menu button reachable`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/t/general?fake_mod=offline')
      if (openPanel) await chip(page).click()
      const menu = page.getByTestId('thread-settings-trigger')
      await expect(menu).toBeVisible()
      const hit = await menu.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return el.contains(at)
      })
      expect(hit, 'the thread menu button is what a click at its centre lands on').toBe(true)
      const a = await chip(page).boundingBox()
      const b = await menu.boundingBox()
      expect(
        a && b && (a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height),
      ).toBe(true)
    })
  }

  test('a lapsed mod is a small dot on the chip, with the words in its name and tooltip; no dot otherwise', async ({
    page,
  }) => {
    await page.goto('/t/general')
    await expect(page.getByTestId('session-offline-dot')).toHaveCount(0)
    await expect(chip(page)).not.toHaveAttribute('aria-label', /.*/)
    await page.goto('/t/general?fake_mod=offline')
    await expect(page.getByTestId('session-offline-dot')).toBeVisible()
    await expect(page.getByTestId('session-chip')).not.toContainText('mod offline')
    await expect(chip(page)).toHaveAttribute('aria-label', /mod offline/)
    await expect(chip(page)).toHaveAttribute('title', /mod offline/)
    expect(((await chip(page).boundingBox())?.width ?? 999) < 140).toBe(true)
  })
})

test('on a phone the panel is still a sheet from the header, and there is no corner chip', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) >= 768, 'phone only')
  await page.goto('/t/general')
  await expect(page.getByTestId('session-chip')).toHaveCount(0)
  await chip(page).click()
  await expect(page.getByTestId('session-sheet')).toBeVisible()
  await expect(page.getByTestId('session-dock')).toHaveCount(0)
})

test('on a tablet-wide window the panel is a sheet, not docked', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 1024, 'run from the desktop project')
  await page.setViewportSize({ width: 900, height: 900 })
  await page.goto('/t/general')
  await chip(page).click()
  await expect(page.getByTestId('session-sheet')).toBeVisible()
  await expect(page.getByTestId('session-dock')).toHaveCount(0)
})
