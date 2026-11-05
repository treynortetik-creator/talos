import XCTest
@testable import BridgeGuard

final class BridgeGuardTests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!
    let relay = Origin(scheme: "https", host: "relay.example.test", port: 0)

    private func allows(
        main: Bool = true, origin: Origin? = nil, page: String = "https://relay.example.test/threads"
    ) -> Bool {
        guardian.allowsPluginCall(isMainFrame: main, frameOrigin: origin ?? relay, pageURL: URL(string: page))
    }

    func testAllowsTopFrameOnRelay() {
        XCTAssertTrue(allows())
        XCTAssertTrue(allows(page: "https://relay.example.test/"))
        XCTAssertTrue(allows(page: "https://relay.example.test/t/abc?x=1#y"))
    }

    func testExplicitDefaultPortEqualsImplicit() {
        XCTAssertTrue(allows(origin: Origin(scheme: "https", host: "relay.example.test", port: 443)))
        XCTAssertTrue(allows(page: "https://relay.example.test:443/x"))
    }

    func testHostCaseInsensitive() {
        XCTAssertTrue(allows(origin: Origin(scheme: "HTTPS", host: "Relay.Example.Test", port: nil)))
    }

    func testDropsSubframes() {
        XCTAssertFalse(allows(main: false))
    }

    func testDropsOtherOrigins() {
        XCTAssertFalse(allows(origin: Origin(scheme: "https", host: "evil.test", port: nil)))
        XCTAssertFalse(allows(origin: Origin(scheme: "http", host: "relay.example.test", port: nil)))
        XCTAssertFalse(allows(origin: Origin(scheme: "https", host: "relay.example.test", port: 8443)))
        XCTAssertFalse(allows(origin: Origin(scheme: "https", host: "relay.example.test.evil.test", port: nil)))
        XCTAssertFalse(allows(page: "https://evil.test/threads"))
    }

    func testDropsWhenOriginOrPageUnknown() {
        XCTAssertFalse(guardian.allowsPluginCall(isMainFrame: true, frameOrigin: nil, pageURL: URL(string: "https://relay.example.test/")))
        XCTAssertFalse(guardian.allowsPluginCall(isMainFrame: true, frameOrigin: relay, pageURL: nil))
    }

    func testDropsMediaPaths() {
        for p in [
            "/media/abc", "/media", "/media/abc/page", "/Media/abc", "//media/abc", "/a/../media/abc",
            "/./media/x", "/%6Dedia/x", "/%6dEDIA/x", "/x/%2e%2e/media/x", "/%2Fmedia/x",
        ] {
            XCTAssertFalse(allows(page: "https://relay.example.test" + p), p)
        }
    }

    func testMediaLookalikesAreNotMedia() {
        XCTAssertTrue(allows(page: "https://relay.example.test/mediafoo"))
        XCTAssertTrue(allows(page: "https://relay.example.test/x/media/y"))
        XCTAssertTrue(allows(page: "https://relay.example.test/settings/media"))
    }

    func testCapacitorSchemeRelayDenied() {
        // A build with no relay configured has the capacitor://localhost origin: still a valid, closed origin.
        let g = BridgeGuard(relayURL: URL(string: "capacitor://localhost")!)!
        XCTAssertFalse(g.allowsPluginCall(isMainFrame: true, frameOrigin: relay, pageURL: URL(string: "https://relay.example.test/")))
    }

    func testSafariRouting() {
        let media = URL(string: "https://relay.example.test/media/abc/page")!
        let app = URL(string: "https://relay.example.test/threads")!
        let other = URL(string: "https://example.org/")!
        XCTAssertTrue(guardian.shouldOpenInSafari(url: media, isNewWindow: false, isMainFrameTarget: true))
        XCTAssertTrue(guardian.shouldOpenInSafari(url: media, isNewWindow: true, isMainFrameTarget: false))
        XCTAssertFalse(guardian.shouldOpenInSafari(url: media, isNewWindow: false, isMainFrameTarget: false), "sandboxed iframe stays")
        XCTAssertFalse(guardian.shouldOpenInSafari(url: app, isNewWindow: false, isMainFrameTarget: true))
        XCTAssertTrue(guardian.shouldOpenInSafari(url: app, isNewWindow: true, isMainFrameTarget: false))
        XCTAssertTrue(guardian.shouldOpenInSafari(url: other, isNewWindow: true, isMainFrameTarget: false))
        XCTAssertFalse(guardian.shouldOpenInSafari(url: URL(string: "tel:123")!, isNewWindow: true, isMainFrameTarget: false))
        XCTAssertFalse(guardian.shouldOpenInSafari(url: URL(string: "javascript:alert(1)")!, isNewWindow: true, isMainFrameTarget: false))
    }

    func testUserinfoOnRelayIsNotRelay() {
        XCTAssertFalse(guardian.isRelayURL(URL(string: "https://user\u{40}relay.example.test/")!))
        XCTAssertFalse(guardian.isRelayURL(URL(string: "https://relay.example.test\u{40}evil.test/")!))
        XCTAssertTrue(guardian.isRelayURL(URL(string: "https://relay.example.test/x")!))
        XCTAssertFalse(allows(page: "https://user\u{40}relay.example.test/threads"))
    }

    func testRelayMediaGoesToViewer() {
        XCTAssertTrue(guardian.isRelayMedia(URL(string: "https://relay.example.test/media/x/page")!))
        XCTAssertFalse(guardian.isRelayMedia(URL(string: "https://evil.test/media/x")!))
        XCTAssertFalse(guardian.isRelayMedia(URL(string: "https://relay.example.test/threads")!))
    }

    func testRelayInitRejectsHostless() {
        XCTAssertNil(BridgeGuard(relayURL: URL(string: "file:///tmp/x")!))
    }

    // MARK: shareMedia (the "Share" action on an attachment)

    func testShareMediaURLAcceptsOnlyAMediaIdOnTheRelay() {
        XCTAssertEqual(guardian.shareMediaURL(path: "/media/md_01HZX")?.absoluteString, "https://relay.example.test/media/md_01HZX")
        for bad in [
            "", "/media", "/media/", "/media/md_1/page", "/media/md_1/app", "/media/../threads", "/media/%2e%2e/x",
            "/media/md_1?x=1", "/media/md_1#f", "//evil.test/media/md_1", "https://evil.test/media/md_1",
            "/Media/md_1", "/threads", "/media/md 1", "/media/md_1\n", "/media/" + String(repeating: "a", count: 200),
        ] {
            XCTAssertNil(guardian.shareMediaURL(path: bad), bad)
        }
    }

    func testShareMediaURLKeepsTheRelayPort() {
        let g = BridgeGuard(relayURL: URL(string: "https://relay.example.test:8443")!)!
        XCTAssertEqual(g.shareMediaURL(path: "/media/md_1")?.absoluteString, "https://relay.example.test:8443/media/md_1")
    }

    func testShareFileNameIsSafeToWriteToDisk() {
        XCTAssertEqual(BridgeGuard.shareFileName("notes.pdf"), "notes.pdf")
        XCTAssertEqual(BridgeGuard.shareFileName("../../etc/passwd"), "passwd")
        XCTAssertEqual(BridgeGuard.shareFileName("a\\b/c.txt"), "c.txt")
        XCTAssertEqual(BridgeGuard.shareFileName("re\u{0}po\u{1f}rt\u{7f}.pdf"), "report.pdf")
        XCTAssertEqual(BridgeGuard.shareFileName("fi\u{202E}fdp.exe"), "fifdp.exe")
        XCTAssertEqual(BridgeGuard.shareFileName("..."), "file")
        XCTAssertEqual(BridgeGuard.shareFileName(""), "file")
        XCTAssertEqual(BridgeGuard.shareFileName(".hidden"), "hidden")
        for raw in [" ..", " .", ". .", " . . ", "\t..\n", "\u{00A0}..", ".. "] {
            XCTAssertEqual(BridgeGuard.shareFileName(raw), "file", "\(raw.debugDescription)")
        }
        XCTAssertEqual(BridgeGuard.shareFileName("  ..hidden.pdf "), "hidden.pdf")
        XCTAssertLessThanOrEqual(BridgeGuard.shareFileName(String(repeating: "\u{1F600}", count: 100) + ".pdf").utf8.count, 200)
        XCTAssertTrue(BridgeGuard.shareFileName(String(repeating: "\u{1F600}", count: 100) + ".pdf").hasSuffix(".pdf"))
    }
}

