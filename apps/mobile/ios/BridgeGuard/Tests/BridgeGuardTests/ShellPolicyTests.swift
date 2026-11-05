import XCTest
@testable import BridgeGuard

/// Package E (audit D3, D6, D49): retry, launch fallback and file viewer decisions.
final class ShellPolicyTests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!
    let offline = URL(string: "capacitor://localhost/offline.html")!
    let retry = URL(string: "talos-retry://now")!

    // D3
    func testRetryHonouredOnOfflinePage() {
        XCTAssertTrue(guardian.allowsRetry(url: retry, isMainFrame: true, currentURL: offline))
    }

    func testRetryHonouredWhenNothingLoaded() {
        XCTAssertTrue(guardian.allowsRetry(url: retry, isMainFrame: true, currentURL: nil))
    }

    func testRetryRefusedFromRelayPageSubframeOrMedia() {
        XCTAssertFalse(guardian.allowsRetry(url: retry, isMainFrame: true, currentURL: URL(string: "https://relay.example.test/")!))
        XCTAssertFalse(guardian.allowsRetry(url: retry, isMainFrame: true, currentURL: URL(string: "https://relay.example.test/media/x")!))
        XCTAssertFalse(guardian.allowsRetry(url: retry, isMainFrame: false, currentURL: offline))
    }

    func testOtherSchemesAreNotRetry() {
        XCTAssertFalse(guardian.allowsRetry(url: URL(string: "https://relay.example.test/")!, isMainFrame: true, currentURL: offline))
        XCTAssertFalse(BridgeGuard.isRetryURL(URL(string: "talos-retry-x://now")!))
    }

    func testNetworkBackAndForegroundOnlyActWhenNotOnRelayPage() {
        XCTAssertTrue(guardian.needsRetry(currentURL: offline))
        XCTAssertTrue(guardian.needsRetry(currentURL: URL(string: "https://relay.example.test.evil.test/")!))
        XCTAssertFalse(guardian.needsRetry(currentURL: URL(string: "https://relay.example.test/threads")!))
    }

    // D49
    func testLaunchFallsToOfflineBetween10And15Seconds() {
        XCTAssertGreaterThanOrEqual(BridgeGuard.launchTimeout, 10)
        XCTAssertLessThanOrEqual(BridgeGuard.launchTimeout, 15)
        XCTAssertFalse(BridgeGuard.shouldFallToOffline(elapsed: 3, relayPageFinished: false))
        XCTAssertTrue(BridgeGuard.shouldFallToOffline(elapsed: BridgeGuard.launchTimeout, relayPageFinished: false))
        XCTAssertFalse(BridgeGuard.shouldFallToOffline(elapsed: 60, relayPageFinished: true))
    }

    // D6
    func testAttachmentAndUnshowableTypesDownload() {
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: "attachment; filename=\"a.zip\"", canShowMIMEType: true), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: " Attachment", canShowMIMEType: true), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: nil, canShowMIMEType: false), .download)
    }

    func testShowableInlineTypesShow() {
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: "inline", canShowMIMEType: true), .show)
        XCTAssertEqual(MediaPolicy.classify(statusCode: nil, contentDisposition: nil, canShowMIMEType: true), .show)
    }

    func testFailureStatusNeverShowsBody() {
        for code in [401, 403, 404, 410, 500, 503] {
            guard case .failed(let m) = MediaPolicy.classify(statusCode: code, contentDisposition: "attachment", canShowMIMEType: true)
            else { return XCTFail("\(code) must fail, not show or download") }
            XCTAssertFalse(m.isEmpty)
            XCTAssertFalse(m.lowercased().contains("json"))
        }
        XCTAssertEqual(MediaPolicy.classify(statusCode: 399, contentDisposition: nil, canShowMIMEType: true), .show)
    }

    func testFileNameCannotEscapeTempFolder() {
        XCTAssertEqual(MediaPolicy.safeFileName("../../etc/passwd"), "passwd")
        XCTAssertEqual(MediaPolicy.safeFileName("a\\b\\c.csv"), "c.csv")
        XCTAssertEqual(MediaPolicy.safeFileName(".hidden"), "hidden")
        XCTAssertEqual(MediaPolicy.safeFileName(nil), "file")
        XCTAssertEqual(MediaPolicy.safeFileName("   "), "file")
        XCTAssertEqual(MediaPolicy.safeFileName("report.pdf"), "report.pdf")
        XCTAssertLessThanOrEqual(MediaPolicy.safeFileName(String(repeating: "x", count: 500) + ".pdf").count, 120)
        XCTAssertTrue(MediaPolicy.safeFileName(String(repeating: "x", count: 500) + ".pdf").hasSuffix(".pdf"))
    }

    // Review follow-ups
    func testPdfDownloadsSoItGetsShare() {
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: "inline", canShowMIMEType: true, mimeType: "application/pdf"), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: nil, canShowMIMEType: true, mimeType: "Application/PDF; charset=x"), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: nil, canShowMIMEType: true, mimeType: "video/mp4"), .show)
        // An image opened from the viewer's Save / Share goes to the system preview too (L15).
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: "inline", canShowMIMEType: true, mimeType: "image/png"), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: nil, canShowMIMEType: true, mimeType: "IMAGE/JPEG; q=1"), .download)
        XCTAssertEqual(MediaPolicy.classify(statusCode: 200, contentDisposition: nil, canShowMIMEType: true, mimeType: "imagery/x"), .show)
        guard case .failed = MediaPolicy.classify(statusCode: 410, contentDisposition: nil, canShowMIMEType: true, mimeType: "image/png")
        else { return XCTFail("a gone image must show the failure panel, not download JSON") }
        guard case .failed = MediaPolicy.classify(statusCode: 404, contentDisposition: nil, canShowMIMEType: true, mimeType: "application/pdf")
        else { return XCTFail("a failed PDF stays a failure") }
    }

    func testPluginHandledLoadIsNotAFailure() {
        XCTAssertTrue(MediaPolicy.isPluginHandledLoad(domain: "WebKitErrorDomain", code: 204))
        XCTAssertFalse(MediaPolicy.isPluginHandledLoad(domain: "WebKitErrorDomain", code: 102))
        XCTAssertFalse(MediaPolicy.isPluginHandledLoad(domain: NSURLErrorDomain, code: 204))
        XCTAssertFalse(MediaPolicy.isPluginHandledLoad(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
    }

    func testCancelledLoadIsNotAFailure() {
        XCTAssertTrue(MediaPolicy.isCancelledLoad(domain: NSURLErrorDomain, code: NSURLErrorCancelled))
        XCTAssertTrue(MediaPolicy.isCancelledLoad(domain: "WebKitErrorDomain", code: 102))
        XCTAssertFalse(MediaPolicy.isCancelledLoad(domain: NSURLErrorDomain, code: NSURLErrorTimedOut))
        XCTAssertFalse(MediaPolicy.isCancelledLoad(domain: NSURLErrorDomain, code: -1009))
    }

    func testCommittedRelayLoadGetsALongerLimit() {
        XCTAssertFalse(BridgeGuard.shouldFallToOffline(elapsed: BridgeGuard.launchTimeout + 1, relayPageFinished: false, relayPageCommitted: true))
        XCTAssertTrue(BridgeGuard.shouldFallToOffline(elapsed: BridgeGuard.launchTimeout + 1, relayPageFinished: false, relayPageCommitted: false))
        XCTAssertTrue(BridgeGuard.shouldFallToOffline(elapsed: BridgeGuard.committedLaunchTimeout, relayPageFinished: false, relayPageCommitted: true))
        XCTAssertGreaterThan(BridgeGuard.committedLaunchTimeout, BridgeGuard.launchTimeout)
        XCTAssertEqual(BridgeGuard.launchLimit(relayPageCommitted: false), BridgeGuard.launchTimeout)
    }

    func testFileNameIsBoundedInBytesNotCharacters() {
        for name in [String(repeating: "\u{6F22}", count: 110) + ".pdf", String(repeating: "\u{1F600}", count: 100),
                     String(repeating: "\u{6F22}", count: 100) + ".\u{6F22}\u{6F22}\u{6F22}"] {
            let safe = MediaPolicy.safeFileName(name)
            XCTAssertLessThanOrEqual(safe.utf8.count, 255, safe)
            XCTAssertLessThanOrEqual(safe.utf8.count, MediaPolicy.maxFileNameBytes)
            XCTAssertFalse(safe.isEmpty)
        }
        let pdf = MediaPolicy.safeFileName(String(repeating: "\u{6F22}", count: 110) + ".pdf")
        XCTAssertTrue(pdf.hasSuffix(".pdf"))
        XCTAssertEqual(MediaPolicy.safeFileName("budget \u{6F22}\u{5B57}.csv"), "budget \u{6F22}\u{5B57}.csv")
    }
}
