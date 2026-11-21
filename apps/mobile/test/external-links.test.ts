// A link to another site opens OUTSIDE Talos on the iPhone (the owner, 2026-11-20: a Google Docs link started a Google sign-in
// inside Talos). The shell used to present SFSafariViewController, an in-app browser with no Safari sign-ins that also keeps a
// Drive or Docs link out of its app. Now every non-relay web link goes through UIApplication.shared.open, so the system picks:
// the Drive or Docs app for their links, Safari for the rest. The relay's own /media/ pages keep their in-app viewer.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ios = (p: string) => readFileSync(join(__dirname, '..', 'ios', 'App', 'App', p), 'utf8')
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

describe('external links leave the app through the system', () => {
  const controller = code(ios('TalosBridgeViewController.swift'))
  const gate = code(ios('WebViewGuards.swift'))

  it('the shell presents no in-app browser for a link', () => {
    expect(controller).not.toMatch(/SFSafariViewController\(/)
  })

  it('openOutside hands http(s) links to UIApplication.shared.open, and nothing else', () => {
    const fn = controller.slice(controller.indexOf('func openOutside('))
    expect(fn.slice(0, 400)).toMatch(/scheme == "http" \|\| scheme == "https"/)
    expect(fn.slice(0, 400)).toMatch(/openURL\(url\)/)
    expect(controller).toMatch(/var openURL: \(URL\) -> Void = \{ UIApplication\.shared\.open\(\$0/)
  })

  it('the navigation gate routes every non-relay link, in-page or new window, to openOutside; relay media to the viewer', () => {
    expect(gate).toMatch(/if guardian\.isRelayMedia\(url\) \{ showMedia\(url\) \} else \{ openOutside\(url\) \}/)
    // a new window (window.open, target=_blank) never becomes a web view in the app
    const popup = gate.slice(gate.indexOf('createWebViewWith configuration'))
    expect(popup.slice(0, 900)).toMatch(/return nil/)
  })
})
