import XCTest
@testable import BridgeGuard

/// The answers the web view's native hooks hand to WebKit: device permission, the cookie prompt channel, and new windows.
final class WebViewDecisionTests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!
    let relay = Origin(scheme: "https", host: "relay.example.test", port: 0)
    let other = Origin(scheme: "https", host: "evil.example.test", port: 0)
    let page = URL(string: "https://relay.example.test/threads")!
    let mediaPage = URL(string: "https://relay.example.test/media/x.html")!

    func testCameraAndMicAreGrantedToTheAppsOwnTopFrameOnly() {
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: page), .grant)
        // an iframe of agent-written HTML on the same origin
        XCTAssertEqual(guardian.devicePermission(isMainFrame: false, frameOrigin: relay, pageURL: page), .deny)
        // a /media/ page
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: mediaPage), .deny)
        // another origin, and no origin at all
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: other, pageURL: page), .deny)
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: nil, pageURL: page), .deny)
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: nil), .deny)
    }

    func testTheCookiePromptChannelIsOpenToTheTopFrameOnly() {
        XCTAssertTrue(guardian.allowsPromptChannel(isMainFrame: true, frameOrigin: relay, pageURL: page))
        XCTAssertFalse(guardian.allowsPromptChannel(isMainFrame: false, frameOrigin: relay, pageURL: page))
        XCTAssertFalse(guardian.allowsPromptChannel(isMainFrame: true, frameOrigin: relay, pageURL: mediaPage))
        XCTAssertFalse(guardian.allowsPromptChannel(isMainFrame: true, frameOrigin: other, pageURL: page))
    }

    func testNewWindowsGoToSafariOrTheViewerAndNeverLaunchAnotherApp() {
        func act(_ s: String?, trusted: Bool = true) -> BridgeGuard.PopupAction {
            guardian.popupAction(url: s.flatMap { URL(string: $0) }, sourceIsTrusted: trusted)
        }
        XCTAssertEqual(act("https://other.example.test/a"), .openInBrowser)
        XCTAssertEqual(act("http://other.example.test/a"), .openInBrowser)
        XCTAssertEqual(act("https://relay.example.test/media/x.html"), .showMedia)
        XCTAssertEqual(act("https://relay.example.test/threads"), .openInBrowser)
        for refused in ["tel:5550100", "sms:5550100", "javascript:alert(1)", "data:text/html,hi", "someapp://open?x=1", "facetime://a", "file:///etc/hosts"] {
            XCTAssertEqual(act(refused), .refuse, refused)
        }
        XCTAssertEqual(act(nil), .refuse)
    }

    func testMailOpensOnlyFromTheTrustedFrame() {
        XCTAssertEqual(guardian.popupAction(url: URL(string: "mailto:a@example.com"), sourceIsTrusted: true), .openMail)
        XCTAssertEqual(guardian.popupAction(url: URL(string: "mailto:a@example.com"), sourceIsTrusted: false), .refuse)
        XCTAssertEqual(guardian.popupAction(url: URL(string: "MAILTO:a@example.com"), sourceIsTrusted: false), .refuse)
    }
}
