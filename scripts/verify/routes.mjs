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
  nyx: {
    name: 'nyx',
    path: '/memory',
    proves: 'the Nyx screen draws with its address field and Connect button',
    ready: async (page) => {
      await page.getByRole('button', { name: 'Connect' }).waitFor({ state: 'visible', timeout: 20_000 })
    },
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
