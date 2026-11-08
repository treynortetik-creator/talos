// The Terminal screen's tab strip in a real browser, in the Mac app's web view (a page that looks like it) at the phone and the
// desktop projects' sizes. The shell is faked: its messages go in through `window.talosNative.receive`, the real door, and what
// the page posts back is read from the fake message handler. Screenshots of both themes are saved when TALOS_SHOTS is a folder.
import { expect, type Page, test } from '@playwright/test'

type Posted = Array<Record<string, unknown>>
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: Posted }).__posted)
const views = async (page: Page) => (await posted(page)).filter((m) => m.type === 'terminal_view')

const item = (o: Record<string, unknown> & { id?: string }) => ({
  state: 'live',
  key: null,
  panel: 'terminal',
  action: null,
  detail: '',
  ...o,
})
const LIST = [
  item({ id: 'main', name: 'Main', state: 'working', key: '1' }),
  item({ id: 'trip', name: 'OC Test', state: 'idle', key: '2' }),
  item({
    id: 'p',
    name: 'Work',
    state: 'parked',
    key: '3',
    panel: 'resume',
    action: 'resume',
    detail: 'Parked to save memory. Resume starts the same conversation.',
  }),
  item({
    id: 'q',
    name: 'Penny Gothic',
    state: 'needs_you',
    key: '4',
    detail: 'Waiting on a "trust this folder" prompt. Answer it here.',
  }),
  item({
    id: 'f',
    name: 'Broken',
    state: 'failed',
    key: '5',
    panel: 'error',
    detail: 'The session exited at once (start_failed: it exited at once).',
  }),
]

async function pretendMacApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: unknown[]; webkit?: unknown }
    w.__posted = []
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { talos: { postMessage: (m: unknown) => w.__posted.push(m) } } },
    })
  })
}

/** What the Mac app does: hands the page a JSON string through the door the page installed. */
const fromMac = (page: Page, m: unknown) =>
  page.evaluate(
    (json) => (window as unknown as { talosNative: { receive(s: string): boolean } }).talosNative.receive(json),
    JSON.stringify(m),
  )

async function openTerminal(page: Page) {
  await pretendMacApp(page)
  await page.goto('/terminal')
  await expect(page.getByTestId('terminal-space')).toBeVisible()
  await signIn(page)
}

/** The fake-mode app never calls /api/me, so its session stays "loading"; the shell only talks to a signed-in page. */
async function signIn(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __talosSession: { setState(s: object): void } }).__talosSession.setState({
      status: 'authed',
    }),
  )
}

async function sendList(page: Page, items: unknown[] = LIST) {
  await expect.poll(() => fromMac(page, { type: 'terminal_sessions', items })).toBe(true)
}

test.describe('in the Mac app', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh) TalosDesktop/1.0' })

  test('no list yet: the one terminal space, no strip, nothing wrong', async ({ page }) => {
    await openTerminal(page)
    await expect(page.getByRole('tablist')).toHaveCount(0)
    await expect.poll(async () => (await views(page)).at(-1)?.rect).toBeTruthy()
  })

  test('the strip lists Main and every session with a word, the picked tab is underlined, and the keys move it', async ({
    page,
  }) => {
    await openTerminal(page)
    await sendList(page)
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(5)
    await expect(tabs.nth(0)).toContainText('Main')
    await expect(tabs.nth(0)).toContainText('working')
    await expect(tabs.nth(3)).toContainText('needs you')
    await expect(tabs.nth(4)).toContainText('failed')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    // the underline is the accent colour on the selected tab only
    const underline = (i: number) => tabs.nth(i).evaluate((el) => getComputedStyle(el).borderBottomColor)
    expect(await underline(0)).not.toBe(await underline(1))

    // keyboard: Tab reaches the strip once (roving), arrows move, Ctrl+digit jumps
    await tabs.nth(0).focus()
    await page.keyboard.press('ArrowRight')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toBeFocused()
    await page.keyboard.press('Control+5')
    await expect(tabs.nth(4)).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByTestId('terminal-panel')).toContainText('Broken failed')
    await page.keyboard.press('Control+1')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveURL(/\/terminal$/) // Ctrl+1 did not also open thread 1
  })

  test('picking a thread tells the Mac which session; a parked one shows Resume and closes the native view', async ({
    page,
  }) => {
    await openTerminal(page)
    await sendList(page)
    await page.getByRole('tab', { name: /OC Test/ }).click()
    await expect
      .poll(async () => (await views(page)).at(-1))
      .toMatchObject({ session: 'trip', rect: { width: expect.any(Number) } })
    await page.getByRole('tab', { name: /Work/ }).click()
    await expect(page.getByTestId('terminal-panel')).toContainText('Parked to save memory')
    await expect.poll(async () => (await views(page)).at(-1)).toMatchObject({ session: 'p', rect: null })
    await page.getByRole('button', { name: 'Resume' }).focus()
    await page.keyboard.press('Enter') // by keyboard: focus must stay on the button, not drop to the page
    await expect(page.getByTestId('terminal-resume')).toBeFocused()
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type === 'terminal_resume'))
      .toEqual([{ type: 'terminal_resume', thread_id: 'p' }])
    await fromMac(page, { type: 'terminal_resume_result', thread_id: 'p', outcome: 'asked' })
    await expect(page.getByTestId('terminal-resume-note')).toContainText('Asked to resume')
    // the session comes up: the panel gives way to the terminal space again
    await sendList(
      page,
      LIST.map((i) => (i.id === 'p' ? { ...i, state: 'idle', panel: 'terminal', action: null } : i)),
    )
    await expect(page.getByTestId('terminal-panel')).toHaveCount(0)
    await expect
      .poll(async () => (await views(page)).at(-1))
      .toMatchObject({ session: 'p', rect: { width: expect.any(Number) } })
  })

  test('the last tab is remembered when the screen is left and come back to', async ({ page }) => {
    await openTerminal(page)
    await sendList(page)
    await page.getByRole('tab', { name: /OC Test/ }).click()
    await page.goto('/') // leave the screen: the tab is kept in this window's session storage
    await page.goto('/terminal')
    await signIn(page)
    await sendList(page)
    await expect(page.getByRole('tab', { name: /OC Test/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('a list with a state it does not know, a hostile name and a bad item still draws, and the strip does not overflow the page', async ({
    page,
  }) => {
    await openTerminal(page)
    await sendList(page, [
      ...LIST,
      item({ id: 'z', name: 'Z'.repeat(80), state: 'levitating' }),
      { id: '../x', name: 'bad' },
      item({ id: 'h', name: '<script>window.__pwned=1</script>' }),
    ])
    await expect(page.getByRole('tab')).toHaveCount(7)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
    // the strip scrolls inside itself; the page does not grow sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`both themes: ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme })
      await openTerminal(page)
      await sendList(page)
      await page.getByRole('tab', { name: /Work/ }).click()
      await expect(page.getByTestId('terminal-panel')).toBeVisible()
      const dir = process.env.TALOS_SHOTS
      const settle = async () => {
        await page.mouse.move(1, 700) // off the strip: no hover tint in the picture
        await page.waitForTimeout(300) // the tabs' colour transition (140 ms) has finished
      }
      await settle()
      if (dir) await page.screenshot({ path: `${dir}/terminal-tabs-${info.project.name}-${theme}-resume.png` })
      await page.getByRole('tab', { name: /Broken/ }).click()
      await expect(page.getByTestId('terminal-panel')).toContainText('failed')
      await settle()
      if (dir) await page.screenshot({ path: `${dir}/terminal-tabs-${info.project.name}-${theme}-failed.png` })
      await page.getByRole('tab', { name: /OC Test/ }).click()
      await settle()
      if (dir) await page.screenshot({ path: `${dir}/terminal-tabs-${info.project.name}-${theme}-live.png` })
    })
  }
})

test.describe('in a browser', () => {
  test('/terminal goes to Home and nothing is posted', async ({ page }) => {
    await page.goto('/terminal')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole('tablist', { name: 'Sessions' })).toHaveCount(0)
  })
})
