import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildConfig } from '../capacitor.config'
import { swiftBody, withoutComments } from './swift-source'

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const REPO = new URL('../../../', import.meta.url).pathname
const APP = 'ios/App/App'

describe('D3: offline page retry is native', () => {
  const html = read('www/offline.html')
  it('Try again is a talos-retry link, not history.back()', () => {
    expect(html).not.toMatch(/history\.back/)
    expect(html).toMatch(/<a[^>]+href="talos-retry:\/\/now"[^>]*>\s*Try again\s*<\/a>/)
  })
  it('does not use the word relay', () => {
    expect(html.toLowerCase()).not.toContain('relay')
  })
  it('the view controller intercepts the same scheme the page links to, and retries on tap, network return and foreground', () => {
    const swift = read('ios/BridgeGuard/Sources/BridgeGuard/ShellPolicy.swift')
    expect(swift).toContain('retryScheme = "talos-retry"')
    const vc = withoutComments(read(`${APP}/TalosBridgeViewController.swift`))
    // a tap is decided by BridgeGuard.allowsRetry (ShellPolicyTests), acted on, and never loaded
    expect(swiftBody(vc, 'decidePolicyFor navigationAction')).toMatch(
      /if let url = navigationAction\.request\.url, BridgeGuard\.isRetryURL\(url\) \{\s*if guardian\.allowsRetry\(url: url, isMainFrame: navigationAction\.sourceFrame\.isMainFrame, currentURL: webView\.url\) \{\s*retry\(\)\s*\}\s*decisionHandler\(\.cancel\)\s*return/,
    )
    expect(vc).toMatch(/retry: \{ \[weak self\] in self\?\.retryIfNeeded\(tapped: true\) \}/)
    // network return (only a satisfied path) and coming to the front both go through the same retry
    const triggers = swiftBody(vc, 'private func startRetryTriggers')
    // coming to the front: the offline page or a blank view is retried first; the page is then checked either way
    // (WebViewRevival), and brought back only when it is dead or stuck
    expect(triggers).toMatch(
      /UIApplication\.didBecomeActiveNotification[\s\S]*?self\?\.retryIfNeeded\(\)\s*self\?\.revival\?\.appDidForeground\(\)/,
    )
    // leaving the front voids a check that is waiting for an answer
    expect(triggers).toMatch(
      /willResignActiveNotification, UIApplication\.didEnterBackgroundNotification[\s\S]*?revival\?\.cancel\(\)/,
    )
    expect(triggers).toMatch(
      /guard path\.status == \.satisfied else \{ return \}\s*DispatchQueue\.main\.async \{ self\?\.retryIfNeeded\(\) \}/,
    )
    expect(triggers).toMatch(/monitor\.start\(queue:/)
    // Capacitor's reload for a terminated web process still runs: the shell forwards the callback after resetting audio
    expect(swiftBody(vc, 'func webViewWebContentProcessDidTerminate')).toMatch(
      /pageDidReset\(\)\s*\(inner as\? WKNavigationDelegate\)\?\.webViewWebContentProcessDidTerminate\?\(webView\)/,
    )
    // the retry reloads only when the web view is not on a relay page (needsRetry, ShellPolicyTests)
    expect(swiftBody(vc, 'private func retryIfNeeded')).toMatch(
      /tapped \|\| showingFallback,\s*guardian\.needsRetry\(currentURL: webView\.url\)/,
    )
  })
})

describe('D49: launch screen and background are Talos, not Capacitor', () => {
  it('config sets the brand background and keeps errorPath', () => {
    const cfg = buildConfig({ TALOS_RELAY_URL: 'https://relay.example.test' })
    expect(cfg.ios?.backgroundColor).toBe('#141110')
    expect(cfg.server?.errorPath).toBe('offline.html')
  })
  it('app icon and splash are the brand art, not the stock Capacitor files', () => {
    const brand = readFileSync(`${REPO}assets/brand/talos-icon-1024.png`)
    const icon = readFileSync(new URL(`../${APP}/Assets.xcassets/AppIcon.appiconset/AppIcon-512.png`, import.meta.url))
    expect(icon.equals(brand)).toBe(false) // flattened to RGB: App Store rejects an alpha icon
    // PNG colour type byte 25: 2 = RGB, 6 = RGBA.
    expect(icon[25]).toBe(2)
    expect(existsSync(new URL(`../${APP}/Assets.xcassets/Splash.imageset/splash.png`, import.meta.url))).toBe(true)
    const contents = JSON.parse(read(`${APP}/Assets.xcassets/Splash.imageset/Contents.json`))
    expect(contents.images.map((i: { filename?: string }) => i.filename)).toEqual(['splash.png'])
  })
  it('launch storyboard background matches the splash art', () => {
    const sb = read(`${APP}/Base.lproj/LaunchScreen.storyboard`)
    expect(sb).not.toContain('systemBackgroundColor"/>\n') // stock white
    expect(sb).toContain('red="0.0784313725"')
  })
  it('launch has a native spinner that stops when a page finishes, and a watchdog that falls to the offline page', () => {
    const vc = withoutComments(read(`${APP}/TalosBridgeViewController.swift`))
    expect(swiftBody(vc, 'override func viewDidLoad')).toMatch(
      /view\.addSubview\(launchSpinner\)[\s\S]*launchSpinner\.startAnimating\(\)/,
    )
    expect(swiftBody(vc, 'func pageDidFinish')).toMatch(/^\s*launchSpinner\.stopAnimating\(\)/)
    // the stall limit is BridgeGuard's (ShellPolicyTests); the timer must use it and then show the bundled offline page
    const dog = swiftBody(vc, 'private func startLaunchWatchdog')
    expect(dog).toMatch(/withTimeInterval: BridgeGuard\.launchLimit\(relayPageCommitted: relayPageCommitted\)/)
    expect(dog).toMatch(
      /BridgeGuard\.shouldFallToOffline\(elapsed: elapsed \+ 0\.5, relayPageFinished: self\.relayPageFinished,\s*relayPageCommitted: self\.relayPageCommitted\)/,
    )
    expect(dog).toMatch(
      /errorPathURL[\s\S]*launchSpinner\.stopAnimating\(\)[\s\S]*webView\?\.load\(URLRequest\(url: errorURL\)\)/,
    )
  })
  it('a committed relay page gets the longer limit (slow bundle is not a stall)', () => {
    const vc = read(`${APP}/TalosBridgeViewController.swift`)
    expect(vc).toContain('BridgeGuard.launchLimit(relayPageCommitted: relayPageCommitted)')
    expect(vc).toContain('didCommit: { [weak self] in self?.pageDidCommit() }')
    expect(vc).toMatch(/didCommit\(\)\n\s+\(inner as\? WKNavigationDelegate\)\?\.webView\?\(webView, didCommit/)
  })
})

describe('D6: files go through the download path', () => {
  const viewer = read(`${APP}/MediaViewerController.swift`)
  it('uses the tested classifier, WKDownload and a system preview with Share', () => {
    expect(viewer).toContain('MediaPolicy.classify')
    expect(viewer).toContain('decisionHandler(.download)')
    expect(viewer).toContain('WKDownloadDelegate')
    expect(viewer).toContain('QLPreviewController')
    expect(viewer).toContain('UIActivityViewController')
    expect(viewer).toContain('MediaPolicy.safeFileName')
  })
  it('both failure callbacks share one filter: 204 is playing, cancelled is not new', () => {
    expect(viewer).toMatch(/didFail navigation[\s\S]*?handleLoadError\(error\)/)
    expect(viewer).toMatch(/didFailProvisionalNavigation[\s\S]*?handleLoadError\(error\)/)
    expect(viewer).toContain('MediaPolicy.isPluginHandledLoad')
    expect(viewer).toContain('MediaPolicy.isCancelledLoad')
    expect(viewer).toContain('mimeType: navigationResponse.response.mimeType')
  })
  it('lives in its own file, still bridge-less', () => {
    expect(viewer).toContain('WKUserContentController()')
    expect(viewer).not.toContain('name: "bridge"')
  })
})

describe('D52: TestFlight script and doc', () => {
  const script = readFileSync(`${REPO}scripts/testflight.sh`, 'utf8')
  const doc = readFileSync(`${REPO}docs/ios.md`, 'utf8')
  it('script is executable and passes bash -n', () => {
    expect(statSync(`${REPO}scripts/testflight.sh`).mode & 0o111).toBeGreaterThan(0)
    execFileSync('bash', ['-n', `${REPO}scripts/testflight.sh`])
  })
  it('reads credentials from the environment only', () => {
    for (const v of ['ASC_KEY_PATH', 'ASC_KEY_ID', 'ASC_ISSUER_ID']) {
      expect(script).toContain(v)
      expect(doc).toContain(v)
    }
    expect(script).not.toMatch(/\.p8['"]?\s*$/m)
    expect(script).toMatch(/CURRENT_PROJECT_VERSION=/)
    expect(script).toContain('worktree add --detach')
  })
  it('refuses to run without credentials, and says which are missing, before touching anything', () => {
    let out = ''
    let code = 0
    try {
      execFileSync('bash', [`${REPO}scripts/testflight.sh`], {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
        stdio: 'pipe',
      })
    } catch (e) {
      const err = e as { status: number; stderr: Buffer }
      code = err.status
      out = err.stderr.toString()
    }
    expect(code).not.toBe(0)
    expect(out).toContain('ASC_KEY_PATH')
    expect(out).toContain('ASC_KEY_ID')
    expect(out).toContain('ASC_ISSUER_ID')
  })
})
