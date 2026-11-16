// The screenshot hotkey in a real browser, in the Mac app's web view (a page that looks like it), at the phone and desktop
// projects' sizes. The shell is faked: `capture_drop` goes in through `window.talosNative.receive`, the real door, and the
// page's `capture_ack` is read from the fake message handler. The capture lands in the composer as a chip with a thumbnail,
// the box has focus for a line of text, and only Send sends it. Screenshots of both themes go to TALOS_SHOTS when it is set.
import { expect, type Page, test } from '@playwright/test'

type Posted = Array<Record<string, unknown>>
const posted = (page: Page) => page.evaluate(() => (window as unknown as { __posted: Posted }).__posted)
const acks = async (page: Page) => (await posted(page)).filter((m) => m.type === 'capture_ack')

// A 40x24 PNG, one colour: small, but a real image the thumbnail can draw.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAYCAIAAAAH5iiXAAAAKElEQVR42mOI6rkzIIhh1OJRi0ctHrV41OJRi0ctHrV41OJRi4ePxQCepZfboxL/ywAAAABJRU5ErkJggg=='

async function pretendMacApp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __posted: unknown[] }
    w.__posted = []
    Object.defineProperty(window, 'webkit', {
      configurable: true,
      value: { messageHandlers: { talos: { postMessage: (m: unknown) => w.__posted.push(m) } } },
    })
  })
}

/** The fake-mode app never calls /api/me, so its session stays "loading"; the shell only talks to a signed-in page. */
async function signIn(page: Page) {
  await page.evaluate(() =>
    (window as unknown as { __talosSession: { setState(s: object): void } }).__talosSession.setState({
      status: 'authed',
    }),
  )
}

/** What the Mac app does: hands the page a JSON string through the door the page installed, and waits for its answer. */
const fromMac = (page: Page, m: unknown) =>
  page.evaluate(
    (json) =>
      (window as unknown as { talosNative: { receive(s: string): boolean | Promise<boolean> } }).talosNative.receive(
        json,
      ),
    JSON.stringify(m),
  )

const capture = (over: Record<string, unknown> = {}) => ({
  type: 'capture_drop',
  req: 'r1',
  thread_id: null,
  mime: 'image/png',
  data_b64: PNG_B64,
  width: 40,
  height: 24,
  mode: 'region',
  ...over,
})

/** Records what reaches the client's sendMessage: the words and the kinds of the attachments. */
async function watchSends(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __talos: { sendMessage: (a: { text: string; attachments?: { kind: string }[] }) => Promise<unknown> }
      __sends: Array<{ text: string; kinds: string[] }>
    }
    const real = w.__talos.sendMessage.bind(w.__talos)
    w.__sends = []
    w.__talos.sendMessage = async (a) => {
      w.__sends.push({ text: a.text, kinds: (a.attachments ?? []).map((x) => x.kind) })
      return real(a)
    }
  })
}
const sends = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sends: Array<{ text: string; kinds: string[] }> }).__sends)

const box = (page: Page) => page.getByLabel('Message', { exact: true })

async function openThread(page: Page) {
  await pretendMacApp(page)
  await page.goto('/t/general')
  await expect(box(page)).toBeVisible()
  await signIn(page)
  await watchSends(page)
}

test.describe('in the Mac app', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh) TalosDesktop/1.0' })

  test('the page says it can take a capture', async ({ page }) => {
    await openThread(page)
    await expect
      .poll(async () => (await posted(page)).filter((m) => m.type === 'ready').at(-1)?.features)
      .toContain('capture-drop')
  })

  test('a capture lands in the composer with a thumbnail and focus; only Send sends it, with the line typed', async ({
    page,
  }) => {
    await openThread(page)
    expect(await fromMac(page, capture())).toBe(true)
    expect(await acks(page)).toEqual([{ type: 'capture_ack', req: 'r1', ok: true }])
    const chip = page.getByTestId('chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText(/Screenshot .* at .*\.png/)
    const thumb = page.getByTestId('chip-thumb')
    await expect(thumb).toBeVisible()
    expect(await thumb.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(40)
    await expect(box(page)).toBeFocused()
    await expect(chip).not.toContainText('Uploading') // ready
    expect(await sends(page)).toEqual([]) // nothing has gone yet
    await page.keyboard.type('the button is cut off here')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => sends(page)).toEqual([{ text: 'the button is cut off here', kinds: ['image'] }])
    await expect(page.getByTestId('chip')).toHaveCount(0)
    // the page does not grow sideways at this width
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })

  test('the keyboard reaches the chip: Tab back from the box to its remove button, Enter removes it, nothing is sent', async ({
    page,
    browserName,
  }) => {
    await openThread(page)
    expect(await fromMac(page, capture())).toBe(true)
    await expect(box(page)).toBeFocused()
    const remove = page.getByRole('button', { name: /^(Remove|Cancel upload of) Screenshot/ })
    let reached = false
    for (let i = 0; i < 8 && !reached; i++) {
      // WebKit's Tab skips buttons unless Option is held (Safari's own setting; a keyboard on an iPhone is the same), as in
      // schedules/thread-groups.spec.ts and threads/decided-card-placement.spec.ts
      await page.keyboard.press(browserName === 'webkit' ? 'Shift+Alt+Tab' : 'Shift+Tab')
      reached = await remove.evaluate((el) => el === document.activeElement)
    }
    expect(reached).toBe(true)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('chip')).toHaveCount(0)
    expect(await sends(page)).toEqual([])
  })

  test('from another screen: the page opens the default thread and its composer takes the capture when it mounts', async ({
    page,
  }) => {
    await pretendMacApp(page)
    await page.goto('/settings')
    await signIn(page)
    expect(await fromMac(page, capture())).toBe(true)
    await expect(page).toHaveURL(/\/t\/general$/)
    await expect(page.getByTestId('chip-thumb')).toBeVisible()
    await expect(box(page)).toBeFocused()
    expect(await acks(page)).toEqual([{ type: 'capture_ack', req: 'r1', ok: true }])
  })

  test('not a PNG: answered bad_image, nothing in the composer', async ({ page }) => {
    await openThread(page)
    expect(await fromMac(page, capture({ data_b64: btoa('GIF89a..') }))).toBe(true)
    expect(await acks(page)).toEqual([{ type: 'capture_ack', req: 'r1', ok: false, reason: 'bad_image' }])
    await expect(page.getByTestId('chip')).toHaveCount(0)
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`both themes: ${theme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: theme })
      await openThread(page)
      expect(await fromMac(page, capture())).toBe(true)
      await expect(page.getByTestId('chip-thumb')).toBeVisible()
      await page.keyboard.type('look at this')
      const dir = process.env.TALOS_SHOTS
      if (dir) await page.screenshot({ path: `${dir}/capture-drop-${info.project.name}-${theme}.png` })
    })
  }
})
