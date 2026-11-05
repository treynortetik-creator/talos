import { expect, test } from '../helpers/fixtures.ts'
import { agentReply, openSignedIn } from '../helpers/util.ts'

// Audit D34: task lists and math render instead of printing raw. Math is MathML from Temml, loaded the first time a formula
// is shown (its own chunk), so a thread without maths never fetches it.
const TASKS = ['- [x] book the room', '- [ ] send the invite', '- plain item'].join('\n')
const MATH = ['Area is $\\pi r^2$ here, and it costs $5 and $10.', '', '$$\\frac{a}{b} = \\sqrt{2}$$'].join('\n')

test('a task list shows glyphs and text, with no checkbox and no raw brackets', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: TASKS }))
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg.locator('li')).toHaveCount(3)
  await expect(msg.locator('li').nth(0)).toHaveText('\u2611 book the room')
  await expect(msg.locator('li').nth(1)).toHaveText('\u2610 send the invite')
  await expect(msg.locator('li').nth(2)).toHaveText('plain item')
  await expect(msg.locator('input')).toHaveCount(0)
  await expect(msg).not.toContainText('[ ]')
  await expect(msg).not.toContainText('[x]')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

for (const scheme of ['light', 'dark'] as const) {
  test(`maths draws as MathML, lazily, with money left alone (${scheme})`, async ({ page, context, harness }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const chunks: string[] = []
    page.on('request', (r) => {
      if (/temml/i.test(r.url())) chunks.push(r.url())
    })
    await openSignedIn(harness, page, context)
    // a plain message first: Temml is not fetched for it
    harness.relay.sendToApps(agentReply({ text: 'No maths here, just $5.' }))
    await expect(page.getByTestId('msg-agent').first()).toContainText('just $5.')
    expect(chunks).toEqual([])

    harness.relay.sendToApps(agentReply({ text: MATH }))
    const msg = page.getByTestId('msg-agent').nth(1)
    await expect(msg.locator('math')).toHaveCount(2)
    expect(chunks.length).toBeGreaterThan(0)
    await expect(msg.locator('math[display="block"] mfrac')).toHaveCount(1)
    await expect(msg).toContainText('costs $5 and $10.')
    await expect(msg).not.toContainText('\\frac')
    // it is drawn, not an empty box: the browser gave the formula a real size
    for (const m of await msg.locator('math').all()) {
      const box = (await m.boundingBox()) as { width: number; height: number }
      expect(box.width).toBeGreaterThan(8)
      expect(box.height).toBeGreaterThan(8)
    }
    await expect(msg.locator('math [style], math[style]')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}

test('hostile TeX stays inert end to end', async ({ page, context, harness }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { __opened: unknown[] }).__opened = []
    window.open = ((...a: unknown[]) => {
      ;(window as unknown as { __opened: unknown[] }).__opened.push(a)
      return null
    }) as typeof window.open
  })
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(
    agentReply({
      text: [
        '$\\href{javascript:window.__xss=1}{x}$',
        '$\\includegraphics{https://evil.example/a.png}$',
        '$\\htmlStyle{color:red}{y}$',
      ].join('\n\n'),
    }),
  )
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg).toContainText('htmlStyle')
  await expect(msg.locator('a, img, script, iframe, [style], [href]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  expect(await page.evaluate(() => (window as unknown as { __opened: unknown[] }).__opened.length)).toBe(0)
})

// Review findings on D34, measured in the real engines (WebKit = iPhone and the Mac app; Chromium = Pixel and desktop).
const WIDE = Array.from({ length: 40 }, (_, i) => `x_{${i}}^{2}`).join(' + ')

test('a formula wider than the phone scrolls inside its own box, display or inline, and never pans the timeline', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(agentReply({ text: `Inline $${WIDE}$ then\n\n$$${WIDE}$$\n\nend` }))
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg.locator('math')).toHaveCount(2)
  const vw = (page.viewportSize() as { width: number }).width
  for (const box of await msg.locator('.md-math').all()) {
    const b = (await box.boundingBox()) as { x: number; width: number }
    expect(b.width, 'the box stays inside the screen').toBeLessThanOrEqual(vw)
    // the formula is wider than its box, so the box is what scrolls
    expect(await box.evaluate((e) => e.scrollWidth > e.clientWidth + 20)).toBe(true)
    expect(await box.evaluate((e) => getComputedStyle(e).overflowX)).toBe('auto')
  }
  // no ancestor (the timeline included) grew sideways because of it
  const grown = await msg.evaluate((e) => {
    const out: string[] = []
    for (let n: Element | null = e; n; n = n.parentElement) if (n.scrollWidth > n.clientWidth + 1) out.push(n.tagName)
    return out
  })
  expect(grown).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('aligned columns line up and \\boxed, \\overline and \\hline keep what they draw', async ({
  page,
  context,
  harness,
}) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(
    agentReply({
      text: [
        '$$\\begin{aligned}a &= b \\\\ cccccc &= dddd\\end{aligned}$$',
        '$\\boxed{x}$ and $\\overline{yyyy}$',
        '$$\\begin{array}{c|c}a&b\\\\\\hline c&d\\end{array}$$',
      ].join('\n\n'),
    }),
  )
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg.locator('math')).toHaveCount(4)
  // both `=` sit at the same x: the left column is right-aligned and the right one left-aligned
  const eq = await msg
    .locator('mtable.tml-jot mtd:nth-child(2) mo')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
  expect(eq).toHaveLength(2)
  expect(Math.abs((eq[0] as number) - (eq[1] as number))).toBeLessThanOrEqual(1)
  // the glyphs themselves, not the cells: `a` and `cccccc` end at the same x (right-aligned column)
  const lhs = await msg
    .locator('mtable.tml-jot mtd:nth-child(1)')
    .evaluateAll((cells) =>
      cells.map((c) => Math.round((c.querySelector('mi:last-of-type') as Element).getBoundingClientRect().right)),
    )
  expect(lhs).toHaveLength(2)
  expect(Math.abs((lhs[0] as number) - (lhs[1] as number))).toBeLessThanOrEqual(1)
  // \boxed has its border, \overline has its rule, \hline has its row border
  expect(
    await msg
      .locator('mrow[style*="border"]')
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth)),
  ).toBeGreaterThan(0)
  expect(
    await msg.locator('menclose.tml-overline').evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth)),
  ).toBeGreaterThan(0)
  expect(
    await msg
      .locator('mtd[style*="border-bottom"]')
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).borderBottomWidth)),
  ).toBeGreaterThan(0)
})

test('TeX that asks to be drawn far outside its message cannot', async ({ page, context, harness }) => {
  await openSignedIn(harness, page, context)
  harness.relay.sendToApps(
    agentReply({
      text: '$\\raisebox{-300em}{PAINTED}$ and $\\rule[-300em]{1em}{1em}$ and $\\raisebox{300em}{UP}$',
    }),
  )
  const msg = page.getByTestId('msg-agent').first()
  await expect(msg.locator('math')).not.toHaveCount(0)
  const m = (await msg.boundingBox()) as { y: number; height: number }
  // 20em is the most a formula may ask for (about 400px); before the fix one asked for 5000px
  expect(m.height).toBeLessThan(600)
  for (const box of await msg.locator('.md-math').all()) {
    const b = (await box.boundingBox()) as { y: number; height: number }
    expect(b.height).toBeLessThan(600)
    expect(b.y + b.height).toBeLessThan(m.y + m.height + 100)
  }
  // nothing inside the boxes reaches past them (overflow is clipped, and the asks were dropped)
  const far = await msg
    .locator('.md-math *')
    .evaluateAll(
      (els) =>
        els.filter(
          (e) =>
            Math.abs(e.getBoundingClientRect().top - (e.closest('.md-math') as Element).getBoundingClientRect().top) >
            600,
        ).length,
    )
  expect(far).toBe(0)
})
