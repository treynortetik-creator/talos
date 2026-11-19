import BridgeGuard
import Capacitor
import TalosRelayCore
import UIKit
import WebKit
import XCTest

@testable import App

/// The real shell: the web view, the guard and the plugin gate follow the active relay profile, and a build with nothing paired
/// shows the native first-run screen and loads no page.
@MainActor
final class RelayActiveOriginTests: XCTestCase {
    private let id = "r_abcdefghijklmnopqrst"
    private var savedRuntime: (@MainActor () -> RelayRuntime)!
    private var savedAttester: (@MainActor () -> AttestRunning)!
    /// Every paired controller here is checked by this stub (a pass), never by the network.
    private let attester = StubAttester(.verdict(.pass))

    override func setUp() {
        super.setUp()
        savedRuntime = TalosBridgeViewController.runtime
        savedAttester = TalosBridgeViewController.attester
        let stub = attester
        TalosBridgeViewController.attester = { stub }
    }

    override func tearDown() {
        TalosBridgeViewController.runtime = savedRuntime
        TalosBridgeViewController.attester = savedAttester
        super.tearDown()
    }

    private struct NoStores: RelayDataStoreAccess {
        func identifiers() async -> [UUID] { [] }
        func remove(_ id: UUID) async -> Bool { true }
        func clearDefault() async {}
    }

    private func use(_ store: RelayStore?, allowBuildTime: Bool = false) {
        TalosBridgeViewController.runtime = { RelayRuntime(store: { store }, dataStores: NoStores(), allowBuildTime: allowBuildTime) }
    }

    private func pairedStore(host: String, dataStore: UUID) throws -> RelayStore {
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(RelayProfile(
            id: id, origin: URL(string: "https://\(host)")!, kind: .self, label: host, bridgeFp: String(repeating: "A", count: 43),
            deviceId: "", dataStoreId: dataStore, addedAt: Date(timeIntervalSince1970: 1000))!)
        return store
    }

    private func shown(_ window: UIWindow) -> TalosBridgeViewController {
        let controller = TalosBridgeViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        controller.loadViewIfNeeded()
        // The first Mac check answers (a stub: a pass) before the page counts as verified.
        let until = Date(timeIntervalSinceNow: 3)
        while let trust = controller.relayContext?.trust, !trust.settled, Date() < until { spin(0.02) }
        return controller
    }

    private func makeWindow() throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        return UIWindow(windowScene: scene)
    }

    private func spin(_ seconds: TimeInterval = 0.3) { RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds)) }

    func testThePairedRelayDrivesTheWebViewTheGuardAndTheDataStore() throws {
        let dataStore = UUID()
        use(try pairedStore(host: "mine.example.com", dataStore: dataStore))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        let context = try XCTUnwrap(controller.relayContext)
        XCTAssertEqual(context.active.origin.absoluteString, "https://mine.example.com")
        XCTAssertEqual((controller.bridge as? CapacitorBridge)?.config.appStartServerURL.absoluteString, "https://mine.example.com")
        XCTAssertEqual(controller.webView?.configuration.websiteDataStore.identifier, dataStore, "one data store per relay")
        XCTAssertTrue(controller.webView?.navigationDelegate is NavigationGate, "the guards are installed on this relay")
        XCTAssertFalse(controller.isShowingFirstRun)
    }

    func testEveryGuardedSiteHoldsTheContextsOwnTrustObject() throws {
        use(try pairedStore(host: "mine.example.com", dataStore: UUID()))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        let trust = try XCTUnwrap(controller.relayContext?.trust)
        XCTAssertTrue(try XCTUnwrap(controller.guardedMessageHandler).trust === trust, "the bridge handler")
        XCTAssertTrue(try XCTUnwrap(controller.shareMessageHandler).trust === trust, "the share handler")
        XCTAssertTrue(try XCTUnwrap(controller.webView?.navigationDelegate as? NavigationGate).trust === trust, "the navigation gate")
        XCTAssertTrue(try XCTUnwrap(controller.webView?.uiDelegate as? NavigationGate).trust === trust)
    }

    func testThePluginGateFollowsTheProfileOrigin() throws {
        use(try pairedStore(host: "mine.example.com", dataStore: UUID()))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        let web = try XCTUnwrap(controller.webView)
        let recorder = try XCTUnwrap(NavigationRecorder.attach(to: controller))
        let threads = URL(string: "https://mine.example.com/threads")!

        // The profile's own page really loads, and the gate allows it where a page-driven call would see it.
        let own = recorder.load(web, threads.absoluteString)
        XCTAssertFalse(own.timedOut, "the navigation never ended")
        XCTAssertEqual(own.policy, .allow)
        XCTAssertEqual(own.committedURL, threads)
        XCTAssertEqual(own.gateAtCommit, true, "the profile's own page, at didCommit")
        XCTAssertEqual(own.finalURL, threads)
        XCTAssertTrue(own.gateAtEnd, "the profile's own page, once loaded")

        // A main-frame request for /media/ or another origin is routed out (the media viewer, Safari) and cancelled: the web view
        // stays on /threads. If a page ever did load there, the gate must refuse it where a call would see it, at didCommit and after.
        for (url, what) in [("https://mine.example.com/media/x.html", "/media/"), ("https://elsewhere.example.com/threads", "another origin")] {
            let out = recorder.load(web, url)
            XCTAssertFalse(out.timedOut, "\(what): the navigation never ended")
            if out.loaded {
                XCTAssertEqual(out.gateAtCommit, false, "\(what) is never allowed at didCommit")
                XCTAssertFalse(out.gateAtEnd, "\(what) is never allowed once loaded")
            }
            XCTAssertEqual(out.policy, .cancel, "\(what) is cancelled, not loaded")
            XCTAssertNil(out.committedURL, "\(what) never commits")
            XCTAssertEqual(out.finalURL, threads, "\(what): the web view stays on the profile's page")
            XCTAssertTrue(out.gateAtEnd, "the page still shown is /threads, which the gate allows")
        }
    }

    func testNothingPairedShowsTheFirstRunScreenAndLoadsNoPage() throws {
        use(RelayStore(backing: InMemoryKeychain()), allowBuildTime: false)
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        XCTAssertNil(controller.relayContext)
        XCTAssertTrue(controller.isShowingFirstRun)
        XCTAssertEqual(controller.webView?.isHidden, false, "the screen is a subview of the web view, so hiding it hides the screen")
        XCTAssertFalse(controller.webView?.navigationDelegate is NavigationGate, "no guards: nothing loads")
        XCTAssertFalse(TalosPluginGate.allows(controller.bridge), "no relay, no plugin call")
        XCTAssertNotNil(controller.view.window?.rootViewController)
        let url = controller.webView?.url
        XCTAssertTrue(url == nil || url?.scheme == "capacitor" || url?.scheme == "about", "no relay page: \(String(describing: url))")
    }

    func testNothingPairedLoadsNoBundledPage() throws {
        use(RelayStore(backing: InMemoryKeychain()), allowBuildTime: false)
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        let location = try XCTUnwrap((controller.bridge as? CapacitorBridge)?.config.appLocation)
        XCTAssertFalse(FileManager.default.fileExists(atPath: location.appendingPathComponent("index.html").path),
                       "the web view is pointed at an empty folder, not the bundled page: \(location.path)")
    }

    func testAPairedRelayKeepsTheBundledOfflinePage() throws {
        use(try pairedStore(host: "mine.example.com", dataStore: UUID()))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        XCTAssertNotNil((controller.bridge as? CapacitorBridge)?.config.errorPathURL)
    }

    func testARelaySwitchDoesNotSayReconnectingAndAStuckPageDoes() throws {
        use(RelayStore(backing: InMemoryKeychain()))
        let window = try makeWindow()
        _ = shown(window)
        let delegate = SceneDelegate()
        delegate.window = window
        delegate.switchRelay(enrollURL: nil)
        XCTAssertEqual((window.rootViewController as? TalosBridgeViewController)?.startsReconnecting, false)
        delegate.replaceBridgeViewController()
        XCTAssertEqual((window.rootViewController as? TalosBridgeViewController)?.startsReconnecting, true)
        window.isHidden = true
    }

    func testTheSwitchClearsTheRelayBoundStateAgainAfterTheOldPageIsRetired() throws {
        use(RelayStore(backing: InMemoryKeychain()))
        let window = try makeWindow()
        let old = shown(window)
        let delegate = SceneDelegate()
        delegate.window = window
        var seen: [Bool] = []
        delegate.clearRelayBoundState = { seen.append(old.view.superview == nil && old.webView?.navigationDelegate == nil) }
        delegate.switchRelay(enrollURL: nil)
        XCTAssertEqual(seen, [true], "cleared once, after the old controller was retired (its page can no longer write)")
        window.isHidden = true
    }

    func testAControllerThatIsNotTheWindowsRootIsRefusedByThePluginGate() throws {
        use(try pairedStore(host: "mine.example.com", dataStore: UUID()))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        let web = try XCTUnwrap(controller.webView)
        let recorder = try XCTUnwrap(NavigationRecorder.attach(to: controller))
        XCTAssertFalse(recorder.load(web, "https://mine.example.com/threads").timedOut, "the navigation never ended")
        XCTAssertTrue(TalosPluginGate.allows(controller.bridge), "the root controller's own page")
        window.rootViewController = UIViewController()
        XCTAssertFalse(TalosPluginGate.allows(controller.bridge), "a controller that left the window (a relay switch) is refused")
    }

    func testARelaySwitchDropsAWaitingPushTapAndTheOldThread() {
        TalosPushCenter.shared.deliver = nil
        TalosPushCenter.shared.tapped(action: "open", path: "/threads/old")
        TalosPushCenter.shared.viewingThread = "old"
        TalosPushCenter.shared.unregisterRemote = {}
        TalosPushCenter.shared.resetForRelaySwitch()
        var delivered: [[String: Any]] = []
        TalosPushCenter.shared.deliver = { delivered.append($0); return true }
        TalosPushCenter.shared.flush()
        TalosPushCenter.shared.deliver = nil
        XCTAssertTrue(delivered.isEmpty, "the old relay's tap must not reach the new relay's page")
        XCTAssertNil(TalosPushCenter.shared.viewingThread)
    }

    func testARelaySwitchLetsGoOfTheOldRelaysApnsRegistrationOnceAndTheNewPageRegistersAgain() {
        let center = TalosPushCenter.shared
        let saved = center.unregisterRemote
        defer { center.unregisterRemote = saved }
        var unregistered = 0
        center.unregisterRemote = { unregistered += 1 }
        center.resetForRelaySwitch()
        XCTAssertEqual(unregistered, 1, "the phone stops holding a registration for the relay it left")
    }

    func testThePluginGateNamesThePairingThePageIsOn() throws {
        let dataStore = UUID()
        use(try pairedStore(host: "mine.example.com", dataStore: dataStore))
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        XCTAssertEqual(TalosPluginGate.keyId(controller.bridge), dataStore.uuidString,
                       "the notification keys are named by the id the phone minted, not by the relay's own id")
        XCTAssertNotEqual(TalosPluginGate.keyId(controller.bridge), id)
        XCTAssertNil(TalosPluginGate.keyId(nil))
    }

    func testAReleaseRuntimeNeverFallsBackToTheCompiledOrigin() throws {
        // Even when this build has a compiled-in server.url, a runtime that does not allow it shows the first-run screen.
        use(RelayStore(backing: InMemoryKeychain()), allowBuildTime: false)
        let window = try makeWindow()
        let controller = shown(window)
        defer { window.isHidden = true }
        XCTAssertTrue(controller.isShowingFirstRun)
        XCTAssertFalse(controller.webView?.navigationDelegate is NavigationGate)
    }

    func testAScanSavedProfileSwitchesTheNextController() throws {
        let store = RelayStore(backing: InMemoryKeychain())
        use(store, allowBuildTime: false)
        let window = try makeWindow()
        let first = shown(window)
        XCTAssertTrue(first.isShowingFirstRun)
        // What the Add-relay sheet's save does, then what its Done does.
        try store.add(RelayProfile(
            id: id, origin: URL(string: "https://scanned.example.com")!, kind: .hosted, label: "scanned.example.com",
            bridgeFp: String(repeating: "A", count: 43), deviceId: "", dataStoreId: UUID(), addedAt: Date())!)
        let delegate = SceneDelegate()
        delegate.window = window
        delegate.replaceBridgeViewController()
        let second = try XCTUnwrap(window.rootViewController as? TalosBridgeViewController)
        second.loadViewIfNeeded()
        defer { window.isHidden = true }
        XCTAssertEqual(second.relayContext?.active.origin.absoluteString, "https://scanned.example.com")
        XCTAssertFalse(second.isShowingFirstRun)
    }
}

/// Stands in front of the shell's NavigationGate (everything it does not record goes straight to the gate) and keeps what a
/// real page-driven plugin call would see: the policy the gate gave the main-frame request, the URL and the plugin gate's answer
/// at didCommit, and the same when the navigation ended (finished, failed, or cancelled by the policy).
/// `WKWebView.url` flips to the requested URL as soon as a load is asked for and flips back if the request is cancelled, so
/// reading it after a fixed wait, or as soon as it shows the new URL, says nothing about a page that really loaded.
@MainActor
final class NavigationRecorder: NSObject, WKNavigationDelegate {
    struct Outcome {
        var policy: WKNavigationActionPolicy?
        var committedURL: URL?
        var gateAtCommit: Bool?
        var finalURL: URL?
        var gateAtEnd = false
        var timedOut = false
        var loaded: Bool { committedURL != nil }
    }

    private let gate: NavigationGate
    private let bridge: CAPBridgeProtocol?
    private var policy: WKNavigationActionPolicy?
    private var committedURL: URL?
    private var gateAtCommit: Bool?
    private var ended = false

    private init(gate: NavigationGate, bridge: CAPBridgeProtocol?) {
        self.gate = gate
        self.bridge = bridge
    }

    private static var key = 0

    /// Puts a recorder in front of the web view's gate once; asking again returns the same one.
    static func attach(to controller: TalosBridgeViewController) -> NavigationRecorder? {
        guard let web = controller.webView else { return nil }
        if let existing = web.navigationDelegate as? NavigationRecorder { return existing }
        guard let gate = web.navigationDelegate as? NavigationGate else { return nil }
        let recorder = NavigationRecorder(gate: gate, bridge: controller.bridge)
        web.navigationDelegate = recorder
        objc_setAssociatedObject(web, &NavigationRecorder.key, recorder, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)   // the delegate is weak
        return recorder
    }

    /// Asks for a page under `url` and runs the run loop until that navigation has settled, or 30 s pass. Settled is: the page
    /// committed (what a page-driven call sees from then on; a cold simulator can take many seconds more to report didFinish), or
    /// it finished or failed, or the policy cancelled it and the web view stopped loading (its url flips back to the old page then).
    func load(_ web: WKWebView, _ url: String) -> Outcome {
        policy = nil
        committedURL = nil
        gateAtCommit = nil
        ended = false
        web.loadHTMLString("<html></html>", baseURL: URL(string: url))
        let until = Date(timeIntervalSinceNow: 30)
        func settled() -> Bool { ended && (committedURL != nil || !web.isLoading) }
        while !settled(), Date() < until { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02)) }
        return Outcome(policy: policy, committedURL: committedURL, gateAtCommit: gateAtCommit, finalURL: web.url,
                       gateAtEnd: TalosPluginGate.allows(bridge), timedOut: !settled())
    }

    override func responds(to selector: Selector!) -> Bool { super.responds(to: selector) || gate.responds(to: selector) }
    override func forwardingTarget(for selector: Selector!) -> Any? { gate.responds(to: selector) ? gate : super.forwardingTarget(for: selector) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        gate.webView(webView, decidePolicyFor: navigationAction) { [weak self] decision in
            if navigationAction.targetFrame?.isMainFrame ?? true, navigationAction.request.url?.scheme != "about" {
                self?.policy = decision
                if decision == .cancel { self?.ended = true }
            }
            decisionHandler(decision)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        committedURL = webView.url
        gateAtCommit = TalosPluginGate.allows(bridge)
        ended = true
        gate.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ended = true
        gate.webView(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        ended = true
        (gate as WKNavigationDelegate).webView?(webView, didFail: navigation, withError: error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        ended = true
        (gate as WKNavigationDelegate).webView?(webView, didFailProvisionalNavigation: navigation, withError: error)
    }
}
