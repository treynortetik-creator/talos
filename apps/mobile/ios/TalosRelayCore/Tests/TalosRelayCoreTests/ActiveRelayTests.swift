import XCTest
@testable import TalosRelayCore

private let idA = "r_abcdefghijklmnopqrst"

private func profile(_ id: String, origin: String = "https://relay.example.com", store: UUID = UUID()) -> RelayProfile {
    RelayProfile(
        id: id, origin: URL(string: origin)!, kind: .self, label: "Home", bridgeFp: String(repeating: "A", count: 43),
        deviceId: "", dataStoreId: store, addedAt: Date(timeIntervalSince1970: 1_700_000_000))!
}

private struct DamagedKeychain: KeychainBacking {
    func read() throws -> Data? { Data("not json".utf8) }
    func write(_ data: Data) throws {}
    func delete() throws {}
}

final class ActiveRelayTests: XCTestCase {
    private let buildTime = URL(string: "https://build.example.com")!

    func testTheActiveProfileWinsOverTheBuildTimeURL() throws {
        let s = RelayStore(backing: InMemoryKeychain())
        let p = profile(idA, origin: "https://mine.example.com:8443")
        try s.add(p)
        for allow in [true, false] {
            let a = ActiveRelay.resolve(store: s, buildTimeURL: buildTime, allowBuildTime: allow)
            XCTAssertEqual(a?.origin.absoluteString, "https://mine.example.com:8443")
            XCTAssertEqual(a?.profile, p)
            XCTAssertEqual(a?.dataStoreId, p.dataStoreId)
        }
    }

    func testNoProfileFallsBackToTheBuildTimeURLOnlyWhenAllowed() {
        let s = RelayStore(backing: InMemoryKeychain())
        let a = ActiveRelay.resolve(store: s, buildTimeURL: buildTime, allowBuildTime: true)
        XCTAssertEqual(a?.origin, buildTime)
        XCTAssertNil(a?.profile)
        XCTAssertNil(a?.dataStoreId, "the build-time fallback uses the default data store")
        XCTAssertNil(ActiveRelay.resolve(store: s, buildTimeURL: buildTime, allowBuildTime: false))
        XCTAssertNil(ActiveRelay.resolve(store: s, buildTimeURL: nil, allowBuildTime: true))
    }

    func testNoStoreBehavesLikeNoProfile() {
        XCTAssertEqual(ActiveRelay.resolve(store: nil, buildTimeURL: buildTime, allowBuildTime: true)?.origin, buildTime)
        XCTAssertNil(ActiveRelay.resolve(store: nil, buildTimeURL: buildTime, allowBuildTime: false))
    }

    func testADamagedStoreNeverFallsBack() {
        let s = RelayStore(backing: DamagedKeychain())
        XCTAssertNil(ActiveRelay.resolve(store: s, buildTimeURL: buildTime, allowBuildTime: true))
    }

    func testARemovedRelayIsNoLongerActive() throws {
        let s = RelayStore(backing: InMemoryKeychain())
        try s.add(profile(idA))
        try s.remove(id: idA)
        XCTAssertNil(ActiveRelay.resolve(store: s, buildTimeURL: nil, allowBuildTime: false))
    }

    func testOrphanedStoresAreEveryStoreNoProfileOwns() {
        let keep = UUID(), gone1 = UUID(), gone2 = UUID()
        XCTAssertEqual(Set(RelayDataStores.orphans(existing: [keep, gone1, gone2], owned: [keep])), [gone1, gone2])
        XCTAssertEqual(RelayDataStores.orphans(existing: [keep], owned: [keep]), [])
        XCTAssertEqual(Set(RelayDataStores.orphans(existing: [gone1], owned: [])), [gone1])
    }

    func testNavigationHostKeepsANonDefaultPort() {
        XCTAssertEqual(ActiveRelay.navigationHost(of: URL(string: "https://relay.example.com")!), "relay.example.com")
        XCTAssertEqual(ActiveRelay.navigationHost(of: URL(string: "https://relay.example.com:8443")!), "relay.example.com:8443")
    }
}
