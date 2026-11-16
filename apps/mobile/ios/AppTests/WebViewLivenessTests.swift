import BridgeGuard
import Darwin
import WebKit
import XCTest

@testable import App

/// The liveness check against a real web view and a real web content process (no fake): what the script answers on a page
/// with content and on an empty one, and what comes back when that process is killed or frozen. The process is reached by its
/// pid, read from the web view (test-only; the app itself never does this).
@MainActor
final class WebViewLivenessTests: XCTestCase {
    private final class Quiet: NSObject, WKNavigationDelegate {
        var finished: (() -> Void)?
        var terminated = 0
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished?() }
        /// Deliberately no reload: the state a page is in when nothing brought it back.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { terminated += 1 }
    }

    private var webView: WKWebView!
    private var quiet: Quiet!
    private var frozen: pid_t?

    override func setUp() {
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480))
        quiet = Quiet()
        webView.navigationDelegate = quiet
    }

    override func tearDown() {
        if let frozen { kill(frozen, SIGKILL) } // never leave a stopped process behind
        frozen = nil
        webView = nil
        quiet = nil
    }

    private func load(_ html: String) {
        let done = expectation(description: "page finished")
        quiet.finished = { done.fulfill() }
        webView.loadHTMLString(html, baseURL: URL(string: "https://relay.example.test/"))
        wait(for: [done], timeout: 20)
        quiet.finished = nil
    }

    private func pulse(timeout: TimeInterval = 10) -> PagePulse {
        let done = expectation(description: "ping answered")
        var got: PagePulse?
        WebViewRevival.ping(webView, timeout: timeout) { got = $0; done.fulfill() }
        wait(for: [done], timeout: timeout + 10)
        return got ?? .silent
    }

    private func processID() throws -> pid_t {
        let pid = try XCTUnwrap(webView.value(forKey: "_webProcessIdentifier") as? NSNumber).int32Value
        XCTAssertGreaterThan(pid, 0)
        return pid
    }

    func testAPageWithContentAnswers() {
        load("<!doctype html><body><main>hello</main></body>")
        XCTAssertEqual(pulse(), .answered)
    }

    func testAnEmptyDocumentIsBlank() {
        load("")
        XCTAssertEqual(pulse(), .blank)
    }

    /// A web view that never loaded anything: the first version's `1` came back from it with no error.
    func testAWebViewWithNoDocumentIsNeverALivePage() {
        XCTAssertNotEqual(pulse(), .answered)
    }

    func testAKilledProcessIsNeverALivePage() throws {
        load("<!doctype html><body><main>hello</main></body>")
        XCTAssertEqual(pulse(), .answered)
        XCTAssertEqual(kill(try processID(), SIGKILL), 0)
        // Wait for WebKit to notice; then ask, with nothing having reloaded the page.
        let noticed = expectation(description: "WebKit reported the death")
        let poll = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [quiet] t in
            if quiet!.terminated > 0 { t.invalidate(); noticed.fulfill() }
        }
        wait(for: [noticed], timeout: 20)
        poll.invalidate()
        XCTAssertEqual(pulse(), .failed, "a dead page must lead to a load")
    }

    /// What WebKit really says for that page, so a change in it is seen here first. It is not the "process terminated" code.
    func testAKilledProcessAnswersWithAnErrorAndNoResult() throws {
        load("<!doctype html><body><main>hello</main></body>")
        XCTAssertEqual(kill(try processID(), SIGKILL), 0)
        let noticed = expectation(description: "WebKit reported the death")
        let poll = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [quiet] t in
            if quiet!.terminated > 0 { t.invalidate(); noticed.fulfill() }
        }
        wait(for: [noticed], timeout: 20)
        poll.invalidate()
        let answered = expectation(description: "answer")
        var got: (Any?, Error?) = (nil, nil)
        webView.evaluateJavaScript("1") { got = ($0, $1); answered.fulfill() }
        wait(for: [answered], timeout: 20)
        XCTAssertNil(got.0)
        XCTAssertNotNil(got.1, "the first version asked for 1 and took any answer but two error codes as a live page")
    }

    func testAFrozenProcessIsSilentWithinTheTimeout() throws {
        load("<!doctype html><body><main>hello</main></body>")
        let pid = try processID()
        XCTAssertEqual(kill(pid, SIGSTOP), 0)
        frozen = pid
        let started = Date()
        XCTAssertEqual(pulse(timeout: 1), .silent)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the timeout answers; the frozen process does not hold the caller")
    }
}
