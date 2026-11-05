import AppKit
import Foundation
import Testing
import WebKit
import TalosDesktopCore
@testable import TalosDesktop

/// A real WKWebView (never shown) with the relay origin faked by `loadHTMLString(baseURL:)`: no network. Needs
/// TALOS_GUI_TESTS=1 because it starts WebKit processes.
@MainActor
@Suite("WebWindow", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct WebWindowTests {
  let relay = RelayOrigin("https://relay.example.com")!

  func makeController() -> (WebController, () -> [WebToNative], () -> [URL]) {
    _ = NSApplication.shared
    let c = WebController()
    var got: [WebToNative] = []
    var opened: [URL] = []
    c.openExternal = { opened.append($0) }
    c.testHook = { got.append($0) }
    c.configure(relay: relay)
    c.prepare()
    return (c, { got }, { opened })
  }

  func pump(_ seconds: Double = 1.2) async {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }

  @Test func mainFrameMessagesArriveAndEverythingElseIsDropped() async throws {
    let (c, got, _) = makeController()
    let wv = try #require(c.webView)
    let post = { (type: String) in "window.webkit.messageHandlers.talos.postMessage({type:'\(type)',count:3})" }
    let html = """
      <html><body><script>
      \(post("badge"));
      window.webkit.messageHandlers.talos.postMessage({type:'badge',count:4,extra:1});
      window.webkit.messageHandlers.talos.postMessage({type:'nope'});
      window.webkit.messageHandlers.talos.postMessage({v:2,type:'badge',count:5});
      </script>
      <iframe sandbox="allow-scripts" srcdoc="<script>try{window.parent.webkit.messageHandlers.talos.postMessage({type:'badge',count:6})}catch(e){};window.webkit.messageHandlers.talos.postMessage({type:'badge',count:7})</script>"></iframe>
      </body></html>
      """
    wv.loadHTMLString(html, baseURL: URL(string: "https://relay.example.com/")!)
    // Wait for the one message that should arrive (bounded; a loaded machine starves WebKit), then let the dropped ones
    // have their chance to show up.
    for _ in 0..<60 where got().isEmpty { await pump(0.15) }
    await pump(0.6)
    #expect(got() == [.badge(3)], "got \(got())")
  }

  // The two gate tests that stood here loaded pages the navigation policy cancels, so no script ever ran. The review's
  // `aCspSandboxedTopLevelPageIsDropped` (real HTTP, real CSP header, proof the page ran) replaces them.

  @Test func aMediaMainFrameLoadGoesToTheBrowserAndNeverLoads() async throws {
    let (c, _, opened) = makeController()
    let wv = try #require(c.webView)
    wv.load(URLRequest(url: URL(string: "https://relay.example.com/media/x/page")!))
    await pump(2)
    #expect(opened() == [URL(string: "https://relay.example.com/media/x/page")!])
  }

  @Test func theUserAgentCarriesTheMarkAndTheHandlerExistsOnlyBecauseWeAddedIt() async throws {
    let (c, _, _) = makeController()
    let wv = try #require(c.webView)
    wv.loadHTMLString("<html></html>", baseURL: URL(string: "https://relay.example.com/")!)
    await pump()
    let ua = try await wv.evaluateJavaScript("navigator.userAgent") as? String
    #expect(ua?.contains(" TalosDesktop/") == true, "ua: \(ua ?? "nil")")
    let hasHandler = try await wv.evaluateJavaScript("typeof window.webkit.messageHandlers.talos.postMessage") as? String
    #expect(hasHandler == "function")
  }

  @Test func nativeToWebReachesTheTopFrameOnly() async throws {
    let (c, _, _) = makeController()
    let wv = try #require(c.webView)
    let html = """
      <html><body><script>
      window.talosNative = { receive: function (j) { window.__got = j } };
      </script><iframe id="f" srcdoc="<script>window.talosNative = { receive: function (j) { window.__got = j } }</script>"></iframe></body></html>
      """
    wv.loadHTMLString(html, baseURL: URL(string: "https://relay.example.com/")!)
    await pump()
    c.deliverForTest(.navigate(path: "/t/general"))
    await pump(0.5)
    let top = try await wv.evaluateJavaScript("window.__got") as? String
    let inner = try await wv.evaluateJavaScript("document.getElementById('f').contentWindow.__got") as? String
    #expect(top == #"{"path":"\/t\/general","type":"navigate"}"# || top == #"{"path":"/t/general","type":"navigate"}"#, "top: \(top ?? "nil")")
    #expect(inner == nil)
  }

  /// Loads `receiver` as the page's `talosNative.receive` body (nil: no receiver at all), waits for the page to run, and says
  /// `ready`. `window.__got` holds every message the page was handed.
  func readyController(receiver: String?, ack: String? = nil) async throws -> (WebController, WKWebView) {
    let (c, _, _) = makeController()
    let wv = try #require(c.webView)
    let doors = [
      receiver.map { "receive: function (j) { window.__got.push(j); window.__doors.push('receive'); \($0) }" },
      ack.map { "receiveAck: function (j) { window.__got.push(j); window.__doors.push('receiveAck'); \($0) }" },
    ].compactMap { $0 }
    let install = doors.isEmpty ? "" : "window.talosNative = { \(doors.joined(separator: ", ")) };"
    wv.loadHTMLString("<html><body><script>window.__got = []; window.__doors = []; \(install)</script></body></html>", baseURL: URL(string: "https://relay.example.com/")!)
    var ran = false
    for _ in 0..<200 where !ran {
      await pump(0.05)
      ran = (try? await wv.evaluateJavaScript("Array.isArray(window.__got)")) as? Bool == true
    }
    try #require(ran, "the test page never ran")
    c.nativeMessage(.ready(signedIn: true, features: []))
    return (c, wv)
  }

  func acknowledged(_ c: WebController, _ m: NativeToWeb) async -> Bool {
    await withCheckedContinuation { k in c.sendAcknowledged(m) { k.resume(returning: $0 == .taken) } }
  }

  func doors(_ wv: WKWebView) async throws -> [String] {
    let all = try await wv.evaluateJavaScript("JSON.stringify(window.__doors)") as? String ?? "[]"
    return try #require(JSONSerialization.jsonObject(with: Data(all.utf8)) as? [String])
  }

  func handed(_ wv: WKWebView) async throws -> Int {
    try await wv.evaluateJavaScript("window.__got.length") as? Int ?? -1
  }

  @Test func sendAcknowledgedIsTrueOnlyWhenThePageReturnsTrue() async throws {
    let (c, wv) = try await readyController(receiver: "return true")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")))
    #expect(try await handed(wv) == 1)
  }

  @Test func sendAcknowledgedWaitsForAPromiseTheReceiverReturns() async throws {
    let (c, wv) = try await readyController(receiver: "return Promise.resolve(true)")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")))
    #expect(try await handed(wv) == 1)
    let (c2, wv2) = try await readyController(receiver: "return new Promise(function (r) { window.__answer = r })")
    var answered: WebController.AckOutcome?
    c2.sendAcknowledged(.compose(threadId: "work", text: "hello")) { answered = $0 }
    for _ in 0..<200 where try await handed(wv2) == 0 { await pump(0.05) }
    #expect(answered == nil, "no answer while the promise is pending")
    _ = try? await wv2.evaluateJavaScript("window.__answer(true)")
    for _ in 0..<200 where answered == nil { await pump(0.05) }
    #expect(answered == .taken)
  }

  @Test func aNewerPageIsAskedThroughReceiveAckAndAnOlderMacAppStillGetsAPlainTrueFromReceive() async throws {
    // The page the web app installs: `receive` is a plain boolean, `receiveAck` a promise. A Mac app that only knows
    // `receive` evaluates it with evaluateJavaScript, which fails on a promise and would report a stored message as not taken.
    let (c, wv) = try await readyController(receiver: "return true", ack: "return Promise.resolve(true)")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")))
    #expect(try await doors(wv) == ["receiveAck"])
    let old = try await wv.evaluateJavaScript(try #require(NativeToWeb.compose(threadId: "work", text: "again").javascript()))
    #expect((old as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } == true, "old Mac, new page: \(String(describing: old))")
    #expect(try await doors(wv) == ["receiveAck", "receive"])
  }

  @Test func anOlderPageWithOnlyReceiveIsStillAcknowledged() async throws {
    let (c, wv) = try await readyController(receiver: "return true")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")))
    #expect(try await doors(wv) == ["receive"])
  }

  @Test func aPendingAcknowledgementEndsAsFalseWhenThePageIsReplaced() async throws {
    let (c, wv) = try await readyController(receiver: "return new Promise(function (r) { window.__answer = r })")
    var answers: [WebController.AckOutcome] = []
    c.sendAcknowledged(.compose(threadId: "work", text: "hello")) { answers.append($0) }
    for _ in 0..<200 where try await handed(wv) == 0 { await pump(0.05) }
    #expect(answers.isEmpty)
    wv.loadHTMLString("<html><body>next</body></html>", baseURL: URL(string: "https://relay.example.com/")!)
    for _ in 0..<200 where answers.isEmpty { await pump(0.05) }
    #expect(answers == [.lost], "the old page can never answer and may have saved it: lost, once")
  }

  @Test func aPendingAcknowledgementEndsAsFalseWhenTheWatchdogReplacesTheView() async throws {
    let (c, wv) = try await readyController(receiver: "return new Promise(function (r) { window.__answer = r })")
    var answers: [WebController.AckOutcome] = []
    c.sendAcknowledged(.compose(threadId: "work", text: "hello")) { answers.append($0) }
    for _ in 0..<200 where try await handed(wv) == 0 { await pump(0.05) }
    #expect(answers.isEmpty)
    c.replaceWebViewForTest()
    for _ in 0..<200 where answers.isEmpty { await pump(0.05) }
    #expect(answers == [.lost], "the replaced view can never answer and may have saved it: lost, once")
  }

  /// The mapping alone: no page, no window. WebKit's two "the page is gone" errors are `lost`, every other error is `notTaken`.
  @Test func aScriptThatFailsBecauseItsPageIsGoneIsLostAndAnyOtherFailureIsNotTaken() {
    func failure(_ code: WKError.Code, domain: String = WKError.errorDomain) -> Result<Any, Error> {
      .failure(NSError(domain: domain, code: code.rawValue))
    }
    #expect(WebController.ackOutcome(failure(.webContentProcessTerminated)) == .lost)
    #expect(WebController.ackOutcome(failure(.webViewInvalidated)) == .lost)
    #expect(WebController.ackOutcome(failure(.javaScriptExceptionOccurred)) == .notTaken, "the page ran and threw")
    #expect(WebController.ackOutcome(failure(.webContentProcessTerminated, domain: NSURLErrorDomain)) == .notTaken, "same number, not WebKit's")
    #expect(WebController.ackOutcome(.success(NSNumber(value: true))) == .taken)
    #expect(WebController.ackOutcome(.success(NSNumber(value: 1))) == .notTaken, "the number 1 is not the page saying yes")
    #expect(WebController.ackOutcome(.success("true")) == .notTaken)
  }

  @Test func sendAcknowledgedIsFalseForARefusingMissingThrowingOrNonTrueReceiver() async throws {
    for receiver: String? in [
      "return false", nil, "throw new Error('boom')", "return undefined", "return 1", "return 'true'",
      "return Promise.resolve(false)", "return Promise.reject(new Error('boom'))", "return Promise.resolve(1)",
    ] {
      let (c, wv) = try await readyController(receiver: receiver)
      #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")) == false, "receiver: \(receiver ?? "none")")
      #expect(try await handed(wv) == (receiver == nil ? 0 : 1))
    }
  }

  @Test func sendAcknowledgedHandsNothingOverBeforeReadyOrForAMessageThePageWouldRefuse() async throws {
    let (c, wv) = try await readyController(receiver: "return true")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "")) == false, "empty text never leaves")
    #expect(await acknowledged(c, .compose(threadId: "not a thread id!", text: "hello")) == false)
    #expect(await acknowledged(c, .compose(threadId: "work", text: String(repeating: "a", count: 32_001))) == false)
    #expect(try await handed(wv) == 0)
    wv.loadHTMLString(
      "<html><body><script>window.__got = []; window.talosNative = { receive: function (j) { window.__got.push(j); return true } }</script></body></html>",
      baseURL: URL(string: "https://relay.example.com/")!)
    for _ in 0..<200 where c.pageReady { await pump(0.05) }
    try #require(!c.pageReady, "a new document drops ready")
    #expect(await acknowledged(c, .compose(threadId: "work", text: "hello")) == false, "no queueing: not ready is false")
    #expect(try await handed(wv) == 0, "the new page, which would have said true, was handed nothing")
  }
}
