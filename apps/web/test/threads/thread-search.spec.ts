// The search button in a thread's phone header searches THIS thread (owner, 2026-11-22: it used to open the command palette,
// had no way out, and read as a shortcut menu). It opens a full-screen search over the thread, with a real X ("Close search")
// that puts the owner back at the same place in the thread; a hit opens its message in context (the app's one jump-to-message,
// /t/:id?m=); "Search all threads" widens the same query. The thread stays mounted underneath, so its scroll position is kept.
// Desktop has no header search icon on purpose (test/threads/chat-header.spec.ts): it searches from the thread's menu.
import { expect, type Locator, type Page, test } from '@playwright/test'
import { expectAxeClean } from '../cards/e2e.ts'
import { isPhoneWidth } from '../helpers/phone.ts'

test.use({ bypassCSP: true, serviceWorkers: 'block' })

type Talos = {
  store: { setState: (f: (s: Record<string, unknown>) => Record<string, unknown>) => void }
  setMacOnline: (online: boolean) => void
  search: { search: (...a: unknown[]) => Promise<unknown> }
}

// A whole 26-character id, as the protocol's MsgId wants (the context view refuses anything else)
const id = (prefix: string, i: number) => `m_${prefix}${String(i).padStart(25, '0')}`
const row = (thread: string, prefix: string, i: number, text: string) => ({
  id: id(prefix, i),
  thread_id: thread,
  seq: 1000 + i,
  author: i % 3 ? 'agent' : 'owner',
  kind: 'text',
  text,
  format: 'plain',
  attachments: [],
  via: 'app',
  created_at: new Date(Date.now() - (500 - i) * 1000).toISOString(),
})
const filler = (i: number) => `Sample message ${i}. ${'Long enough to wrap on a phone and fill the thread. '.repeat(2)}`

/** 40 messages in General (two mention kumquat: 7 and 33) and one kumquat in Inbox, the other thread. */
const GENERAL_HITS = [id('0', 7), id('0', 33)]

async function seed(page: Page) {
  await page.goto('/t/general')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  const general = Array.from({ length: 40 }, (_, i) =>
    row('general', '0', i, i === 7 || i === 33 ? `The kumquat order, part ${i}. ${filler(i)}` : filler(i)),
  )
  const inbox = [row('inbox', '1', 1, 'A kumquat from the other thread.')]
  await page.evaluate(
    ([g, n]) => {
      const t = (window as unknown as { __talos: Talos }).__talos
      t.store.setState((s) => ({
        messages: { ...((s.messages as Record<string, unknown[]>) ?? {}), general: g, inbox: n },
      }))
    },
    [general, inbox] as const,
  )
  const tl = page.getByTestId('timeline')
  await expect(tl.locator('[data-msg-id]').last()).toHaveAttribute('data-msg-id', id('0', 39))
  await page.evaluate(() => document.fonts.ready)
  await settled(tl)
  return tl
}

/**
 * The thread's own card loads its code late (CardView is a lazy chunk): its placeholder is then replaced by a taller card and the
 * thread moves. A position read before that is not where he ends up, so wait until the placeholder is gone and nothing has moved
 * for ten frames.
 */
async function settled(tl: Locator) {
  await expect(tl.locator('.animate-pulse')).toHaveCount(0)
  await tl.evaluate(async (el) => {
    let same = 0
    let was = ''
    while (same < 10) {
      await new Promise((f) => requestAnimationFrame(f))
      const now = `${el.scrollTop} ${el.scrollHeight} ${el.clientHeight}`
      same = now === was ? same + 1 : 0
      was = now
    }
  })
}

/** Where he is reading: the first message in view and how far down the scroller it sits (see follow-new-text.spec.ts). */
const reading = (tl: Locator) =>
  tl.evaluate((el) => {
    const box = el.getBoundingClientRect()
    for (const r of el.querySelectorAll('[data-msg-id]')) {
      const b = r.getBoundingClientRect()
      if (b.bottom > box.top + 1) return `${r.getAttribute('data-msg-id')} at ${Math.round(b.top - box.top)}`
    }
    return 'none'
  })

// found by what it is (the header's search button), so on main it is the palette opener and the specs fail on what it does
const searchButton = (page: Page) => page.getByTestId('phone-header').getByRole('button', { name: /^Search/ })
const panel = (page: Page) => page.getByRole('dialog', { name: 'Search this thread' })

test.describe('thread search (phone header)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) >= 768, 'the phone header')

  test('(a) the header search opens a search of this thread, not the command palette', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    await expect(panel(page)).toBeVisible()
    const input = panel(page).getByRole('searchbox', { name: 'Search this thread' })
    await expect(input).toBeFocused()
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
    // plain words before anything is typed
    await expect(panel(page).getByText(/Type at least 2 letters/)).toBeVisible()
    // the old voice notes' transcripts are still indexed on the Mac; there are no new ones
    await expect(panel(page)).toContainText('an old voice note')
  })

  test('(b) the X closes it and the thread is where it was', async ({ page }) => {
    const tl = await seed(page)
    await tl.evaluate((el) => {
      el.scrollTop = Math.round(el.scrollHeight * 0.4)
      el.dispatchEvent(new Event('scroll'))
    })
    await expect.poll(() => tl.evaluate((el) => el.scrollTop)).toBeGreaterThan(100)
    const top = await tl.evaluate((el) => el.scrollTop)
    const was = await reading(tl)
    await searchButton(page).click()
    await panel(page).getByRole('searchbox').fill('kumquat')
    await expect(panel(page).getByTestId('hit-row').first()).toBeVisible()
    await panel(page).getByRole('button', { name: 'Close search' }).click()
    await expect(panel(page)).toHaveCount(0)
    expect(await tl.evaluate((el) => el.scrollTop)).toBe(top)
    expect(await reading(tl)).toBe(was)
    // and the button that opened it has the focus again
    await expect(searchButton(page)).toBeFocused()
  })

  test('(c) results are this thread only; a hit jumps to its message, highlighted', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    await panel(page).getByRole('searchbox').fill('kumquat')
    const hits = panel(page).getByTestId('hit-row')
    await expect(hits).toHaveCount(2)
    await expect(panel(page).getByText('A kumquat from the other thread.')).toHaveCount(0)
    await hits.filter({ hasText: 'part 33' }).click()
    // the app's own jump-to-message: the context view on the whole message id, scrolled to and pulsing
    await expect(page).toHaveURL(new RegExp(`/t/general\\?m=${GENERAL_HITS[1]}$`))
    const anchor = page.locator(`[data-anchor="true"]#ctx-${GENERAL_HITS[1]}`)
    await expect(anchor).toBeVisible()
    await expect(anchor).toContainText('part 33')
    await expect(anchor.locator('[data-msg-id]')).toHaveAttribute('data-msg-id', GENERAL_HITS[1])
    await expect(anchor).toBeInViewport()
    await expect(page.getByTestId('thread-search')).toHaveCount(0)
  })

  test('(d) "Search all threads" widens the same query, and back again', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    await p.getByRole('searchbox').fill('kumquat')
    await expect(p.getByTestId('hit-row')).toHaveCount(2)
    await p.getByRole('button', { name: 'Search all threads' }).click()
    await expect(p.getByTestId('hit-row')).toHaveCount(3)
    await expect(p.getByText('A kumquat from the other thread.')).toBeVisible()
    await expect(p.getByRole('searchbox')).toHaveValue('kumquat')
    await p.getByRole('button', { name: 'Search only this thread' }).click()
    await expect(p.getByTestId('hit-row')).toHaveCount(2)
  })

  test('(e) Escape closes it, like the X', async ({ page }) => {
    const tl = await seed(page)
    const was = await reading(tl)
    await searchButton(page).click()
    await expect(panel(page).getByRole('searchbox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    expect(await reading(tl)).toBe(was)
  })

  test('(f) nothing found, and search not answering, say so in plain words', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    await p.getByRole('searchbox').fill('zzzqqq')
    await expect(p.getByText('Nothing found for “zzzqqq”.')).toBeVisible()
    await expect(p.getByTestId('thread-search-empty')).toContainText('Try fewer words')
    // the Mac does not answer: this device's own messages are searched, and it says so
    await page.evaluate(() => (window as unknown as { __talos: Talos }).__talos.setMacOnline(false))
    await p.getByRole('searchbox').fill('kumquat')
    await expect(p.getByText(/Your Mac is offline\. Showing matches from messages on this device\./)).toBeVisible()
    await expect(p.getByTestId('hit-row')).toHaveCount(2)
    // search itself failing
    await page.evaluate(() => {
      const t = (window as unknown as { __talos: Talos }).__talos
      t.setMacOnline(true)
      t.search.search = () => Promise.reject(new Error('boom'))
    })
    await p.getByRole('searchbox').fill('kumquats')
    await expect(p.getByRole('alert')).toHaveText('Search failed. Try again.')
  })

  test('arrow keys move between the box and the hits; Enter opens the hit', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    await p.getByRole('searchbox').fill('kumquat')
    await expect(p.getByTestId('hit-row')).toHaveCount(2)
    await page.keyboard.press('ArrowDown')
    await expect(p.getByTestId('hit-row').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(p.getByTestId('hit-row').nth(1)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(p.getByRole('searchbox')).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/t\/general\?m=/)
  })

  test('the header search button is named for what it does, and the palette button is gone from it', async ({
    page,
  }) => {
    await seed(page)
    await expect(page.getByTestId('palette-button')).toHaveCount(0)
    await expect(searchButton(page)).toHaveAccessibleName('Search this thread')
  })

  // everything under the panel (header, banners, timeline, composer, strips) lives in ONE container that carries `inert`
  const under = (page: Page) => page.getByTestId('thread-under-search')
  const outside = (p: Locator) =>
    p.evaluate((el) => {
      const a = document.activeElement
      return !!a && a !== document.body && !el.contains(a) // the page itself may take the focus: that is not the thread
    })
  const tabAround = async (page: Page, p: Locator) => {
    await p.getByTestId('thread-search-close').focus()
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      expect(await outside(p), `Tab ${i + 1}`).toBe(false)
    }
    await p.getByRole('searchbox').focus()
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab')
      expect(await outside(p), `Shift+Tab ${i + 1}`).toBe(false)
    }
  }
  // back to normal: nothing inert or hidden, and the composer takes the focus
  const threadIsBack = async (page: Page) => {
    await expect(under(page)).not.toHaveAttribute('inert')
    await expect(under(page)).not.toHaveAttribute('aria-hidden')
    await page.getByTestId('composer').getByRole('textbox').focus()
    await expect(page.getByTestId('composer').getByRole('textbox')).toBeFocused()
  }

  test('focus cannot leave the panel: the thread under it is inert, and is back when it closes', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    await expect(under(page)).toHaveAttribute('inert', '')
    await expect(under(page)).toHaveAttribute('aria-hidden', 'true')
    await tabAround(page, p)
    await p.getByRole('button', { name: 'Close search' }).click()
    await expect(p).toHaveCount(0)
    await expect(searchButton(page)).toBeFocused()
    await threadIsBack(page)
  })

  test('a strip that appears under the open panel is inert too: Tab still cannot reach it', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    // the agent starts working, and the owner's stop (pressed on the line under the panel by script: nothing can reach it
    // by hand) brings up the "Stopped" strip with its Undo button, which was not there when the panel opened
    await page.evaluate(() => {
      const t = (window as unknown as { __talos: Talos & { session: { patch(p: object): void } } }).__talos
      t.store.setState((s) => ({
        ...s,
        statuses: { general: { thread_id: 'general', state: 'working', since: new Date().toISOString() } },
      }))
      t.session.patch({ busy: true, turn_id: 'turn_7' })
    })
    const stop = page.getByTestId('stop-line-button')
    await expect(stop).toHaveCount(1)
    await stop.evaluate((b) => (b as HTMLElement).click())
    const strip = page.getByTestId('stopped-strip')
    await expect(strip).toHaveCount(1)
    expect(await strip.evaluate((el) => !!el.closest('[inert]'))).toBe(true)
    await tabAround(page, p)
  })

  test('Escape gives the thread back too, and so does Back after a hit', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    await page.keyboard.press('Escape')
    await expect(panel(page)).toHaveCount(0)
    await expect(searchButton(page)).toBeFocused()
    await threadIsBack(page)
    // a hit leaves for the message in context; Back is the thread again, not inert and not hidden
    await searchButton(page).click()
    await panel(page).getByRole('searchbox').fill('kumquat')
    await panel(page).getByTestId('hit-row').first().click()
    await expect(page.getByTestId('context-view')).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/t\/general$/)
    await expect(page.getByTestId('timeline')).toBeVisible()
    await threadIsBack(page)
  })

  test('one status line stays in place across the states and only its words change', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    const p = panel(page)
    await expect(p.getByRole('status')).toHaveCount(1)
    const line = await p.getByTestId('thread-search-status').elementHandle()
    expect(line).not.toBeNull()
    await p.getByRole('searchbox').fill('kumquat')
    await expect(p.getByTestId('thread-search-status')).toHaveText('2 matches')
    await p.getByRole('searchbox').fill('zzzqqq')
    await expect(p.getByTestId('thread-search-status')).toHaveText('Nothing found for “zzzqqq”.')
    await page.evaluate(() => (window as unknown as { __talos: Talos }).__talos.setMacOnline(false))
    await p.getByRole('searchbox').fill('kumquat')
    await expect(p.getByTestId('thread-search-status')).toContainText('Your Mac is offline.')
    await expect(p.getByRole('status')).toHaveCount(1)
    // the same element all along: a live region that is replaced, not changed, is often not read aloud
    expect(await line?.evaluate((n) => n.isConnected)).toBe(true)
  })

  test('axe: the open panel, with results, is clean', async ({ page }) => {
    await seed(page)
    await searchButton(page).click()
    await panel(page).getByRole('searchbox').fill('kumquat')
    await expect(panel(page).getByTestId('hit-row')).toHaveCount(2)
    await expectAxeClean(page)
  })
})

test.describe('thread search (desktop)', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'desktop only')

  test('no header search icon on purpose; the thread menu searches this thread only', async ({ page }) => {
    await seed(page)
    expect(isPhoneWidth(page)).toBe(false)
    await expect(searchButton(page)).toHaveCount(0)
    await page.getByTestId('thread-settings-trigger').click()
    await page.getByTestId('thread-settings-open').click()
    await page.getByRole('button', { name: 'Search this thread' }).click()
    await expect(page).toHaveURL(/\/search\?thread=general/)
    await page.getByRole('searchbox', { name: 'Search messages' }).fill('kumquat')
    await expect(page.getByTestId('hit-row')).toHaveCount(2)
  })
})

// The owner sees UI first: TS_SHOTS=<folder> writes the pictures (dark and light) and runs nothing else of value here.
const SHOTS = process.env.TS_SHOTS
test.describe('thread search screenshots', () => {
  test.skip(!SHOTS, 'set TS_SHOTS=<folder> to take the pictures')
  for (const scheme of ['dark', 'light'] as const) {
    test(`pictures, ${scheme}`, async ({ page }, info) => {
      const name = info.project.name
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })
      const tl = await seed(page)
      const shot = (n: string) => page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${n}.png` })
      if (isPhoneWidth(page)) {
        await tl.evaluate((el) => {
          el.scrollTop = Math.round(el.scrollHeight * 0.4)
          el.dispatchEvent(new Event('scroll'))
        })
        await searchButton(page).click()
        await expect(panel(page).getByRole('searchbox')).toBeFocused()
        await shot('1-open')
        await panel(page).getByRole('searchbox').fill('kumquat')
        await expect(panel(page).getByTestId('hit-row')).toHaveCount(2)
        await shot('2-results')
        await panel(page).getByRole('button', { name: 'Close search' }).click()
        await expect(panel(page)).toHaveCount(0)
        await shot('3-closed')
      } else {
        // a reload would empty the fake client: reach it the way the owner does, from the thread's menu
        await page.getByTestId('thread-settings-trigger').click()
        await page.getByTestId('thread-settings-open').click()
        await page.getByRole('button', { name: 'Search this thread' }).click()
        await page.getByRole('searchbox', { name: 'Search messages' }).fill('kumquat')
        await expect(page.getByTestId('hit-row')).toHaveCount(2)
        await shot('search-this-thread')
      }
    })
  }
})
