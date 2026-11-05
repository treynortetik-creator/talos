import AppKit
import Foundation
import Testing
import WebKit
import TalosDesktopCore
@testable import TalosDesktop

let talosPost = "window.webkit.messageHandlers.talos.postMessage"

/// D3 review. A real WKWebView against a real HTTP server on loopback: real redirects, real CSP headers, real origins.
/// Needs TALOS_GUI_TESTS=1. Nothing is shown and nothing touches a live session.
extension GuiSerial {
@MainActor
@Suite("Review D3: web window", .serialized, .enabled(if: guiTestsEnabled))
struct ReviewD3WebTests {
  final class Box: @unchecked Sendable {
    var got: [WebToNative] = []
    var opened: [URL] = []
  }

  func make(_ relay: FakeRelay) -> (WebController, Box) {
    cannotTakeTheKeyboard()
    let c = WebController()
    let b = Box()
    c.openExternal = { b.opened.append($0) }
    c.testHook = { b.got.append($0) }
    c.configure(relay: relay.relay)
    c.prepare()
    return (c, b)
  }

  /// Spec 5.3 and WP-D3 acceptance. The builder's test uses `loadHTMLString(baseURL: nil)`, which the policy cancels before
  /// any script runs, so it passes without the gate ever being reached (see the next test).
  @Test func aCspSandboxedTopLevelPageIsDropped() async throws {
    let relay = try FakeRelay { r in
      switch r.path {
      case "/": return .init(body: "<html>app</html>")
      case "/sandboxed":
        return .init(
          headers: ["Content-Security-Policy": "sandbox allow-scripts"],
          body: "<img src='/ran.png'><script>\(talosPost)({type:'badge',count:9})</script>")
      default: return .init(body: "")
      }
    }
    defer { relay.stop() }
    let (c, b) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    wv.load(URLRequest(url: URL(string: relay.origin + "/sandboxed")!))
    #expect(await pumpUntil(3) { relay.saw("/ran.png") }, "control: the sandboxed page really ran")
    await pump(0.5)
    #expect(b.got.isEmpty, "a sandboxed document reached native: \(b.got)")
  }

  /// Proof that aTopLevelPageWithNoRelayOriginIsDropped and aMainFramePageUnderMediaIsDropped never reach the gate.
  @Test func theBuildersOpaqueAndMediaGateTestsNeverRunTheirScript() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    let (c, b) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.3)
    let html = "<script>\(talosPost)({type:'badge',count:1})</script>"
    wv.loadHTMLString(html, baseURL: nil)
    await pump(0.8)
    wv.loadHTMLString(html, baseURL: URL(string: relay.origin + "/media/x/page")!)
    await pump(0.8)
    #expect(b.opened.map(\.path) == ["/media/x/page"], "the media page was routed away by the policy: \(b.opened)")
    #expect(wv.url?.absoluteString == relay.origin + "/", "neither document ever loaded: \(wv.url?.absoluteString ?? "nil")")
  }

  @Test func aRedirectOffTheRelayGoesToTheBrowserAndNeverLoads() async throws {
    let relay = try FakeRelay { r in
      switch r.path {
      case "/": return .init(body: "<html>app</html>")
      case "/out": return .init(status: 302, headers: ["Location": "http://other.invalid/landing"])
      case "/in-media": return .init(status: 302, headers: ["Location": "/media/abc/page"])
      case "/media/abc/page": return .init(body: "<script>\(talosPost)({type:'badge',count:2})</script>")
      default: return nil
      }
    }
    defer { relay.stop() }
    let (c, b) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.3)
    wv.load(URLRequest(url: URL(string: relay.origin + "/out")!))
    #expect(await pumpUntil(3) { b.opened.count == 1 })
    #expect(b.opened.first?.absoluteString == "http://other.invalid/landing")
    wv.load(URLRequest(url: URL(string: relay.origin + "/in-media")!))
    #expect(await pumpUntil(3) { b.opened.count == 2 })
    #expect(b.opened.last?.path == "/media/abc/page")
    await pump(0.5)
    #expect(!relay.saw("/media/abc/page"), "the agent page was fetched by the view")
    #expect(b.got.filter { if case .badge = $0 { return true } else { return false } }.isEmpty)
  }

  /// The real shape of an agent page: sandboxed iframe, CSP sandbox header. Everything it tries must go nowhere.
  @Test func anAgentPageInItsIframeReachesNothing() async throws {
    let agent = """
      <img src='/ran-in-frame.png'><script>
      try { \(talosPost)({type:'open_external',url:'https://evil.example/own'}) } catch (e) {}
      try { parent.webkit.messageHandlers.talos.postMessage({type:'open_external',url:'https://evil.example/parent'}) } catch (e) {}
      try { top.webkit.messageHandlers.talos.postMessage({type:'open_external',url:'https://evil.example/top'}) } catch (e) {}
      try { window.open('https://evil.example/popup') } catch (e) {}
      try { top.location = 'https://evil.example/top-nav' } catch (e) {}
      setTimeout(function () { location.href = 'https://evil.example/self-nav' }, 100)
      </script>
      """
    let relay = try FakeRelay { r in
      switch r.path {
      case "/": return .init(body: "<html><iframe sandbox='allow-scripts' src='/media/x/page'></iframe></html>")
      case "/media/x/page": return .init(headers: ["Content-Security-Policy": "sandbox allow-scripts"], body: agent)
      default: return .init(body: "")
      }
    }
    defer { relay.stop() }
    let (c, b) = make(relay)
    _ = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/ran-in-frame.png") }, "control: the agent script ran")
    await pump(1)
    #expect(b.got.isEmpty, "agent reached native: \(b.got)")
    #expect(b.opened.isEmpty, "agent opened the browser: \(b.opened)")
  }

  /// The gate reads frameInfo, and a frame calling `top.webkit...` is reported as the main frame. A sandboxed frame can't
  /// reach `top`, so this is safe only because every framed document is opaque: `decideSubframe` lets any relay path in.
  /// Real relay headers close it today (`frame-ancestors 'none'` on the app, CSP sandbox on media); the shell shouldn't rely on it.
  @Test func aSameOriginFrameCannotSpeakAsTheMainFrame() async throws {
    let relay = try FakeRelay { r in
      switch r.path {
      case "/": return .init(body: "<html><iframe src='/not-sandboxed'></iframe></html>")
      case "/not-sandboxed":
        return .init(body: "<img src='/ran-same-origin.png'><script>top.webkit.messageHandlers.talos.postMessage({type:'badge',count:7})</script>")
      default: return .init(body: "")
      }
    }
    defer { relay.stop() }
    let (c, b) = make(relay)
    _ = try #require(c.webView)
    // Control changed with the fix (said so in the PR): the policy now refuses to frame any relay path outside /media/, so the
    // framed page is never fetched at all. The assertion that matters is unchanged: nothing reached native.
    await pump(1.5)
    #expect(!relay.saw("/not-sandboxed"), "a non-media relay page was framed")
    #expect(b.got.isEmpty, "a framed document spoke as the main frame: \(b.got)")
  }

  /// The window lives hidden for days and notifications depend on the page. WebKit reloads a crashed page only when the view
  /// is visible, so a web-process crash while hidden is silent until someone opens the window. There is no
  /// `webViewWebContentProcessDidTerminate`.
  @Test func aCrashedPageComesBackWhileHidden() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    let (c, _) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.3)
    let before = relay.log.count
    let sel = Selector(("_killWebContentProcess"))
    try #require(wv.responds(to: sel), "WebKit SPI missing on this OS")
    wv.perform(sel)
    #expect(await pumpUntil(6) { relay.log.count > before }, "the hidden page never came back")
  }

  /// window.open from the app's own page goes through the same policy.
  @Test func windowOpenOnlyEverReachesThePolicy() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    let (c, b) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.3)
    for u in ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "x-apple.systempreferences:", "about:blank", "ftp://x.example/"] {
      _ = try? await wv.evaluateJavaScript("void window.open('\(u)')")
    }
    await pump(0.5)
    #expect(b.opened.isEmpty, "\(b.opened)")
    _ = try? await wv.evaluateJavaScript("void window.open('https://ok.example/a')")
    _ = try? await wv.evaluateJavaScript("void window.open('/media/q/page')")
    #expect(await pumpUntil(2) { b.opened.count == 2 }, "\(b.opened)")
  }

  /// 5.2 step 5 says what a shell keeps; the relay already has `POST /api/auth/logout`. Deleting only the local cookie
  /// leaves the session row alive on the relay until its TTL, sliding included.
  @Test func signOutEndsTheSessionOnTheRelayToo() async throws {
    let relay = try FakeRelay { r in
      r.path == "/api/auth/logout" ? .init(status: 204) : .init(body: "<html>app</html>")
    }
    defer { relay.stop() }
    let (c, _) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    let cookie = HTTPCookie(properties: [
      .name: "__Host-talos_s", .value: "tok", .domain: "127.0.0.1", .path: "/", .secure: "TRUE",
    ])!
    await wv.configuration.websiteDataStore.httpCookieStore.setCookie(cookie)
    await c.signOut()
    await pump(1)
    let left = await wv.configuration.websiteDataStore.httpCookieStore.allCookies().filter { $0.name == "__Host-talos_s" }
    #expect(left.isEmpty, "the local cookie goes")
    #expect(relay.saw(method: "POST", "/api/auth/logout"), "the relay was never told; its session row is still live")
  }

  /// Sign out keeps the device key; Forget wipes it, on a live page holding an open IndexedDB connection.
  @Test func signOutKeepsIndexedDBAndTheWipeRemovesIt() async throws {
    let relay = try FakeRelay { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    let (c, _) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.5)
    let setup = """
      return await new Promise((res, rej) => {
        const o = indexedDB.open('talos-rv', 1)
        o.onupgradeneeded = () => o.result.createObjectStore('k')
        o.onerror = () => rej(o.error)
        o.onsuccess = () => {
          window.__db = o.result
          const t = o.result.transaction('k', 'readwrite')
          t.objectStore('k').put('device-key', 'dk')
          t.oncomplete = () => res('ok')
        }
      })
      """
    let read = """
      return await new Promise((res, rej) => {
        const o = indexedDB.open('talos-rv', 1)
        o.onupgradeneeded = () => o.result.createObjectStore('k')
        o.onerror = () => rej(o.error)
        o.onsuccess = () => {
          const g = o.result.transaction('k').objectStore('k').get('dk')
          g.onsuccess = () => { const v = g.result; o.result.close(); res(v === undefined ? 'gone' : v) }
        }
      })
      """
    let wrote = try await wv.callAsyncJavaScript(setup, contentWorld: .page) as? String
    #expect(wrote == "ok")
    await c.signOut()
    await pump(1)
    let kept = try await wv.callAsyncJavaScript(read, contentWorld: .page) as? String
    #expect(kept == "device-key")
    await c.wipeSiteData()
    await pump(1)
    let after = try await wv.callAsyncJavaScript(read, contentWorld: .page) as? String
    #expect(after == "gone", "the device key survived Forget: \(after ?? "nil")")
  }

  /// `prepare()` runs at app launch (login item: the network may not be up yet) and the window can sit hidden for days. One
  /// failed load leaves it dead: no retry, no error, no socket, no notifications, and `show()` doesn't reload.
  @Test func aRelayThatIsDownAtLaunchIsRetried() async throws {
    let probe = try FakeRelay { _ in nil }
    let port = probe.port
    probe.stop()
    cannotTakeTheKeyboard()
    let c = WebController()
    c.configure(relay: RelayOrigin("http://127.0.0.1:\(port)"))
    c.prepare()
    await pump(1.5)
    let relay = try FakeRelay(port: port) { _ in .init(body: "<html>app</html>") }
    defer { relay.stop() }
    c.show()
    defer { for w in NSApp.windows where w.title == "Talos" { w.orderOut(nil) } }
    #expect(await pumpUntil(12) { relay.saw("/") }, "the page never came back after the relay did")
  }

  /// A failed navigation never clears `pageReady = false`, so a later `sendWhenReady` waits for a `ready` that can't come
  /// while the old page still works.
  @Test func aFailedNavigationDoesNotStrandTheNextMessage() async throws {
    let relay = try FakeRelay { r in
      switch r.path {
      case "/":
        return .init(body: """
          <script>window.talosNative={receive:function(j){window.__got=j}};\(talosPost)({type:'ready',shell_api:1,features:[],signed_in:false})</script>
          """)
      case "/hang": return .init(status: 204)
      default: return nil
      }
    }
    defer { relay.stop() }
    let (c, b) = make(relay)
    let wv = try #require(c.webView)
    #expect(await pumpUntil(3) { c.pageReady })
    _ = b
    wv.load(URLRequest(url: URL(string: relay.origin + "/hang")!))
    await pump(1)
    #expect(wv.url?.path == "/", "204 leaves the old document in place")
    #expect(c.pageReady, "the old page is still up and ready, but the shell now thinks it is not")
  }

  // MARK: Forget this Mac

  struct Forget {
    var devices: String
    var devicesExit: Int32 = 0
  }

  func forgetRun(_ home: String, _ f: Forget, relay: FakeRelay) async throws -> (revoked: [String], note: String) {
    let log = home + "/calls.log"
    writeScript(home + "/talos-app", """
      #!/bin/bash
      echo "$*" >> '\(log)'
      if [ "$1" = devices ] && [ -z "$2" ]; then
        cat '\(home)/devices.txt'
        exit \(f.devicesExit)
      fi
      exit 0
      """)
    try f.devices.write(toFile: home + "/devices.txt", atomically: true, encoding: .utf8)
    AlertSpy.install()
    let (c, _) = make(relay)
    #expect(await pumpUntil(3) { relay.saw("/") })
    await pump(0.3)
    var cfg = DesktopConfig.defaults
    cfg.talosAppCommand = [home + "/talos-app"]
    c.forgetThisMac(config: cfg)
    #expect(await pumpUntil(15) { AlertSpy.seen.count >= 2 }, "alerts: \(AlertSpy.seen)")
    let calls = (try? String(contentsOfFile: log, encoding: .utf8)) ?? ""
    let revoked = calls.split(separator: "\n").filter { $0.hasPrefix("devices revoke ") }.map { String($0.dropFirst(15)) }
    return (revoked, AlertSpy.seen.last ?? "")
  }

  nonisolated static let this = "d_" + String(repeating: "a", count: 20)
  nonisolated static let other = "d_" + String(repeating: "b", count: 20)
  /// `/api/me` already tells the page which device this web view is.
  func relayKnowing(_ id: String) throws -> FakeRelay {
    try FakeRelay { r in
      r.path == "/api/me"
        ? .init(headers: ["Content-Type": "application/json"], body: "{\"device_id\":\"\(id)\",\"device_pinned\":true}")
        : .init(body: "<html>app</html>")
    }
  }

  /// A dev build next to the installed app has its own WebKit store and key, and both pair as "Mac app"; so does a
  /// reinstall. Forget in one must not revoke the other: the name is device-supplied text, not an identity.
  @Test func forgetRevokesThisMacAndNotAnotherMacApp() async throws {
    try await withScratchHome { home in
      let relay = try relayKnowing(Self.this)
      defer { relay.stop() }
      let r = try await forgetRun(
        home,
        Forget(devices: """
          \(Self.this)  pinned   Mac app  [a b c d]  2026-10-30T12:00:00.000Z
          \(Self.other)  pinned   Mac app  [e f g h]  2026-10-30T13:00:00.000Z

          """), relay: relay)
      #expect(r.revoked == [Self.this], "revoked \(r.revoked)")
    }
  }

  /// The name is the only key today, so a device whose name differs is silently left pinned while its key is wiped.
  @Test func forgetFindsThisMacAfterARename() async throws {
    try await withScratchHome { home in
      let relay = try relayKnowing(Self.this)
      defer { relay.stop() }
      let r = try await forgetRun(
        home, Forget(devices: "\(Self.this)  pinned   Studio Mac  [a b c d]  2026-10-30T12:00:00.000Z\n"), relay: relay)
      #expect(r.revoked == [Self.this], "revoked \(r.revoked); note: \(r.note)")
    }
  }

  /// `talos-app devices` exits 1 on a corrupt devices.json. The status is never read, so the owner is told no device was
  /// found, which is false, and the key is wiped anyway.
  @Test func forgetTellsTheTruthWhenTheDeviceListFails() async throws {
    try await withScratchHome { home in
      let relay = try relayKnowing(Self.this)
      defer { relay.stop() }
      let r = try await forgetRun(
        home, Forget(devices: "devices.json is unreadable; fix or restore it\n", devicesExit: 1), relay: relay)
      #expect(!r.note.contains("No pinned"), "note: \(r.note)")
    }
  }

  // MARK: setup code

  /// A second Sign in after the first enroll ended (declined, timed out, failed): the new pty must be the one on screen,
  /// because that is where the owner types `y`.
  @Test func aSecondSignInShowsTheNewPane() async throws {
    try await withScratchHome { home in
      let relay = try FakeRelay { _ in
        .init(body: "<script>window.talosNative={receive:function(j){(window.__got=window.__got||[]).push(j)}};\(talosPost)({type:'ready',shell_api:1,features:[],signed_in:false})</script>")
      }
      defer { relay.stop() }
      let (c, _) = make(relay)
      #expect(await pumpUntil(3) { c.pageReady })
      let code = "0123456789ABCDEFGHJKMNPQRS"
      writeScript(home + "/talos-app", """
        #!/bin/bash
        echo 'Open this link on the device you want to add (it works once, for 10 minutes):'
        echo '\(relay.origin)/enroll#\(code)'
        if [ -f '\(home)/second' ]; then sleep 20; else touch '\(home)/second'; fi
        """)
      var cfg = DesktopConfig.defaults
      cfg.talosAppCommand = [home + "/talos-app"]
      let p = PairingController.shared
      p.start(config: cfg, web: c)
      #expect(await pumpUntil(8) { allTerminalViews().contains { !$0.process.running } && !p.isRunning }, "first enroll ended")
      await pump(0.3)
      p.start(config: cfg, web: c)
      #expect(await pumpUntil(8) { p.isRunning }, "second enroll is running")
      await pump(0.3)
      // The agent viewer (tab 1 of the terminal window, from D2) is not a sign-in pane: count only the enroll ptys.
      let live = allTerminalViews().filter { $0.process.running && !TerminalWindowController.shared.isAgentViewer($0) }
      #expect(live.count == 1, "the running enroll pty is not in any window, so nobody can answer it: \(allTerminalViews().count) views")
      p.closeForReview()
    }
  }
}
}

extension PairingController {
  /// Our own enroll child only.
  func closeForReview() {
    for w in NSApp.windows where w.title == "Sign in to Talos" { w.close() }
    for w in NSApp.windows where w.title == "Talos" { w.orderOut(nil) }
  }
}
