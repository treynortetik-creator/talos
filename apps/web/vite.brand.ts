// The brand a build is for (VITE_BRAND, default talos), written into index.html so the page matches what main.tsx sets
// at start-up. Only a plain lowercase word is accepted, so the value cannot add markup to the page.
import type { Plugin } from 'vite'

const NAME = /^[a-z][a-z0-9-]{0,31}$/

export function brandName(raw: string | undefined): string {
  const name = raw || 'talos'
  if (!NAME.test(name)) throw new Error('VITE_BRAND must be lowercase letters, digits and dashes (up to 32)')
  return name
}

export function brandHtml(html: string, raw: string | undefined): string {
  const brand = brandName(raw)
  if (brand === 'talos') return html
  return html.replace('data-brand="talos"', `data-brand="${brand}"`).replaceAll('/brand/talos/', `/brand/${brand}/`)
}

export function brandPlugin(raw: string | undefined): Plugin {
  brandName(raw)
  return { name: 'talos-brand-html', transformIndexHtml: (html) => brandHtml(html, raw) }
}
