// Owner bug reports from the iPhone shell: the keyboard accessory bar / composer layout after a photo is attached, the +
// menu that stayed open, the missing jump-to-latest button, and the header status line that ran into "5 tasks".
// Fake mode (VITE_FAKE=1). The iOS keyboard cannot be raised in a browser, so a test stands in for it the way the shell's
// native resize mode behaves: the layout viewport itself shrinks (helpers/keyboard.ts). Screenshots land in
// test/shell/shots/<project>-*.png.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { keyboard, visible } from '../helpers/keyboard.ts'

// Screenshots are rewritten only on request (TALOS_SHOTS=1), so a plain run leaves tracked files alone.
const shot = (name: string, project: string) =>
  process.env.TALOS_SHOTS ? `test/shell/shots/${project}-${name}.png` : `test-results/shots/${project}-${name}.png`

type Talos = {
  store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void }
  uploadMedia: (...a: unknown[]) => Promise<unknown>
}

/** The shell registers the Keyboard plugin; the page only ever looks for it on the global (lib/native.ts). */
const withKeyboardPlugin = (page: Page) =>
  page.addInitScript(() => {
    ;(window as unknown as { Capacitor: unknown }).Capacitor = { Plugins: { Keyboard: {} } }
  })

async function open(page: Page, path = '/t/general') {
  await page.goto(path)
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  if (path.startsWith('/t/')) await expect(page.getByTestId('composer')).toBeVisible()
}

const seed = (page: Page, n: number, from = 0, author: 'agent' | 'owner' = 'agent') =>
  page.evaluate(
    ([count, start, who]) => {
      const t = (window as unknown as { __talos: Talos }).__talos
      const mk = (i: number) => ({
        id: `m_seed_${i}`,
        thread_id: 'general',
        seq: 1000 + i,
        author: who,
        kind: 'text',
        text: `Seeded message number ${i}. ${'It is long enough to wrap on a phone and fill the thread. '.repeat(2)}`,
        format: 'plain',
        attachments: [],
        via: 'app',
        created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
      })
      t.store.setState((s) => {
        const msgs = (s.messages as Record<string, unknown[]>) ?? {}
        const cur = start === 0 ? [] : (msgs.general ?? [])
        return {
          messages: {
            ...msgs,
            general: [...cur, ...Array.from({ length: count as number }, (_, k) => mk((start as number) + k))],
          },
        }
      })
    },
    [n, from, author] as const,
  )

const inside = async (loc: Locator, page: Page, label: string) => {
  const b = await loc.boundingBox()
  expect(b, `${label} has a box`).not.toBeNull()
  const v = await visible(page)
  expect(b?.y ?? -1, `${label} top`).toBeGreaterThanOrEqual(v.top - 0.5)
  expect((b?.y ?? 0) + (b?.height ?? 0), `${label} bottom above the keyboard`).toBeLessThanOrEqual(v.bottom + 0.5)
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme}`, () => {
    test.use({ colorScheme: scheme })

    test('1: composer, chips and send button stay above the keyboard after a photo is attached', async ({
      page,
    }, info) => {
      await open(page)
      await seed(page, 30)
      await page.getByRole('button', { name: 'Attach' }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('attach-photos').click()
      await (await chooser).setFiles({ name: 'IMG_8114.png', mimeType: 'image/png', buffer: Buffer.from('x') })
      await expect(page.getByText('IMG_8114.png')).toBeVisible()
      const box = page.getByLabel('Message', { exact: true })
      await box.fill(`Order was placed. It's just taking a minute. ${'More words to make the box grow. '.repeat(6)}`)
      await keyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
      await expect(page.getByTestId('composer')).toBeVisible()
      await inside(page.getByTestId('composer'), page, 'composer')
      await inside(box, page, 'message box')
      await inside(page.getByRole('button', { name: 'Send', exact: true }), page, 'send button')
      await inside(page.getByRole('button', { name: 'Attach' }), page, 'attach button')
      await inside(page.getByRole('button', { name: 'Remove IMG_8114.png' }), page, 'chip')
      // the room goes to the box and the thread: there is no tab strip at any width (the thread list is the left menu)
      await expect(page.getByTestId('thread-tabs')).toHaveCount(0)
      await expect.poll(async () => (await page.getByTestId('timeline').boundingBox())?.height ?? 0).toBeGreaterThan(40)
      await page.screenshot({ path: shot(`keyboard-chip-${scheme}`, info.project.name) })
      await keyboard(page, 0)
      await expect(page.locator('html')).not.toHaveAttribute('data-kb', /.*/)
    })

    test('1c: a long message and many chips stay above the keyboard on small and landscape screens', async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'iphone', 'iOS layout')
      const cases = [
        { w: 393, h: 659, kb: 336, chips: 10, offline: true },
        { w: 375, h: 553, kb: 260, chips: 1, offline: true },
        { w: 844, h: 390, kb: 200, chips: 5, offline: false },
        { w: 844, h: 390, kb: 200, chips: 10, offline: true },
      ]
      for (const c of cases) {
        await page.setViewportSize({ width: c.w, height: c.h })
        await open(page)
        await seed(page, 30)
        await page.evaluate((off) => {
          if (off)
            (window as unknown as { __talos: Talos }).__talos.store.setState((s) => ({
              presence: { ...(s.presence as object), bridge_online: false },
            }))
        }, c.offline)
        await page.getByTestId('pick-photos').setInputFiles(
          Array.from({ length: c.chips }, (_, i) => ({
            name: `IMG_${i}.png`,
            mimeType: 'image/png',
            buffer: Buffer.from('x'),
          })),
        )
        await expect(page.getByText(`IMG_${c.chips - 1}.png`)).toBeVisible()
        await page
          .getByLabel('Message', { exact: true })
          .fill('Four lines of words.\nsecond line\nthird line\nfourth line\nfifth line')
        await keyboard(page, c.kb)
        await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
        const label = `${c.w}x${c.h} kb${c.kb} chips${c.chips}`
        await inside(page.getByLabel('Message', { exact: true }), page, `box ${label}`)
        // Four lines at most above the keyboard (app.css): min(6.5rem, 25% of what is visible).
        const boxH = (await page.getByLabel('Message', { exact: true }).boundingBox())?.height ?? 0
        const cap = Math.min(6.5 * 16, 0.25 * c.h - 0.25 * c.kb)
        expect(boxH, `box height ${label}`).toBeLessThanOrEqual(cap + 1)
        await inside(page.getByRole('button', { name: 'Send', exact: true }), page, `send ${label}`)
        // the thread keeps a readable strip (more than its padding) when the screen is portrait
        if (c.h > c.w)
          expect((await page.getByTestId('timeline').boundingBox())?.height ?? 0, `timeline ${label}`).toBeGreaterThan(
            60,
          )
        await keyboard(page, 0)
      }
    })

    test('1d: the slash picker stays on screen in landscape with many chips', async ({ page }, info) => {
      test.skip(info.project.name !== 'iphone', 'iOS layout')
      await page.setViewportSize({ width: 844, height: 390 })
      await open(page)
      await page.getByTestId('pick-photos').setInputFiles(
        Array.from({ length: 10 }, (_, i) => ({
          name: `IMG_${i}.png`,
          mimeType: 'image/png',
          buffer: Buffer.from('x'),
        })),
      )
      await expect(page.getByText('IMG_9.png')).toBeVisible()
      await page.getByLabel('Message', { exact: true }).fill('/')
      await keyboard(page, 200)
      await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
      await inside(page.getByTestId('slash-picker').getByRole('option').first(), page, 'first command')
    })

    test("1e: another screen's field is scrolled into view when focus moves to it with the keyboard up", async ({
      page,
    }, info) => {
      test.skip(info.project.name !== 'iphone', 'iOS layout')
      await page.setViewportSize({ width: 393, height: 852 })
      await open(page, '/schedules/new')
      await keyboard(page, 336)
      await expect(page.locator('html')).toHaveAttribute('data-kb', 'open')
      const scroller = page.getByRole('region', { name: 'Job form' })
      // preventScroll: only the focusin reveal can bring the field into view, not the browser's own focus scroll.
      const focusAndMeasure = (label: string) =>
        page.getByLabel(label).evaluate((el) => {
          ;(el as HTMLElement).focus({ preventScroll: true })
          const f = el.getBoundingClientRect()
          const a = (el.closest('[aria-label="Job form"]') as HTMLElement).getBoundingClientRect()
          return { outsideBefore: f.top < a.top || f.bottom > a.bottom }
        })
      const bounds = async (label: string) => {
        const f = await page.getByLabel(label).boundingBox()
        const a = await scroller.boundingBox()
        return {
          top: (f?.y ?? 0) - (a?.y ?? 0),
          bottom: (f?.y ?? 0) + (f?.height ?? 0) - ((a?.y ?? 0) + (a?.height ?? 0)),
        }
      }
      // A field below the fold comes up to the keyboard...
      expect((await focusAndMeasure('What to do')).outsideBefore, 'setup: the field starts below the fold').toBe(true)
      await expect.poll(async () => (await bounds('What to do')).bottom).toBeLessThanOrEqual(0.5)
      expect((await bounds('What to do')).top).toBeGreaterThanOrEqual(-0.5)
      // ...and a field scrolled out above the fold comes back down.
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      expect((await focusAndMeasure('Name')).outsideBefore, 'setup: the field starts above the fold').toBe(true)
      await expect.poll(async () => (await bounds('Name')).top).toBeGreaterThanOrEqual(-0.5)
      expect((await bounds('Name')).bottom).toBeLessThanOrEqual(0.5)
    })

    test('1f: a long status label does not move the timeline', async ({ page }, info) => {
      test.skip(info.project.name !== 'iphone', 'iOS layout')
      await open(page)
      const top = async (label?: string) => {
        await page.evaluate((l) => {
          ;(window as unknown as { __talos: Talos }).__talos.store.setState((s) => ({
            statuses: {
              ...(s.statuses as object),
              general: {
                thread_id: 'general',
                state: 'working',
                ...(l ? { label: l } : {}),
                since: new Date().toISOString(),
              },
            },
          }))
        }, label)
        await page.waitForTimeout(100)
        return (await page.getByTestId('timeline').boundingBox())?.y ?? 0
      }
      const bare = await top()
      expect(await top('Reading the thread and checking the logs')).toBe(bare)
    })

    test('2: the + menu closes on a choice and on a pick; focus goes back to the box', async ({ page }, info) => {
      await withKeyboardPlugin(page)
      await open(page)
      const attach = page.getByRole('button', { name: 'Attach' })
      await attach.click()
      await expect(page.getByTestId('attach-photos')).toBeVisible()
      await page.screenshot({ path: shot(`menu-open-${scheme}`, info.project.name) })
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('attach-photos').click()
      await expect(page.getByTestId('attach-photos')).toHaveCount(0) // closed by the choice, picker still "open"
      await (await chooser).setFiles({ name: 'IMG_8115.png', mimeType: 'image/png', buffer: Buffer.from('y') })
      await expect(page.getByText('IMG_8115.png')).toBeVisible()
      await expect(page.getByTestId('attach-photos')).toHaveCount(0)
      await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
      await page.keyboard.type('and typing continues')
      await expect(page.getByLabel('Message', { exact: true })).toHaveValue('and typing continues')
      await page.screenshot({ path: shot(`menu-closed-${scheme}`, info.project.name) })
    })

    test('2b: a cancelled picker closes the menu and returns focus too', async ({ page }) => {
      await withKeyboardPlugin(page)
      await open(page)
      await page.getByRole('button', { name: 'Attach' }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('attach-files').click()
      await chooser
      await page.getByTestId('pick-files').dispatchEvent('cancel')
      await expect(page.getByTestId('attach-files')).toHaveCount(0)
      await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
    })

    test('2d: off the shell, a touch device does not refocus the box after a pick (the keyboard is unmeasured there)', async ({
      page,
    }, info) => {
      test.skip(info.project.name === 'desktop', 'a mouse device keeps the refocus')
      await open(page)
      await page.getByRole('button', { name: 'Attach' }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('attach-photos').click()
      await (await chooser).setFiles({ name: 'IMG_8116.png', mimeType: 'image/png', buffer: Buffer.from('y') })
      await expect(page.getByText('IMG_8116.png')).toBeVisible()
      await expect(page.getByTestId('attach-photos')).toHaveCount(0)
      await expect(page.getByLabel('Message', { exact: true })).not.toBeFocused()
    })

    test('2c: a failed upload leaves the menu closed, the error on the chip and the composer usable', async ({
      page,
    }, info) => {
      await withKeyboardPlugin(page)
      await open(page)
      await page.evaluate(() => {
        ;(window as unknown as { __talos: Talos }).__talos.uploadMedia = async () => {
          throw new Error('boom')
        }
      })
      await page.getByRole('button', { name: 'Attach' }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('attach-files').click()
      await (await chooser).setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('z') })
      await expect(page.getByText("Couldn't upload")).toBeVisible()
      await expect(page.getByTestId('attach-files')).toHaveCount(0)
      await expect(page.getByLabel('Message', { exact: true })).toBeFocused()
      await page.screenshot({ path: shot(`upload-failed-${scheme}`, info.project.name) })
    })

    test('2e: two failed photos: the note reads right, and goes when the chips do', async ({ page }) => {
      await open(page)
      await page.evaluate(() => {
        ;(window as unknown as { __talos: Talos }).__talos.uploadMedia = async () => {
          throw new Error('boom')
        }
      })
      await page
        .getByTestId('pick-photos')
        .setInputFiles(
          ['IMG_1.png', 'IMG_2.png'].map((name) => ({ name, mimeType: 'image/png', buffer: Buffer.from('x') })),
        )
      await expect(page.getByText("Couldn't upload")).toHaveCount(2)
      await page.getByLabel('Message', { exact: true }).fill('with photos')
      await page.getByRole('button', { name: 'Send', exact: true }).click()
      const note = page.getByTestId('composer').getByText(/not sent/)
      await expect(note).toHaveText("2 files didn't upload and were not sent. Remove them or add them again.")
      await page.getByRole('button', { name: 'Remove IMG_1.png' }).click()
      await page.getByRole('button', { name: 'Remove IMG_2.png' }).click()
      await expect(note).toHaveCount(0)
    })

    test('3: jump to latest appears when scrolled away, counts arrivals, jumps, and works by keyboard', async ({
      page,
    }, info) => {
      await open(page)
      await seed(page, 40)
      const tl = page.getByTestId('timeline')
      const jump = page.getByTestId('jump-to-latest')
      const atBottom = () => tl.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80)
      await expect.poll(atBottom).toBe(true)
      await expect(jump).toHaveCount(0)

      await tl.evaluate((el) => {
        el.scrollTop = 0
      })
      await expect(jump).toBeVisible()
      await expect(jump).toHaveAccessibleName('Jump to latest message')
      await expect(page.getByTestId('jump-count')).toHaveCount(0)
      await page.screenshot({ path: shot(`jump-${scheme}`, info.project.name) })

      // two messages arrive while scrolled away: counted, and the scroll position is left alone
      await seed(page, 2, 40)
      await expect(page.getByTestId('jump-count')).toHaveText('2')
      await expect(jump).toHaveAccessibleName('Jump to latest, 2 new messages')
      expect(await tl.evaluate((el) => el.scrollTop)).toBeLessThan(5)
      // the owner's own send is not "new"
      await seed(page, 1, 42, 'owner')
      await expect(page.getByTestId('jump-count')).toHaveText('2')

      // keyboard open: the button sits above the composer, inside the visible area
      await keyboard(page, 336)
      await inside(jump, page, 'jump button')
      const jb = await jump.boundingBox()
      const cb = await page.getByTestId('composer').boundingBox()
      expect((jb?.y ?? 0) + (jb?.height ?? 0)).toBeLessThanOrEqual(cb?.y ?? 0)
      await page.screenshot({ path: shot(`jump-keyboard-${scheme}`, info.project.name) })
      await keyboard(page, 0)

      // reachable and operable by keyboard
      await jump.focus()
      await expect(jump).toBeFocused()
      await page.keyboard.press('Enter')
      await expect.poll(atBottom).toBe(true)
      await expect(jump).toHaveCount(0)
      await expect(tl).toBeFocused()

      // a message arriving while at the bottom keeps following (the scroll anchor is intact) and shows no button
      await seed(page, 1, 43)
      await expect.poll(atBottom).toBe(true)
      await expect(jump).toHaveCount(0)
    })

    test('3b: no jump button in an empty thread', async ({ page }) => {
      await open(page, '/threads')
      await page.locator('main').getByTestId('new-thread').click()
      await page.getByTestId('thread-settings').getByLabel('Name').fill('Empty one')
      await page.getByRole('button', { name: 'Create thread' }).click()
      await page.getByTestId('thread-row-empty_one').click()
      await expect(page.getByTestId('thread-empty-explainer')).toBeVisible()
      await expect(page.getByTestId('jump-to-latest')).toHaveCount(0)
    })

    test('4: the phone header keeps its menu button, thread name, status dot and ring apart, at phone widths', async ({
      page,
    }, info) => {
      for (const width of [320, 360, 393]) {
        await page.setViewportSize({ width, height: 800 })
        await page.goto('/t/general?fake_agents=demo')
        await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
        await page.evaluate(() => {
          ;(window as unknown as { __talos: Talos }).__talos.store.setState((s) => ({
            statuses: {
              ...(s.statuses as object),
              general: {
                thread_id: 'general',
                state: 'queued',
                label: 'Waiting for the Mac to wake up',
                since: new Date().toISOString(),
              },
            },
          }))
        })
        const header = page.getByTestId('phone-header')
        const menu = page.getByTestId('phone-menu-button')
        const name = header.getByRole('heading', { level: 1 })
        const dot = page.getByTestId('phone-status')
        const ring = page.getByTestId('session-trigger')
        // the word lives with the dot for a screen reader; the line itself stays one slim row
        await expect(dot).toContainText('Queued')
        await expect(ring).toBeVisible()
        const boxes = await Promise.all([menu, name, dot, ring].map((l) => l.boundingBox()))
        const [m, n, d, r] = boxes
        const apart = (a: typeof m, b: typeof m) =>
          (a?.x ?? 0) + (a?.width ?? 0) <= (b?.x ?? 0) + 0.5 || (b?.x ?? 0) + (b?.width ?? 0) <= (a?.x ?? 0) + 0.5
        const label = `at ${width}px: ${JSON.stringify(boxes)}`
        expect(apart(m, n), `menu vs name ${label}`).toBe(true)
        expect(apart(n, d), `name vs dot ${label}`).toBe(true)
        expect(apart(d, r), `dot vs ring ${label}`).toBe(true)
        expect(apart(n, r), `name vs ring ${label}`).toBe(true)
        expect((r?.x ?? 0) + (r?.width ?? 0), `ring inside the screen ${label}`).toBeLessThanOrEqual(width)
        expect((await header.boundingBox())?.height ?? 99, `one slim row ${label}`).toBeLessThanOrEqual(48)
        expect(n?.width ?? 0, `the thread name keeps room ${label}`).toBeGreaterThan(60)
        if (width === 360)
          await page.screenshot({
            path: shot(`header-${scheme}`, info.project.name),
            clip: { x: 0, y: 0, width, height: 220 },
          })
      }
    })
  })
}
