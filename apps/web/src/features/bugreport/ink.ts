// The annotation model for the bug reporter: a list of marks over the screenshot, drawn onto a canvas. Pure and small so the
// picture that is sent is exactly the picture that was drawn: `render` is the only drawing code, used by the screen and by
// the export alike. Blur is real: the region of the picture is pixelated in what gets exported, not covered by a CSS filter.

export const TOOLS = ['pen', 'arrow', 'box', 'text', 'blur'] as const
export type Tool = (typeof TOOLS)[number]
/** The three ink colours, as tokens (resolved when drawing). Amber is the first and the default. */
export const INK_TOKENS = ['--ink-1', '--ink-2', '--ink-3'] as const
export type Pt = { x: number; y: number }

export type Mark =
  | { kind: 'pen'; ink: number; pts: Pt[] }
  | { kind: 'arrow'; ink: number; from: Pt; to: Pt }
  | { kind: 'box'; ink: number; from: Pt; to: Pt }
  | { kind: 'text'; ink: number; at: Pt; text: string }
  | { kind: 'blur'; from: Pt; to: Pt }

/** How big a pixelated block is in the exported picture, in picture pixels (10 screen pixels on a 2x display: big text stays unreadable). */
export const BLUR_BLOCK = 20
const STROKE = 4

export const rectOf = (a: Pt, b: Pt) => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  w: Math.abs(a.x - b.x),
  h: Math.abs(a.y - b.y),
})

/** Pixelates `r` of the picture already on `ctx`: the area is shrunk to blocks and drawn back up without smoothing. */
export function pixelate(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }): void {
  const x = Math.max(0, Math.floor(r.x))
  const y = Math.max(0, Math.floor(r.y))
  const w = Math.min(ctx.canvas.width - x, Math.ceil(r.w))
  const h = Math.min(ctx.canvas.height - y, Math.ceil(r.h))
  if (w < 1 || h < 1) return
  const img = ctx.getImageData(x, y, w, h)
  const d = img.data
  for (let by = 0; by < h; by += BLUR_BLOCK) {
    for (let bx = 0; bx < w; bx += BLUR_BLOCK) {
      const bw = Math.min(BLUR_BLOCK, w - bx)
      const bh = Math.min(BLUR_BLOCK, h - by)
      let r0 = 0
      let g0 = 0
      let b0 = 0
      let a0 = 0
      for (let j = 0; j < bh; j++)
        for (let i = 0; i < bw; i++) {
          const k = ((by + j) * w + bx + i) * 4
          r0 += d[k] as number
          g0 += d[k + 1] as number
          b0 += d[k + 2] as number
          a0 += d[k + 3] as number
        }
      const n = bw * bh
      for (let j = 0; j < bh; j++)
        for (let i = 0; i < bw; i++) {
          const k = ((by + j) * w + bx + i) * 4
          d[k] = Math.round(r0 / n)
          d[k + 1] = Math.round(g0 / n)
          d[k + 2] = Math.round(b0 / n)
          d[k + 3] = Math.round(a0 / n)
        }
    }
  }
  ctx.putImageData(img, x, y)
}

export function inkColour(ink: number, style: CSSStyleDeclaration | null = null): string {
  const token = INK_TOKENS[ink] ?? INK_TOKENS[0]
  const s = style ?? (typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null)
  return s?.getPropertyValue(token).trim() || 'currentColor'
}

function arrowHead(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, size: number) {
  const a = Math.atan2(to.y - from.y, to.x - from.x)
  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(a - Math.PI / 6), to.y - size * Math.sin(a - Math.PI / 6))
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - size * Math.cos(a + Math.PI / 6), to.y - size * Math.sin(a + Math.PI / 6))
  ctx.stroke()
}

/**
 * Draws the picture and then every mark in order. Blurs act on whatever is under them at that point (the picture and the marks
 * drawn before), so a blur placed over a mark hides it too.
 */
export function render(
  ctx: CanvasRenderingContext2D,
  picture: CanvasImageSource | null,
  marks: readonly Mark[],
  scale = 1,
  colour: (ink: number) => string = (i) => inkColour(i),
): void {
  const { width, height } = ctx.canvas
  ctx.clearRect(0, 0, width, height)
  if (picture) ctx.drawImage(picture, 0, 0, width, height)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const m of marks) {
    if (m.kind === 'blur') {
      const r = rectOf(m.from, m.to)
      pixelate(ctx, { x: r.x * scale, y: r.y * scale, w: r.w * scale, h: r.h * scale })
      continue
    }
    ctx.strokeStyle = colour(m.ink)
    ctx.fillStyle = colour(m.ink)
    ctx.lineWidth = STROKE * scale
    if (m.kind === 'pen') {
      ctx.beginPath()
      for (const [i, p] of m.pts.entries()) {
        if (i === 0) ctx.moveTo(p.x * scale, p.y * scale)
        else ctx.lineTo(p.x * scale, p.y * scale)
      }
      ctx.stroke()
    } else if (m.kind === 'arrow') {
      ctx.beginPath()
      ctx.moveTo(m.from.x * scale, m.from.y * scale)
      ctx.lineTo(m.to.x * scale, m.to.y * scale)
      ctx.stroke()
      arrowHead(ctx, { x: m.from.x * scale, y: m.from.y * scale }, { x: m.to.x * scale, y: m.to.y * scale }, 18 * scale)
    } else if (m.kind === 'box') {
      const r = rectOf(m.from, m.to)
      ctx.strokeRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale)
    } else {
      ctx.font = `600 ${22 * scale}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(m.text, m.at.x * scale, m.at.y * scale)
    }
  }
}

/** A mark worth keeping: a click without a drag leaves nothing behind. */
export function worthKeeping(m: Mark): boolean {
  if (m.kind === 'pen') return m.pts.length > 1
  if (m.kind === 'text') return m.text.trim() !== ''
  const r = rectOf(m.from, m.to)
  return r.w > 3 || r.h > 3
}

export type PictureBlob = { blob: Blob; type: 'image/png' | 'image/jpeg' }
