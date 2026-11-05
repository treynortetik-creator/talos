// Adversarial review of PR #40 (page scrolls past the app on desktop). Runs the real production bundle against the
// relay harness (socket client, real Shell), plus the schedules harness (real Shell on the fake client) for Schedules.
// Every assertion is about the document itself: document.scrollingElement must never be taller or wider than the
// viewport while the shell is mounted, and the inner panes must still scroll.
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import { mkFrame } from '@talos-app/testkit'
import { expect, test } from '../helpers/fixtures.ts'
import type { Harness } from '../helpers/harness.ts'
import { agentReply, newId, openSignedIn } from '../helpers/util.ts'

const DESKTOP = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]
const isDesktop = (name: string) => name === 'desktop'
// The schedules harness lives in the fake-mode build (vite preview on PW_PORT), not on the relay harness's origin.
const FAKE_ORIGIN = `http://localhost:${process.env.PW_PORT ?? 4173}`
async function openSchedules(page: Page, route: string) {
  await page.goto(
    `${FAKE_ORIGIN}/test/schedules/harness/index.html?${new URLSearchParams({ route, variant: 'healthyRan' })}`,
  )
  await page.waitForFunction(() => Boolean((window as unknown as { __talos?: unknown }).__talos))
  await page.waitForLoadState('networkidle')
}

type Metrics = {
  sh: number
  ih: number
  sw: number
  iw: number
  bodySh: number
  bodyCh: number
  rootScroll: number
  bodyScroll: number
  escapees: string[]
}

/** Document size plus every absolutely positioned element whose containing block is the viewport (no positioned
 * ancestor) yet which sits inside a scroll container: those escape the scroller and stretch the document. */
function metrics(page: Page): Promise<Metrics> {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement
    const b = document.body
    const name = (el: Element) => {
      const id = el.id ? `#${el.id}` : ''
      const tid = el.getAttribute('data-testid')
      const lab = el.getAttribute('aria-label')
      const cls = typeof el.className === 'string' ? `.${el.className.split(/\s+/).slice(0, 3).join('.')}` : ''
      return `${el.tagName.toLowerCase()}${id}${tid ? `[data-testid=${tid}]` : ''}${lab ? `[aria-label="${lab}"]` : ''}${cls}`
    }
    const escapees: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (getComputedStyle(el).position !== 'absolute' || el.getClientRects().length === 0) continue
      let p = el.parentElement
      let scroller: HTMLElement | null = null
      let contained = false
      while (p && p !== document.documentElement && p !== b) {
        const s = getComputedStyle(p)
        if (
          s.position !== 'static' ||
          s.transform !== 'none' ||
          s.filter !== 'none' ||
          s.perspective !== 'none' ||
          /layout|paint|strict|content/.test(s.contain) ||
          s.containerType !== 'normal'
        ) {
          contained = true
          break
        }
        if (!scroller && /auto|scroll/.test(`${s.overflowY} ${s.overflowX}`)) scroller = p
        p = p.parentElement
      }
      if (!contained && scroller)
        escapees.push(`${name(el)} (text "${(el.textContent ?? '').slice(0, 30)}") inside ${name(scroller)}`)
    }
    return {
      sh: se.scrollHeight,
      ih: innerHeight,
      sw: se.scrollWidth,
      iw: innerWidth,
      bodySh: b.scrollHeight,
      bodyCh: b.clientHeight,
      rootScroll: se.scrollTop,
      bodyScroll: b.scrollTop,
      escapees: [...new Set(escapees)],
    }
  })
}

async function expectLocked(page: Page, where: string, sweep = false) {
  const m = await metrics(page)
  expect.soft(m.sh, `${where}: document taller than the viewport (${m.sh} > ${m.ih})`).toBeLessThanOrEqual(m.ih)
  expect.soft(m.sw, `${where}: document wider than the viewport (${m.sw} > ${m.iw})`).toBeLessThanOrEqual(m.iw)
  expect.soft(m.bodySh, `${where}: body overflows its own box`).toBeLessThanOrEqual(m.bodyCh)
  expect.soft(m.rootScroll + m.bodyScroll, `${where}: the page itself is scrolled`).toBe(0)
  if (sweep)
    expect.soft(m.escapees, `${where}: abspos elements with no positioned ancestor inside a scroller`).toEqual([])
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
function htmlAtt(harness: Harness, name: string, body: string) {
  const media_id = newId('md')
  const bytes = Buffer.from(body)
  harness.relay.media.set(media_id, { bytes, sha256: sha(bytes), mime: 'text/html' })
  return { media_id, kind: 'html', role: 'attachment', mime: 'text/html', name, size: bytes.length, sha256: sha(bytes) }
}

const WIDE = `${'x'.repeat(400)}`
const CODE = `\`\`\`ts\n${Array.from({ length: 40 }, (_, i) => `const line${i} = "${WIDE}"`).join('\n')}\n\`\`\``
const TABLE = `| ${Array.from({ length: 24 }, (_, i) => `column ${i}`).join(' | ')} |\n|${' --- |'.repeat(24)}\n${Array.from(
  { length: 15 },
  (_, r) => `| ${Array.from({ length: 24 }, (_, c) => `cell ${r}.${c} value`).join(' | ')} |`,
).join('\n')}`
const URL_LONG = `https://example.com/${'a'.repeat(500)}`

function manyThreads(harness: Harness, n: number) {
  const base = harness.relay.config.threads[0]
  if (!base) throw new Error('no base thread')
  const extra = Array.from({ length: n }, (_, i) => ({
    ...base,
    id: `topic_${i}`,
    name: `Topic number ${i}`,
    kind: 'agent' as const,
    order: 10 + i,
  }))
  harness.relay.config = { ...harness.relay.config, threads: [...harness.relay.config.threads, ...extra] }
}

function inboxItems(harness: Harness, n: number) {
  for (let i = 0; i < n; i++)
    harness.relay.sendToApps(
      mkFrame('inbox.item', {
        item: {
          id: `e_${newId('m').slice(2)}`,
          source: 'github',
          connection: 'cn_8fK2aBcDeFgHiJkLmNoPqR',
          kind: 'github.review_requested',
          title: `Review requested: change ${i}`,
          summary: `octocat requested your review on example-org/example-repo#${i}`,
          agent_summary: `The agent thinks change ${i} is routine.`,
          url: `https://github.com/example-org/example-repo/pull/${i}`,
          actor: { name: 'octocat' },
          ts: new Date(Date.now() - i * 60_000).toISOString(),
          thread: 'inbox',
          work: false,
          priority: 'high',
          state: 'new',
        },
      }),
    )
}

async function wheelScrolls(page: Page, testId: string | null, locator = testId ? page.getByTestId(testId) : null) {
  if (!locator) throw new Error('no locator')
  const box = await locator.boundingBox()
  if (!box) throw new Error(`${testId} not laid out`)
  const before = await locator.evaluate((el) => el.scrollTop)
  const max = await locator.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(max, `${testId}: has content to scroll`).toBeGreaterThan(0)
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200))
  await page.mouse.wheel(0, before > 0 ? -400 : 400)
  await expect.poll(() => locator.evaluate((el) => el.scrollTop)).not.toBe(before)
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Does the document still overflow in any shell view?
// ---------------------------------------------------------------------------------------------------------------

// No test in this file calls page.setViewportSize(). On Chromium that is `Browser.setWindowBounds` on the test's real
// browser window, which the window server refuses while the window is fullscreen, maximised, minimised or still
// animating out of one of those (the expand button below calls the real requestFullscreen()). Under load the exit can
// lag the next resize, so the test failed with "restore it to normal state first". Each size is instead its own test
// with its own fresh context opened at that viewport (`test.use({ viewport })`): no window is ever resized mid-test.
test.describe('1. no shell view overflows the document (desktop 1280x800, 1440x900)', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  test.beforeEach(({}, info) => test.skip(!isDesktop(info.project.name), 'desktop sizes'))

  for (const size of DESKTOP) {
    const at = `@${size.width}`
    test.describe(`@${size.width}x${size.height}`, () => {
      test.use({ viewport: size })

      test('thread with long code blocks, wide tables and an unbroken URL', async ({ page, context, harness }) => {
        await openSignedIn(harness, page, context)
        for (let i = 0; i < 12; i++)
          harness.relay.sendToApps(agentReply({ text: `Reply ${i}\n\n${CODE}\n\n${TABLE}\n\n${URL_LONG}` }))
        await expect(page.getByText('Reply 11', { exact: true })).toBeVisible()
        await expectLocked(page, `thread ${at}`)
      })

      test('HTML preview inline and expanded full screen', async ({ page, context, harness }) => {
        await openSignedIn(harness, page, context)
        const tall = `<!doctype html><body style="margin:0"><div style="height:5000px;width:3000px">tall page</div></body>`
        for (let i = 0; i < 6; i++)
          harness.relay.sendToApps(
            agentReply({ text: `Page ${i}`, attachments: [htmlAtt(harness, `r${i}.html`, tall)] }),
          )
        // Chromium waits for a tap before an inline page runs; WebKit runs it at once.
        await page.locator('iframe[title="r5.html"], button[aria-label="Run r5.html"]').first().waitFor()
        const run = page.getByRole('button', { name: 'Run r5.html' })
        if (await run.count()) await run.click()
        await expect(page.locator('iframe[title="r5.html"]')).toBeVisible()
        expect(page.viewportSize()).toEqual(size)
        await expectLocked(page, `html inline ${at}`)
        await page.getByRole('button', { name: 'Expand r5.html to full screen' }).click()
        await expect(page.getByRole('dialog', { name: 'r5.html' })).toBeVisible()
        await expectLocked(page, `html fullscreen ${at}`)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expectLocked(page, `html after close ${at}`)
      })

      test('composer with a very long draft', async ({ page, context, harness }) => {
        await openSignedIn(harness, page, context)
        await page
          .getByRole('textbox', { name: 'Message' })
          .fill(Array.from({ length: 300 }, (_, i) => `draft line ${i} ${WIDE}`).join('\n'))
        await expectLocked(page, `composer ${at}`)
      })

      test('Inbox with 60 events', async ({ page, context, harness }) => {
        await openSignedIn(harness, page, context, '/t/inbox')
        inboxItems(harness, 60)
        await expect(page.getByText('Review requested: change 59')).toBeVisible()
        await expectLocked(page, `inbox ${at}`)
      })

      test('sidebar and Sessions/threads list with 32 threads (config max is 40)', async ({
        page,
        context,
        harness,
      }) => {
        manyThreads(harness, 30)
        await openSignedIn(harness, page, context, '/threads')
        await expect(page.getByText('Topic number 29').first()).toBeVisible()
        await expectLocked(page, `threads list ${at}`)
        await page.goto('/t/topic_29')
        await page.getByTestId('thread-screen').waitFor()
        await expectLocked(page, `thread with long sidebar ${at}`)
      })

      test('every settings section, integrations and the webhook wizard', async ({ page, context, harness }) => {
        await openSignedIn(harness, page, context, '/settings')
        const nav = page.getByRole('navigation', { name: 'Settings sections' })
        await expect(nav).toBeVisible()
        const hrefs = await nav.getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))
        for (const r of hrefs) {
          await page.goto(r)
          await page.waitForLoadState('networkidle')
          await expectLocked(page, `${r} ${at}`)
        }
        // the wizard is reached from the Integrations screen itself (its own deep links were removed, nothing linked to them)
        await page.goto('/settings/integrations')
        await page.getByRole('button', { name: 'Add an integration' }).click()
        await page.waitForLoadState('networkidle')
        await expectLocked(page, `the integration wizard ${at}`)
      })

      test('Schedules tab: list, new-schedule form, detail (real Shell, fake client)', async ({ page }) => {
        for (const route of ['/schedules', '/schedules/new', '/schedules/daily-summary']) {
          await openSchedules(page, route)
          await expectLocked(page, `${route} ${at}`)
        }
      })
    })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// The belt-and-braces CSS hides the next overflow bug instead of preventing it.
// ---------------------------------------------------------------------------------------------------------------

for (const size of DESKTOP) {
  test.describe(`@${size.width}x${size.height}`, () => {
    test.use({ viewport: size })
    test('sidebar with 32 threads: Ctrl+N sr-only spans stretch the document (same bug class, not fixed)', async ({
      page,
      context,
      harness,
    }, info) => {
      test.skip(!isDesktop(info.project.name), 'the sidebar is desktop/tablet only')
      manyThreads(harness, 30)
      await openSignedIn(harness, page, context)
      await expect(
        page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /Topic number 29/ }),
      ).toHaveCount(1)
      const m = await metrics(page)
      expect.soft(m.sh, `@${size.width}: document is ${m.sh}px tall in a ${m.ih}px window`).toBeLessThanOrEqual(m.ih)
    })
  })
}

test('the CSS lock turns a stray page scroll into a stuck page (screen reader / find-in-page reaching a Ctrl+N span)', async ({
  page,
  context,
  harness,
}, info) => {
  test.skip(!isDesktop(info.project.name), 'desktop')
  manyThreads(harness, 30)
  await openSignedIn(harness, page, context)
  await expect(
    page.getByRole('complementary', { name: 'Sidebar' }).getByRole('link', { name: /Topic number 29/ }),
  ).toHaveCount(1)
  // What VoiceOver's cursor or Chrome's find bar does when it lands on the last sidebar link's hidden "Ctrl+31" text.
  const y = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('nav[aria-label="Primary"] .sr-only')]
    spans.at(-1)?.scrollIntoView()
    return document.scrollingElement?.scrollTop ?? 0
  })
  await page.mouse.move(640, 300)
  await page.mouse.wheel(0, -3000)
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)
  expect(y === 0 || after === 0, `page jumped to ${y}px and the wheel cannot bring it back (still ${after}px)`).toBe(
    true,
  )
})

// ---------------------------------------------------------------------------------------------------------------
// 2. Regressions: inner panes still scroll; pages without #main still scroll.
// ---------------------------------------------------------------------------------------------------------------

test.describe('2. inner panes still scroll (desktop wheel)', () => {
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture signature
  test.beforeEach(({}, info) => test.skip(!isDesktop(info.project.name), 'desktop wheel'))

  test('timeline', async ({ page, context, harness }) => {
    await openSignedIn(harness, page, context)
    for (let i = 0; i < 20; i++) harness.relay.sendToApps(agentReply({ text: `Reply ${i}\n\n${'para '.repeat(80)}` }))
    await expect(page.getByText('Reply 19', { exact: true })).toBeVisible()
    await wheelScrolls(page, 'timeline')
  })

  test.describe('@1280x600', () => {
    test.use({ viewport: { width: 1280, height: 600 } })
    test('thread list and sidebar', async ({ page, context, harness }) => {
      manyThreads(harness, 30)
      await openSignedIn(harness, page, context, '/threads')
      await expect(page.getByText('Topic number 29').first()).toBeVisible()
      const list = page.locator('#main [role="region"], #main .overflow-y-auto').first()
      await wheelScrolls(page, 'thread list', list)
      const side = page
        .getByRole('complementary', { name: 'Sidebar' })
        .locator('.overflow-y-auto, [role="region"]')
        .first()
      await wheelScrolls(page, 'sidebar', side)
    })
  })

  test.describe('@1280x420', () => {
    test.use({ viewport: { width: 1280, height: 420 } })
    test('settings', async ({ page, context, harness }) => {
      await openSignedIn(harness, page, context, '/settings/account')
      const pane = page.locator('#main [role="region"], #main .overflow-y-auto').last()
      await wheelScrolls(page, 'settings', pane)
    })
  })

  test.describe('@1280x420', () => {
    test.use({ viewport: { width: 1280, height: 420 } })
    test('schedule list', async ({ page }) => {
      await openSchedules(page, '/schedules')
      const pane = page.locator('#main [role="region"], #main .overflow-y-auto').first()
      await wheelScrolls(page, 'schedules', pane)
    })
  })

  test('inbox', async ({ page, context, harness }) => {
    await openSignedIn(harness, page, context, '/t/inbox')
    inboxItems(harness, 40)
    await expect(page.getByText('Review requested: change 39')).toBeVisible()
    const pane = page.locator('#main [role="region"], #main .overflow-y-auto').first()
    await wheelScrolls(page, 'inbox', pane)
  })
})

/** Home ("Needs you", route /) has no inner scroller: it was built to scroll with the document (pb-28 clears the FAB). */
async function longHome(page: Page, context: Parameters<Harness['seedDevice']>[0], harness: Harness) {
  manyThreads(harness, 30)
  await openSignedIn(harness, page, context, '/')
  for (let i = 0; i < 30; i++) harness.relay.sendToApps(agentReply({ thread: `topic_${i}`, text: `Update ${i}` }))
  const last = page.getByRole('region', { name: 'Needs you' }).getByText('Topic number 0', { exact: true })
  await expect(last).toHaveCount(1)
  // whichever row sorts last in the list is the one the owner must be able to reach
  return page.locator('section[aria-label="Needs you"] li').last()
}
const inView = (_page: Page, loc: ReturnType<Page['locator']>) =>
  loc.evaluate((el) => {
    const b = el.getBoundingClientRect()
    return b.top >= 0 && b.bottom <= innerHeight
  })

test.describe('2a. REGRESSION: Home (Needs you) must still scroll to its last row', () => {
  test.describe('@1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 } })
    test('desktop wheel, 1280x800', async ({ page, context, harness }, info) => {
      test.skip(!isDesktop(info.project.name), 'desktop wheel')
      const lastRow = await longHome(page, context, harness)
      expect(await inView(page, lastRow), 'precondition: the last row starts off screen').toBe(false)
      await page.mouse.move(700, 400)
      for (let i = 0; i < 10; i++) await page.mouse.wheel(0, 600)
      await expect
        .poll(() => inView(page, lastRow), { message: 'last Needs-you row never scrolls into view' })
        .toBe(true)
    })
  })

  test('Pixel touch swipe', async ({ page, context, harness }, info) => {
    test.skip(info.project.name !== 'pixel', 'needs CDP touch')
    const lastRow = await longHome(page, context, harness)
    expect(await inView(page, lastRow), 'precondition: the last row starts off screen').toBe(false)
    const cdp = await context.newCDPSession(page)
    for (let i = 0; i < 6; i++)
      await cdp.send('Input.synthesizeScrollGesture', {
        x: 200,
        y: 500,
        yDistance: -500,
        gestureSourceType: 'touch',
        speed: 3000,
      })
    await expect.poll(() => inView(page, lastRow), { message: 'last Needs-you row never scrolls into view' }).toBe(true)
  })

  test('iPhone: the content below the fold is not clipped away by a locked body', async ({
    page,
    context,
    harness,
  }, info) => {
    test.skip(info.project.name !== 'iphone', 'iPhone')
    await longHome(page, context, harness)
    const m = await page.evaluate(() => {
      const se = document.scrollingElement as HTMLElement
      const sec = document.querySelector('section[aria-label="Needs you"]') as HTMLElement
      let p: HTMLElement | null = sec
      let scroller = false
      while (p) {
        if (/auto|scroll/.test(getComputedStyle(p).overflowY)) scroller = true
        p = p.parentElement
      }
      return {
        bottom: sec.getBoundingClientRect().bottom,
        ih: innerHeight,
        rootScrollable:
          se.scrollHeight > se.clientHeight && getComputedStyle(document.documentElement).overflowY !== 'hidden',
        scroller,
      }
    })
    expect(m.bottom).toBeGreaterThan(m.ih)
    // Either the page scrolls (as before the PR) or Home has its own scroller; with neither, the rows are unreachable.
    expect(
      m.rootScrollable || m.scroller,
      `Home is ${Math.round(m.bottom)}px tall in a ${m.ih}px screen with nothing to scroll it`,
    ).toBe(true)
  })
})

test.describe('2b. phones: inner timeline scrolls by touch, the page does not', () => {
  test('Pixel (Chromium touch gesture via CDP)', async ({ page, context, harness }, info) => {
    test.skip(info.project.name !== 'pixel', 'needs CDP touch')
    await openSignedIn(harness, page, context)
    for (let i = 0; i < 20; i++) harness.relay.sendToApps(agentReply({ text: `Reply ${i}\n\n${'para '.repeat(80)}` }))
    await expect(page.getByText('Reply 19', { exact: true })).toBeVisible()
    const tl = page.getByTestId('timeline')
    const box = await tl.boundingBox()
    if (!box) throw new Error('timeline not laid out')
    const before = await tl.evaluate((el) => el.scrollTop)
    const cdp = await context.newCDPSession(page)
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
      yDistance: 400, // finger moves down = content scrolls up (towards older messages)
      gestureSourceType: 'touch',
      speed: 2000,
    })
    await expect.poll(() => tl.evaluate((el) => el.scrollTop)).toBeLessThan(before)
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
    await expectLocked(page, 'pixel thread')
  })

  test('iPhone (WebKit): timeline is the scroller, document locked', async ({ page, context, harness }, info) => {
    test.skip(info.project.name !== 'iphone', 'iPhone')
    await openSignedIn(harness, page, context)
    for (let i = 0; i < 20; i++) harness.relay.sendToApps(agentReply({ text: `Reply ${i}\n\n${'para '.repeat(80)}` }))
    await expect(page.getByText('Reply 19', { exact: true })).toBeVisible()
    const tl = page.getByTestId('timeline')
    const s = await tl.evaluate((el) => {
      const c = getComputedStyle(el)
      el.scrollTop = 0
      return { oy: c.overflowY, ob: c.overscrollBehaviorY, top: el.scrollTop, max: el.scrollHeight - el.clientHeight }
    })
    expect(s.oy).toBe('auto')
    expect(s.max).toBeGreaterThan(0)
    expect(s.top).toBe(0)
    await expectLocked(page, 'iphone thread')
  })
})

test('Pixel: Schedules pull-to-refresh still fires (touch drag down at the top of the list)', async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== 'pixel', 'needs CDP touch')
  await openSchedules(page, '/schedules')
  const before = await page.evaluate(() => window.__talos.schedules.sentCount.list)
  const cdp = await context.newCDPSession(page)
  await cdp.send('Input.synthesizeScrollGesture', {
    x: 200,
    y: 250,
    yDistance: 300,
    gestureSourceType: 'touch',
    speed: 800,
  })
  await expect.poll(() => page.evaluate(() => window.__talos.schedules.sentCount.list)).toBeGreaterThan(before)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
})

test.describe('2c. pages without #main still scroll when taller than the screen', () => {
  test.describe('@1280x260', () => {
    test.use({ viewport: { width: 1280, height: 260 } })
    test('login page in a short window', async ({ page, harness }, info) => {
      test.skip(!isDesktop(info.project.name), 'desktop wheel')
      await page.goto(`${harness.url}/login`)
      await page.waitForLoadState('networkidle')
      const m = await page.evaluate(() => ({
        sh: document.scrollingElement?.scrollHeight ?? 0,
        ov: getComputedStyle(document.documentElement).overflowY,
        main: Boolean(document.getElementById('main')),
      }))
      expect(m.main).toBe(false)
      expect(m.ov).toBe('visible')
      test.skip(m.sh <= 260, 'login fits')
      await page.mouse.move(640, 130)
      await page.mouse.wheel(0, 400)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    })
  })

  test.describe('@1280x260', () => {
    test.use({ viewport: { width: 1280, height: 260 } })
    test('enroll page in a short window', async ({ page, harness }, info) => {
      test.skip(!isDesktop(info.project.name), 'desktop wheel')
      const { link } = harness.armEnroll()
      await page.goto(link)
      await expect(page.getByRole('heading', { name: 'Set up Talos on this device' })).toBeVisible()
      const m = await page.evaluate(() => ({
        sh: document.scrollingElement?.scrollHeight ?? 0,
        ov: getComputedStyle(document.documentElement).overflowY,
      }))
      expect(m.ov).toBe('visible')
      expect(m.sh).toBeGreaterThan(260)
      await page.mouse.move(640, 130)
      await page.mouse.wheel(0, 400)
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    })
  })
})

test('3. sweep: no abspos element without a positioned ancestor inside a scroller', async ({
  page,
  context,
  harness,
}, info) => {
  manyThreads(harness, 30)
  await openSignedIn(harness, page, context, '/t/inbox')
  inboxItems(harness, 30)
  await expect(page.getByText('Review requested: change 29')).toBeVisible()
  await expectLocked(page, `${info.project.name} /t/inbox`, true)
  for (const r of ['/', '/t/general', '/threads', '/settings', '/settings/integrations']) {
    await page.goto(r)
    await page.waitForLoadState('networkidle')
    await expectLocked(page, `${info.project.name} ${r}`, true)
  }
})
