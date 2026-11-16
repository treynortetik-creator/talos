// The annotation model: Blur really pixelates the picture it is exported from, other marks do not, and an empty click leaves no mark.
import { describe, expect, it } from 'vitest'
import { BLUR_BLOCK, type Mark, pixelate, render, worthKeeping } from '../../src/features/bugreport/ink.ts'

/** A canvas context over a plain pixel array: enough of the 2D API for the code under test. */
function fakeCtx(w: number, h: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4)
  const ctx = {
    canvas: { width: w, height: h },
    getImageData: (sx: number, sy: number, sw: number, sh: number) => {
      const out = new Uint8ClampedArray(sw * sh * 4)
      for (let y = 0; y < sh; y++)
        out.set(data.subarray(((sy + y) * w + sx) * 4, ((sy + y) * w + sx + sw) * 4), y * sw * 4)
      return { data: out, width: sw, height: sh }
    },
    putImageData: (img: { data: Uint8ClampedArray; width: number; height: number }, dx: number, dy: number) => {
      for (let y = 0; y < img.height; y++)
        data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((dy + y) * w + dx) * 4)
    },
    clearRect: () => {},
    drawImage: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    strokeRect: () => {},
    fillText: () => {},
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, data }
}
const px = (data: Uint8ClampedArray, w: number, x: number, y: number) => [
  ...data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4),
]
// a hard checker: every pixel differs from its neighbour, so any smoothing is visible
const checker = (x: number, y: number): [number, number, number, number] =>
  (x + y) % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]

describe('pixelate', () => {
  it('turns the region into flat blocks of the average colour and leaves the rest untouched', () => {
    const w = 48
    const { ctx, data } = fakeCtx(w, 48, checker)
    pixelate(ctx, { x: 12, y: 12, w: 24, h: 24 })
    // inside: every pixel of one block is the same
    const a = px(data, w, 12, 12)
    expect(px(data, w, 13, 12)).toEqual(a)
    expect(px(data, w, 12, 13)).toEqual(a)
    expect(px(data, w, 12 + BLUR_BLOCK - 1, 12 + BLUR_BLOCK - 1)).toEqual(a)
    // and it is the average, not one of the originals
    expect(a[0]).toBeGreaterThan(100)
    expect(a[0]).toBeLessThan(160)
    // outside: unchanged
    expect(px(data, w, 0, 0)).toEqual([255, 0, 0, 255])
    expect(px(data, w, 1, 0)).toEqual([0, 0, 255, 255])
    expect(px(data, w, 36, 36)).toEqual(checker(36, 36))
  })

  it('stays inside the picture when the region hangs over its edge', () => {
    const { ctx } = fakeCtx(20, 20, checker)
    expect(() => pixelate(ctx, { x: 10, y: 10, w: 100, h: 100 })).not.toThrow()
    expect(() => pixelate(ctx, { x: -5, y: -5, w: 3, h: 3 })).not.toThrow()
  })
})

describe('render', () => {
  it('a blur mark pixelates the picture it covers', () => {
    const { ctx, data } = fakeCtx(48, 48, checker)
    const marks: Mark[] = [{ kind: 'blur', from: { x: 0, y: 0 }, to: { x: 24, y: 24 } }]
    render(ctx, null, marks)
    expect(px(data, 48, 0, 0)).toEqual(px(data, 48, 1, 0))
    expect(px(data, 48, 40, 40)).toEqual(checker(40, 40))
  })
  it('works in picture pixels when the picture is larger than the screen (scale)', () => {
    const { ctx, data } = fakeCtx(48, 48, checker)
    render(ctx, null, [{ kind: 'blur', from: { x: 0, y: 0 }, to: { x: 12, y: 12 } }], 2)
    expect(px(data, 48, 20, 20)).toEqual(px(data, 48, 21, 20))
  })
})

describe('worthKeeping', () => {
  it('drops a click with no drag, a one-point pen stroke and empty text', () => {
    const p = { x: 5, y: 5 }
    expect(worthKeeping({ kind: 'box', ink: 0, from: p, to: p })).toBe(false)
    expect(worthKeeping({ kind: 'blur', from: p, to: { x: 40, y: 40 } })).toBe(true)
    expect(worthKeeping({ kind: 'pen', ink: 0, pts: [p] })).toBe(false)
    expect(worthKeeping({ kind: 'pen', ink: 0, pts: [p, { x: 9, y: 9 }] })).toBe(true)
    expect(worthKeeping({ kind: 'text', ink: 0, at: p, text: '  ' })).toBe(false)
  })
})
