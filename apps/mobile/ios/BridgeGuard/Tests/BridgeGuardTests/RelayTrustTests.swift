import XCTest
@testable import BridgeGuard

/// One shared trust reference reaches every guarded site. Only `.pass` exists for now, so behaviour is the same as before.
final class RelayTrustTests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!
    let relay = Origin(scheme: "https", host: "relay.example.test", port: 0)
    let page = URL(string: "https://relay.example.test/threads")!

    func testANewTrustPasses() {
        XCTAssertEqual(RelayTrust().state, .pass)
        XCTAssertTrue(RelayTrustState.pass.allowsNativeFeatures)
    }

    func testEveryGuardedDecisionTakesTheState() {
        let state = RelayTrust().state
        XCTAssertTrue(guardian.allowsPluginCall(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state))
        XCTAssertTrue(guardian.allowsPromptChannel(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state))
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state), .grant)
    }

    func testTheTrustIsOneSharedReference() {
        let trust = RelayTrust()
        let holders = [trust, trust]
        XCTAssertTrue(holders[0] === holders[1])
    }
}
