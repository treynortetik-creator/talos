import TalosRelayCore
import UIKit
import WebKit
import XCTest

@testable import App

/// An attester that is a script: it answers from a list (then a fallback), records every call, and can hold an answer until a test
/// releases it, so the order of events during a check can be tested. Nothing here touches the network.
@MainActor
final class StubAttester: AttestRunning {
    struct Call { let origin: URL; let relayID: String; let pinnedFP: String; let cookie: String?; let context: BridgeAttest.Context }
    var outcomes: [AttestOutcome] = []
    var fallback: AttestOutcome
    var holds = false
    private(set) var calls: [Call] = []
    private var waiting: CheckedContinuation<Void, Never>?

    init(_ fallback: AttestOutcome = .verdict(.pass)) { self.fallback = fallback }

    func run(origin: URL, relayID: String, pinnedFP: String, cookie: String?, context: BridgeAttest.Context) async -> AttestOutcome {
        calls.append(Call(origin: origin, relayID: relayID, pinnedFP: pinnedFP, cookie: cookie, context: context))
        if holds { await withCheckedContinuation { waiting = $0 } }
        return outcomes.isEmpty ? fallback : outcomes.removeFirst()
    }

    var isHeld: Bool { waiting != nil }

    func release() {
        let w = waiting
        waiting = nil
        w?.resume()
    }
}

/// Pieces of WebKit that a test cannot make any other way (a frame, a security origin, a script message, a navigation action). WebKit marks
/// their `init()` unavailable, so each is made through `NSObject.Type` and filled in afterwards.
/// They are never freed (WebKit's own `dealloc` of an object made this way crashes), so a test run leaks a few small objects.
private nonisolated(unsafe) var keptAlive: [NSObject] = []
private func make<T: NSObject>(_ type: T.Type) -> T {
    let o = (type as NSObject.Type).init() as! T
    keptAlive.append(o)
    return o
}

final class FakeOrigin: WKSecurityOrigin {
    var hostText = ""
    static func with(host: String) -> FakeOrigin { let o = make(FakeOrigin.self); o.hostText = host; return o }
    override var `protocol`: String { "https" }
    override var host: String { hostText }
    override var port: Int { 0 }
}

final class FakeFrame: WKFrameInfo {
    var main = true
    var origin = FakeOrigin.with(host: "")
    var url = URL(string: "about:blank")!
    static func with(host: String, url: URL, main: Bool = true) -> FakeFrame {
        let f = make(FakeFrame.self)
        f.main = main
        f.origin = FakeOrigin.with(host: host)
        f.url = url
        return f
    }
    override var isMainFrame: Bool { main }
    override var securityOrigin: WKSecurityOrigin { origin }
    override var request: URLRequest { URLRequest(url: url) }
}

final class FakeMessage: WKScriptMessage {
    var payload: Any = ""
    var frame: WKFrameInfo!
    weak var web: WKWebView?
    static func with(body: Any, frame: WKFrameInfo, webView: WKWebView?) -> FakeMessage {
        let m = make(FakeMessage.self)
        m.payload = body
        m.frame = frame
        m.web = webView
        return m
    }
    override var body: Any { payload }
    override var frameInfo: WKFrameInfo { frame }
    override var webView: WKWebView? { web }
    override var name: String { "bridge" }
}

final class FakeNavigationAction: WKNavigationAction {
    var req = URLRequest(url: URL(string: "about:blank")!)
    var source: WKFrameInfo!
    var target: WKFrameInfo?
    static func with(url: URL, source: WKFrameInfo, target: WKFrameInfo?) -> FakeNavigationAction {
        let a = make(FakeNavigationAction.self)
        a.req = URLRequest(url: url)
        a.source = source
        a.target = target
        return a
    }
    override var request: URLRequest { req }
    override var sourceFrame: WKFrameInfo { source }
    override var targetFrame: WKFrameInfo? { target }
}

/// A message handler that records what reached it.
final class SpyHandler: NSObject, WKScriptMessageHandler {
    private(set) var received = 0
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) { received += 1 }
}

/// A WKUIDelegate that records that the prompt channel reached it and answers.
final class SpyUI: NSObject, WKUIDelegate, WKNavigationDelegate {
    private(set) var prompts = 0
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        prompts += 1
        completionHandler("ok")
    }
}
