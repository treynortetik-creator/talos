// The Report a bug specs on WebKit, as a real iPhone runs them. WebKit on iOS (Safari, the iPhone app, the Mac app) marks a
// canvas that drew an SVG <foreignObject> page unreadable, so the reporter's probe (capture.ts canReadBackPage) finds no
// read-back and copies nothing. Playwright's WebKit build on Linux CAN read such a canvas back (Titan, 2026-11-19), so the
// iphone project ran the whole page copy that no iPhone ever runs, and timed out on it under load. On WebKit this makes a
// canvas that drew an SVG image refuse to be read, as iOS does; every other engine is left as it is (Chromium reads back,
// and the long-copy cases run there: capture-give-up.spec.ts).
import { type BrowserContext, test as base } from '@playwright/test'

export async function iosReadBack(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const tainted = new WeakSet<HTMLCanvasElement>()
    const isSvg = (img: unknown) =>
      img instanceof HTMLImageElement && /^data:image\/svg\+xml/.test(img.currentSrc || img.src || '')
    const proto = CanvasRenderingContext2D.prototype
    const draw = proto.drawImage
    proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if (isSvg(args[0])) tainted.add(this.canvas)
      return (draw as (...a: unknown[]) => void).apply(this, args)
    } as typeof proto.drawImage
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    const read = proto.getImageData
    proto.getImageData = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof read>) {
      if (tainted.has(this.canvas)) refuse()
      return read.apply(this, args)
    }
    const url = HTMLCanvasElement.prototype.toDataURL
    HTMLCanvasElement.prototype.toDataURL = function (this: HTMLCanvasElement, ...args: Parameters<typeof url>) {
      if (tainted.has(this)) refuse()
      return url.apply(this, args)
    }
    const blob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<typeof blob>) {
      if (tainted.has(this)) refuse()
      return blob.apply(this, args)
    }
  })
}

/** `test` for the Report a bug specs: on WebKit every context reads back as an iPhone does. */
export const test = base.extend<{ iosCanvas: void }>({
  iosCanvas: [
    async ({ context, browserName }, use) => {
      if (browserName === 'webkit') await iosReadBack(context)
      await use()
    },
    { auto: true },
  ],
})
