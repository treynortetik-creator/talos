import BridgeGuard
import TalosRelayCore
import WebKit
import XCTest

@testable import App

/// The active relay is the one source for the web view, the guard, the plugin gate and the data store; each relay has its own
/// WebKit data store; a removed or replaced relay's store goes.
@MainActor
final class RelayRuntimeTests: XCTestCase {
    private let idA = "r_abcdefghijklmnopqrst"
    private let idB = "r_234567abcdefghijklmn"

    private func profile(_ id: String, host: String, store: UUID = UUID()) -> RelayProfile {
        RelayProfile(id: id, origin: URL(string: "https://\(host)")!, kind: .self, label: host,
                     bridgeFp: String(repeating: "A", count: 43), deviceId: "", dataStoreId: store,
                     addedAt: Date(timeIntervalSince1970: 1000))!
    }

    private final class FakeStores: RelayDataStoreAccess {
        var existing: [UUID]
        var removed: [UUID] = []
        var failing = false
        var defaultCleared = 0
        init(existing: [UUID]) { self.existing = existing }
        func clearDefault() async { defaultCleared += 1 }
        func identifiers() async -> [UUID] { existing }
        func remove(_ id: UUID) async -> Bool {
            if failing { return false }
            existing.removeAll { $0 == id }
            removed.append(id)
            return true
        }
    }

    private func runtime(_ store: RelayStore?, _ stores: RelayDataStoreAccess, allowBuildTime: Bool = false,
                         sweeps: Bool = true, onSwitch: @escaping () -> Void = {}, clearKeys: @escaping (String) -> Void = { _ in },
                         clearLegacyKeys: @escaping () -> Void = {}, pruneKeys: @escaping (Set<String>) -> Void = { _ in },
                         defaults: UserDefaults? = nil) -> RelayRuntime {
        RelayRuntime(store: { store }, dataStores: stores, allowBuildTime: allowBuildTime, sweeps: sweeps, onSwitch: onSwitch,
                     clearKeys: clearKeys, clearLegacyKeys: clearLegacyKeys, pruneKeys: pruneKeys,
                     defaults: defaults ?? freshDefaults())
    }

    private func freshDefaults() -> UserDefaults { UserDefaults(suiteName: "relay-runtime-tests-\(UUID().uuidString)")! }

    private func pending(_ p: RelayProfile) -> PendingRelay { PendingRelay(profile: p, note: nil, code: "01234567890123456789012345") }

    // MARK: One source of truth

    func testTheContextIsBuiltFromTheActiveProfileNotTheBuildTimeURL() throws {
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "mine.example.com"))
        let active = try XCTUnwrap(runtime(store, FakeStores(existing: [])).active(buildTimeURL: URL(string: "https://build.example.com")))
        let ctx = try XCTUnwrap(RelayContext(active: active))
        XCTAssertEqual(ctx.guardian.relay, Origin(scheme: "https", host: "mine.example.com", port: nil))
        XCTAssertTrue(ctx.guardian.isRelayURL(URL(string: "https://mine.example.com/threads")!))
        XCTAssertFalse(ctx.guardian.isRelayURL(URL(string: "https://build.example.com/threads")!))
    }

    func testANewContextStartsAtPass() throws {
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "mine.example.com"))
        let active = try XCTUnwrap(runtime(store, FakeStores(existing: [])).active(buildTimeURL: nil))
        XCTAssertEqual(try XCTUnwrap(RelayContext(active: active)).trust.state, .pass)
    }

    func testTheEnrollURLCarriesTheScannedCodeToTheScannedOrigin() {
        let url = RelayContext.enrollURL(origin: URL(string: "https://mine.example.com:8443")!, code: "01234567890123456789012345")
        XCTAssertEqual(url?.absoluteString, "https://mine.example.com:8443/enroll#01234567890123456789012345")
    }

    func testAReleaseRuntimeIgnoresTheBuildTimeURL() {
        let store = RelayStore(backing: InMemoryKeychain())
        XCTAssertNil(runtime(store, FakeStores(existing: []), allowBuildTime: false).active(buildTimeURL: URL(string: "https://build.example.com")))
        XCTAssertNotNil(runtime(store, FakeStores(existing: []), allowBuildTime: true).active(buildTimeURL: URL(string: "https://build.example.com")))
    }

    func testTheShippingRuntimeFallsBackOnlyInDebugBuilds() {
        #if DEBUG
        XCTAssertTrue(RelayRuntime.live.allowBuildTime)
        #else
        XCTAssertFalse(RelayRuntime.live.allowBuildTime)
        #endif
    }

    func testNoStoreMeansNoContextWithoutAnOrigin() {
        XCTAssertNil(RelayContext(active: nil))
    }

    // MARK: Data stores

    func testRemovingTheLastRelayRemovesItsOwnDataStoreAndNothingElse() async throws {
        let a = UUID(), other = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: a))
        let stores = FakeStores(existing: [a, other])
        try await runtime(store, stores).remove(id: idA)
        XCTAssertEqual(stores.removed, [a], "the list is empty now, so the sweep skips and only the removed relay's store goes")
        XCTAssertNil(try store.active())
    }

    func testAFailedRemovalOfTheLastRelaysStoreIsRetriedByALaterSweep() async throws {
        let a = UUID()
        let defaults = freshDefaults()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: a))
        let stores = FakeStores(existing: [a])
        stores.failing = true
        try await runtime(store, stores, defaults: defaults).remove(id: idA)
        XCTAssertEqual(stores.existing, [a], "the web view still held it")
        // A later launch: the list is empty, yet the removed relay's store is still removed.
        stores.failing = false
        let failed = await runtime(store, stores, defaults: defaults).sweepOrphans()
        XCTAssertEqual(failed, 0)
        XCTAssertEqual(stores.removed, [a])
        // And it is not tried again.
        _ = await runtime(store, stores, defaults: defaults).sweepOrphans()
        XCTAssertEqual(stores.removed, [a])
    }

    func testAPendingRemovalThatStillFailsStaysPending() async throws {
        let a = UUID()
        let defaults = freshDefaults()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: a))
        let stores = FakeStores(existing: [a])
        stores.failing = true
        try await runtime(store, stores, defaults: defaults).remove(id: idA)
        let failed = await runtime(store, stores, defaults: defaults).sweepOrphans()
        XCTAssertEqual(failed, 1)
        stores.failing = false
        _ = await runtime(store, stores, defaults: defaults).sweepOrphans()
        XCTAssertEqual(stores.removed, [a])
    }

    func testAnEmptyListSweepsNothing() async {
        let stores = FakeStores(existing: [UUID(), UUID()])
        let failed = await runtime(RelayStore(backing: InMemoryKeychain()), stores).sweepOrphans()
        XCTAssertEqual(failed, 0)
        XCTAssertTrue(stores.removed.isEmpty, "an empty read must never delete every store")
    }

    func testTheInMemoryStubNeverSweeps() async throws {
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: UUID()))
        let stores = FakeStores(existing: [UUID()])
        _ = await runtime(store, stores, sweeps: false).sweepOrphans()
        XCTAssertTrue(stores.removed.isEmpty)
    }

    // MARK: A relay switch

    func testSavingADifferentRelayClearsTheShareToken() throws {
        let store = RelayStore(backing: InMemoryKeychain())
        var cleared = 0
        let rt = runtime(store, FakeStores(existing: []), onSwitch: { cleared += 1 })
        try rt.save(pending(profile(idA, host: "a.example.com")))
        XCTAssertEqual(cleared, 1, "the first pairing replaces whatever the build-time relay left")
        try rt.save(pending(profile(idB, host: "b.example.com")))
        XCTAssertEqual(cleared, 2)
        XCTAssertEqual(try store.active()?.id, idB)
    }

    func testSavingTheSameRelayAgainKeepsThem() throws {
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com"))
        var cleared = 0
        try runtime(store, FakeStores(existing: []), onSwitch: { cleared += 1 }).save(pending(profile(idA, host: "a.example.com")))
        XCTAssertEqual(cleared, 0)
    }

    func testAFailedSaveClearsNothing() {
        var cleared = 0
        XCTAssertThrowsError(try runtime(nil, FakeStores(existing: []), onSwitch: { cleared += 1 }).save(pending(profile(idA, host: "a.example.com"))))
        XCTAssertEqual(cleared, 0)
    }

    // MARK: Notification keys follow their pairing

    func testRemovingARelayDeletesThatPairingsKeysAndNoOthers() async throws {
        let ds = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: ds))
        var cleared: [String] = []
        try await runtime(store, FakeStores(existing: []), clearKeys: { cleared.append($0) }).remove(id: idA)
        XCTAssertEqual(cleared, [ds.uuidString], "named by the key id the phone minted")
    }

    func testSavingADifferentRelayDeletesTheOldPairingsKeys() throws {
        let dsA = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: dsA))
        var cleared: [String] = []
        try runtime(store, FakeStores(existing: []), clearKeys: { cleared.append($0) })
            .save(pending(profile(idB, host: "b.example.com")))
        XCTAssertEqual(cleared, [dsA.uuidString], "relay A left the list, so its keys go; relay B's are made by B's own page")
    }

    func testSavingARelayThatClaimsTheOldRelaysIdGetsNoAccessToTheOldKeys() throws {
        // The relay id comes from the relay's public descriptor, so a hostile relay can claim relay A's id.
        let dsA = UUID(), dsHostile = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        let a = profile(idA, host: "a.example.com", store: dsA)
        try store.add(a)
        var cleared: [String] = []
        let hostile = profile(idA, host: "hostile.example.com", store: dsHostile)
        try runtime(store, FakeStores(existing: []), clearKeys: { cleared.append($0) }).save(pending(hostile))
        XCTAssertEqual(cleared, [dsA.uuidString], "A's keys are deleted")
        let active = try XCTUnwrap(try store.active())
        XCTAssertEqual(active.id, idA)
        XCTAssertEqual(active.origin, hostile.origin)
        XCTAssertNotEqual(active.keyId, a.keyId, "and the new pairing is named by an id the phone just minted")
    }

    func testSameRelayIdAndSameKeyIdButAnotherOriginStillClearsTheKeys() throws {
        let ds = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: ds))
        var cleared: [String] = []
        try runtime(store, FakeStores(existing: []), clearKeys: { cleared.append($0) })
            .save(pending(profile(idA, host: "moved.example.com", store: ds)))
        XCTAssertEqual(cleared, [ds.uuidString], "defensive: a profile at another origin never keeps the keys of the old one")
    }

    func testSavingTheSamePairingAgainKeepsItsKeys() throws {
        let ds = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: ds))
        var cleared: [String] = []
        try runtime(store, FakeStores(existing: []), clearKeys: { cleared.append($0) })
            .save(pending(profile(idA, host: "a.example.com", store: ds)))
        XCTAssertTrue(cleared.isEmpty)
    }

    func testTheFirstPairingClearsNoKeys() throws {
        var cleared: [String] = []
        try runtime(RelayStore(backing: InMemoryKeychain()), FakeStores(existing: []), clearKeys: { cleared.append($0) })
            .save(pending(profile(idA, host: "a.example.com")))
        XCTAssertTrue(cleared.isEmpty)
    }

    func testTheLaunchSweepDropsTheSingleRelayKeysAndEveryPairingNoStoredProfileOwns() throws {
        let dsA = UUID(), dsB = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: dsA))
        var legacy = 0
        var kept: [Set<String>] = []
        runtime(store, FakeStores(existing: []), clearLegacyKeys: { legacy += 1 }, pruneKeys: { kept.append($0) }).sweepKeysAtLaunch()
        XCTAssertEqual(legacy, 1, "the single-relay keys are deleted, never adopted")
        XCTAssertEqual(kept, [[dsA.uuidString]])
        XCTAssertFalse(kept[0].contains(dsB.uuidString))
    }

    func testTheLaunchSweepPrunesNothingWhenTheListCannotBeRead() {
        let broken = InMemoryKeychain()
        try? broken.write(Data("not json".utf8))
        var kept = 0
        runtime(RelayStore(backing: broken), FakeStores(existing: []), pruneKeys: { _ in kept += 1 }).sweepKeysAtLaunch()
        runtime(nil, FakeStores(existing: []), pruneKeys: { _ in kept += 1 }).sweepKeysAtLaunch()
        XCTAssertEqual(kept, 0, "an unreadable list is not proof that no relay owns a key")
    }

    func testTheOldDefaultDataStoreIsClearedOnce() async throws {
        let suite = UserDefaults(suiteName: "relay-runtime-tests-\(UUID().uuidString)")!
        let stores = FakeStores(existing: [])
        let rt = runtime(RelayStore(backing: InMemoryKeychain()), stores)
        let first = await rt.clearDefaultStoreOnce(defaults: suite)
        let second = await rt.clearDefaultStoreOnce(defaults: suite)
        XCTAssertTrue(first)
        XCTAssertFalse(second)
        XCTAssertEqual(stores.defaultCleared, 1)
    }

    func testSweepKeepsTheStoreOfEveryStoredRelay() async throws {
        let a = UUID(), orphan = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: a))
        let stores = FakeStores(existing: [a, orphan])
        let failed = await runtime(store, stores).sweepOrphans()
        XCTAssertEqual(failed, 0)
        XCTAssertEqual(stores.removed, [orphan])
        XCTAssertEqual(stores.existing, [a])
    }

    func testReplacingTheRelayLeavesTheOldStoreForTheSweep() async throws {
        let old = UUID(), new = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: old))
        try store.add(profile(idB, host: "b.example.com", store: new))
        let stores = FakeStores(existing: [old, new])
        _ = await runtime(store, stores).sweepOrphans()
        XCTAssertEqual(stores.existing, [new])
    }

    func testAStoreInUseIsReportedAndKept() async throws {
        let orphan = UUID()
        let kept = UUID()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(idA, host: "a.example.com", store: kept))
        let stores = FakeStores(existing: [orphan, kept])
        stores.failing = true
        let failed = await runtime(store, stores).sweepOrphans()
        XCTAssertEqual(failed, 1)
    }

    func testADamagedListSweepsNothing() async {
        struct Damaged: KeychainBacking {
            func read() throws -> Data? { Data("x".utf8) }
            func write(_ data: Data) throws {}
            func delete() throws {}
        }
        let stores = FakeStores(existing: [UUID()])
        _ = await runtime(RelayStore(backing: Damaged()), stores).sweepOrphans()
        XCTAssertTrue(stores.removed.isEmpty, "an unreadable list must never read as 'no relay owns any store'")
    }

    func testNoKeychainSweepsNothing() async {
        let stores = FakeStores(existing: [UUID()])
        _ = await runtime(nil, stores).sweepOrphans()
        XCTAssertTrue(stores.removed.isEmpty)
    }

    // MARK: The real WebKit stores

    func testTwoRelaysNeverShareCookies() async throws {
        let a = UUID(), b = UUID()
        let storeA = WKWebsiteDataStore(forIdentifier: a)
        let storeB = WKWebsiteDataStore(forIdentifier: b)
        let cookie = try XCTUnwrap(HTTPCookie(properties: [
            .domain: "a.example.com", .path: "/", .name: "session", .value: "secret", .secure: "TRUE"]))
        await storeA.httpCookieStore.setCookie(cookie)
        let inA = await storeA.httpCookieStore.allCookies()
        let inB = await storeB.httpCookieStore.allCookies()
        XCTAssertEqual(inA.map(\.name), ["session"])
        XCTAssertEqual(inB, [], "another relay's data store must not see it")
        let real = WebKitRelayDataStores()
        _ = await real.remove(a)
        _ = await real.remove(b)
    }

    func testTheRealStoreRemovalDeletesTheStore() async throws {
        let id = UUID()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.domain: "a.example.com", .path: "/", .name: "k", .value: "v", .secure: "TRUE"]))
        await WKWebsiteDataStore(forIdentifier: id).httpCookieStore.setCookie(cookie)
        let real = WebKitRelayDataStores()
        // WebKit refuses while the store object above is still alive, which is why the sweep tries again later.
        var removed = false
        for _ in 0..<50 where !removed {
            removed = await real.remove(id)
            if !removed { try await Task.sleep(nanoseconds: 100_000_000) }
        }
        XCTAssertTrue(removed)
        let reborn = await WKWebsiteDataStore(forIdentifier: id).httpCookieStore.allCookies()
        XCTAssertEqual(reborn, [], "a removed relay's cookies are gone")
        _ = await real.remove(id)
    }
}
