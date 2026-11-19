import XCTest
@testable import TalosRelayCore

/// What phase 4b adds to the stored profile: the time of the last verified attest, saved by the profile's own key id.
final class RelayProfileTrustTests: XCTestCase {
    private let fp = String(repeating: "A", count: 43)

    private func profile(_ id: String = "r_abcdefghijklmnopqrst", store: UUID = UUID(), verified: Date? = nil, origin: String = "https://relay.example.test", failed: Bool = false) -> RelayProfile {
        RelayProfile(
            id: id, origin: URL(string: origin)!, kind: .self, label: "relay.example.test", bridgeFp: fp, deviceId: "",
            dataStoreId: store, addedAt: Date(timeIntervalSince1970: 1000), lastVerifiedAt: verified, attestFailed: failed)!
    }

    func testLastVerifiedRoundTripsAndAnOldBlobReadsNil() throws {
        let when = Date(timeIntervalSince1970: 4000)
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(profile(verified: when))
        XCTAssertEqual(try store.active()?.lastVerifiedAt, when)
        // A blob written before this field existed has no key for it.
        let old = #"{"relays":[{"id":"r_abcdefghijklmnopqrst","origin":"https:\/\/relay.example.test","kind":"self","label":"x","bridge_fp":"\#(fp)","device_id":"","data_store_id":"00000000-0000-0000-0000-000000000001","added_at":"1970-01-01T00:16:40Z"}],"active":"r_abcdefghijklmnopqrst"}"#
        let backing = InMemoryKeychain()
        try backing.write(Data(old.utf8))
        XCTAssertNil(try RelayStore(backing: backing).active()?.lastVerifiedAt)
    }

    func testUpdateChangesOnlyTheProfileWithThatKeyId() throws {
        let a = profile(store: UUID(uuidString: "00000000-0000-0000-0000-00000000000A")!)
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(a)
        let when = Date(timeIntervalSince1970: 9000)
        let newFp = String(repeating: "B", count: 43)
        XCTAssertTrue(try store.update(keyId: a.keyId) { $0.lastVerifiedAt = when; $0.bridgeFp = newFp })
        XCTAssertEqual(try store.active()?.lastVerifiedAt, when)
        XCTAssertEqual(try store.active()?.bridgeFp, newFp)
        XCTAssertEqual(try store.active()?.id, a.id)
        XCTAssertEqual(try store.activeId(), a.id, "the active relay is unchanged")
    }

    func testUpdateByAnotherPairingsKeyIdChangesNothingEvenWithTheSameRelayId() throws {
        // A relay chooses its own id: a second pairing that claims the first one's id has its own key id and must not be touched.
        let first = profile(store: UUID(uuidString: "00000000-0000-0000-0000-00000000000A")!)
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(first)
        let stranger = UUID(uuidString: "00000000-0000-0000-0000-00000000000B")!.uuidString
        XCTAssertFalse(try store.update(keyId: stranger) { $0.lastVerifiedAt = Date(timeIntervalSince1970: 1) })
        XCTAssertNil(try store.active()?.lastVerifiedAt)
    }

    func testUpdateCannotChangeWhoThePairingIs() throws {
        let a = profile()
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(a)
        _ = try store.update(keyId: a.keyId) { $0.dataStoreId = UUID(); $0.origin = URL(string: "https://evil.example.test")!; $0.lastVerifiedAt = Date() }
        XCTAssertEqual(try store.active()?.keyId, a.keyId, "a change that moves the key id or the origin is dropped")
        XCTAssertEqual(try store.active()?.origin, a.origin)
    }

    func testUpdateThrowsOnADamagedBlob() throws {
        let backing = InMemoryKeychain()
        try backing.write(Data("junk".utf8))
        XCTAssertThrowsError(try RelayStore(backing: backing).update(keyId: "x") { _ in })
    }

    func testOriginTextIsSchemeHostAndPortOnly() {
        XCTAssertEqual(profile(origin: "https://relay.example.test").originText, "https://relay.example.test")
        XCTAssertEqual(profile(origin: "https://relay.example.test/").originText, "https://relay.example.test")
        XCTAssertEqual(profile(origin: "https://Relay.Example.test:8443").originText, "https://relay.example.test:8443")
        XCTAssertEqual(profile(origin: "https://relay.example.test:443").originText, "https://relay.example.test")
    }

    // MARK: what a notification button may do (quick-act reads this from the shared Keychain, per key id)

    func testQuickActIsAllowedOnlyForAFreshUnfailedPairing() {
        let now = Date(timeIntervalSince1970: 10_000_000)
        let day = RelayProfile.trustWindow
        XCTAssertEqual(day, 24 * 3600)
        XCTAssertTrue(profile(verified: now.addingTimeInterval(-60)).allowsQuickAct(now: now), "verified a minute ago")
        XCTAssertTrue(profile(verified: now.addingTimeInterval(-day + 1)).allowsQuickAct(now: now), "one second inside the window")
        XCTAssertFalse(profile(verified: now.addingTimeInterval(-day)).allowsQuickAct(now: now), "exactly 24 hours is expired")
        XCTAssertFalse(profile(verified: now.addingTimeInterval(-day - 1)).allowsQuickAct(now: now))
        XCTAssertFalse(profile(verified: nil).allowsQuickAct(now: now), "never verified: refused")
        XCTAssertFalse(profile(verified: now.addingTimeInterval(5)).allowsQuickAct(now: now), "a time in the future counts as expired")
        XCTAssertFalse(profile(verified: now.addingTimeInterval(-60), failed: true).allowsQuickAct(now: now), "a failed pairing is refused whatever the time")
    }

    func testTheFailedFlagRoundTripsDefaultsToFalseAndIsKeptByUpdate() throws {
        let a = profile(store: UUID(uuidString: "00000000-0000-0000-0000-00000000000A")!)
        XCTAssertFalse(a.attestFailed)
        let store = RelayStore(backing: InMemoryKeychain())
        try store.add(a)
        XCTAssertTrue(try store.update(keyId: a.keyId) { $0.attestFailed = true })
        XCTAssertEqual(try store.active()?.attestFailed, true)
        XCTAssertTrue(try store.update(keyId: a.keyId) { $0.attestFailed = false })
        XCTAssertEqual(try store.active()?.attestFailed, false)
        // a blob from before this field has no key for it
        let old = #"{"relays":[{"id":"r_abcdefghijklmnopqrst","origin":"https:\/\/relay.example.test","kind":"self","label":"x","bridge_fp":"\#(fp)","device_id":"","data_store_id":"00000000-0000-0000-0000-000000000001","added_at":"1970-01-01T00:16:40Z"}],"active":"r_abcdefghijklmnopqrst"}"#
        let backing = InMemoryKeychain()
        try backing.write(Data(old.utf8))
        XCTAssertEqual(try RelayStore(backing: backing).active()?.attestFailed, false)
    }
}
