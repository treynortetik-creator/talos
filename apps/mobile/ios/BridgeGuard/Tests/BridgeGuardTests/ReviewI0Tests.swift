import XCTest
@testable import BridgeGuard

/// Regression tests for the iOS bridge guard, covering the navigation rule below.
///
/// I14 (navigation): "any /media/* URL and any non-relay host opens in SFSafariViewController, never in the shell's view".
/// NavigationGate only decides /media/ and new windows; every other top-level navigation is forwarded to Capacitor's
/// WebViewDelegationHandler, whose test is `navURL.absoluteString.starts(with: serverURL.absoluteString)` plus a
/// port-blind `allowNavigation` host match (Capacitor 8.5.3 WebViewDelegationHandler.swift:98-112). Both let lookalike
/// origins load INSIDE the shell, where Capacitor's prompt() cookie channel and its blanket media-capture grant are not
/// covered by the bridge wrapper.
final class ReviewI0Tests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!

    private func leavesShell(_ s: String, file: StaticString = #filePath, line: UInt = #line) {
        let url = URL(string: s)!
        XCTAssertTrue(
            guardian.shouldOpenInSafari(url: url, isNewWindow: false, isMainFrameTarget: true),
            "top-level navigation to \(s) must leave the shell (I14), not fall through to Capacitor",
            file: file, line: line
        )
    }

    /// FAILS: Capacitor allows this in-view because the string starts with "https://relay.example.test".
    func testPrefixLookalikeHostLeavesShell() {
        leavesShell("https://relay.example.test.evil.test/login")
    }

    /// FAILS: Capacitor allows this in-view: the userinfo trick also passes its starts(with:) check (host is evil.test).
    func testUserinfoLookalikeLeavesShell() {
        leavesShell("https://relay.example.test\u{40}evil.test/login")
    }

    /// FAILS: allowNavigation is matched on the host only (no port), so another port on the relay host loads in-view.
    func testOtherPortOnRelayHostLeavesShell() {
        leavesShell("https://relay.example.test:8443/")
    }

    /// FAILS: scheme downgrade on the relay host also passes Capacitor's port-blind host match (ATS may still block it).
    func testHttpOnRelayHostLeavesShell() {
        leavesShell("http://relay.example.test/")
    }

    /// FAILS: a trailing-dot host is a different origin to WebKit, so the gate's relay comparison misses its /media/ path.
    func testTrailingDotRelayMediaLeavesShell() {
        leavesShell("https://relay.example.test./media/abc/page")
    }

    /// FAILS: any other host at top level (Capacitor sends it to the Safari app via UIApplication.open, not to
    /// SFSafariViewController; spec I14 wants the gate to own this decision).
    func testUnrelatedHostLeavesShell() {
        leavesShell("https://example.org/")
    }

    /// Passes today; regression guard for the cases the PR does cover.
    func testCoveredCasesStayCovered() {
        leavesShell("https://RELAY.example.test/MEDIA/abc/page")
        leavesShell("https://relay.example.test:443/media/abc")
        leavesShell("https://relay.example.test/a/..//%6Dedia/x")
        XCTAssertFalse(guardian.shouldOpenInSafari(
            url: URL(string: "https://relay.example.test/threads")!, isNewWindow: false, isMainFrameTarget: true))
    }

    /// Passes: plugin calls from every lookalike are dropped by the origin check. Kept so a fix to the gate can't
    /// loosen the call filter.
    func testLookalikesNeverGetPluginCalls() {
        for (scheme, host, port) in [
            ("https", "relay.example.test.evil.test", 0), ("https", "evil.test", 0), ("https", "relay.example.test.", 0),
            ("https", "relay.example.test", 8443), ("http", "relay.example.test", 0), ("", "", 0),
        ] {
            let o = host.isEmpty ? nil : Origin(scheme: scheme, host: host, port: port)
            XCTAssertFalse(guardian.allowsPluginCall(
                isMainFrame: true, frameOrigin: o, pageURL: URL(string: "https://relay.example.test/")), "\(scheme)://\(host):\(port)")
        }
    }
}
