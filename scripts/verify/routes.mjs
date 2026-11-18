// The routes capture.mjs knows by name. A route is {name, path, proves, ready(page), act?(page), expect?(facts)}:
//   path    where the fake-mode app is opened (the app is served from a production build with VITE_FAKE=1)
//   ready   waits for the screen to be really drawn (never a bare sleep)
//   act     what the owner does on that screen before the picture (a click, a keystroke); act(page, {touch}) with touch true at phone width
//   expect  looks at the facts the page measured and returns a list of problems (empty = the claim holds)
// Add a route here when a change reaches a screen no route covers, then run it before AND after the change.

/** Runs in the page: every font and colour fact the theme step needs. Colours are normalised to sRGB through a canvas, because
 *  the stylesheet's own colours (oklch and the like) come back from getComputedStyle in their own space. */
export function measureInPage() {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const rgba = (css) => {
    ctx.clearRect(0, 0, 1, 1)
    ctx.fillStyle = '#000'
    ctx.fillStyle = css
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    return `rgba(${d[0]}, ${d[1]}, ${d[2]}, ${(d[3] / 255).toFixed(3)})`
  }
  const visible = (sel) => [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0)
  const bgOf = (el) => {
    // composite the backgrounds from the page down to the element
    const chain = []
    for (let e = el; e; e = e.parentElement) chain.unshift(getComputedStyle(e).backgroundColor)
    let [r, g, b] = [255, 255, 255]
    for (const css of chain) {
      const m = /rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(rgba(css))
      if (!m) continue
      const a = Number(m[4])
      r = Number(m[1]) * a + r * (1 - a)
      g = Number(m[2]) * a + g * (1 - a)
      b = Number(m[3]) * a + b * (1 - a)
    }
    return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, 1)`
  }
  const targets = {
    body: document.body,
    wordmark: visible('.wordmark'),
    heading: visible('h1, h2, h3'),
    mono: visible('code, pre, kbd'),
  }
  const fonts = {}
  const samples = []
  for (const [name, el] of Object.entries(targets)) {
    if (!el) continue
    const cs = getComputedStyle(el)
    fonts[name] = `${cs.fontFamily} | weight ${cs.fontWeight}`
    if (name !== 'mono')
      samples.push({
        label: name,
        fg: rgba(cs.color),
        bg: bgOf(el),
        px: Number.parseFloat(cs.fontSize),
        weight: cs.fontWeight,
      })
  }
  const second = visible('.text-text-2')
  if (second) {
    const cs = getComputedStyle(second)
    samples.push({
      label: 'secondary-text',
      fg: rgba(cs.color),
      bg: bgOf(second),
      px: Number.parseFloat(cs.fontSize),
      weight: cs.fontWeight,
    })
  }
  return { fonts, samples, dataTheme: document.documentElement.dataset.theme ?? null }
}

const shellReady = async (page) => {
  await page.getByLabel('Message', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
}

export const ROUTES = {
  home: {
    name: 'home',
    path: '/t/general',
    proves: 'the thread screen draws with its seeded message, in this theme',
    ready: shellReady,
  },
  wordmark: {
    name: 'wordmark',
    path: '/t/general',
    proves: 'the TALOS wordmark is Cinzel at weight 900 (a theme changes colours only)',
    ready: async (page) => {
      await shellReady(page)
      await page.locator('.wordmark').first().waitFor({ state: 'attached', timeout: 20_000 })
      await page.evaluate(() => document.fonts.ready)
    },
    expect: (facts) => {
      const w = facts.fonts?.wordmark ?? ''
      return /Cinzel/.test(w) && /weight 900/.test(w)
        ? []
        : [`wordmark is not Cinzel Black: ${w || '(no wordmark on screen)'}`]
    },
  },
  'settings-appearance': {
    name: 'settings-appearance',
    path: '/settings/appearance',
    proves: 'Settings > Appearance draws with the theme picker, in this theme',
    ready: async (page) => {
      await page.getByRole('radio', { name: 'Dark' }).waitFor({ state: 'visible', timeout: 20_000 })
    },
  },
  'clio-graph': {
    name: 'clio-graph',
    path: '/memory/graph',
    proves: 'the Clio graph opens and draws its canvas',
    reducedMotion: true,
    ready: async (page) => {
      await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(1500) // the layout has to settle before a picture; there is no event for it
    },
  },
  'clio-graph-note': {
    name: 'clio-graph-note',
    path: '/memory/graph',
    proves: 'one click on a note in the graph opens the Chosen note panel',
    reducedMotion: true,
    ready: async (page) => {
      await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForFunction(() => typeof window.__clioGraphNodeScreen === 'function', null, { timeout: 20_000 })
    },
    act: async (page, { touch }) => {
      // A settled note whose spot is the canvas itself (not under the title or search), as an owner would click it: the page's own
      // test hooks give where a note is on screen; the click is a real mouse click at that spot.
      const hit = await page.evaluate(async () => {
        const w = window
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const deadline = Date.now() + 40_000
        const seen = {} // per note: where it was on the last reads; settled = three equal reads in a row
        while (Date.now() < deadline) {
          // an older build has no "fitted" hook: then three equal reads are all there is to go by
          const fitted = typeof w.__clioGraphFitted === 'function' ? w.__clioGraphFitted() === true : true
          for (const i of [2, 0, 1, 3, 4, 5, 6, 7]) {
            const p = w.__clioGraphNodeScreen?.(i)
            if (!p) continue
            const key = `${Math.round(p.x)},${Math.round(p.y)}`
            seen[i] = [...(seen[i] ?? []), key].slice(-3)
            const h = seen[i]
            if (
              fitted &&
              h.length === 3 &&
              h.every((k) => k === key) &&
              document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS'
            )
              return { x: p.x, y: p.y }
          }
          await sleep(300)
        }
        return null
      })
      if (!hit) throw new Error('no settled note on open canvas within 40 s (the graph never settled)')
      // a phone taps with no pointer moving first, and the tap must pick the note under itself
      if (touch) await page.touchscreen.tap(hit.x, hit.y)
      else await page.mouse.click(hit.x, hit.y)
      await page.waitForTimeout(800)
    },
    facts: async (page) => {
      const panel = page.getByRole('complementary', { name: 'Chosen note' })
      const open = await panel.isVisible().catch(() => false)
      const inView = open
        ? await panel.evaluate((el) => {
            const r = el.getBoundingClientRect()
            return r.right > 0 && r.left < window.innerWidth
          })
        : false
      const heading = open
        ? (
            (await panel
              .getByRole('heading', { level: 2 })
              .first()
              .textContent()
              .catch(() => '')) ?? ''
          ).trim()
        : ''
      return { panelOpen: open && inView, panelHeading: heading }
    },
    expect: (facts) => (facts.panelOpen && facts.panelHeading ? [] : ['the click did not open the Chosen note panel']),
  },
}

/** An ad hoc route: --path /x. The screen is "ready" when the page has any text. */
export function adhocRoute(name, path) {
  return {
    name,
    path,
    proves: `${path} draws`,
    ready: async (page) => {
      await page.locator('body *').first().waitFor({ state: 'attached', timeout: 20_000 })
      await page.waitForTimeout(500)
    },
  }
}
