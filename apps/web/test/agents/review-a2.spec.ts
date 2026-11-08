// Regression tests for the agents panel in a real browser. Each test names the bug it pins;
// `guard` tests pin behaviour that already held. Fake mode (`VITE_FAKE=1`, `?fake_agents=demo`).
import { expect, type Page, test } from '@playwright/test'
import { openSessionPanel } from '../helpers/phone.ts'

const isDesktop = (name: string) => name === 'desktop'
async function openThread(page: Page, q = 'fake_agents=demo') {
  await page.goto(`/t/general?${q}`)
  await expect(page.getByTestId('thread-screen')).toBeVisible()
}
type Fake = { session: { setAgents(rows: unknown[] | null, over?: Record<string, unknown>): void } }

/** Where the list lives for this project: the docked panel on desktop, the sheet on phones. */
async function panel(page: Page, project: string) {
  if (isDesktop(project)) return openSessionPanel(page)
  await page.getByTestId('session-trigger').click()
  const sheet = page.getByTestId('session-sheet')
  await expect(sheet).toBeVisible()
  // The phone drawer slides in over 200 ms (phone.css `.drawer-anim`). WebKit evaluates a running transform at the moment of each
  // getBoundingClientRect call, not once per frame, so two reads a millisecond or two apart (a loaded runner) differ by the distance
  // the drawer moved in between: the F7 measure read 364.65 against an edge of 362.20 mid-slide. Measure only once the drawer itself has stopped (its own animations; rows below carry endless spinners).
  await expect
    .poll(() => sheet.evaluate((el) => el.getAnimations().filter((a) => a.playState === 'running').length), {
      timeout: 3000,
    })
    .toBe(0)
  return sheet
}

test('F7: the folded "(+N)" is not clipped away by the row truncation', async ({ page }, info) => {
  await openThread(page)
  const where = await panel(page, info.project.name)
  const reviewer = where.locator('[data-id="tm_reviewer_1"]')
  await expect(reviewer).toBeVisible()
  const clipped = await reviewer.evaluate((li) => {
    const title = li.querySelector('.agent-title') as HTMLElement
    const more = [...title.querySelectorAll('span')].find((s) => /\(\+\d+\)/.test(s.textContent ?? '')) as HTMLElement
    return { right: more.getBoundingClientRect().right, edge: title.getBoundingClientRect().right }
  })
  // Today the (+1) sits inside the `truncate` span after the title, so it is the first thing the ellipsis eats.
  expect(clipped.right).toBeLessThanOrEqual(clipped.edge + 0.5)
})

test('F9: phone sheet traps focus (ok), but Escape strands focus instead of returning it to the chip', async ({
  page,
}, info) => {
  test.skip(isDesktop(info.project.name), 'phones only')
  await openThread(page)
  const chip = page.getByTestId('session-trigger')
  await chip.click()
  const sheet = page.getByTestId('session-sheet')
  await expect(sheet).toBeVisible()
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await sheet.evaluate((s) => s.contains(document.activeElement))).toBe(true)
  }
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(chip).toBeFocused()
})

test('F5c: in the sheet, opening a row puts focus on the detail, not the dialog shell', async ({ page }, info) => {
  test.skip(isDesktop(info.project.name), 'phones only')
  await openThread(page)
  await page.getByTestId('session-trigger').click()
  const sheet = page.getByTestId('session-sheet')
  await sheet.getByRole('button', { name: /research mods API/ }).focus()
  await page.keyboard.press('Enter')
  await expect(sheet.getByTestId('agent-detail')).toBeVisible()
  const where = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return { tag: a?.tagName, testid: a?.dataset.testid, text: a?.textContent?.slice(0, 40) }
  })
  // Today focus falls back to the dialog container (Radix refocuses it when the button unmounts).
  expect(where.testid).not.toBe('session-sheet')
  expect(where.tag).not.toBe('BODY')
})

test('guard: 160-char unbroken paths and HTML stay inside the panel, no horizontal scroll', async ({ page }, info) => {
  await openThread(page, 'fake_agents=empty')
  const path = `/srv/owner/${'very-long-directory-name/'.repeat(5)}x`.slice(0, 159)
  await page.evaluate((p) => {
    const t = (window as unknown as { __talos: Fake }).__talos
    t.session.setAgents([
      {
        id: 'long',
        title: `<b>x</b> ${p}`,
        name: 'n'.repeat(64),
        activity: p,
        activity_source: 'tool',
        tokens: 1_250_000,
        started_at: new Date(Date.now() - 3_700_000).toISOString(),
        recent: [{ at: new Date().toISOString(), text: p }],
      },
    ])
  }, path)
  const where = await panel(page, info.project.name)
  await where.getByTestId('agent-row').getByRole('button').click()
  await expect(where.getByTestId('agent-detail')).toBeVisible()
  await expect(where.locator('b')).toHaveCount(0)
  // children of a `truncate` span overflow it by design (clipped); what must not happen is the panel itself scrolling
  const over = await where.evaluate((el) => {
    const scrollers = [el, ...el.querySelectorAll<HTMLElement>('*')].filter(
      (n) => getComputedStyle(n).overflowX !== 'hidden' && n.scrollWidth > n.clientWidth + 1 && n.clientWidth > 0,
    )
    return {
      out: scrollers.map((n) => `${n.tagName}.${n.className}`.slice(0, 80)),
      page: document.documentElement.scrollWidth - window.innerWidth,
    }
  })
  expect(over.out).toEqual([])
  expect(over.page).toBeLessThanOrEqual(0)
})

test('guard: 1024 px docks the panel and 1023 px is a sheet; neither scrolls sideways', async ({ page }, info) => {
  test.skip(!isDesktop(info.project.name), 'a desktop browser resized')
  await page.setViewportSize({ width: 1024, height: 800 })
  await openThread(page)
  await page.getByTestId('session-trigger').click()
  await expect(page.getByTestId('session-dock')).toBeVisible()
  await expect(page.getByTestId('agents-chip')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await page.setViewportSize({ width: 1023, height: 800 })
  await expect(page.getByTestId('session-dock')).toHaveCount(0)
  await expect(page.getByTestId('session-trigger')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

test('F8: the running mark keeps 3:1 against the panel at the bottom of its pulse (WCAG 1.4.11)', async ({
  page,
}, info) => {
  test.skip(!isDesktop(info.project.name), 'the docked panel')
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await openThread(page)
    const rail = page.getByTestId('session-dock')
    if (!(await rail.isVisible())) await page.getByTestId('session-trigger').click() // the choice is kept between visits
    const mark = rail.locator('[data-status="running"][role="img"]').first()
    await expect(mark).toBeVisible()
    const ratio = await mark.evaluate((el) => {
      // the keyframe trough, read from the shipped stylesheet (agent-breathe in app.css), not assumed
      let trough = 1
      for (const sheet of [...document.styleSheets])
        for (const rule of [...sheet.cssRules])
          if (rule instanceof CSSKeyframesRule && rule.name === 'agent-breathe')
            for (const k of [...rule.cssRules] as CSSKeyframeRule[])
              trough = Math.min(trough, Number(k.style.opacity || 1))
      const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number)
      let bgEl: HTMLElement | null = el as HTMLElement
      let bg = 'rgba(0, 0, 0, 0)'
      while (bgEl && (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')) {
        bg = getComputedStyle(bgEl).backgroundColor
        bgEl = bgEl.parentElement
      }
      const [r, g, b] = rgb(getComputedStyle(el).color)
      const [R, G, B] = rgb(bg)
      const mix = [r, g, b].map((c, i) => trough * (c ?? 0) + (1 - trough) * ([R, G, B][i] ?? 0))
      const lum = (c: number[]) =>
        c
          .map((v) => v / 255)
          .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
          .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i]!, 0)
      const a = lum(mix)
      const z = lum([R ?? 0, G ?? 0, B ?? 0])
      return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05)
    })
    expect(ratio, colorScheme).toBeGreaterThanOrEqual(3)
  }
})
