// The owner's rule: if he can see what an approval is for, he can approve it from his phone. In the REAL app (thread view with its
// header, composer and overlays), opened from /card/:id on an iPhone SE (320 pt), an iPhone 15 and a Pixel, a permission card opens a
// full-screen approval sheet that owns the screen. Allow stays disabled until the owner has scrolled to the end of the call, nothing
// else draws over the sheet, and a pinch zoom turns Allow off.

import { expect, type Page, test } from '@playwright/test'
import { composePermissionCard } from '@talos-app/protocol'

test.use({ bypassCSP: true })

let seq = 0
const cardFor = (tool: string, preview: string) =>
  composePermissionCard({
    request: {
      request_id: `bcdf${'ghjkmnpqrstvwxyz'[seq % 16]}`,
      tool_name: tool,
      description: 'Scripted call',
      input_preview: preview,
    },
    card_id: `c_01JBF3V7Q8K2M4N6P8R0S${String(96000 + ++seq)}`,
    thread_id: 'general',
    now: Date.parse('2026-10-28T15:59:30.000Z'),
    client_version: '2.1.312',
  })

/** Seeds one permission card into the real fake-mode app and opens it the way a push does: /card/:id, client-side. */
async function openCard(page: Page, preview: string, tool = 'Bash') {
  const card = cardFor(tool, preview)
  await page.clock.install({ time: new Date('2026-10-28T16:00:00.000Z') })
  await page.goto('/threads')
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.evaluate((c) => {
    const w = window as unknown as { __talos: { store: { getState: () => any; setState: (s: any) => void } } }
    const s = w.__talos.store.getState()
    w.__talos.store.setState({ ...s, cards: [...s.cards, c] })
    window.history.pushState({}, '', `/card/${c.id}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, card)
  const sheet = page.getByTestId('approval-sheet')
  await expect(sheet).toBeVisible()
  return { card, sheet }
}

const allow = (sheet: ReturnType<Page['getByTestId']>) => sheet.getByRole('button', { name: /^Allow/ })
const scrollTo = (page: Page, y: number | 'end') =>
  page.evaluate((to) => {
    const el = document.querySelector('[data-testid="approval-scroll"]') as HTMLElement
    el.scrollTop = to === 'end' ? el.scrollHeight : to
  }, y)
const settle = (page: Page) =>
  page
    .evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    .then(() => page.waitForTimeout(150))

const longCall = Array.from(
  { length: 320 },
  (_, i) => `echo line ${i}: building the release bundle for step ${i}`,
).join('; ')

test('the sheet owns the screen: fixed to the visual viewport, above the thread and its chrome', async ({ page }) => {
  const { sheet } = await openCard(page, 'rm -rf /srv/x')
  const m = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect()
    const v = window.visualViewport
    const at = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest('[data-testid="approval-sheet"]') !== null
    return {
      r: { top: r.top, left: r.left, width: r.width, height: r.height },
      vv: { w: v?.width ?? innerWidth, h: v?.height ?? innerHeight },
      pos: getComputedStyle(el).position,
      corners: [
        at(2, 2),
        at(innerWidth - 3, 2),
        at(2, innerHeight - 3),
        at(innerWidth - 3, innerHeight - 3),
        at(innerWidth / 2, 56),
      ],
    }
  })
  expect(m.pos).toBe('fixed')
  expect(Math.abs(m.r.width - m.vv.w)).toBeLessThan(2)
  expect(Math.abs(m.r.height - m.vv.h)).toBeLessThan(2)
  expect(m.corners, 'the sheet is the top layer at the corners and where the now-playing pill sits').toEqual([
    true,
    true,
    true,
    true,
    true,
  ])
})

test('a long call (320 steps): Allow stays disabled until the end has been scrolled to, then enables, and stays enabled', async ({
  page,
}) => {
  const { sheet } = await openCard(page, longCall)
  const scroller = page.getByTestId('approval-scroll')
  const dims = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
  expect(dims.sh, 'the call really does need scrolling here').toBeGreaterThan(dims.ch * 1.5)
  await expect(allow(sheet)).toBeDisabled()
  await expect(sheet.getByTestId('approval-hint')).toContainText('Scroll to the end')
  // every position short of the end keeps Allow off
  for (const f of [0, 0.25, 0.5, 0.75]) {
    await scrollTo(page, Math.floor((dims.sh - dims.ch) * f))
    await settle(page)
    await expect(allow(sheet), `scrolled to ${f * 100}%`).toBeDisabled()
  }
  await scrollTo(page, 'end')
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
  await expect(sheet.getByTestId('approval-hint')).toHaveCount(0)
  // once seen it stays enabled while the sheet is open
  await scrollTo(page, 0)
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
  // the pinned tail is outside the scroll area and shows the end of the call at every position
  await expect(sheet.getByTestId('permission-tail')).toContainText('step 319')
  await expect(sheet.getByTestId('permission-call')).toContainText('echo line 0:')
  await expect(sheet.getByTestId('permission-call')).toContainText('step 319')
  await expect(sheet.getByRole('button', { name: 'Deny' })).toBeEnabled()
})

test('a CJK and emoji call is shown as it is; Allow waits for the end, then enables', async ({ page }) => {
  const call = `${'漢字のテスト '.repeat(2300)}\u{1F600}\u{1F680} done`
  const { sheet } = await openCard(page, call)
  await expect(sheet.getByTestId('permission-call')).toContainText('漢字のテスト')
  await expect(sheet.getByTestId('permission-call')).toContainText('\u{1F600}\u{1F680} done')
  const dims = await page
    .getByTestId('approval-scroll')
    .evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
  expect(dims.sh).toBeGreaterThan(dims.ch)
  await expect(allow(sheet)).toBeDisabled()
  await scrollTo(page, 'end')
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
})

test('a call with hidden and bidi characters shows each as a marker, and Allow unlocks at the end', async ({
  page,
}) => {
  const call = `echo start ‮​⁦ ${'padding word '.repeat(1300)}; rm -rf ~ ‮ done`
  const { sheet } = await openCard(page, call)
  const text = (await sheet.getByTestId('permission-call').textContent()) ?? ''
  expect(text).toContain('[U+202E]')
  expect(text).toContain('[U+200B]')
  expect(text).toContain('[U+2066]')
  expect(text).not.toMatch(/[‮​⁦]/)
  await expect(allow(sheet)).toBeDisabled()
  await scrollTo(page, 'end')
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
  await expect(sheet.getByTestId('permission-tail')).toContainText('[U+202E] done')
})

test('a short call needs no scrolling: Allow is enabled at once', async ({ page }) => {
  const { sheet } = await openCard(page, 'rm -rf /srv/x')
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
})

test('the now-playing pill, a new-reply banner and the toast viewport do not render over the open sheet (and are not lost)', async ({
  page,
}) => {
  const { sheet, card } = await openCard(page, longCall)
  // raise the now-playing pill: a clip in the audio dock (the file will not load; the pill shows either way)
  await page.evaluate(() => {
    const w = window as unknown as {
      __talosDock: { open: (item: object, src: string, rest: unknown[], opts: object) => void }
    }
    w.__talosDock.open({ key: 'm1', mediaId: 'md_X', title: 'A voice note', threadId: 'general' }, '/x.wav', [], {
      play: false,
    })
  })
  // raise a new-reply banner: an unread reply in a thread that is not on screen
  await page.evaluate((cardId) => {
    const w = window as unknown as { __talos: { store: { getState: () => any; setState: (s: any) => void } } }
    const s = w.__talos.store.getState()
    const here = s.cards.find((c: any) => c.id === cardId).thread_id
    const other = s.threads.find((t: any) => t.id !== here && t.notify === 'all' && !t.archived)
    const msg = {
      id: 'm_01JBF3V7Q8K2M4N6P8R0S9ZZZZ',
      thread_id: other.id,
      author: 'agent',
      kind: 'text',
      text: 'A reply that should wait',
      format: 'plain',
      attachments: [],
      via: 'app',
      seq: 999,
      created_at: new Date().toISOString(),
    }
    w.__talos.store.setState({
      ...s,
      messages: { ...s.messages, [other.id]: [...(s.messages[other.id] ?? []), msg] },
      unread: { ...s.unread, [other.id]: (s.unread[other.id] ?? 0) + 1 },
    })
  }, card.id)
  await page.waitForTimeout(400)
  await expect(page.getByTestId('now-playing')).toHaveCount(0)
  await expect(page.getByTestId('thread-banner')).toHaveCount(0)
  const covered = await page.evaluate(() => {
    const top = (x: number, y: number) =>
      document.elementFromPoint(x, y)?.closest('[data-testid="approval-sheet"]') !== null
    return [top(innerWidth / 2, 56), top(innerWidth / 2, 20), top(innerWidth / 2, innerHeight - 20)]
  })
  expect(covered).toEqual([true, true, true])
  // closing the sheet gives the screen back: the pill and the banner it held back appear
  await sheet.getByTestId('approval-close').click()
  await expect(page.getByTestId('now-playing')).toBeVisible()
  await expect(page.getByTestId('thread-banner')).toBeVisible()
})

test('a pinch zoom turns Allow off until the page is back to 1x (Deny stays)', async ({ page, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'WebKit gives Playwright no way to set the page scale; the zoom rule is unit-tested there',
  )
  const { sheet } = await openCard(page, 'rm -rf /srv/x')
  await settle(page)
  await expect(allow(sheet)).toBeEnabled()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 })
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBeGreaterThan(1.5)
  await expect(allow(sheet)).toBeDisabled()
  await expect(sheet.getByTestId('approval-hint')).toContainText('Zoom back out')
  await expect(sheet.getByRole('button', { name: 'Deny' })).toBeEnabled()
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBeLessThan(1.01)
  await expect(allow(sheet)).toBeEnabled()
})

test('Allow from the sheet sends a primary resolve with the card hash', async ({ page }) => {
  const { sheet, card } = await openCard(page, 'rm -rf /srv/x')
  await settle(page)
  await allow(sheet).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => (window as unknown as { __talos: { sent: any[] } }).__talos.sent)).some(
        (f) => f.type === 'card.resolve',
      ),
    )
    .toBe(true)
  const last = (await page.evaluate(() => (window as unknown as { __talos: { sent: any[] } }).__talos.sent)).at(-1)
  expect(last).toMatchObject({
    type: 'card.resolve',
    action: 'primary',
    card_id: card.id,
    payload_hash: card.payload_hash,
  })
})

test('a run of Hangul conjoining jamo (one grapheme cluster, nothing to break) never runs off the side with Allow on', async ({
  page,
}) => {
  const { sheet } = await openCard(page, `echo ${'\u1100'.repeat(300)}SECRETTAIL`)
  await settle(page)
  const m = await page.evaluate(() => {
    const sc = document.querySelector('[data-testid="approval-scroll"]') as HTMLElement
    const call = document.querySelector('[data-testid="approval-sheet"] [data-testid="permission-call"]') as HTMLElement
    const tail = document.querySelector('[data-testid="permission-tail"]') as HTMLElement
    const title = document.querySelector(
      '[data-testid="approval-sheet"] h2, [data-testid="approval-sheet"] [role="dialog"] h2, [data-testid="approval-sheet"] h1',
    ) as HTMLElement | null
    const wide = (e: HTMLElement | null) => (e ? e.scrollWidth > e.clientWidth + 1 : false)
    return {
      sideways: wide(sc) || wide(tail) || wide(title),
      scrollW: sc.scrollWidth,
      clientW: sc.clientWidth,
      callRight: call.getBoundingClientRect().right,
      vw: window.innerWidth,
    }
  })
  if (m.sideways) {
    // part of the call is off the side: Allow must be off
    await scrollTo(page, 'end')
    await settle(page)
    await expect(allow(sheet)).toBeDisabled()
  } else {
    // it wrapped: every character is inside the screen, and Allow comes once the end has been reached
    expect(m.scrollW).toBeLessThanOrEqual(m.clientW + 1)
    expect(m.callRight).toBeLessThanOrEqual(m.vw + 1)
    await scrollTo(page, 'end')
    await settle(page)
    await expect(allow(sheet)).toBeEnabled()
    await expect(sheet.getByTestId('permission-tail')).toContainText('SECRETTAIL')
  }
  await expect(sheet.getByRole('button', { name: 'Deny' })).toBeEnabled()
})
