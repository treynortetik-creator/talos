// gate-reads: apps/mobile/ios/App/App/*.swift
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The web app opens its thread menu from a swipe that starts at the left screen edge. iOS keeps that strip for its own
// "swipe back" when a WKWebView turns it on. Capacitor leaves it off, so the shell must never turn it on.
const SRC = fileURLToPath(new URL('../ios/App/App/', import.meta.url)) // not .pathname: that keeps %20 and, on Windows, a /C:

describe('iOS shell keeps the left edge for the web app', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.swift'))
  it('has Swift sources to check', () => expect(files.length).toBeGreaterThan(0))
  it('never enables the WKWebView back/forward swipe', () => {
    for (const f of files) {
      const text = readFileSync(join(SRC, f), 'utf8')
      expect(text, f).not.toMatch(/allowsBackForwardNavigationGestures\s*=\s*true/)
    }
  })
})
