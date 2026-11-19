import XCTest
@testable import BridgeGuard

/// One shared trust reference reaches every guarded site, and the state it holds decides each of them. Time comes from an
/// injected clock, so the 24-hour limit and the page's pacing are tested without waiting.
final class RelayTrustTests: XCTestCase {
    let guardian = BridgeGuard(relayURL: URL(string: "https://relay.example.test")!)!
    let relay = Origin(scheme: "https", host: "relay.example.test", port: 0)
    let page = URL(string: "https://relay.example.test/threads")!
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    let hour: TimeInterval = 3600

    final class Clock {
        var now: Date
        init(_ d: Date) { now = d }
    }

    private func trust(_ state: RelayTrustState = .pass, last: Date?, _ clock: Clock) -> RelayTrust {
        RelayTrust(state, lastVerified: last, now: { clock.now })
    }

    // MARK: what each state allows

    func testOnlyPassAllowsNativeFeatures() {
        XCTAssertTrue(RelayTrustState.pass.allowsNativeFeatures)
        XCTAssertFalse(RelayTrustState.unverified(lastVerified: t0, reason: .macOffline).allowsNativeFeatures)
        XCTAssertFalse(RelayTrustState.failed(reason: "wrong_fp").allowsNativeFeatures)
        XCTAssertFalse(RelayTrustState.hardBlock(lastVerified: t0).allowsNativeFeatures)
    }

    func testOnlyPassAndUnverifiedLoadAPage() {
        XCTAssertTrue(RelayTrustState.pass.loadsPage)
        XCTAssertTrue(RelayTrustState.unverified(lastVerified: t0, reason: .checking).loadsPage)
        XCTAssertFalse(RelayTrustState.failed(reason: "bad_sig").loadsPage)
        XCTAssertFalse(RelayTrustState.hardBlock(lastVerified: t0).loadsPage)
    }

    func testEveryGuardedDecisionRefusesWhenNotPass() {
        let states: [RelayTrustState] = [
            .unverified(lastVerified: t0, reason: .network), .failed(reason: "bad_sig"), .hardBlock(lastVerified: nil),
        ]
        for state in states {
            XCTAssertFalse(guardian.allowsPluginCall(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state), "\(state)")
            XCTAssertFalse(guardian.allowsPromptChannel(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state), "\(state)")
            XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: state), .deny, "\(state)")
        }
        XCTAssertTrue(guardian.allowsPluginCall(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: .pass))
        XCTAssertEqual(guardian.devicePermission(isMainFrame: true, frameOrigin: relay, pageURL: page, trust: .pass), .grant)
    }

    func testTheTrustIsOneSharedReference() {
        let trust = RelayTrust()
        let holders = [trust, trust]
        XCTAssertTrue(holders[0] === holders[1])
    }

    // MARK: the state machine

    func testAPairedRelayStartsUnverifiedNotPass() {
        let clock = Clock(t0)
        let t = trust(.unverified(lastVerified: t0, reason: .checking), last: t0, clock)
        XCTAssertEqual(t.state, .unverified(lastVerified: t0, reason: .checking))
        XCTAssertFalse(t.settled, "the first check has not answered yet")
    }

    func testPassRenewsTheLastVerifiedTime() {
        let clock = Clock(t0)
        let t = trust(.unverified(lastVerified: nil, reason: .checking), last: nil, clock)
        clock.now = t0.addingTimeInterval(5)
        t.markPass()
        XCTAssertEqual(t.state, .pass)
        XCTAssertEqual(t.lastVerifiedAt, t0.addingTimeInterval(5))
    }

    func testUnverifiedKeepsTheLastVerifiedTimeAndGivesTheReason() {
        let clock = Clock(t0)
        let t = trust(last: t0, clock)
        clock.now = t0.addingTimeInterval(hour)
        t.markUnverified(.macOffline)
        XCTAssertEqual(t.state, .unverified(lastVerified: t0, reason: .macOffline))
        XCTAssertEqual(t.lastVerifiedAt, t0)
    }

    func testHardBlockAt24HoursFromTheLastVerifiedNotFromPairing() {
        let clock = Clock(t0)
        let t = trust(last: t0, clock)
        t.markUnverified(.network)
        clock.now = t0.addingTimeInterval(24 * hour - 1)
        XCTAssertEqual(t.state, .unverified(lastVerified: t0, reason: .network), "one second inside the window")
        clock.now = t0.addingTimeInterval(24 * hour)
        XCTAssertEqual(t.state, .hardBlock(lastVerified: t0), "exactly 24 hours counts as expired")
        // A pass renews it, and the window counts from that pass.
        t.markPass()
        XCTAssertEqual(t.state, .pass)
        clock.now = t0.addingTimeInterval(24 * hour + 23 * hour)
        t.markUnverified(.network)
        XCTAssertEqual(t.state, .unverified(lastVerified: t0.addingTimeInterval(24 * hour), reason: .network))
        clock.now = t0.addingTimeInterval(48 * hour)
        XCTAssertEqual(t.state, .hardBlock(lastVerified: t0.addingTimeInterval(24 * hour)))
    }

    func testAPassOlderThan24HoursIsAHardBlockToo() {
        // The timer cannot run while the phone sleeps: a stale pass must not keep native features on.
        let clock = Clock(t0)
        let t = trust(last: t0, clock)
        t.markPass()
        clock.now = t0.addingTimeInterval(25 * hour)
        XCTAssertEqual(t.state, .hardBlock(lastVerified: t0))
        XCTAssertFalse(t.state.allowsNativeFeatures)
    }

    func testAFutureLastVerifiedCountsAsExpired() {
        let clock = Clock(t0)
        let future = t0.addingTimeInterval(hour)
        let t = trust(.unverified(lastVerified: future, reason: .network), last: future, clock)
        XCTAssertEqual(t.state, .hardBlock(lastVerified: future))
    }

    func testNeverVerifiedIsAHardBlockOnceItCannotAnswer() {
        let clock = Clock(t0)
        let t = trust(.unverified(lastVerified: nil, reason: .checking), last: nil, clock)
        XCTAssertEqual(t.state, .hardBlock(lastVerified: nil))
    }

    func testFailIsStickyAndNoPassOrUnverifiedUndoesIt() {
        let clock = Clock(t0)
        let t = trust(last: t0, clock)
        t.markFailed("wrong_fp")
        XCTAssertEqual(t.state, .failed(reason: "wrong_fp"))
        t.markPass()
        t.markUnverified(.network)
        XCTAssertEqual(t.state, .failed(reason: "wrong_fp"))
        XCTAssertEqual(t.lastVerifiedAt, t0, "a failed check does not touch the time")
    }

    func testAPageThatIsNoPairedRelayHasNoWindowToExpire() {
        let clock = Clock(t0)
        let t = RelayTrust(.pass, hasWindow: false, now: { clock.now })
        clock.now = t0.addingTimeInterval(1000 * hour)
        XCTAssertEqual(t.state, .pass)
        XCTAssertTrue(t.allowsPageLoad)
    }

    func testAPairedTrustStartedAtPassWithNoTimeIsExpiredNotTrusted() {
        let clock = Clock(t0)
        XCTAssertEqual(RelayTrust(.pass, now: { clock.now }).state, .hardBlock(lastVerified: nil), "a window that was never started never reads as pass")
    }

    func testSettleIsOnceTheFirstCheckAnswered() {
        let clock = Clock(t0)
        let t = trust(.unverified(lastVerified: t0, reason: .checking), last: t0, clock)
        XCTAssertFalse(t.allowsPageLoad)
        t.markUnverified(.macOffline)
        t.settle()
        XCTAssertTrue(t.settled)
        XCTAssertTrue(t.allowsPageLoad, "unverified inside the 24 hours loads the page read-only")
        t.markFailed("bad_sig")
        XCTAssertFalse(t.allowsPageLoad)
    }

    // MARK: pacing

    func testOneAttestInFlightAtATime() {
        var s = AttestSchedule()
        XCTAssertTrue(s.begin(at: t0, fromPage: false))
        XCTAssertFalse(s.begin(at: t0.addingTimeInterval(100), fromPage: false), "one is running")
        s.end()
        XCTAssertTrue(s.begin(at: t0.addingTimeInterval(100), fromPage: false))
    }

    func testThePageNeedsA30SecondGapButNativeTriggersDoNot() {
        var s = AttestSchedule()
        XCTAssertTrue(s.begin(at: t0, fromPage: false))
        s.end()
        XCTAssertFalse(s.begin(at: t0.addingTimeInterval(29.9), fromPage: true), "inside the gap")
        XCTAssertTrue(s.begin(at: t0.addingTimeInterval(1), fromPage: false), "a foreground check is not paced by the page's gap")
        s.end()
        XCTAssertTrue(s.begin(at: t0.addingTimeInterval(31.1), fromPage: true))
    }

    func testAClockStepBackIsInsideTheGap() {
        var s = AttestSchedule()
        XCTAssertTrue(s.begin(at: t0, fromPage: false))
        s.end()
        XCTAssertFalse(s.begin(at: t0.addingTimeInterval(-500), fromPage: true))
    }

    func testTheHardBlockRefreshIsScheduledForExactlyLastVerifiedPlus24Hours() {
        XCTAssertEqual(try XCTUnwrap(RelayTrust.secondsUntilHardBlock(lastVerified: t0, now: t0.addingTimeInterval(hour))), 23 * hour, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(RelayTrust.secondsUntilHardBlock(lastVerified: t0, now: t0)), 24 * hour, accuracy: 0.001)
        XCTAssertNil(RelayTrust.secondsUntilHardBlock(lastVerified: t0, now: t0.addingTimeInterval(24 * hour)), "already expired: nothing to schedule")
        XCTAssertNil(RelayTrust.secondsUntilHardBlock(lastVerified: nil, now: t0), "never verified: already blocked")
        XCTAssertNil(RelayTrust.secondsUntilHardBlock(lastVerified: t0.addingTimeInterval(hour), now: t0), "a future time counts as expired")
    }

    func testThePacingNumbers() {
        XCTAssertEqual(AttestSchedule.timerInterval, 600)
        XCTAssertEqual(AttestSchedule.minGap, 30)
        XCTAssertEqual(RelayTrust.hardBlockAfter, 24 * 3600)
    }
}
