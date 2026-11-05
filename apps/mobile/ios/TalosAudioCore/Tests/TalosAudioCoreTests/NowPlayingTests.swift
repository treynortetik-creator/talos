import XCTest
@testable import TalosAudioCore

final class FakeNowPlaying: NowPlayingDriving {
    enum Event: Equatable { case publish(NowPlayingInfo), withdraw, enable(Set<RemoteAction>) }
    var events: [Event] = []
    func publish(_ info: NowPlayingInfo) { events.append(.publish(info)) }
    func withdraw() { events.append(.withdraw) }
    func enable(_ actions: Set<RemoteAction>) { events.append(.enable(actions)) }
}

final class NowPlayingTests: XCTestCase {
    private func make() -> (NowPlayingController, FakeNowPlaying, Box) {
        let d = FakeNowPlaying()
        let c = NowPlayingController(driver: d)
        let box = Box()
        c.emit = { box.got.append(Got(action: $0, position: $1)) }
        return (c, d, box)
    }
    struct Got: Equatable { var action: String; var position: Double? }
    final class Box: @unchecked Sendable { var got: [Got] = [] }

    func testSetPublishesTitleDurationPositionRateAndEnablesOnlyAskedActions() {
        let (c, d, _) = make()
        c.set(title: "Weekly report", artist: "Talos", duration: 720, position: 30, rate: 1.5,
              actions: ["play", "pause", "seekbackward", "seekforward", "bogus"])
        XCTAssertEqual(d.events, [
            .publish(NowPlayingInfo(title: "Weekly report", artist: "Talos", duration: 720, position: 30, rate: 1.5)),
            .enable([.play, .pause, .seekbackward, .seekforward]),
        ])
    }

    func testHostileNumbersAreClamped() {
        let (c, _, _) = make()
        c.set(title: "x", artist: nil, duration: 100, position: 5000, rate: 99, actions: [])
        XCTAssertEqual(c.info?.position, 100)
        XCTAssertEqual(c.info?.rate, NowPlayingController.maxRate)
        c.set(title: "x", artist: nil, duration: .nan, position: -4, rate: .infinity, actions: [])
        XCTAssertNil(c.info?.duration)
        XCTAssertEqual(c.info?.position, 0)
        XCTAssertEqual(c.info?.rate, 0)
        c.set(title: "x", artist: nil, duration: -5, position: .nan, rate: -1, actions: [])
        XCTAssertNil(c.info?.duration)
        XCTAssertEqual(c.info?.rate, 0)
    }

    func testTitleIsBoundedStrippedAndNeverEmpty() {
        let (c, _, _) = make()
        c.set(title: String(repeating: "a", count: 500), artist: "Ta\nlos\u{0007}", duration: nil, position: 0, rate: 0, actions: [])
        XCTAssertEqual(c.info?.title.count, NowPlayingController.maxTextLength)
        XCTAssertEqual(c.info?.artist, "Talos")
        c.set(title: "   ", artist: nil, duration: nil, position: 0, rate: 0, actions: [])
        XCTAssertEqual(c.info?.title, "Talos")
    }

    func testUpdateMovesPositionAndRateButKeepsTitleAndCommands() {
        let (c, d, _) = make()
        c.set(title: "T", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play"])
        d.events.removeAll()
        c.update(duration: nil, position: 12, rate: 0)
        XCTAssertEqual(d.events, [.publish(NowPlayingInfo(title: "T", artist: "A", duration: 60, position: 12, rate: 0))])
        c.update(duration: nil, position: 9999, rate: nil)
        XCTAssertEqual(c.info?.position, 60)
    }

    func testUpdateAfterClearDoesNotBringTheLockScreenBack() {
        let (c, d, _) = make()
        c.set(title: "T", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play"])
        c.clear()
        d.events.removeAll()
        c.update(duration: 60, position: 5, rate: 1)
        XCTAssertEqual(d.events, [])
        XCTAssertNil(c.info)
    }

    func testClearWithdrawsInfoAndTurnsEveryCommandOff() {
        let (c, d, _) = make()
        c.set(title: "T", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play", "pause"])
        d.events.removeAll()
        c.clear()
        XCTAssertEqual(d.events, [.withdraw, .enable([])])
        XCTAssertEqual(c.enabledActions, [])
        d.events.removeAll()
        c.clear() // a second clear is a no-op, not a second withdraw
        XCTAssertEqual(d.events, [])
    }

    func testCommandsReachThePageOnlyWhenAskedForAndPublished() {
        let (c, _, box) = make()
        XCTAssertFalse(c.handle(.play)) // nothing published yet
        c.set(title: "T", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play", "seekto"])
        XCTAssertTrue(c.handle(.play))
        XCTAssertFalse(c.handle(.pause)) // the page did not register pause
        XCTAssertTrue(c.handle(.seekto, position: 42))
        XCTAssertFalse(c.handle(.seekto, position: .nan))
        XCTAssertFalse(c.handle(.seekto, position: -1))
        XCTAssertEqual(box.got, [Got(action: "play", position: nil), Got(action: "seekto", position: 42)])
        c.clear()
        XCTAssertFalse(c.handle(.play)) // a command after clear() goes nowhere
        XCTAssertEqual(box.got.count, 2)
    }

    func testSecondSetWithSameActionsDoesNotReRegisterCommands() {
        let (c, d, _) = make()
        c.set(title: "T", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play"])
        d.events.removeAll()
        c.set(title: "T2", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play"])
        XCTAssertEqual(d.events.filter { if case .enable = $0 { return true } else { return false } }, [])
        c.set(title: "T2", artist: "A", duration: 60, position: 0, rate: 1, actions: ["play", "pause"])
        XCTAssertTrue(d.events.contains(.enable([.play, .pause])))
    }
}
