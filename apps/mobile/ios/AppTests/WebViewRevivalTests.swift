import UIKit
import WebKit
import XCTest

@testable import App

/// The resume decision, without a web process: a page that is dead or stuck on return to the front is brought back, once; a live,
/// slow or busy one is left alone.
@MainActor
final class WebViewRevivalTests: XCTestCase {
    /// Every effect recorded; the test answers the pings itself. Closures hold the rig weakly, so it is freed with the test.
    @MainActor
    private final class Rig {
        var hasPage = true
        var busy = false
        var active = true
        var pings: [(timeout: TimeInterval, done: (PagePulse) -> Void)] = []
        var hops: [() -> Void] = []
        var reloads = 0
        var rebuilds = 0
        private(set) var revival: WebViewRevival!
        init() {
            revival = WebViewRevival(
                hasPage: { [unowned self] in hasPage }, isBusy: { [unowned self] in busy }, isActive: { [unowned self] in active },
                ping: { [unowned self] t, d in pings.append((t, d)) }, hop: { [unowned self] in hops.append($0) },
                reload: { [unowned self] in reloads += 1 }, rebuild: { [unowned self] in rebuilds += 1 })
        }
        /// Answers the n-th ping; a missing ping is a failed test, not a crash.
        func answer(_ n: Int, _ pulse: PagePulse, file: StaticString = #filePath, line: UInt = #line) {
            guard pings.indices.contains(n) else { return XCTFail("no ping \(n) was asked", file: file, line: line) }
            pings[n].done(pulse)
        }
        /// Runs what was deferred one run-loop turn.
        func turn() {
            let run = hops
            hops = []
            run.forEach { $0() }
        }
    }

    // MARK: Nothing there to ask

    func testAPageWithNoURLAndNoLoadIsReloadedWithoutAsking() {
        let r = Rig(); r.hasPage = false
        r.revival.appDidForeground()
        XCTAssertEqual(r.reloads, 1)
        XCTAssertTrue(r.pings.isEmpty, "nothing to ask: there is no document")
    }

    func testAPageWithNoURLWhileALoadRunsIsNotInterruptedButStillAsked() {
        let r = Rig(); r.hasPage = false; r.busy = true
        r.revival.appDidForeground()
        XCTAssertEqual(r.reloads, 0, "a load that is running is left to finish")
        XCTAssertEqual(r.pings.count, 1, "a load that goes nowhere is the stuck case")
    }

    // MARK: A live page

    func testALivePageIsLeftAlone() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .answered)
        r.turn()
        XCTAssertEqual(r.reloads + r.rebuilds, 0)
    }

    func testASlowPageThatAnswersTheSecondAskIsLeftAlone() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .silent)
        XCTAssertEqual(r.rebuilds, 0, "one silence is a page that is busy waking up")
        XCTAssertEqual(r.pings.map(\.timeout), [WebViewRevival.firstTimeout, WebViewRevival.secondTimeout], "the second ask gets more time")
        r.answer(1, .answered)
        XCTAssertEqual(r.reloads + r.rebuilds, 0)
    }

    // MARK: A stuck page

    func testAPageSilentTwiceGetsANewWebView() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .silent); r.answer(1, .silent)
        XCTAssertEqual(r.rebuilds, 1, "a load would queue behind the stuck process")
        XCTAssertEqual(r.reloads, 0)
    }

    func testALoadRunningDoesNotHideAStuckProcess() {
        let r = Rig(); r.busy = true
        r.revival.appDidForeground()
        r.answer(0, .silent); r.answer(1, .silent)
        XCTAssertEqual(r.rebuilds, 1, "busy only keeps a reload away; it never excuses a silent process")
    }

    func testTheOfflinePageDoesNotHideAStuckProcessEither() {
        let r = Rig(); r.busy = true // the offline page counts as busy
        r.revival.appDidForeground()
        r.answer(0, .silent); r.answer(1, .silent)
        XCTAssertEqual(r.rebuilds, 1)
    }

    func testASilenceThatLandsInTheBackgroundSaysNothingAboutThePage() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .silent)
        r.active = false // the app left the front before the second ask ended
        r.answer(1, .silent)
        XCTAssertEqual(r.rebuilds, 0)
    }

    func testLeavingTheFrontVoidsACheckInFlight() {
        let r = Rig()
        r.revival.appDidForeground()
        r.revival.cancel()
        r.answer(0, .silent)
        XCTAssertEqual(r.pings.count, 1, "a void answer asks nothing more")
        XCTAssertEqual(r.rebuilds, 0)
    }

    func testAnAnswerFromAnEarlierForegroundDoesNotActInALaterOne() {
        let r = Rig()
        r.revival.appDidForeground() // ping 0
        r.revival.cancel()
        r.revival.appDidForeground() // ping 1
        r.answer(0, .silent); r.answer(0, .silent) // the old check's answers, any number of them
        XCTAssertEqual(r.pings.count, 2, "the old check asks nothing more")
        XCTAssertEqual(r.rebuilds, 0)
        r.answer(1, .answered)
        XCTAssertEqual(r.reloads + r.rebuilds, 0)
    }

    // MARK: A page whose process is gone

    func testAPageWhoseProcessIsGoneIsReloadedAfterOneTurnWhenNothingLoads() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .failed)
        XCTAssertEqual(r.reloads, 0, "Capacitor's own reload gets the first turn")
        r.turn()
        XCTAssertEqual(r.reloads, 1)
        XCTAssertEqual(r.rebuilds, 0)
    }

    func testAPageWhoseProcessIsGoneIsNotReloadedTwiceWhenCapacitorAlreadyLoads() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .failed)
        r.busy = true // Capacitor's reload started
        r.turn()
        XCTAssertEqual(r.reloads, 0)
    }

    func testAReloadThatIsDueWhenTheAppLeavesIsDropped() {
        let r = Rig()
        r.revival.appDidForeground()
        r.answer(0, .failed)
        r.revival.cancel()
        r.turn()
        XCTAssertEqual(r.reloads, 0)
    }

    // MARK: No loops

    func testAForegroundThatFiresTwiceWhileAskingActsOnce() {
        let r = Rig()
        r.revival.appDidForeground()
        r.revival.appDidForeground()
        XCTAssertEqual(r.pings.count, 1, "one check at a time")
        r.answer(0, .failed); r.turn()
        XCTAssertEqual(r.reloads, 1)
    }

    func testAPageThatStaysDeadIsActedOnOncePerForegroundNotInALoop() {
        let r = Rig()
        r.revival.appDidForeground(); r.answer(0, .failed); r.turn()
        XCTAssertEqual(r.reloads, 1)
        XCTAssertEqual(r.pings.count, 1, "the reload does not start another check")
        r.revival.appDidForeground(); r.answer(1, .failed); r.turn()
        XCTAssertEqual(r.reloads, 2, "the next foreground is a new chance")
    }

    func testTheRigIsFreedWithTheTest() {
        weak var weakRig: Rig?
        autoreleasepool {
            let r = Rig()
            weakRig = r
            r.revival.appDidForeground()
        }
        XCTAssertNil(weakRig, "the rig's closures must not hold it")
    }
}

/// `WebViewRevival.ping` and how an error reads, with a fake script runner and clock.
@MainActor
final class WebViewPingTests: XCTestCase {
    @MainActor
    private final class Rig {
        var replies: [(Error?) -> Void] = []
        var timers: [(TimeInterval, () -> Void)] = []
        var results: [PagePulse] = []
        init(timeout: TimeInterval = 2) {
            // The stored closures reach the rig weakly, so it is freed with the test.
            WebViewRevival.ping(
                timeout: timeout, evaluate: { [weak self] in self?.replies.append($0) },
                after: { [weak self] in self?.timers.append(($0, $1)) }, { [weak self] in self?.results.append($0) })
        }
    }

    private func wk(_ code: WKError.Code) -> NSError { NSError(domain: WKError.errorDomain, code: code.rawValue) }

    func testAScriptThatRunsIsAnswered() {
        let r = Rig()
        r.replies[0](nil)
        XCTAssertEqual(r.results, [.answered])
    }

    func testAGoneProcessIsFailedWhateverTheErrorSaysElse() {
        XCTAssertEqual(WebViewRevival.pulse(for: wk(.webContentProcessTerminated)), .failed)
        XCTAssertEqual(WebViewRevival.pulse(for: wk(.webViewInvalidated)), .failed)
    }

    func testAScriptThatThrewOrReturnedAnOddTypeMeansThePageIsThere() {
        XCTAssertEqual(WebViewRevival.pulse(for: wk(.javaScriptExceptionOccurred)), .answered)
        XCTAssertEqual(WebViewRevival.pulse(for: wk(.javaScriptResultTypeIsUnsupported)), .answered)
        XCTAssertEqual(WebViewRevival.pulse(for: NSError(domain: NSURLErrorDomain, code: -1009)), .answered)
        XCTAssertEqual(WebViewRevival.pulse(for: nil), .answered)
    }

    func testAnErrorFromTheGoneProcessComesThroughThePing() {
        let r = Rig()
        r.replies[0](wk(.webContentProcessTerminated))
        XCTAssertEqual(r.results, [.failed])
    }

    func testNoAnswerInTimeIsSilent() {
        let r = Rig(timeout: 5)
        XCTAssertEqual(r.timers.map(\.0), [5], "the timeout is the one asked for")
        r.timers[0].1()
        XCTAssertEqual(r.results, [.silent])
    }

    func testALateAnswerAfterTheTimeoutIsIgnored() {
        let r = Rig()
        r.timers[0].1()
        r.replies[0](nil)
        XCTAssertEqual(r.results, [.silent], "answered once, by the timeout")
    }

    func testATimeoutAfterTheAnswerIsIgnoredAndASecondAnswerToo() {
        let r = Rig()
        r.replies[0](nil)
        r.replies[0](wk(.webContentProcessTerminated))
        r.timers[0].1()
        XCTAssertEqual(r.results, [.answered])
    }
}
