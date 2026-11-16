import Darwin
import UIKit
import WebKit
import XCTest

@testable import App

/// "Reconnecting…" on the real controller: up when the page's web process dies (a real one, killed here) and on the controller
/// that replaces a stuck one, never on a plain launch, and down again once a page (the offline page here: the build's relay does
/// not exist) has finished, so it can never be the last thing on screen.
@MainActor
final class ReconnectNoticeTests: XCTestCase {
    private func makeWindow() throws -> (SceneDelegate, UIWindow) {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        let delegate = SceneDelegate()
        delegate.window = window
        return (delegate, window)
    }

    /// Runs the run loop until the condition holds or the time is up.
    private func waitUntil(_ seconds: TimeInterval, _ condition: () -> Bool) -> Bool {
        let end = Date(timeIntervalSinceNow: seconds)
        while !condition(), Date() < end { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        return condition()
    }

    private func shown(_ window: UIWindow) throws -> TalosBridgeViewController {
        let controller = TalosBridgeViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.loadViewIfNeeded()
        try XCTSkipUnless(controller.webView?.navigationDelegate is NavigationGate,
                          "no relay is configured in this build (run `pnpm --filter @talos-app/mobile cap:sync` with TALOS_RELAY_URL set)")
        return controller
    }

    func testAPlainLaunchShowsNoNotice() throws {
        let (_, window) = try makeWindow()
        let controller = try shown(window)
        XCTAssertFalse(controller.isShowingReconnectNotice)
        window.isHidden = true
    }

    func testTheControllerThatReplacesAStuckOneSaysReconnectingUntilAPageIsUp() throws {
        let (delegate, window) = try makeWindow()
        _ = try shown(window)
        delegate.replaceBridgeViewController()
        let second = try XCTUnwrap(window.rootViewController as? TalosBridgeViewController)
        second.loadViewIfNeeded()
        XCTAssertTrue(second.isShowingReconnectNotice)
        XCTAssertTrue(waitUntil(30) { !second.isShowingReconnectNotice }, "the notice comes down when a page (here the offline page) is up")
        window.isHidden = true
    }

    func testARealWebProcessDeathPutsTheNoticeUpAndAPageTakesItDown() throws {
        let (_, window) = try makeWindow()
        let controller = try shown(window)
        let webView = try XCTUnwrap(controller.webView)
        var pid: pid_t = 0
        XCTAssertTrue(waitUntil(20) {
            pid = (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
            return pid > 0
        }, "the web process never started")
        XCTAssertFalse(controller.isShowingReconnectNotice)

        XCTAssertEqual(kill(pid, SIGKILL), 0)
        XCTAssertTrue(waitUntil(20) { controller.isShowingReconnectNotice }, "a dead web process must not leave a bare view")
        XCTAssertTrue(waitUntil(30) { !controller.isShowingReconnectNotice }, "and the notice goes once a page is up")
        XCTAssertNotNil(webView.url, "a page (the relay's or the offline page) is in the view")
        window.isHidden = true
    }
}
