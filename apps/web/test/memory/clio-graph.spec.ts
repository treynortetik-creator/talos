// The Clio graph in a real browser (fake mode: the made-up notes in lib/fakeV2.ts). From Clio, Graph opens the 3D view of
// the notes and their links; it says how many it shows, draws into a canvas, and Back returns to Clio. The 3D library loads
// only here. The graph fills the content area, zooms with the wheel, and a chosen note slides a panel in from the right.
import { expect, type Page, test } from '@playwright/test'

type Hooks = {
  __clioGraphCamera?: () => number
  __clioGraphNodeScreen?: (i: number) => { x: number; y: number } | null
}

async function openGraph(page: Page) {
  await page.goto('/memory/graph')
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => (window as Hooks).__clioGraphCamera !== undefined)).toBe(true)
}

/** Where a note is on screen once the layout has settled and the first fit is done (three reads in a row agree). */
async function settledNode(page: Page, i: number) {
  const seen: string[] = []
  await expect
    .poll(
      async () => {
        const p = await page.evaluate((k) => (window as Hooks).__clioGraphNodeScreen?.(k) ?? null, i)
        seen.push(JSON.stringify(p && { x: Math.round(p.x), y: Math.round(p.y) }))
        const last = seen.slice(-3)
        return p !== null && last.length === 3 && last.every((v) => v === last[0])
      },
      { timeout: 20_000, intervals: [300] },
    )
    .toBe(true)
  return (await page.evaluate((k) => (window as Hooks).__clioGraphNodeScreen?.(k) ?? null, i)) as {
    x: number
    y: number
  }
}

/** A settled note whose spot is the canvas itself (not under the floating title or search), as an owner would click it. */
async function clickableNode(page: Page) {
  const count = await page.evaluate(() => document.querySelectorAll('canvas').length)
  expect(count).toBe(1)
  for (const i of [2, 0, 1, 3, 4, 5, 6, 7]) {
    const at = await settledNode(page, i)
    const tag = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [at.x, at.y])
    if (tag === 'CANVAS') return { i, at }
  }
  throw new Error('no note lies on open canvas')
}

test('Graph opens the notes in 3D, says what it shows, and Back returns to Clio', async ({ page }, info) => {
  await page.goto('/memory')
  await expect(page.getByRole('heading', { level: 1, name: 'Clio' })).toBeVisible()
  await page.getByRole('link', { name: 'Graph' }).click()
  await expect(page).toHaveURL(/\/memory\/graph$/)
  const graph = page.getByTestId('clio-graph')
  await expect(graph.getByRole('heading', { name: 'Clio graph' })).toBeVisible()
  await expect(graph.getByTestId('clio-graph-meta')).toHaveText(/^\d+ notes · \d+ links?$/)
  await expect(graph.locator('canvas')).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: info.outputPath(`clio-graph-${info.project.name}.png`) })
  await graph.getByRole('searchbox', { name: 'Find a note' }).fill('zzzz-nothing')
  await expect(graph.getByText('No note matches.')).toBeVisible()
  await graph.getByRole('link', { name: 'Back to Clio' }).click()
  await expect(page).toHaveURL(/\/memory(\?.*)?$/) // a phone opens on its only folder (?r=)
})

test('the graph fills the content area, with no page scroll and no Pause button', async ({ page }) => {
  await openGraph(page)
  const graph = page.getByTestId('clio-graph')
  const [g, c, main] = await Promise.all([
    graph.boundingBox(),
    graph.locator('canvas').boundingBox(),
    page.locator('#main').boundingBox(),
  ])
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(Math.abs((c?.[k] ?? -99) - (g?.[k] ?? 99))).toBeLessThanOrEqual(2)
  expect(Math.abs((g?.width ?? 0) - (main?.width ?? -99))).toBeLessThanOrEqual(2)
  const room = await page.locator('#main').evaluate((m) => m.scrollHeight - m.clientHeight)
  expect(room).toBeLessThanOrEqual(0)
  await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Turn' })).toHaveCount(0)
})

test('the wheel zooms the graph', async ({ page }, info) => {
  test.skip(info.project.name.startsWith('iphone') || info.project.name === 'pixel', 'a wheel is a desktop input')
  await openGraph(page)
  await page.waitForTimeout(1500) // the first framing of the graph
  const box = await page.getByTestId('clio-graph').locator('canvas').boundingBox()
  await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, (box?.y ?? 0) + (box?.height ?? 0) / 2)
  const before = await page.evaluate(() => (window as Hooks).__clioGraphCamera?.() ?? 0)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(500)
  const after = await page.evaluate(() => (window as Hooks).__clioGraphCamera?.() ?? 0)
  expect(before).toBeGreaterThan(0)
  expect(after).toBeLessThan(before)
})

test('choosing a note slides its panel in beside a live graph, links browse inside it, and Escape closes it', async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }) // no turn, no camera glide: the note holds still to be clicked
  await openGraph(page)
  const panel = page.getByRole('complementary', { name: 'Chosen note' })
  await expect(panel).not.toBeInViewport()
  const { i, at } = await clickableNode(page)
  // a mouse comes to rest on the note before it clicks: the graph picks the note it is over on the next frame
  await page.mouse.move(at.x, at.y, { steps: 4 })
  await page.waitForTimeout(150)
  await page.mouse.click(at.x, at.y)
  await expect(panel).toBeInViewport()
  await expect(panel.getByRole('heading', { level: 2 })).not.toBeEmpty()
  const canvas = page.getByTestId('clio-graph').locator('canvas')
  await expect(canvas).toBeVisible()
  if (!info.project.name.match(/iphone|pixel/)) {
    // a wide screen shares it: the graph narrows to the panel's edge, nothing of it is under the panel
    await expect
      .poll(async () => {
        const c = await canvas.boundingBox()
        const p = await panel.boundingBox()
        return c && p ? Math.round(p.x - (c.x + c.width)) : null
      })
      .toBe(0)
  }
  await page.waitForTimeout(400)
  await page.screenshot({ path: info.outputPath(`clio-graph-panel-${info.project.name}.png`) })
  if (i === 2) {
    // fake notes sort as ideas, plan, todo; Todo links to Ideas: the link opens Ideas in the panel, Back returns to Todo
    await expect(panel.getByText('Buy groceries', { exact: false })).toBeVisible()
    await panel.getByRole('link', { name: 'ideas' }).click()
    await expect(panel.getByRole('heading', { level: 2 })).not.toHaveText(/Todo/)
    await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(panel.getByRole('heading', { level: 2, name: 'Todo' })).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(panel).not.toBeInViewport()
})
