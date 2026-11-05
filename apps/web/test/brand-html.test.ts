// VITE_BRAND picks the brand at build time. main.tsx sets data-brand from it at start-up; index.html must carry the same
// brand before any script runs, so the first paint, the icons and the stylesheet blocks agree.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brandHtml, brandName } from '../vite.brand.ts'

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
const dockerfile = readFileSync(join(import.meta.dirname, '..', '..', 'relay', 'Dockerfile'), 'utf8')
const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.tsx'), 'utf8')

describe('brand in index.html', () => {
  it('the source page is the talos brand', () => {
    expect(html).toContain('data-brand="talos"')
  })
  it('a build with VITE_BRAND=acme writes acme into the attribute and the brand asset paths', () => {
    const out = brandHtml(html, 'acme')
    expect(out).toContain('data-brand="acme"')
    expect(out).toContain('/brand/acme/favicon.ico')
    expect(out).toContain('/brand/acme/apple-touch-icon.png')
    expect(out).not.toContain('data-brand="talos"')
    expect(out).not.toContain('/brand/talos/')
  })
  it('no VITE_BRAND, an empty one or "talos" leaves the page as it is', () => {
    for (const b of [undefined, '', 'talos']) expect(brandHtml(html, b)).toBe(html)
  })
  it('a name that is not a plain lowercase word is refused, not written into the page', () => {
    for (const bad of ['"><script>', 'A cme', '../x', 'a'.repeat(40)]) expect(() => brandName(bad)).toThrow()
  })
  it('main.tsx treats an empty VITE_BRAND as talos too', () => {
    expect(main).toMatch(/VITE_BRAND \|\| 'talos'/)
  })
  it('the relay image build passes VITE_BRAND to the web build, and only when it is set', () => {
    expect(dockerfile).toMatch(/ARG VITE_BRAND/)
    expect(dockerfile).toMatch(/\$\{VITE_BRAND:\+VITE_BRAND="\$VITE_BRAND"\}/)
  })
})
