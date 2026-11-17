// The Clio graph in a real browser (fake mode: the made-up notes in lib/fakeV2.ts). From Clio, Graph opens the 3D view of
// the notes and their links; it says how many it shows, draws into a canvas, and Back returns to Clio. The 3D library loads
// only here. The graph fills the content area, zooms with the wheel, and a chosen note slides a panel in from the right.
import { expect, type Page, test } from '@playwright/test'

type Hooks = {
  __clioGraphCamera?: () => number
  __clioGraphNodeScreen?: (i: number) => { x: number; y: number } | null
  __clioGraphPointers?: () => number[]
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
  await settledNode(page, 0) // the layout and its first framing are done: nothing else moves the camera
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
  // no hover first and no wait: a phone taps with no pointer moving before it, and a click must pick the note under itself
  if (info.project.name.startsWith('iphone') || info.project.name === 'pixel') await page.touchscreen.tap(at.x, at.y)
  else await page.mouse.click(at.x, at.y)
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

test('a mouse press released where the graph never heard it does not break the next one', async ({ page }) => {
  // the owner's report (2026-11-16): OrbitControls threw on a release after a press whose release it missed
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await openGraph(page)
  await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    const at = {
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      bubbles: true,
      pointerType: 'mouse',
      isPrimary: true,
    }
    c.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 1, button: 0, buttons: 1 })) // its release never comes
    c.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerId: 2, button: 0, buttons: 1 }))
    c.ownerDocument.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerId: 2, button: 0, buttons: 0 }))
  })
  await page.waitForTimeout(300)
  // synthetic pointers are not real active pointers, so the browser refuses their pointer capture: that is the test's own
  // doing, not the graph's; the crash it guards against was a TypeError reading a pointer's position
  expect(errors.filter((m) => !/^NotFoundError|PointerCapture/.test(m))).toEqual([])
  // (zooming afterwards is not checked here: synthetic pointers make setPointerCapture throw inside OrbitControls' own handler,
  // which no real pointer does; the wheel test above covers zoom)
})

// The owner's second report (2026-11-16 13:48, a build with the fix above): the same OrbitControls release path, reached from
// the graph library's own made-up touch release after a note drag. Each case holds a REAL mouse press on open canvas (so the
// controls really hold a pointer: checked, never vacuous), sends one pointer event the controls never saw go down, then
// releases: no TypeError, and the controls hold nothing afterwards.
async function openCanvasSpot(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement
    const r = c.getBoundingClientRect()
    for (const [fx, fy] of [
      [0.15, 0.85],
      [0.85, 0.85],
      [0.15, 0.5],
      [0.5, 0.9],
    ] as const) {
      const x = r.left + r.width * fx
      const y = r.top + r.height * fy
      if (document.elementFromPoint(x, y) === c) return { x, y }
    }
    return null
  })
}

const STRAYS: { name: string; send: string }[] = [
  {
    name: "the graph's own touch release after a note drag",
    send: "document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }))",
  },
  {
    name: 'a pen release it never saw',
    send: "document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'pen', pointerId: 41 }))",
  },
  {
    name: 'a touch release it never saw',
    send: "canvas.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 42, bubbles: true }))",
  },
  {
    name: 'a cancel of a pointer it never saw',
    send: "canvas.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'touch', pointerId: 43, bubbles: true }))",
  },
  {
    name: 'a move of a pointer it never saw',
    send: "document.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 44, clientX: 5, clientY: 5 }))",
  },
  { name: 'the window losing focus mid-drag', send: "window.dispatchEvent(new Event('blur'))" },
]

for (const stray of STRAYS)
  test(`a held press survives ${stray.name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
    await openGraph(page)
    const spot = await openCanvasSpot(page)
    expect(spot).not.toBeNull()
    if (!spot) return
    await page.mouse.move(spot.x, spot.y)
    await page.mouse.down()
    expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.().length)).toBe(1)
    await page.evaluate((code) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement
      new Function('canvas', code)(canvas)
    }, stray.send)
    await page.mouse.move(spot.x + 30, spot.y - 20)
    await page.mouse.up()
    await page.waitForTimeout(200)
    expect(errors).toEqual([])
    expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.())).toEqual([])
  })

test('a press whose release was missed, then a new press and release, leaves nothing held', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await openGraph(page)
  const spot = await openCanvasSpot(page)
  if (!spot) throw new Error('no open canvas')
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  const held = await page.evaluate(() => (window as Hooks).__clioGraphPointers?.() ?? [])
  expect(held.length).toBe(1)
  // the release is lost (outside the window): the next press of that same mouse arrives while the controls still hold it
  await page.evaluate((id) => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const r = canvas.getBoundingClientRect()
    canvas.dispatchEvent(
      new PointerEvent('pointerdown', {
        pointerId: id,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
        bubbles: true,
        clientX: r.left + 9,
        clientY: r.top + 9,
      }),
    )
    document.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch' }))
  }, held[0])
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.())).toEqual([])
})

test('a second mouse button pressed during a drag, then both released, leaves nothing held', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await openGraph(page)
  const spot = await openCanvasSpot(page)
  if (!spot) throw new Error('no open canvas')
  await page.mouse.move(spot.x, spot.y)
  await page.mouse.down()
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(spot.x + 20, spot.y)
  await page.mouse.up({ button: 'right' })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.())).toEqual([])
})

test('dragging a note throws nothing and leaves nothing held', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  await page.emulateMedia({ reducedMotion: 'reduce' }) // the note holds still to be grabbed
  await openGraph(page)
  const { at } = await clickableNode(page)
  // a note drag: the graph library ends it with its own made-up touch release
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 40, at.y + 25, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.())).toEqual([])
})

test('a press on the open note panel released on the graph, and the other way round, throw nothing', async ({
  page,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
  // a phone's note panel covers the graph, so there is no graph beside it to release on
  test.skip(
    info.project.name.startsWith('iphone') || info.project.name === 'pixel',
    'the panel shares the screen only when wide',
  )
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openGraph(page)
  const { at } = await clickableNode(page)
  await page.mouse.click(at.x, at.y)
  const panel = page.getByRole('complementary', { name: 'Chosen note' })
  await expect(panel).toBeInViewport()
  const box = await panel.boundingBox()
  const spot = await openCanvasSpot(page)
  if (!box || !spot) throw new Error('no panel or no open canvas')
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.down()
  await page.mouse.move(spot.x, spot.y, { steps: 4 })
  await page.mouse.up()
  await page.mouse.down()
  await page.mouse.move(mid.x, mid.y, { steps: 4 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  expect(errors).toEqual([])
  expect(await page.evaluate(() => (window as Hooks).__clioGraphPointers?.())).toEqual([])
})
