import BridgeGuard
import TalosRelayCore
import XCTest

@testable import App

/// The coordinator that runs the checks and writes their result into the one trust object: what it does for every outcome, the blocking
/// confirm of a key change, the pacing of the page's `recheck()`, and the cookie rule. No network, no UIKit.
@MainActor
final class AttestCoordinatorTests: XCTestCase {
    private let rid = "r_abcdefghijklmnopqrst"
    private let fp = String(repeating: "A", count: 43)
    private let newFp = String(repeating: "B", count: 43)
    private let t0 = Date(timeIntervalSince1970: 2_000_000)
    private var clockNow: Date!

    override func setUp() {
        super.setUp()
        clockNow = t0
    }

    private struct World {
        let store: RelayStore
        let profile: RelayProfile
        let trust: RelayTrust
        let stub: StubAttester
        let coordinator: AttestCoordinator
        let prompts: Prompts
        let removed: Counter
        let changed: Counter
    }

    final class Prompts { var hosts: [String] = []; var answer: RepinChoice = .decline; var hold = false; var waiting: CheckedContinuation<RepinChoice, Never>? }
    final class Counter { var n = 0 }

    private func world(
        verified: Date? = nil, cookie: String? = nil, storeWorks: Bool = true, outcome: AttestOutcome = .verdict(.pass),
        preFailed: Bool = false
    ) throws -> World {
        let store = RelayStore(backing: InMemoryKeychain())
        let lv = verified ?? t0.addingTimeInterval(-3600)
        let profile = RelayProfile(
            id: rid, origin: URL(string: "https://mine.example.com")!, kind: .self, label: "mine.example.com", bridgeFp: fp, deviceId: "",
            dataStoreId: UUID(), addedAt: t0, lastVerifiedAt: lv, attestFailed: preFailed)!
        try store.add(profile)
        let trust = RelayTrust(.unverified(lastVerified: lv, reason: .checking), lastVerified: lv, now: { [unowned self] in clockNow })
        let stub = StubAttester(outcome)
        let prompts = Prompts()
        let removed = Counter(), changed = Counter()
        let coordinator = AttestCoordinator(
            profile: profile, trust: trust, runner: stub, cookie: { cookie }, store: { storeWorks ? store : nil },
            confirmRepin: { host, _ in
                prompts.hosts.append(host)
                if prompts.hold { return await withCheckedContinuation { prompts.waiting = $0 } }
                return prompts.answer
            },
            now: { [unowned self] in clockNow }, changed: { changed.n += 1 }, remove: { removed.n += 1 })
        return World(store: store, profile: profile, trust: trust, stub: stub, coordinator: coordinator, prompts: prompts, removed: removed, changed: changed)
    }

    // MARK: outcomes

    func testAPassMakesItPassAndSavesTheTimeOnThatPairing() async throws {
        let w = try world(cookie: "__Host-talos_s=abc")
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .pass)
        XCTAssertTrue(w.trust.settled)
        XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0, "saved on the profile, by its key id")
        let call = try XCTUnwrap(w.stub.calls.first)
        XCTAssertEqual(call.pinnedFP, fp)
        XCTAssertEqual(call.relayID, rid)
        XCTAssertEqual(call.origin.absoluteString, "https://mine.example.com")
        XCTAssertEqual(call.cookie, "__Host-talos_s=abc", "a paired relay sends its own session cookie")
        XCTAssertEqual(call.context, .reconnect)
        XCTAssertEqual(w.changed.n, 1)
    }

    func testEveryWayTheMacCannotAnswerIsUnverifiedWithItsOwnReasonAndKeepsTheLastTime() async throws {
        let cases: [AttestUnreachable] = [.network, .macOffline, .unsupported, .macTimeout, .rateLimited, .badAnswer]
        for why in cases {
            let w = try world(outcome: .unreachable(why))
            await w.coordinator.run(.launch)
            XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: UnverifiedReason(rawValue: why.rawValue)!), "\(why)")
            XCTAssertTrue(w.trust.settled)
            XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(-3600), "an unverified answer does not touch the saved time")
        }
    }

    func testAFailIsStickyAndNothingChecksAgain() async throws {
        let w = try world(outcome: .verdict(.fail(.wrongFP)))
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .failed(reason: "wrong_fp"))
        w.stub.fallback = .verdict(.pass)
        for t in [AttestCoordinator.Trigger.foreground, .network, .timer, .retry, .page] { await w.coordinator.run(t) }
        XCTAssertEqual(w.stub.calls.count, 1, "no check runs for a failed relay")
        XCTAssertEqual(w.trust.state, .failed(reason: "wrong_fp"))
    }

    func testAPassAfterAnUnverifiedAnswerRenewsTheWindow() async throws {
        let w = try world(outcome: .unreachable(.macOffline))
        await w.coordinator.run(.launch)
        clockNow = t0.addingTimeInterval(7200)
        w.stub.fallback = .verdict(.pass)
        await w.coordinator.run(.foreground)
        XCTAssertEqual(w.trust.state, .pass)
        XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(7200))
    }

    // MARK: a key change: a blocking confirm every time

    func testARepinAsksWithTheHostAndNothingChangesUntilTheOwnerAccepts() async throws {
        let w = try world(outcome: .verdict(.pass))
        w.stub.outcomes = [.verdict(.repin(newFP: newFp))]
        w.prompts.hold = true
        let running = Task { await w.coordinator.run(.launch) }
        for _ in 0..<5000 where w.prompts.waiting == nil { await Task.yield() }
        try XCTUnwrap(w.prompts.waiting, "the confirm was never asked")
        XCTAssertEqual(w.prompts.hosts, ["mine.example.com"], "the confirm shows the host")
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .keyChanged), "not a pass while the question is up")
        XCTAssertEqual(try w.store.active()?.bridgeFp, fp, "nothing is saved before the owner accepts")
        XCTAssertFalse(w.trust.state.allowsNativeFeatures)
        // The owner takes an hour to decide: the answer the key change came with is that old.
        clockNow = t0.addingTimeInterval(3600)
        w.prompts.waiting?.resume(returning: .accept)
        await running.value
        XCTAssertEqual(w.stub.calls.count, 2, "accepting runs a FRESH check against the new key")
        XCTAssertEqual(w.stub.calls.last?.pinnedFP, newFp)
        XCTAssertEqual(w.trust.state, .pass)
        XCTAssertEqual(try w.store.active()?.bridgeFp, newFp, "on accept the stored fp moves")
        XCTAssertEqual(w.coordinator.profile.bridgeFp, newFp)
        XCTAssertEqual(w.trust.lastVerifiedAt, t0.addingTimeInterval(3600), "stamped when the fresh check passed, not when the old answer came")
        XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(3600))
    }

    func testAcceptingIsNotAPassUntilTheFreshCheckPasses() async throws {
        for (fresh, reason) in [(AttestOutcome.unreachable(.macOffline), UnverifiedReason.macOffline), (.unreachable(.network), .network)] {
            let w = try world(outcome: fresh)
            w.stub.outcomes = [.verdict(.repin(newFP: newFp))]
            w.prompts.answer = .accept
            clockNow = t0
            await w.coordinator.run(.launch)
            XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: reason), "an old answer is never stamped as a pass")
            XCTAssertEqual(try w.store.active()?.bridgeFp, newFp, "the new key is saved")
            XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(-3600), "and the verified time did not move")
        }
        let w = try world(outcome: .verdict(.fail(.badSig)))
        w.stub.outcomes = [.verdict(.repin(newFP: newFp))]
        w.prompts.answer = .accept
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .failed(reason: "bad_sig"), "a fresh check that fails is a fail")
    }

    func testAcceptWhileAnotherCheckRunsStillGetsItsFreshCheckWhenThatOneEnds() async throws {
        let w = try world(outcome: .verdict(.pass))
        w.stub.outcomes = [.verdict(.repin(newFP: newFp)), .verdict(.repin(newFP: newFp))]
        w.prompts.hold = true
        let first = Task { await w.coordinator.run(.launch) }
        for _ in 0..<5000 where w.prompts.waiting == nil { await Task.yield() }
        let asking = try XCTUnwrap(w.prompts.waiting, "the confirm was never asked")
        // Another check starts while the owner is being asked (it still pins the old key) and is waiting on the network.
        w.stub.holds = true
        let second = Task { await w.coordinator.run(.foreground) }
        for _ in 0..<5000 where !w.stub.isHeld { await Task.yield() }
        XCTAssertTrue(w.stub.isHeld, "the second check never started")
        asking.resume(returning: .accept)
        await first.value
        XCTAssertEqual(w.stub.calls.count, 2, "the accept's own fresh check could not start: one is running")
        XCTAssertEqual(w.trust.state.allowsNativeFeatures, false)
        // The running check ends (its answer is the old pin's key change, now already accepted): the fresh check runs once, at its end.
        w.stub.holds = false
        w.stub.release()
        await second.value
        XCTAssertEqual(w.stub.calls.count, 3, "the pending fresh check ran when the running one ended")
        XCTAssertEqual(w.stub.calls.last?.pinnedFP, newFp, "against the new key")
        XCTAssertEqual(w.trust.state, .pass, "so it does not sit on Checking until a timer")
        // and only once
        await w.coordinator.run(.timer)
        XCTAssertEqual(w.stub.calls.count, 4)
    }

    func testAStuckConfirmDoesNotFreezeLaterChecks() async throws {
        let w = try world(outcome: .unreachable(.macOffline))
        w.stub.outcomes = [.verdict(.repin(newFP: newFp))]
        w.prompts.hold = true   // the alert never shows and never answers
        let stuck = Task { await w.coordinator.run(.launch) }
        for _ in 0..<5000 where w.prompts.waiting == nil { await Task.yield() }
        let first = try XCTUnwrap(w.prompts.waiting, "the confirm was never asked")
        XCTAssertFalse(w.coordinator.isRunning, "the check slot is free while the owner is being asked")
        await w.coordinator.run(.retry)
        XCTAssertEqual(w.stub.calls.count, 2, "Retry still runs")
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .macOffline))
        await w.coordinator.run(.foreground)
        await w.coordinator.run(.timer)
        XCTAssertEqual(w.stub.calls.count, 4, "so do the foreground and timer checks")
        first.resume(returning: .decline)
        await stuck.value
    }

    func testAFailIsSavedOnThePairingAndAPassClearsIt() async throws {
        let w = try world(outcome: .verdict(.fail(.wrongFP)))
        await w.coordinator.run(.launch)
        XCTAssertEqual(try w.store.active()?.attestFailed, true, "quick-act reads this from the shared Keychain")
        XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(-3600), "a fail keeps the time")
        // A later launch (a new coordinator on the same stored pairing) that passes clears the flag and renews the time.
        let again = try world(outcome: .verdict(.pass), preFailed: true)
        XCTAssertEqual(try again.store.active()?.attestFailed, true)
        await again.coordinator.run(.launch)
        XCTAssertEqual(try again.store.active()?.attestFailed, false)
        XCTAssertEqual(try again.store.active()?.lastVerifiedAt, t0)
        let silent = try world(outcome: .unreachable(.macOffline), preFailed: true)
        await silent.coordinator.run(.launch)
        XCTAssertEqual(try silent.store.active()?.attestFailed, true, "an unanswered check does not clear a failure")
    }

    func testDeclineLeavesItUnverifiedAndTheOldKeyPinned() async throws {
        let w = try world(outcome: .verdict(.repin(newFP: newFp)))
        w.prompts.answer = .decline
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .keyChanged))
        XCTAssertEqual(try w.store.active()?.bridgeFp, fp)
        XCTAssertEqual(w.coordinator.profile.bridgeFp, fp)
        XCTAssertEqual(try w.store.active()?.lastVerifiedAt, t0.addingTimeInterval(-3600), "a decline never counts as a verified time")
    }

    func testATimerOrForegroundDoesNotAskAgainAboutTheKeyTheOwnerRefusedButRetryDoes() async throws {
        let w = try world(outcome: .verdict(.repin(newFP: newFp)))
        w.stub.fallback = .verdict(.repin(newFP: newFp))
        await w.coordinator.run(.launch)
        await w.coordinator.run(.foreground)
        await w.coordinator.run(.timer)
        await w.coordinator.run(.network)
        XCTAssertEqual(w.prompts.hosts.count, 1, "asked once")
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .keyChanged))
        w.prompts.answer = .accept
        w.stub.fallback = .verdict(.pass)
        w.stub.outcomes = [.verdict(.repin(newFP: newFp))]
        await w.coordinator.run(.retry)
        XCTAssertEqual(w.prompts.hosts.count, 2, "Retry asks again")
        XCTAssertEqual(w.trust.state, .pass)
    }

    func testADifferentNewKeyAsksAgain() async throws {
        let w = try world(outcome: .verdict(.repin(newFP: newFp)))
        await w.coordinator.run(.launch)
        w.stub.fallback = .verdict(.repin(newFP: String(repeating: "C", count: 43)))
        await w.coordinator.run(.foreground)
        XCTAssertEqual(w.prompts.hosts.count, 2)
    }

    func testAcceptThatCannotBeSavedIsNotAPass() async throws {
        let w = try world(storeWorks: false, outcome: .verdict(.repin(newFP: newFp)))
        w.prompts.answer = .accept
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .saveFailed))
        XCTAssertEqual(w.coordinator.profile.bridgeFp, fp, "the old key stays pinned")
    }

    func testRemoveFromTheConfirmRemovesAndDoesNotPass() async throws {
        let w = try world(outcome: .verdict(.repin(newFP: newFp)))
        w.prompts.answer = .remove
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.removed.n, 1)
        XCTAssertFalse(w.trust.state.allowsNativeFeatures)
        XCTAssertEqual(try w.store.active()?.bridgeFp, fp)
    }

    // MARK: the page's recheck()

    func testThePageCanOnlyAddACheckWhileVerifiedOneAtATimeAnd30SecondsApart() async throws {
        let w = try world()
        await w.coordinator.run(.page)
        XCTAssertTrue(w.stub.calls.isEmpty, "not verified yet: the page adds nothing")
        await w.coordinator.run(.launch)
        XCTAssertEqual(w.trust.state, .pass)
        XCTAssertEqual(w.stub.calls.count, 1)
        clockNow = t0.addingTimeInterval(10)
        await w.coordinator.run(.page)
        XCTAssertEqual(w.stub.calls.count, 1, "inside the 30 s gap")
        clockNow = t0.addingTimeInterval(31)
        await w.coordinator.run(.page)
        XCTAssertEqual(w.stub.calls.count, 2)
        // one in flight at a time
        w.stub.holds = true
        clockNow = t0.addingTimeInterval(100)
        let running = Task { await w.coordinator.run(.foreground) }
        for _ in 0..<5000 where !w.stub.isHeld { await Task.yield() }
        XCTAssertTrue(w.stub.isHeld, "the check never started")
        await w.coordinator.run(.page)
        await w.coordinator.run(.network)
        XCTAssertEqual(w.stub.calls.count, 3, "one is running: no other starts")
        w.stub.release()
        await running.value
    }

    func testThePageCannotSkipACheckOrSetAResult() async throws {
        let w = try world(outcome: .unreachable(.macOffline))
        await w.coordinator.run(.launch)
        w.coordinator.recheckFromPage()
        await Task.yield()
        XCTAssertEqual(w.stub.calls.count, 1, "unverified: a page call does no network call")
        XCTAssertEqual(w.trust.state, .unverified(lastVerified: t0.addingTimeInterval(-3600), reason: .macOffline))
    }

    func testAStoppedCoordinatorWritesNothing() async throws {
        let w = try world()
        w.stub.holds = true
        let running = Task { await w.coordinator.run(.launch) }
        for _ in 0..<5000 where !w.stub.isHeld { await Task.yield() }
        XCTAssertTrue(w.stub.isHeld, "the check never started")
        w.coordinator.stop()
        w.stub.release()
        await running.value
        XCTAssertFalse(w.trust.settled)
        XCTAssertEqual(w.changed.n, 0)
        await w.coordinator.run(.foreground)
        XCTAssertEqual(w.stub.calls.count, 1)
    }
}

/// The confirm itself: when the alert cannot be put on screen it answers "no" instead of waiting for ever.
@MainActor
final class RepinPromptTests: XCTestCase {
    private func spin(until done: () -> Bool, timeout: TimeInterval = 5) {
        let end = Date(timeIntervalSinceNow: timeout)
        while !done(), Date() < end { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
    }

    func testAnAlertThatNeverPresentsIsADeclineAndTheNextAskIsNotBlocked() throws {
        let prompt = RepinPrompt(presentCheckDelay: 0.2)
        let detached = UIViewController()   // in no window: nothing reaches the screen
        var answers: [RepinChoice] = []
        prompt.ask(host: "mine.example.com", from: { detached }) { answers.append($0) }
        XCTAssertTrue(prompt.isShowing)
        spin(until: { answers.count == 1 })
        XCTAssertEqual(answers, [.decline], "an alert that never showed is a decline")
        XCTAssertFalse(prompt.isShowing)
        prompt.ask(host: "mine.example.com", from: { detached }) { answers.append($0) }
        spin(until: { answers.count == 2 })
        XCTAssertEqual(answers, [.decline, .decline], "and it does not block the next ask")
    }

    func testAnAlertThatIsOnScreenStaysUntilTheOwnerAnswers() throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let prompt = RepinPrompt(presentCheckDelay: 0.2)
        var answers: [RepinChoice] = []
        prompt.ask(host: "mine.example.com", from: { root }) { answers.append($0) }
        XCTAssertNotNil(root.presentedViewController as? UIAlertController)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.8))   // well past the presentation check
        XCTAssertTrue(prompt.isShowing, "a shown alert is not answered for the owner")
        XCTAssertEqual(answers, [])
        // a second ask while one is up is a decline, and does not touch the first
        var second: [RepinChoice] = []
        prompt.ask(host: "mine.example.com", from: { root }) { second.append($0) }
        XCTAssertEqual(second, [.decline])
        prompt.choose(.accept)
        XCTAssertEqual(answers, [.accept])
    }
}

/// The session cookie rule: only the relay's own `__Host-` cookie for this exact host, secure, path `/`.
final class PairedSessionCookieTests: XCTestCase {
    private let origin = URL(string: "https://mine.example.com")!

    private func cookie(_ name: String = "__Host-talos_s", value: String = "tok123", domain: String = "mine.example.com", path: String = "/", secure: Bool = true) -> HTTPCookie {
        var p: [HTTPCookiePropertyKey: Any] = [.name: name, .value: value, .domain: domain, .path: path]
        if secure { p[.secure] = "TRUE" }
        return HTTPCookie(properties: p)!
    }

    func testTheRightCookieIsSentAsOneHeader() {
        XCTAssertEqual(PairedSessionCookie.header(from: [cookie()], origin: origin), "__Host-talos_s=tok123")
    }

    func testNothingElseIsEverSent() {
        let wrong: [HTTPCookie] = [
            cookie("other"), cookie(domain: "evil.example.com"), cookie(domain: ".mine.example.com"), cookie(domain: "example.com"),
            cookie(path: "/app"), cookie(secure: false), cookie(value: "a;b"), cookie(value: "a b"),
        ]
        for c in wrong { XCTAssertNil(PairedSessionCookie.header(from: [c], origin: origin), "\(c.name) \(c.domain) \(c.path) \(c.isSecure)") }
        XCTAssertNil(PairedSessionCookie.header(from: [cookie()], origin: URL(string: "http://mine.example.com")!), "never over http")
        XCTAssertNil(PairedSessionCookie.header(from: [], origin: origin), "no cookie, no header")
        XCTAssertEqual(PairedSessionCookie.header(from: wrong + [cookie(value: "good")], origin: origin), "__Host-talos_s=good")
    }
}

/// The wording the owner reads.
final class TrustWordsTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 3_000_000)

    func testTheBannerSaysWhatIsOffAndWhyAndWhenItWasLastConfirmed() {
        let text = TrustWords.banner(lastVerified: now.addingTimeInterval(-3 * 3600), reason: .macOffline, host: "mine.example.com", now: now)
        XCTAssertTrue(text.hasPrefix("Can't confirm this is your Mac. The page's camera and microphone access, sharing and native features are off until it answers."), text)
        XCTAssertFalse(text.contains("Camera, mic"), "no absolute claim: a file input that opens the system camera is not a WebKit check")
        XCTAssertTrue(text.contains("Your Mac is not connected to the relay."), text)
        XCTAssertTrue(text.hasSuffix("Last confirmed 3 hours ago."), text)
    }

    func testNeverConfirmedAndAFutureTimeSayNever() {
        XCTAssertEqual(TrustWords.lastConfirmed(nil, now: now), "never")
        XCTAssertEqual(TrustWords.lastConfirmed(now.addingTimeInterval(60), now: now), "never")
    }

    func testEveryReasonHasItsOwnWordsAndAnOldMacIsToldToUpdate() {
        let reasons: [UnverifiedReason] = [.checking, .network, .macOffline, .unsupported, .macTimeout, .rateLimited, .badAnswer, .keyChanged, .saveFailed]
        XCTAssertEqual(Set(reasons.map { TrustWords.why($0, host: "h") }).count, reasons.count)
        XCTAssertTrue(TrustWords.why(.unsupported, host: "h").contains("update talos-app"))
    }

    func testTheScreensNameTheHostAndNothingIsLoaded() {
        XCTAssertTrue(TrustWords.failBody(host: "mine.example.com").contains("mine.example.com"))
        XCTAssertTrue(TrustWords.blockBody(lastVerified: nil, host: "mine.example.com", now: now).contains("last confirmed never"))
        XCTAssertNotEqual(TrustWords.failTitle, TrustWords.blockTitle)
        XCTAssertTrue(TrustWords.repinMessage(host: "mine.example.com").contains("talos-app rotate"))
    }
}
