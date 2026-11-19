import BridgeGuard
import Foundation
import TalosRelayCore
import WebKit

/// Where the shell finds the relay it is on (BYOR.md 3.1, 10d). One resolution, `ActiveRelay`, feeds the web view's start URL,
/// the bridge guard, the navigation gate, the plugin gate and the web view's data store. The origin is set only by the native
/// scan (`AddRelayViewController.handle(link:)`, which saves a profile); nothing here reads a page, a deep link or a plugin
/// argument.

/// WebKit's per-relay data stores, behind a protocol so tests can stand in for them.
@MainActor
protocol RelayDataStoreAccess {
    func identifiers() async -> [UUID]
    /// False when the store could not be removed (for example a web view still uses it).
    func remove(_ id: UUID) async -> Bool
    /// The app's old shared store (what the build-time relay used before relays had their own).
    func clearDefault() async
}

@MainActor
struct WebKitRelayDataStores: RelayDataStoreAccess {
    func identifiers() async -> [UUID] { await WKWebsiteDataStore.allDataStoreIdentifiers }
    func remove(_ id: UUID) async -> Bool {
        // Removing the store deletes what is on disk; cookies and caches a live network session still holds in memory stay
        // readable by a store of the same id until the app restarts, so the data is emptied first.
        await Self.empty(id)
        do {
            try await WKWebsiteDataStore.remove(forIdentifier: id)
            return true
        } catch {
            return false
        }
    }

    private static func empty(_ id: UUID) async {
        let store = WKWebsiteDataStore(forIdentifier: id)
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    func clearDefault() async {
        let store = WKWebsiteDataStore.default()
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }
}

@MainActor
struct RelayRuntime {
    var store: () -> RelayStore?
    var dataStores: RelayDataStoreAccess
    /// A development build may load its build-time URL while nothing is paired. A release build never does.
    var allowBuildTime: Bool
    /// False for the in-memory DEBUG stub, whose list is empty again on every launch: a sweep against it would delete real stores.
    var sweeps = true
    /// Runs when a different relay is saved: whatever the old relay's page left in the shared Keychain (the share token) goes,
    /// so the extension never acts against the new relay with the old relay's proof. The notification keys and grant are per
    /// pairing (`NativeKeyStore`, named by `RelayProfile.keyId`), so they are not cleared here: they stay with their own pairing.
    var onSwitch: () -> Void = RelayRuntime.clearRelayBoundNativeState
    /// Deletes one pairing's notification keys and grant, by key id (the relay was removed or replaced).
    var clearKeys: (String) -> Void = { _ = NativeKeyStore.clearAll(keyId: $0) }
    /// Deletes the notification keys the single-relay builds made. They are never adopted: a relay the owner has left may know them.
    var clearLegacyKeys: () -> Void = NativeKeyStore.clearLegacy
    /// Deletes the keys of every pairing not in the set (the sweep at launch).
    var pruneKeys: (Set<String>) -> Void = { NativeKeyStore.removeKeys(exceptKeyIds: $0) }
    /// Holds the data stores whose removal failed (a web view still used them), so a later launch tries again.
    var defaults: UserDefaults = .standard
    private static let pendingKey = "talos.relay.pendingStoreRemovals"

    private var pendingRemovals: [UUID] {
        get { (defaults.stringArray(forKey: Self.pendingKey) ?? []).compactMap(UUID.init(uuidString:)) }
        nonmutating set { defaults.set(newValue.map(\.uuidString), forKey: Self.pendingKey) }
    }

    static func clearRelayBoundNativeState() {
        try? KeychainTokenStore.clear()
    }

    static var live: RelayRuntime {
        var store: () -> RelayStore? = {
            KeychainTokenStore.group().map { RelayStore(backing: SystemKeychain(accessGroup: $0)) }
        }
        #if DEBUG
        // The simulator's unsigned build has no Keychain group; the DEBUG hook keeps its list in memory.
        var sweeps = true
        if DebugAddRelay.stub() != nil { store = { DebugAddRelay.store }; sweeps = false }
        let allowBuildTime = true
        #else
        let sweeps = true
        let allowBuildTime = false
        #endif
        return RelayRuntime(store: store, dataStores: WebKitRelayDataStores(), allowBuildTime: allowBuildTime, sweeps: sweeps)
    }

    func active(buildTimeURL: URL?) -> ActiveRelay? {
        ActiveRelay.resolve(store: store(), buildTimeURL: buildTimeURL, allowBuildTime: allowBuildTime)
    }

    /// Saves a scanned relay and makes it active. A different relay (or the first pairing) clears the share token first-hand: it
    /// came from another relay's page. The notification keys of the profile that was active go when it left the list, and also
    /// when the new profile has another relay id or another origin (even if it somehow kept the same key id): a relay chooses its own
    /// id, so a hostile one can claim an earlier relay's, and the new pairing must never reach the old one's keys or grant. A new
    /// scan has a new key id (the phone mints it), so its keys are new either way. Nothing is cleared when the save fails.
    func save(_ pending: PendingRelay) throws {
        guard let store = store() else { throw RelayRuntimeError.noStore }
        let before = try? store.active()
        try AddRelayFlow.save(pending, in: store)
        if before?.id != pending.profile.id || before?.origin != pending.profile.origin { onSwitch() }
        if let old = before {
            let stillListed = ((try? store.list()) ?? []).contains { $0.keyId == old.keyId }
            if old.id != pending.profile.id || old.origin != pending.profile.origin || !stillListed { clearKeys(old.keyId) }
        }
    }

    /// Run at launch: keys from the single-relay builds are deleted, and so are the keys of any pairing no stored profile owns (a
    /// removed or replaced relay, or a deletion that failed earlier). An unreadable relay list sweeps nothing.
    func sweepKeysAtLaunch() {
        guard sweeps else { return }
        clearLegacyKeys()
        guard let profiles = try? store()?.list() else { return }
        pruneKeys(Set(profiles.map(\.keyId)))
    }

    /// Removes the relay from the list, its notification keys and grant, and its own data store (and any other store no stored
    /// relay owns, while some relay is left).
    func remove(id: String) async throws {
        let profile = try store()?.list().first { $0.id == id }
        let own = profile?.dataStoreId
        try store()?.remove(id: id)
        if let profile { clearKeys(profile.keyId) }
        if let own, await !dataStores.remove(own) { pendingRemovals = pendingRemovals + [own] }
        _ = await sweepOrphans()
    }

    /// Clears the old default data store once, the first time a relay profile is the active one. Returns whether it ran.
    @discardableResult
    func clearDefaultStoreOnce(defaults: UserDefaults = .standard) async -> Bool {
        let key = "talos.relay.defaultStoreCleared"
        guard !defaults.bool(forKey: key) else { return false }
        defaults.set(true, forKey: key)
        await dataStores.clearDefault()
        return true
    }

    /// Removes every WebKit data store that no stored relay owns (a removed or replaced relay). An unreadable or missing list
    /// removes nothing. Returns how many stores could not be removed (a web view may still hold one; the next sweep tries again).
    @discardableResult
    func sweepOrphans() async -> Int {
        var failed = 0
        // Stores of removed relays that could not go the first time. They are known ids, so they are retried whatever the list says.
        var stillPending: [UUID] = []
        for id in pendingRemovals {
            if await !dataStores.remove(id) { stillPending.append(id) }
        }
        pendingRemovals = stillPending
        failed += stillPending.count
        // An empty list is not proof that no relay owns a store (an unreadable item reads empty too): only a non-empty one sweeps.
        guard sweeps, let store = store(), let owned = try? store.list().map(\.dataStoreId), !owned.isEmpty else { return failed }
        for id in RelayDataStores.orphans(existing: await dataStores.identifiers(), owned: owned) {
            if await !dataStores.remove(id) { failed += 1 }
        }
        return failed
    }
}

enum RelayRuntimeError: Error { case noStore }

/// What one web view controller holds for its relay: the guard built from the active origin and the trust object injected into
/// every guarded site. Made once per controller, so a profile change takes a new controller (and a new web view).
final class RelayContext {
    let active: ActiveRelay
    let guardian: BridgeGuard
    let trust: RelayTrust

    /// The page that continues pairing after a scan: `<origin>/enroll#<code>` (the code only ever lives in this URL's fragment).
    static func enrollURL(origin: URL, code: String) -> URL? {
        URL(string: "\(origin.absoluteString)/enroll#\(code)")
    }

    /// A paired relay starts `.unverified(.checking)`: it reaches `.pass` only when an attest passes. The one page that is no paired
    /// relay (a development build's compiled-in address, never in a release build) has no key to check and starts `.pass`.
    init?(active: ActiveRelay?, trust: RelayTrust? = nil) {
        guard let active, let guardian = BridgeGuard(relayURL: active.origin) else { return nil }
        self.active = active
        self.guardian = guardian
        if let trust {
            self.trust = trust
        } else if let profile = active.profile {
            self.trust = RelayTrust(.unverified(lastVerified: profile.lastVerifiedAt, reason: .checking), lastVerified: profile.lastVerifiedAt)
        } else {
            self.trust = RelayTrust(.pass, hasWindow: false)
        }
    }
}
