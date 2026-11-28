// The read-only terminal view in a real browser (iphone, pixel and desktop projects): the fixed card first, then the pane shown by the
// real xterm.js under the relay's REAL Content-Security-Policy (no CSP change, no violation, colours applied), the pane's size kept and the
// page never scrolled sideways (320 px included), nothing typed into it, a resume by offset after a lag, and every way a view ends. The
// Mac is the fake client's made-up pane (src/lib/fakeTerm.ts).

import AxeBuilder from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'
import { appCsp } from '@talos-app/protocol'
import { proxyFailures, proxyWithCsp } from '../helpers/csp-route.ts'

type FakeTermCall = 'say' | 'lag' | 'end' | 'resizePane' | 'refuseNext'
/** Drives the fake Mac's pane from the page (no eval: the page runs under the real CSP). */
const term = (page: Page, method: FakeTermCall, ...args: unknown[]) =>
  page.evaluate(
    ([m, a]) =>
      (window as unknown as { __talos: { fakeTerm: Record<string, (...x: unknown[]) => unknown> } }).__talos.fakeTerm[
        m as string
      ]?.(...(a as unknown[])),
    [method, args] as const,
  )
const sent = (page: Page): Promise<Array<Record<string, unknown>>> =>
  page.evaluate(() =>
    JSON.parse(
      JSON.stringify((window as unknown as { __talos: { fakeTerm: { sent: unknown } } }).__talos.fakeTerm.sent),
    ),
  )

/** axe in both themes. Not the shared helper: it adds a <style> tag, which the real policy refuses. */
async function expectAxeClean(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
    await expect.poll(() => page.evaluate(() => document.getAnimations().length)).toBe(0)
    const res = await new AxeBuilder({ page }).analyze()
    const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    expect(
      bad.map((v) => `${scheme}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      `axe ${scheme}`,
    ).toEqual([])
  }
}

const problems: string[] = []
test.beforeEach(async ({ page, baseURL }) => {
  problems.length = 0
  // the relay's production policy on every HTML page, and a listener for each violation the browser reports
  await page.route('**/*', (route) => proxyWithCsp(route, appCsp(new URL(baseURL as string).origin)))
  await page.addInitScript(() => {
    ;(window as unknown as { __csp: string[] }).__csp = []
    document.addEventListener('securitypolicyviolation', (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample}`,
      ),
    )
  })
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
})
test.afterEach(async ({ page }) => {
  const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => [])
  // React's own bundle probes eval at load and the policy refuses it, on every page of the app (it falls back and works); that is not
  // this screen's, so it is not counted. Any other violation, a blocked <style> above all, fails.
  expect(
    csp.filter((v) => !/^script-src eval .*\/assets\/jsx-runtime-/.test(v)),
    'CSP violations',
  ).toEqual([])
  expect(problems, 'console errors and page errors').toEqual([])
  expect(proxyFailures.splice(0)).toEqual([])
})

async function open(page: Page) {
  await page.goto('/terminal')
  // not waitForFunction: Playwright evaluates its expression with eval, which the real policy refuses
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __talos?: unknown }).__talos))).toBe(true)
  await expect(page.getByTestId('terminal-card')).toBeVisible()
}
const watch = async (page: Page) => {
  await page.getByTestId('terminal-watch').click()
  await expect(page.getByTestId('remote-terminal')).toBeVisible()
  await expect(page.locator('.xterm-rows')).toContainText('Reading apps/web/src/lib/socket-connection.ts')
}
const rows = (page: Page) => page.locator('.xterm-rows')

test('the card comes first: fixed words, and nothing is asked of the Mac until the tap', async ({ page }) => {
  await open(page)
  const card = page.getByTestId('terminal-card')
  await expect(card.getByRole('heading', { name: "Watch your agent's terminal" })).toBeVisible()
  await expect(card).toContainText('Read-only. Nothing you do here types into it.')
  await expect(card.getByRole('button', { name: 'Watch' })).toBeVisible()
  expect(await sent(page)).toEqual([])
  await expectAxeClean(page)
})

test('a tap shows the live pane: real xterm, colours applied under the real CSP, the header, the time left, and Close', async ({
  page,
}) => {
  await open(page)
  await watch(page)
  await expect(page.getByRole('heading', { name: "Main's terminal" })).toBeVisible()
  await expect(page.getByTestId('terminal-status')).toHaveText('Watching · read-only · 60 min')
  await expect(page.getByTestId('terminal-box')).toHaveAttribute('aria-label', 'Terminal output, read-only')
  await expect(page.getByText("You're watching. Nothing you do here types into the terminal.")).toBeVisible()
  const frames = await sent(page)
  expect(frames.filter((f) => f.type === 'term.open')).toHaveLength(1)
  expect(frames.find((f) => f.type === 'term.open')).toMatchObject({ tier: 'view', target: 'main' })
  // the colours really applied: a green bullet is not the default foreground (the stylesheet came through the adopted-sheets shim)
  const colours = await page.evaluate(() => {
    const spans = [...document.querySelectorAll<HTMLElement>('.xterm-rows span')]
    const bullet = spans.find((s) => s.textContent?.includes('⏺'))
    const plain = spans.find((s) => s.textContent?.includes('Running the socket tests'))
    return { bullet: bullet ? getComputedStyle(bullet).color : '', plain: plain ? getComputedStyle(plain).color : '' }
  })
  expect(colours.bullet).not.toBe('')
  expect(colours.bullet).not.toBe(colours.plain)
  // new output arrives live, in order
  await term(page, 'say', '\x1b[31mred alert\x1b[0m\r\nsecond line\r\n')
  await expect(rows(page)).toContainText('red alert')
  await expect(rows(page)).toContainText('second line')
  await expectAxeClean(page)
})

test('nothing typed anywhere reaches the Mac, and no keyboard can open', async ({ page }) => {
  await open(page)
  await watch(page)
  await page.getByTestId('terminal-box').click()
  await page.keyboard.type('rm -rf / --no-preserve-root')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Control+c')
  await page.keyboard.press('ArrowUp')
  const types = new Set((await sent(page)).map((f) => f.type))
  expect([...types].sort()).toEqual(['term.ack', 'term.open'])
  const area = await page.evaluate(() => {
    const a = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    return a
      ? {
          readonly: a.readOnly,
          inputmode: a.getAttribute('inputmode'),
          tabindex: a.tabIndex,
          focused: document.activeElement === a,
        }
      : null
  })
  expect(area).toEqual({ readonly: true, inputmode: 'none', tabindex: -1, focused: false })
  // what the owner typed is not on the screen either: the terminal is not an input
  await expect(rows(page)).not.toContainText('rm -rf')
})

test('the page never scrolls sideways at 320 px; the pane scrolls inside its own box', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 })
  await open(page)
  await watch(page)
  const m = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="terminal-box"]') as HTMLElement
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      boxOverflow: box.scrollWidth - box.clientWidth,
      boxWidth: box.clientWidth,
    }
  })
  expect(m.page).toBeLessThanOrEqual(0)
  expect(m.body).toBeLessThanOrEqual(0)
  expect(m.boxWidth).toBeLessThanOrEqual(320)
  // 100 columns do not fit 320 px even at the smallest font: they scroll inside the box
  expect(m.boxOverflow).toBeGreaterThan(0)
  await expectAxeClean(page)
})

test('a lag: the page resumes by the offset it drew, and the dropped output arrives once, in order', async ({
  page,
}) => {
  await open(page)
  await watch(page)
  await term(page, 'say', 'first part\r\n')
  await expect(rows(page)).toContainText('first part')
  await term(page, 'say', 'DROPPED-BY-RELAY\r\n', true)
  await term(page, 'lag')
  await expect(rows(page)).toContainText('DROPPED-BY-RELAY')
  await term(page, 'say', 'after resume\r\n')
  await expect(rows(page)).toContainText('after resume')
  const frames = await sent(page)
  const resumes = frames.filter((f) => f.type === 'term.resume')
  expect(resumes).toHaveLength(1)
  expect(typeof resumes[0]?.from).toBe('number')
  // once only: the dropped line is on the screen one time
  const text = (await rows(page).textContent()) ?? ''
  expect(text.split('DROPPED-BY-RELAY')).toHaveLength(2)
})

test('Close ends the view, tells the Mac, and brings the card back; watching again is a new view', async ({ page }) => {
  await open(page)
  await watch(page)
  await page.getByTestId('terminal-close').click()
  await expect(page.getByTestId('terminal-card')).toBeVisible()
  expect((await sent(page)).filter((f) => f.type === 'term.close')).toHaveLength(1)
  await watch(page)
  const opens = (await sent(page)).filter((f) => f.type === 'term.open')
  expect(opens).toHaveLength(2)
  expect(opens[0]?.term_id).not.toBe(opens[1]?.term_id)
})

test('how a view ends is said in words, with Watch again; the Mac being away is said before the tap', async ({
  page,
}) => {
  await open(page)
  await watch(page)
  await term(page, 'end', 'idle')
  await expect(page.getByTestId('terminal-ended')).toHaveText(
    'The terminal closed after 10 minutes with nobody looking at it.',
  )
  await expect(page.getByRole('button', { name: 'Watch again' })).toBeVisible()
  await expectAxeClean(page)
  // the agent's terminal ending while it is watched
  await watch(page)
  await term(page, 'end', 'pane_gone')
  await expect(page.getByTestId('terminal-ended')).toHaveText("The agent's terminal ended.")
  // a Mac that cannot show it
  await term(page, 'refuseNext', 'no_pane')
  await page.getByTestId('terminal-watch').click()
  await expect(page.getByTestId('terminal-ended')).toHaveText('That agent has no terminal running right now.')
})

test('the Mac away: the card says so and Watch asks nothing', async ({ page }) => {
  await open(page)
  await page.evaluate(() =>
    (window as unknown as { __talos: { setMacOnline(b: boolean): void } }).__talos.setMacOnline(false),
  )
  await expect(page.getByTestId('terminal-unavailable')).toHaveText(
    "Your Mac isn't connected. You can watch its terminal when it is.",
  )
  // aria-disabled, so Playwright would wait for it forever: press it anyway
  await page.getByTestId('terminal-watch').click({ force: true })
  expect(await sent(page)).toEqual([])
})

test('a thread with its own session is a target; the view is for that thread', async ({ page }) => {
  await open(page)
  await page.evaluate(() =>
    (window as unknown as { __talos: { emit(t: string, f: unknown): void } }).__talos.emit('workers.status', {
      status: {
        supported: true,
        supervisor_online: true,
        threads: [{ thread_id: 'inbox', state: 'live' }],
        governor: { state: 'ok' },
        at: new Date().toISOString(),
      },
    }),
  )
  const picker = page.getByTestId('terminal-target')
  await expect(picker.locator('option')).toHaveText(['Main', 'Inbox'])
  await picker.selectOption('inbox')
  await page.getByTestId('terminal-watch').click()
  await expect(page.getByRole('heading', { name: "Inbox's terminal" })).toBeVisible()
  expect((await sent(page)).find((f) => f.type === 'term.open')).toMatchObject({ target: 'inbox' })
})

test("the pane's size is the Mac's: a resize on the Mac re-fits the box and clears to a new picture", async ({
  page,
}) => {
  await open(page)
  await watch(page)
  const before = await page.evaluate(() => document.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0)
  await term(page, 'resizePane', 60, 20)
  await expect(rows(page)).toContainText('Reading apps/web/src/lib/socket-connection.ts')
  await expect
    .poll(() => page.evaluate(() => document.querySelector('.xterm-screen')?.getBoundingClientRect().width ?? 0))
    .toBeLessThan(before)
})
