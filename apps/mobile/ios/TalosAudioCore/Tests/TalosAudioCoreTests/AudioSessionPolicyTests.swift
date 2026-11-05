import XCTest
@testable import TalosAudioCore

final class FakeSession: AudioSessionDriving {
    enum Event: Equatable { case apply(SessionConfig), active(Bool, Bool) }
    var events: [Event] = []
    var failNext = false
    var failDeactivate = false
    func apply(_ config: SessionConfig) throws {
        if failNext { failNext = false; throw NSError(domain: "x", code: 1) }
        events.append(.apply(config))
    }
    func setActive(_ active: Bool, notifyOthers: Bool) throws {
        if failDeactivate && !active { throw NSError(domain: "busy", code: 560030580) }
        events.append(.active(active, notifyOthers))
    }
}

final class Counter: @unchecked Sendable { var n = 0 }

final class AudioSessionPolicyTests: XCTestCase {
    func testLaunchParksMixingAndNeverActivates() throws {
        let s = FakeSession()
        try AudioSessionPolicy(driver: s).configureAtLaunch()
        XCTAssertEqual(s.events, [.apply(.parked)])
        XCTAssertTrue(SessionConfig.parked.mixWithOthers)
        XCTAssertFalse(s.events.contains { if case .active = $0 { return true } else { return false } })
    }

    func testReplyActivatesWithoutMixingThenReleasesAndNotifiesOthers() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.configureAtLaunch()
        try p.set(.playback)
        XCTAssertEqual(s.events.suffix(2), [.apply(.playing), .active(true, false)])
        XCTAssertFalse(SessionConfig.playing.mixWithOthers)
        try p.set(.idle)
        XCTAssertEqual(s.events.suffix(2), [.active(false, true), .apply(.parked)])
        XCTAssertEqual(p.mode, .idle)
    }

    func testPausedKeepsTheSessionActiveAndNotMixing() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.configureAtLaunch()
        try p.set(.playback)
        try p.set(.paused)
        // no deactivate, no notify-others, no parking: iOS keeps Talos as the Now Playing app while the clip waits
        XCTAssertEqual(s.events.suffix(2), [.apply(.playing), .active(true, false)])
        XCTAssertFalse(s.events.contains(.active(false, true)))
        XCTAssertEqual(p.mode, .paused)
        // only an explicit idle gives the route back
        try p.set(.idle)
        XCTAssertEqual(s.events.suffix(2), [.active(false, true), .apply(.parked)])
        XCTAssertEqual(p.mode, .idle)
    }

    func testAPausedClipDoesNotRetakeTheRouteAfterACall() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.set(.paused)
        let before = s.events.count
        p.interruptionBegan()
        try p.interruptionEnded(shouldResume: true)
        XCTAssertEqual(s.events.count, before)
    }

    func testRecordingUsesPlayAndRecordWithSpeakerAndBluetooth() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.set(.record)
        XCTAssertEqual(s.events, [.apply(.recording), .active(true, false)])
        XCTAssertEqual(SessionConfig.recording.category, .playAndRecord)
        XCTAssertTrue(SessionConfig.recording.defaultToSpeaker)
        // recording then playback (the order the drive controller uses) re-categorises before it activates
        try p.set(.playback)
        XCTAssertEqual(s.events.suffix(2), [.apply(.playing), .active(true, false)])
    }

    func testIdleWhenAlreadyIdleDoesNotDeactivateAnInactiveSession() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.configureAtLaunch()
        try p.set(.idle)
        XCTAssertEqual(s.events, [.apply(.parked), .apply(.parked)])
    }

    func testFailureKeepsTheOldModeAndThrows() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.set(.playback)
        s.failNext = true
        XCTAssertThrowsError(try p.set(.record))
        XCTAssertEqual(p.mode, .playback)
    }

    func testRefusedDeactivateStillParksAndEndsIdle() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        let warned = Counter()
        p.onWarning = { _ in warned.n += 1 }
        try p.set(.playback)
        s.failDeactivate = true
        s.events.removeAll()
        try p.set(.idle)
        XCTAssertEqual(p.mode, .idle)
        XCTAssertEqual(s.events, [.apply(.parked)])
        XCTAssertEqual(warned.n, 1)
        // The next idle (or reset) retries the release.
        s.failDeactivate = false
        p.reset()
        XCTAssertEqual(s.events.suffix(2), [.active(false, true), .apply(.parked)])
    }

    func testResetGivesTheRouteBackAndIsHarmlessWhenIdle() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.configureAtLaunch()
        p.reset()
        XCTAssertEqual(s.events, [.apply(.parked), .apply(.parked)])
        try p.set(.record)
        p.reset()
        XCTAssertEqual(p.mode, .idle)
        XCTAssertEqual(s.events.suffix(2), [.active(false, true), .apply(.parked)])
    }

    func testInterruptionResumesOnlyWithShouldResumeAndOnlyWhileSomethingWasPlaying() throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        try p.configureAtLaunch()
        p.interruptionBegan()
        try p.interruptionEnded(shouldResume: true)
        XCTAssertEqual(s.events, [.apply(.parked)])  // idle: nothing to resume
        try p.set(.playback)
        s.events.removeAll()
        p.interruptionBegan()
        try p.interruptionEnded(shouldResume: false)  // the system says don't: leave the session alone
        XCTAssertEqual(s.events, [])
        p.interruptionBegan()
        try p.interruptionEnded(shouldResume: true)
        XCTAssertEqual(s.events, [.apply(.playing), .active(true, false)])
        try p.interruptionEnded(shouldResume: true)  // an end with no begin does nothing
        XCTAssertEqual(s.events.count, 2)
    }

    func testCallsFromManyThreadsNeverCrashOrCorruptMode() async throws {
        let s = FakeSession()
        let p = AudioSessionPolicy(driver: s)
        await withTaskGroup(of: Void.self) { g in
            for i in 0..<200 {
                g.addTask {
                    switch i % 4 {
                    case 0: try? p.set(.playback)
                    case 1: try? p.set(.record)
                    case 2: p.reset()
                    default: p.interruptionBegan(); try? p.interruptionEnded(shouldResume: true)
                    }
                }
            }
        }
        p.reset()
        XCTAssertEqual(p.mode, .idle)
    }

    func testModeStringsMatchTheWebAdapter() {
        XCTAssertEqual(Set(AudioMode.allCases.map(\.rawValue)), ["playback", "paused", "record", "idle"])
        XCTAssertNil(AudioMode(rawValue: "PLAYBACK"))
        XCTAssertNil(AudioMode(rawValue: "auto"))
    }
}
