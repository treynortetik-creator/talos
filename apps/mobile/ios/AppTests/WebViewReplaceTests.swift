import UIKit
import XCTest

@testable import App

/// Replacing the web view when its process is stuck: the new one keeps every guard, a sheet over the old one does not hold it
/// up, the old one is let go, and a notification tap that went through to the old page is not lost.
@MainActor
final class WebViewReplaceTests: XCTestCase {
    private func makeWindow() throws -> (SceneDelegate, UIWindow) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        let delegate = SceneDelegate()
        delegate.window = window
        return (delegate, window)
    }

    private func spin(_ seconds: TimeInterval = 0.5) {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
    }

    func testTheNewWebViewKeepsTheNavigationGuards() throws {
        let (delegate, window) = try makeWindow()
        let first = TalosBridgeViewController()
        window.rootViewController = first
        window.makeKeyAndVisible()
        first.loadViewIfNeeded()
        try XCTSkipUnless(first.webView?.navigationDelegate is NavigationGate,
                          "no relay is configured in this build (run `pnpm --filter @talos-app/mobile cap:sync` with TALOS_RELAY_URL set)")

        delegate.replaceBridgeViewController()
        let second = try XCTUnwrap(window.rootViewController as? TalosBridgeViewController)
        XCTAssertFalse(second === first)
        second.loadViewIfNeeded()
        XCTAssertTrue(second.webView?.navigationDelegate is NavigationGate, "the guards are on the new view")
        XCTAssertTrue(second.webView?.uiDelegate is NavigationGate)
        window.isHidden = true
    }

    func testASheetOverTheOldControllerIsClosedAndTheSwapFollows() throws {
        let (delegate, window) = try makeWindow()
        let first = TalosBridgeViewController()
        window.rootViewController = first
        window.makeKeyAndVisible()
        first.loadViewIfNeeded()
        let sheet = UIViewController()
        let shown = expectation(description: "sheet up")
        first.present(sheet, animated: false) { shown.fulfill() }
        wait(for: [shown], timeout: 5)
        XCTAssertNotNil(first.presentedViewController)

        delegate.replaceBridgeViewController()
        XCTAssertTrue(window.rootViewController === first, "the swap waits until the sheet is closed")
        spin()
        XCTAssertTrue(window.rootViewController is TalosBridgeViewController)
        XCTAssertFalse(window.rootViewController === first, "the swap happened after the sheet was closed")
        XCTAssertNil(first.presentedViewController, "nothing is left on the old controller")
        window.isHidden = true
    }

    func testTheReplacedWebViewIsDetachedAndSilenced() throws {
        let (delegate, window) = try makeWindow()
        let first = TalosBridgeViewController()
        window.rootViewController = first
        window.makeKeyAndVisible()
        first.loadViewIfNeeded()
        let oldWebView = try XCTUnwrap(first.webView)
        try XCTSkipUnless(oldWebView.navigationDelegate is NavigationGate, "no relay is configured in this build")

        delegate.replaceBridgeViewController()
        XCTAssertNil(oldWebView.superview, "the old web view is out of the window")
        XCTAssertNil(oldWebView.navigationDelegate, "and no longer drives anything")
        XCTAssertNil(oldWebView.uiDelegate)
        window.isHidden = true
    }
}

final class PushTapReplaceTests: XCTestCase {
    private func center(at start: Date) -> (TalosPushCenter, Clock) {
        let c = TalosPushCenter()
        let clock = Clock(start)
        c.now = { clock.date }
        return (c, clock)
    }
    private final class Clock { var date: Date; init(_ d: Date) { date = d } }
    /// The center takes a tap through `deliver`, the way the notification delegate hands it over.
    private func deliverTap(_ c: TalosPushCenter, to sink: @escaping ([String: Any]) -> Bool) {
        c.deliver = sink
        c.tapped(action: "open", path: "/t/th_one")
    }

    func testATapGivenToAPageThatIsReplacedRightAfterGoesToTheNewPage() {
        let (c, clock) = center(at: Date(timeIntervalSince1970: 1_000))
        var old: [[String: Any]] = []
        deliverTap(c) { old.append($0); return true }
        XCTAssertEqual(old.count, 1)

        clock.date.addTimeInterval(5)
        c.requeueRecentlyDelivered()
        var new: [[String: Any]] = []
        c.deliver = { new.append($0); return true } // the new plugin loads
        c.flush()
        XCTAssertEqual(new.count, 1)
        XCTAssertEqual(new.first?["navigate"] as? String, "/t/th_one")
    }

    func testAnOldTapIsNotGivenAgain() {
        let (c, clock) = center(at: Date(timeIntervalSince1970: 1_000))
        deliverTap(c) { _ in true }
        clock.date.addTimeInterval(600)
        c.requeueRecentlyDelivered()
        var new = 0
        c.deliver = { _ in new += 1; return true }
        c.flush()
        XCTAssertEqual(new, 0)
    }

    func testTwoSwapsBeforeAPageTakesTheTapGiveItOnce() {
        let (c, _) = center(at: Date(timeIntervalSince1970: 1_000))
        deliverTap(c) { _ in true }
        c.requeueRecentlyDelivered()
        c.requeueRecentlyDelivered()
        var new = 0
        c.deliver = { _ in new += 1; return true }
        c.flush()
        XCTAssertEqual(new, 1)
    }

    func testATapStillWaitingIsNotOverwrittenByAnOlderOne() {
        let (c, _) = center(at: Date(timeIntervalSince1970: 1_000))
        deliverTap(c) { _ in true }
        c.deliver = { _ in false } // the page cannot take taps yet
        c.tapped(action: "approve", path: "/card/c_new")
        c.requeueRecentlyDelivered()
        var got: [String] = []
        c.deliver = { got.append($0["navigate"] as? String ?? ""); return true }
        c.flush()
        XCTAssertEqual(got, ["/card/c_new"])
    }
}
