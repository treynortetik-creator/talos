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

    override func setUp() {
        super.setUp()
        savedRuntime = TalosBridgeViewController.runtime
    }

    override func tearDown() {
        TalosBridgeViewController.runtime = savedRuntime
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
        web.loadHTMLString("<html></html>", baseURL: URL(string: "https://mine.example.com/threads"))
        spin()
        XCTAssertEqual(web.url?.host, "mine.example.com")
        XCTAssertTrue(TalosPluginGate.allows(controller.bridge), "the profile's own page")
        web.loadHTMLString("<html></html>", baseURL: URL(string: "https://mine.example.com/media/x.html"))
        spin()
        XCTAssertFalse(TalosPluginGate.allows(controller.bridge), "/media/ is never allowed")
        web.loadHTMLString("<html></html>", baseURL: URL(string: "https://elsewhere.example.com/threads"))
        spin()
        XCTAssertFalse(TalosPluginGate.allows(controller.bridge), "another origin is refused")
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
        web.loadHTMLString("<html></html>", baseURL: URL(string: "https://mine.example.com/threads"))
        spin()
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
