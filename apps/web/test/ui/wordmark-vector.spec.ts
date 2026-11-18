// The TΛLOS wordmark is the committed vector (assets/brand/wordmark/, from Cinzel Black's outlines), drawn as is: the svg
// the app renders, rasterised at 200 px high, matches the committed reference render within anti-aliasing. The compare
// runs in the page (canvas), so it holds on every engine and OS. WORDMARK_REFERENCE_UPDATE=1 rewrites the reference.
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const DIR = new URL('../../../../assets/brand/wordmark/', import.meta.url)
const REF = new URL('wordmark-reference.png', DIR)
const FILE = readFileSync(new URL('wordmark.svg', DIR), 'utf8')
const HEIGHT = 200

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })

test('the sidebar wordmark is the committed vector, at the size of its text', async ({ page }) => {
  await page.goto('/')
  const mark = page.locator('[role=img][aria-label="Talos"]:visible').first()
  await expect(mark).toBeVisible()
  const svg = mark.locator('svg')
  await expect(svg).toHaveAttribute('viewBox', /viewBox="([^"]+)"/.exec(FILE)?.[1] as string)
  const size = await mark.evaluate((el) => {
    const r = (el.querySelector('svg') as SVGSVGElement).getBoundingClientRect()
    return {
      font: Number.parseFloat(getComputedStyle(el).fontSize),
      height: r.height,
      width: r.width,
      clipped: el.scrollWidth > el.clientWidth + 1,
    }
  })
  expect(size.height).toBeCloseTo(size.font * 0.733, 0) // the letters are as big as Cinzel text at this font size
  expect(size.width).toBeCloseTo(size.height * (3734 / 733), 0) // drawn at its own proportions, not squeezed or stretched
  expect(size.clipped).toBe(false) // and the whole of it shows

  // what the app draws: its viewBox and path, read from the page
  const drawn = await svg.evaluate((el) => ({
    viewBox: el.getAttribute('viewBox') as string,
    d: el.querySelector('path')?.getAttribute('d') as string,
    fill: el.querySelector('path')?.getAttribute('fill') as string,
  }))
  expect(drawn.fill).toBe('currentColor')
  const ref = process.env.WORDMARK_REFERENCE_UPDATE ? null : readFileSync(REF).toString('base64')
  const out = await page.evaluate(
    async ({ drawn, ref, height }) => {
      // WebKit draws an svg image blank if it is drawn right on load: decode it and wait a frame first
      const load = async (src: string) => {
        const i = new Image()
        i.src = src
        await i.decode()
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50)))
        return i
      }
      const [, , w, h] = drawn.viewBox.split(' ').map(Number) as number[]
      const width = Math.round(((w as number) / (h as number)) * height)
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${drawn.viewBox}"><path fill="#000" d="${drawn.d}"/></svg>`
      const raster = (img: HTMLImageElement) => {
        const c = document.createElement('canvas')
        c.width = width
        c.height = height
        const x = c.getContext('2d') as CanvasRenderingContext2D
        x.fillStyle = '#fff'
        x.fillRect(0, 0, width, height)
        x.drawImage(img, 0, 0, width, height)
        return { canvas: c, data: x.getImageData(0, 0, width, height).data }
      }
      const mine = raster(await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`))
      if (!ref) return { png: mine.canvas.toDataURL('image/png').slice('data:image/png;base64,'.length) }
      const theirs = raster(await load(`data:image/png;base64,${ref}`))
      let mineInk = 0
      let ink = 0
      let off = 0
      for (let i = 0; i < mine.data.length; i += 4) {
        const a = mine.data[i] as number
        const b = theirs.data[i] as number
        if (a < 128) mineInk++
        if (a < 128 || b < 128) ink++
        if (Math.abs(a - b) > 96) off++ // a pixel that is ink in one and paper in the other, not an edge's grey
      }
      return { ink, mineInk, off, size: [theirs.canvas.width, theirs.canvas.height] }
    },
    { drawn, ref, height: HEIGHT },
  )
  if (out.png) {
    writeFileSync(REF, Buffer.from(out.png, 'base64'))
    test.skip(true, 'reference rewritten')
    return
  }
  const { mineInk = 0, ink = 1, off = ink } = out
  expect(mineInk, "the app's svg drew nothing").toBeGreaterThan(10_000) // the letters are there
  expect(off / ink).toBeLessThan(0.01) // and in the same place, the Λ included
})
