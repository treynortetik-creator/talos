import BridgeGuard
import Capacitor
import TalosRelayCore
import UIKit
import WebKit
import XCTest

@testable import App

/// The real shell with a stub in place of the network: what the owner sees and what native code may do, in every trust state.
@MainActor
final class RelayTrustControllerTests: XCTestCase {
    private let id = "r_abcdefghijklmnopqrst"
    private let fp = String(repeating: "A", count: 43)
    private let newFp = String(repeating: "B", count: 43)
    private var savedRuntime: (@MainActor () -> RelayRuntime)!
    private var savedAttester: (@MainActor () -> AttestRunning)!
    private var stub: StubAttester!
    private var window: UIWindow?
    private var store: RelayStore!

    private struct NoStores: RelayDataStoreAccess {
        func identifiers() async -> [UUID] { [] }
        func remove(_ id: UUID) async -> Bool { true }
        func clearDefault() async {}
    }

    override func setUp() {
        super.setUp()
        savedRuntime = TalosBridgeViewController.runtime
        savedAttester = TalosBridgeViewController.attester
        stub = StubAttester(.verdict(.pass))
        let s = stub!
        TalosBridgeViewController.attester = { s }
    }

    override func tearDown() {
        window?.isHidden = true
        window = nil
        TalosBridgeViewController.runtime = savedRuntime
        TalosBridgeViewController.attester = savedAttester
        super.tearDown()
    }

    private func spin(_ seconds: TimeInterval = 0.05) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }

    private func waitFor(_ what: String, timeout: TimeInterval = 5, _ cond: () -> Bool, file: StaticString = #filePath, line: UInt = #line) {
        let until = Date(timeIntervalSinceNow: timeout)
        while !cond(), Date() < until { spin(0.02) }
        XCTAssertTrue(cond(), "timed out: \(what)", file: file, line: line)
    }

    /// A phone paired to https://mine.example.com. `verified` is the time of its last passing attest (nil: never).
    @discardableResult
    private func pair(verified: Date? = Date().addingTimeInterval(-3600)) throws -> RelayStore {
        let s = RelayStore(backing: InMemoryKeychain())
        try s.add(RelayProfile(
            id: id, origin: URL(string: "https://mine.example.com")!, kind: .self, label: "mine.example.com", bridgeFp: fp, deviceId: "",
            dataStoreId: UUID(), addedAt: Date(timeIntervalSince1970: 1000), lastVerifiedAt: verified)!)
        store = s
        TalosBridgeViewController.runtime = { RelayRuntime(store: { s }, dataStores: NoStores(), allowBuildTime: false) }
        return s
    }

    private func show(firstPage: URL? = nil) throws -> TalosBridgeViewController {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let w = UIWindow(windowScene: scene)
        window = w
        let controller = TalosBridgeViewController()
        controller.firstPage = firstPage
        w.rootViewController = controller
        w.makeKeyAndVisible()
        controller.loadViewIfNeeded()
        return controller
    }

    private func settled(_ c: TalosBridgeViewController) {
        waitFor("the first check answers") { c.relayContext?.trust.settled == true }
    }

    private func buttons(in root: UIView) -> [String] {
        var out: [String] = []
        func walk(_ v: UIView) {
            if v is UIButton, let id = v.accessibilityIdentifier { out.append(id) }
            v.subviews.forEach(walk)
        }
        walk(root)
        return out.sorted()
    }

    private func relayPage(_ controller: TalosBridgeViewController, path: String = "/threads") {
        guard let web = controller.webView, let recorder = NavigationRecorder.attach(to: controller) else { return XCTFail("no gate on this web view") }
        // The navigation ends (finished, failed or cancelled by the gate) before anything is asserted about the page.
        XCTAssertFalse(recorder.load(web, "https://mine.example.com\(path)").timedOut, "the navigation never ended")
    }

    // MARK: launch: the check comes first, and the watchdog starts after it

    func testNothingLoadsAndNoWatchdogRunsUntilTheFirstCheckAnswers() throws {
        try pair()
        stub.holds = true
        let c = try show()
        waitFor("the check starts") { self.stub.isHeld }
        XCTAssertEqual(stub.calls.count, 1)
        XCTAssertNil(c.lastRelayLoad, "no relay page is asked for while the check runs")
        XCTAssertFalse(c.isLaunchWatchdogRunning, "the offline page cannot show in the middle of the check")
        XCTAssertFalse(c.isShowingTrustBanner)
        XCTAssertFalse(c.relayContext?.trust.allowsPageLoad ?? true)
        stub.release()
        waitFor("the page load starts") { c.lastRelayLoad != nil }
        XCTAssertTrue(c.isLaunchWatchdogRunning, "the watchdog starts with the page load, after the check")
        XCTAssertEqual(c.relayContext?.trust.state, .pass)
        XCTAssertFalse(c.isShowingTrustBanner)
    }

    func testTheNavigationGateCancelsARelayLoadUntilTheCheckHasAnswered() throws {
        try pair()
        stub.holds = true
        let c = try show()
        waitFor("the check starts") { self.stub.isHeld }
        let gate = try XCTUnwrap(c.webView?.navigationDelegate as? NavigationGate)
        let url = URL(string: "https://mine.example.com/threads")!
        let frame = FakeFrame.with(host: "mine.example.com", url: url)
        func decide() -> WKNavigationActionPolicy? {
            var out: WKNavigationActionPolicy?
            gate.webView(c.webView!, decidePolicyFor: FakeNavigationAction.with(url: url, source: frame, target: frame)) { out = $0 }
            return out
        }
        XCTAssertEqual(decide(), .cancel, "Capacitor's own first load, a reload and a link all stop here before the check answers")
        stub.release()
        settled(c)
        XCTAssertNotEqual(decide(), .cancel)
    }

    // MARK: unverified: a banner, a read-only page, native features off

    func testUnverifiedShowsTheBannerWithRetryAndRemoveAndLoadsThePageReadOnly() throws {
        try pair(verified: Date().addingTimeInterval(-3 * 3600))
        stub.fallback = .unreachable(.macOffline)
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBanner)
        let text = try XCTUnwrap(c.trustBannerText)
        XCTAssertTrue(text.hasPrefix("Can't confirm this is your Mac. The page's camera and microphone access, sharing and native features are off until it answers."), text)
        XCTAssertTrue(text.contains("Last confirmed 3 hours ago."), text)
        XCTAssertEqual(buttons(in: c.view).filter { $0.hasPrefix("trust.") }, ["trust.remove", "trust.retry"])
        XCTAssertFalse(c.isShowingTrustBlock)
        XCTAssertNotNil(c.lastRelayLoad, "unverified inside the 24 hours still loads the page")
        relayPage(c)
        XCTAssertFalse(TalosPluginGate.allows(c.bridge), "native features are off on the relay's own page")
        XCTAssertFalse(c.relayContext!.trust.state.allowsNativeFeatures)
    }

    func testLeavingPassEndsWhatThePageHoldsOfTheCameraAndMicrophone() throws {
        // WebKit keeps a grant the delegate gave under .pass and does not ask again (found in the simulator run): leaving .pass must end it.
        try pair()
        let c = try show()
        settled(c)
        XCTAssertEqual(c.mediaCaptureStops, 0, "nothing is stopped while the relay is verified")
        stub.fallback = .unreachable(.macOffline)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        waitFor("the banner") { c.isShowingTrustBanner }
        XCTAssertGreaterThan(c.mediaCaptureStops, 0)
    }

    func testTheBlockScreenShowsOnTimeAtLastVerifiedPlus24Hours() throws {
        // Verified 24 h minus 1.5 s ago, and the Mac does not answer: the banner shows now and the block must replace it by itself.
        try pair(verified: Date().addingTimeInterval(-24 * 3600 + 1.5))
        stub.fallback = .unreachable(.macOffline)
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBanner)
        XCTAssertFalse(c.isShowingTrustBlock)
        waitFor("the hard block shows when the 24 hours run out", timeout: 8) { c.isShowingTrustBlock }
        XCTAssertFalse(c.isShowingTrustBanner)
    }

    func testAFailIsSavedOnThePairing() throws {
        let s = try pair()
        stub.fallback = .verdict(.fail(.wrongFP))
        let c = try show()
        settled(c)
        XCTAssertEqual(try s.active()?.attestFailed, true)
    }

    func testRetryChecksAgainAndAPassClearsTheBannerAndTurnsNativeFeaturesOn() throws {
        try pair()
        stub.fallback = .unreachable(.macOffline)
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBanner)
        stub.fallback = .verdict(.pass)
        let retry = try XCTUnwrap(find(c.view, "trust.retry") as? UIButton)
        retry.sendActions(for: .primaryActionTriggered)
        waitFor("the banner goes") { !c.isShowingTrustBanner }
        XCTAssertEqual(stub.calls.count, 2)
        XCTAssertEqual(c.relayContext?.trust.state, .pass)
        relayPage(c)
        XCTAssertTrue(TalosPluginGate.allows(c.bridge))
    }

    func testAForegroundChecksAgainAndANeverVerifiedPhoneThatCannotAnswerIsBlocked() throws {
        try pair(verified: nil)
        stub.fallback = .unreachable(.network)
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBlock, "never verified is past any window")
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        waitFor("a second check") { self.stub.calls.count >= 2 }
    }

    // MARK: hard block and fail: a native screen, no page

    func testAHardBlockShowsTheNativeScreenWithRetryAndRemoveAndLoadsNoPage() throws {
        try pair(verified: Date().addingTimeInterval(-25 * 3600))
        stub.fallback = .unreachable(.macOffline)
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBlock)
        XCTAssertFalse(c.trustBlockIsFail)
        XCTAssertFalse(c.isShowingTrustBanner)
        XCTAssertNil(c.lastRelayLoad, "a hard block loads nothing")
        XCTAssertEqual(buttons(in: c.view).filter { $0.hasPrefix("trust.") }, ["trust.remove", "trust.retry"])
        XCTAssertFalse(c.isLaunchWatchdogRunning)
        XCTAssertFalse(TalosPluginGate.allows(c.bridge))
        // Retry with a pass brings the page back.
        stub.fallback = .verdict(.pass)
        (find(c.view, "trust.retry") as? UIButton)?.sendActions(for: .primaryActionTriggered)
        waitFor("the block goes and the page loads") { !c.isShowingTrustBlock && c.lastRelayLoad != nil }
        XCTAssertEqual(c.relayContext?.trust.state, .pass)
    }

    func testAFailShowsTheRedScreenWithOnlyRemoveClearsThePageAndRefusesEverything() throws {
        try pair()
        stub.fallback = .verdict(.fail(.wrongFP))
        let c = try show()
        settled(c)
        XCTAssertTrue(c.isShowingTrustBlock)
        XCTAssertTrue(c.trustBlockIsFail)
        XCTAssertEqual(buttons(in: c.view).filter { $0.hasPrefix("trust.") }, ["trust.remove"], "only Remove this relay and pair again")
        XCTAssertNil(c.lastRelayLoad)
        XCTAssertFalse(TalosPluginGate.allows(c.bridge))
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        spin(0.3)
        XCTAssertEqual(stub.calls.count, 1, "a failed relay is not asked again")
        XCTAssertEqual(c.relayContext?.trust.state, .failed(reason: "wrong_fp"))
    }

    func testAFailAfterAPassClearsTheLoadedPage() throws {
        try pair()
        let c = try show()
        settled(c)
        relayPage(c)
        XCTAssertEqual(c.webView?.url?.host, "mine.example.com")
        stub.fallback = .verdict(.fail(.badSig))
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        waitFor("the red screen") { c.isShowingTrustBlock }
        waitFor("the web view leaves the relay's page") { c.webView?.url?.host != "mine.example.com" }
        XCTAssertNotEqual(c.webView?.url?.host, "mine.example.com", "the relay's page is gone from the web view")
        XCTAssertFalse(TalosPluginGate.allows(c.bridge))
    }

    // MARK: the pairing code goes only to a relay that just passed

    func testTheSetupCodeIsLoadedOnlyAfterAPass() throws {
        try pair()
        let enroll = URL(string: "https://mine.example.com/enroll#01234567890123456789012345")!
        let c = try show(firstPage: enroll)
        waitFor("the load") { c.lastRelayLoad != nil }
        XCTAssertEqual(c.lastRelayLoad, enroll, "after a pass the page continues pairing")
    }

    func testAnUnverifiedRelayNeverGetsTheSetupCode() throws {
        try pair()
        stub.fallback = .unreachable(.macOffline)
        let enroll = URL(string: "https://mine.example.com/enroll#01234567890123456789012345")!
        let c = try show(firstPage: enroll)
        settled(c)
        XCTAssertEqual(c.lastRelayLoad?.absoluteString, "https://mine.example.com", "the ordinary start page, read-only, without the code")
        XCTAssertFalse(c.lastRelayLoad?.absoluteString.contains("0123456789") ?? false)
    }

    func testAFailedRelayNeverGetsTheSetupCode() throws {
        try pair()
        stub.fallback = .verdict(.fail(.badSig))
        let c = try show(firstPage: URL(string: "https://mine.example.com/enroll#01234567890123456789012345")!)
        settled(c)
        XCTAssertNil(c.lastRelayLoad)
    }

    // MARK: a key change: the blocking native confirm

    func testAKeyChangeAsksOnScreenAndDeclineKeepsItUnverified() throws {
        let s = try pair()
        stub.fallback = .verdict(.repin(newFP: newFp))
        let c = try show()
        waitFor("the confirm") { c.isRepinPromptShowing }
        let alert = try XCTUnwrap(c.presentedViewController as? UIAlertController)
        XCTAssertTrue(alert.title?.contains("mine.example.com") == true, "the host is in the title: \(alert.title ?? "")")
        XCTAssertEqual(alert.actions.map(\.title), ["Continue", "Not now", "Remove this relay"])
        XCTAssertFalse(c.relayContext!.trust.state.allowsNativeFeatures, "not a pass while the question is up")
        XCTAssertEqual(try s.active()?.bridgeFp, fp)
        c.testRepinPrompt.choose(.decline)
        waitFor("answered") { !c.isRepinPromptShowing }
        spin(0.2)
        guard case .unverified(_, .keyChanged) = c.relayContext!.trust.state else { return XCTFail("\(c.relayContext!.trust.state)") }
        XCTAssertEqual(try s.active()?.bridgeFp, fp, "the old key is still pinned")
        XCTAssertTrue(c.isShowingTrustBanner)
    }

    func testAcceptingAKeyChangeMovesThePinAndPasses() throws {
        let s = try pair()
        stub.outcomes = [.verdict(.repin(newFP: newFp))]   // then the fresh check against the new key passes
        stub.fallback = .verdict(.pass)
        let c = try show()
        waitFor("the confirm") { c.isRepinPromptShowing }
        c.testRepinPrompt.choose(.accept)
        waitFor("a pass") { c.relayContext?.trust.state == .pass }
        XCTAssertEqual(try s.active()?.bridgeFp, newFp)
        waitFor("the banner goes") { !c.isShowingTrustBanner }
    }

    // MARK: every guarded site refuses when the relay is not verified

    private func sites(_ trust: RelayTrust) throws -> (message: (String) -> Int, share: () -> Int, prompt: () -> String?, camera: () -> WKPermissionDecision, motion: () -> WKPermissionDecision) {
        let guardian = try XCTUnwrap(BridgeGuard(relayURL: URL(string: "https://mine.example.com")!))
        let page = URL(string: "https://mine.example.com/threads")!
        let web = WKWebView(frame: .zero)
        let frame = FakeFrame.with(host: "mine.example.com", url: page)
        let inner = SpyHandler()
        let guarded = GuardedMessageHandler(inner: inner, guardian: guardian, trust: trust)
        var shared = 0
        let share = ShareMediaMessageHandler(guardian: guardian, trust: trust) { _, _ in shared += 1 }
        let ui = SpyUI()
        let gate = NavigationGate(inner: ui, guardian: guardian, trust: trust, openInSafari: { _ in }, showMedia: { _ in })
        let controller = WKUserContentController()
        return (
            { plugin in
                guarded.userContentController(controller, didReceive: FakeMessage.with(
                    body: ["pluginId": plugin, "methodName": "x", "callbackId": "1", "options": [String: Any]()], frame: frame, webView: web))
                return inner.received
            },
            {
                share.userContentController(controller, didReceive: FakeMessage.with(body: ["path": "/media/abc", "name": "a.png"], frame: frame, webView: web))
                return shared
            },
            {
                var out: String? = "unset"
                gate.webView(web, runJavaScriptTextInputPanelWithPrompt: "hello", defaultText: nil, initiatedByFrame: frame) { out = $0 }
                return out
            },
            {
                var out: WKPermissionDecision = .prompt
                gate.webView(web, requestMediaCapturePermissionFor: FakeOrigin.with(host: "mine.example.com"), initiatedByFrame: frame, type: .camera) { out = $0 }
                return out
            },
            {
                var out: WKPermissionDecision = .prompt
                gate.webView(web, requestDeviceOrientationAndMotionPermissionFor: FakeOrigin.with(host: "mine.example.com"), initiatedByFrame: frame) { out = $0 }
                return out
            })
    }

    func testEveryGuardedSiteDeliversOnPassAndRefusesInEveryOtherState() throws {
        let clock = ClockBox(Date(timeIntervalSince1970: 5_000_000))
        func make(_ setup: (RelayTrust) -> Void) -> RelayTrust {
            let t = RelayTrust(.pass, lastVerified: clock.now, now: { clock.now })
            setup(t)
            return t
        }
        // pass: every site delivers (so a refusal below is the state's doing)
        let pass = try sites(make { $0.markPass() })
        XCTAssertEqual(pass.message("TalosRelay"), 1)
        XCTAssertEqual(pass.share(), 1)
        XCTAssertEqual(pass.prompt(), "ok")
        XCTAssertEqual(pass.camera(), .grant)
        XCTAssertEqual(pass.motion(), .grant)

        let refused: [(String, RelayTrust)] = [
            ("unverified", make { $0.markUnverified(.macOffline) }),
            ("checking", RelayTrust(.unverified(lastVerified: clock.now, reason: .checking), lastVerified: clock.now, now: { clock.now })),
            ("failed", make { $0.markFailed("bad_sig") }),
            ("hard block", { () -> RelayTrust in
                let t = RelayTrust(.pass, lastVerified: clock.now, now: { clock.now })
                t.markUnverified(.network)
                clock.now = clock.now.addingTimeInterval(25 * 3600)
                return t
            }()),
        ]
        for (name, trust) in refused {
            let s = try sites(trust)
            XCTAssertEqual(s.message("TalosRelay"), 0, "bridge handler, \(name)")
            XCTAssertEqual(s.message("TalosPush"), 0, "bridge handler, push plugin, \(name)")
            XCTAssertEqual(s.share(), 0, "share handler, \(name)")
            XCTAssertNil(s.prompt(), "prompt channel, \(name)")
            XCTAssertEqual(s.camera(), .deny, "camera and microphone, \(name)")
            XCTAssertEqual(s.motion(), .deny, "motion, \(name)")
        }
    }

    final class ClockBox { var now: Date; init(_ d: Date) { now = d } }

    func testTheGatesFollowTheControllersTrustWhenItChangesAtRunTime() throws {
        try pair()
        let c = try show()
        settled(c)
        relayPage(c)
        XCTAssertTrue(TalosPluginGate.allows(c.bridge))
        let trust = try XCTUnwrap(c.relayContext?.trust)
        trust.markUnverified(.macOffline)
        XCTAssertFalse(TalosPluginGate.allows(c.bridge), "the same object, read at call time")
        trust.markPass()
        XCTAssertTrue(TalosPluginGate.allows(c.bridge))
        trust.markFailed("bad_sig")
        XCTAssertFalse(TalosPluginGate.allows(c.bridge))
    }

    func testRetiringTheControllerStopsItsChecks() throws {
        try pair()
        let c = try show()
        settled(c)
        let before = stub.calls.count
        c.retire()
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        spin(0.3)
        XCTAssertEqual(stub.calls.count, before, "a retired controller never checks")
    }

    // MARK: Remove

    func testRemoveTakesTheRelayOffThePhoneAndGoesStraightToTheAddRelaySheet() throws {
        let s = try pair()
        let c = try show()
        settled(c)
        let scene = SceneDelegate()
        scene.window = window
        scene.clearRelayBoundState = {}
        var sheetFrom: UIViewController?
        let done = expectation(description: "removed")
        Task { @MainActor in
            await scene.removeRelayThenAdd(id: id) { sheetFrom = $0 }
            done.fulfill()
        }
        wait(for: [done], timeout: 10)
        XCTAssertEqual(try s.list(), [], "the relay is gone from the list")
        let next = try XCTUnwrap(window?.rootViewController as? TalosBridgeViewController)
        XCTAssertFalse(next === c)
        XCTAssertTrue(sheetFrom === next, "the Add-relay sheet is opened on the fresh controller")
        XCTAssertTrue(next.isShowingFirstRun, "and cancelling it leaves the native first-run screen")
        XCTAssertNil(next.relayContext)
    }
}

extension TalosBridgeViewController {
    /// For tests: the confirm of a changed key.
    var testRepinPrompt: RepinPrompt { repinPromptForTests }
}

private func find(_ root: UIView, _ id: String) -> UIView? {
    if root.accessibilityIdentifier == id { return root }
    for v in root.subviews { if let f = find(v, id) { return f } }
    return nil
}
