import XCTest
@testable import TalosPushCore

/// How a Reply or Approve press from a notification ends. The relay, iOS and the failure notice are closures here; the rules
/// under test are the real ones in QuickActRun.
final class QuickActRunTests: XCTestCase {
    private final class World {
        var notices: [String] = []
        var completions = 0
        var backgroundEnds = 0
        var sent: [Data] = []
        var waits = 0
        var answers: [(Int?, String?)] = []
        var pendingRetry: [() -> Void] = []
        lazy var run = QuickActRun(
            notifyFailure: { [unowned self] message, then in notices.append(message); then() },
            complete: { [unowned self] in completions += 1 },
            endBackgroundTask: { [unowned self] in backgroundEnds += 1 })

        func go(_ body: String = "frame") {
            run.send(
                body: Data(body.utf8),
                transport: { [unowned self] data, reply in
                    sent.append(data)
                    let a = answers.isEmpty ? (nil, nil) : answers.removeFirst()
                    reply(a.0, a.1)
                },
                retryLater: { [unowned self] work in waits += 1; pendingRetry.append(work) })
        }
        func runRetries() { let p = pendingRetry; pendingRetry = []; p.forEach { $0() } }
    }

    func testAnAcceptedPressEndsOnceWithNoNotice() {
        let w = World(); w.answers = [(200, nil)]
        w.go()
        XCTAssertEqual(w.notices, [])
        XCTAssertEqual(w.completions, 1)
        XCTAssertEqual(w.backgroundEnds, 1)
    }

    func testARefusalIsNeverShownAsSent() {
        let w = World(); w.answers = [(409, "card_hash_mismatch")]
        w.go()
        XCTAssertEqual(w.notices, ["This one needs you to open Talos."])
        XCTAssertEqual(w.completions, 1)
        XCTAssertEqual(w.sent.count, 1, "a refusal is not retried")
    }

    func testAnAnswerWithNoCodeStillCountsAsAFailure() {
        let w = World(); w.answers = [(400, nil)]
        w.go()
        XCTAssertEqual(w.notices.count, 1)
        XCTAssertEqual(w.completions, 1)
    }

    func testNoSignalRetriesOnceWithTheSameBodyThenTells() {
        let w = World(); w.answers = [(nil, nil), (nil, nil)]
        w.go("same-id-frame")
        XCTAssertEqual(w.notices, [], "the owner is not told until the retry has failed")
        XCTAssertEqual(w.waits, 1)
        w.runRetries()
        XCTAssertEqual(w.sent.count, 2)
        XCTAssertEqual(w.sent[0], w.sent[1], "the retry reuses the frame, so the relay can answer done at most once")
        XCTAssertEqual(w.notices, [QuickActRun.noSignalMessage])
        XCTAssertEqual(w.completions, 1)
        XCTAssertEqual(w.waits, 1, "never a third try")
    }

    func testARetryThatSucceedsEndsWithNoNotice() {
        let w = World(); w.answers = [(503, nil), (200, nil)]
        w.go()
        w.runRetries()
        XCTAssertEqual(w.notices, [])
        XCTAssertEqual(w.completions, 1)
    }

    func testRunningOutOfBackgroundTimeSaysSoAndALateAnswerAddsNothing() {
        let w = World()
        w.run.timeExpired()
        XCTAssertEqual(w.notices, [QuickActRun.outOfTimeMessage])
        XCTAssertEqual(w.completions, 1)
        w.run.conclude(nil)               // the network answers after iOS gave up
        w.run.conclude("Late failure")
        XCTAssertEqual(w.notices, [QuickActRun.outOfTimeMessage])
        XCTAssertEqual(w.completions, 1, "the system's completion handler is called once")
    }

    func testAnAnswerThenTimeExpiryDoesNotCompleteTwiceOrWarn() {
        let w = World(); w.answers = [(200, nil)]
        w.go()
        w.run.timeExpired()
        XCTAssertEqual(w.notices, [])
        XCTAssertEqual(w.completions, 1)
    }

    func testTheTypedWordsNeverReachAFailureNotice() {
        let w = World(); w.answers = [(404, "unknown_thread")]
        w.go("secret typed words")
        XCTAssertFalse(w.notices.joined().contains("secret"))
    }
}
