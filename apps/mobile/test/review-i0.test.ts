// Regression tests for the iOS shell. Source-level checks: the Swift side needs a simulator to run.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildConfig } from '../capacitor.config'
import { swiftBody, withoutComments } from './swift-source'

const ROOT = new URL('..', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, ROOT), 'utf8')
const gate = () => {
  const src = withoutComments(read('ios/App/App/TalosBridgeViewController.swift'))
  const start = src.indexOf('final class NavigationGate')
  expect(start, 'NavigationGate exists').toBeGreaterThan(-1)
  return src.slice(start)
}

describe('I14: native paths the bridge wrapper does not cover', () => {
  // Capacitor 8.5.3 WebViewDelegationHandler.swift:271-305 answers prompt() payloads {"type":"CapacitorCookies.get"},
  // {"type":"CapacitorCookies.set","domain":…,"action":"<Set-Cookie>"} natively, for ANY frame, with no plugin-enabled
  // check. NavigationGate forwards that selector untouched (forwardingTarget), so it bypasses GuardedMessageHandler.
  it('NavigationGate answers the prompt() side channel itself: only the trusted frame reaches Capacitor, every other frame gets the cancelled answer', () => {
    const src = gate()
    const body = swiftBody(src, 'runJavaScriptTextInputPanelWithPrompt prompt')
    expect(body).toMatch(
      /guard promptChannelAllowed\(frame, webView\),[^\n]*else \{ return completionHandler\(nil\) \}/,
    )
    // the forward to Capacitor comes only after that guard
    expect(body.indexOf('guard promptChannelAllowed')).toBeGreaterThan(-1)
    expect(body.indexOf('guard promptChannelAllowed')).toBeLessThan(body.indexOf('ui.webView?('))
    // and the decision is the same one the bridge uses (BridgeGuard, covered by WebViewDecisionTests)
    expect(swiftBody(src, 'func promptChannelAllowed')).toMatch(/guardian\.allowsPromptChannel\(/)
  })

  // Capacitor 8.5.3 WebViewDelegationHandler.swift:50-58 grants camera/mic capture to every origin and frame
  // (decisionHandler(.grant)). This PR adds NSMicrophoneUsageDescription, which arms that grant.
  it('NavigationGate decides media-capture and motion permission itself and never hands it to Capacitor', () => {
    const src = gate()
    for (const marker of ['requestMediaCapturePermissionFor', 'requestDeviceOrientationAndMotionPermissionFor']) {
      const body = swiftBody(src, marker)
      expect(body, marker).toMatch(
        /decisionHandler\(devicePermission\(frame, webView\) == \.grant \? \.grant : \.deny\)/,
      )
      expect(body, marker).not.toMatch(/inner|\bui\b/)
    }
    expect(swiftBody(src, 'func devicePermission')).toMatch(/guardian\.devicePermission\(/)
  })

  // createWebViewWith hands any non-http(s) URL from any frame to UIApplication.shared.open (app-scheme launcher).
  it('window.open of a non-http(s) URL is not passed to UIApplication.open unless it is mailto: from the main frame', () => {
    const src = gate()
    const body = src.slice(src.indexOf('createWebViewWith'))
    const opensBlind = /else\s*\{\s*UIApplication\.shared\.open\(url/.test(body)
    expect(opensBlind, 'unconditional UIApplication.shared.open in createWebViewWith').toBe(false)
  })
})

describe('Info.plist covers what the web app actually uses', () => {
  // apps/web/src/features/composer/Composer.tsx:501 has <input type="file" accept="image/*" capture="environment">.
  // In a WKWebView that opens the camera; without NSCameraUsageDescription iOS terminates the app.
  it('declares NSCameraUsageDescription (composer "Take photo")', () => {
    expect(read('ios/App/project.yml')).toMatch(/NSCameraUsageDescription/)
    expect(read('ios/App/App/Info.plist')).toMatch(/<key>NSCameraUsageDescription<\/key>/)
  })

  it('declares no URL scheme (I0 reviewer test: CFBundleURLTypes)', () => {
    expect(read('ios/App/App/Info.plist')).not.toMatch(/CFBundleURLTypes/)
    expect(read('ios/App/project.yml')).not.toMatch(/CFBundleURLTypes/)
  })

  it('has no ATS exception', () => {
    const plist = read('ios/App/App/Info.plist')
    expect(plist).not.toMatch(/NSAllowsArbitraryLoads|NSExceptionDomains|NSAllowsArbitraryLoadsInWebContent/)
  })
})

describe('WP-I0 acceptance (IOS-SPEC rev 2, 8 WP-I0 and I4)', () => {
  it('never emits cleartext: true', () => {
    expect(buildConfig({ TALOS_RELAY_URL: 'http://localhost:8787' }).server?.cleartext).not.toBe(true)
  })

  // KNOWN BUG, reported with the cleanup: relayOrigin accepts a wildcard host, so TALOS_RELAY_URL=https://* builds
  // allowNavigation ["*"]. It is owner-set at build time, so a typo rather than an attack. `it.fails` keeps this green while
  // the bug stands and turns red when it is fixed: then drop `.fails`.
  it.fails('refuses a wildcard host in TALOS_RELAY_URL', () => {
    expect(() => buildConfig({ TALOS_RELAY_URL: 'https://*' })).toThrow()
    expect(buildConfig({ TALOS_RELAY_URL: 'https://relay.example.test' }).server?.allowNavigation).not.toContain('*')
  })
})
