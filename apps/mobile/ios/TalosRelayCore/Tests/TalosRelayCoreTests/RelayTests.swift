import XCTest
@testable import TalosRelayCore

private let idA = "r_abcdefghijklmnopqrst"
private let idB = "r_234567abcdefghijklmn"

private func profile(_ id: String, label: String = "Home") -> RelayProfile {
    RelayProfile(
        id: id, origin: URL(string: "https://relay.example.com")!, kind: .self, label: label,
        bridgeFp: String(repeating: "A", count: 43), deviceId: "d_abc", dataStoreId: UUID(),
        pushHandle: "h_1", stepUpKeyRef: nil, addedAt: Date(timeIntervalSince1970: 1_700_000_000))!
}

final class RelayIDTests: XCTestCase {
    func testValidation() {
        XCTAssertTrue(RelayID.isValid(idA))
        XCTAssertTrue(RelayID.isValid(idB))
        for bad in ["", "r_", "r_abcdefghijklmnopqrs", "r_abcdefghijklmnopqrstu", "R_abcdefghijklmnopqrst",
                    "r_ABCDEFGHIJKLMNOPQRST", "r_abcdefghijklmnopqrs1", "r_abcdefghijklmnopqrs8", "x_abcdefghijklmnopqrst",
                    "r-abcdefghijklmnopqrst", "r_abcdefghijklmnopqrs "] {
            XCTAssertFalse(RelayID.isValid(bad), bad)
        }
    }

    func testProfileRefusesBadId() {
        XCTAssertNil(RelayProfile(id: "nope", origin: URL(string: "https://a.example.com")!, kind: .hosted, label: "x",
                                  bridgeFp: "f", deviceId: "d", dataStoreId: UUID(), addedAt: Date()))
    }

    func testProfileDecodeRefusesBadIdAndUsesSnakeCase() throws {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        let json = try String(data: enc.encode(profile(idA)), encoding: .utf8)!
        for key in ["bridge_fp", "device_id", "data_store_id", "push_handle", "added_at"] { XCTAssertTrue(json.contains(key), key) }
        XCTAssertFalse(json.contains("step_up_key_ref"))
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        XCTAssertNoThrow(try dec.decode(RelayProfile.self, from: Data(json.utf8)))
        let broken = json.replacingOccurrences(of: idA, with: "bogus")
        XCTAssertThrowsError(try dec.decode(RelayProfile.self, from: Data(broken.utf8)))
    }
}

final class RelayStoreTests: XCTestCase {
    func testEmpty() throws {
        let s = RelayStore(backing: InMemoryKeychain())
        XCTAssertEqual(try s.list(), [])
        XCTAssertNil(try s.activeId())
        XCTAssertNil(try s.active())
    }

    func testAddReplacesAndActivates() throws {
        let s = RelayStore(backing: InMemoryKeychain())
        try s.add(profile(idA, label: "One"))
        XCTAssertEqual(try s.activeId(), idA)
        try s.add(profile(idB, label: "Two"))
        XCTAssertEqual(try s.list().map(\.id), [idB])
        XCTAssertEqual(try s.activeId(), idB)
        XCTAssertEqual(try s.active()?.label, "Two")
    }

    func testSetActive() throws {
        let s = RelayStore(backing: InMemoryKeychain())
        try s.add(profile(idA))
        XCTAssertFalse(try s.setActive(idB))
        XCTAssertEqual(try s.activeId(), idA)
        XCTAssertTrue(try s.setActive(idA))
    }

    func testRemoveClearsActive() throws {
        let kc = InMemoryKeychain()
        let s = RelayStore(backing: kc)
        try s.add(profile(idA))
        try s.remove(id: idB)
        XCTAssertEqual(try s.list().count, 1)
        try s.remove(id: idA)
        XCTAssertEqual(try s.list(), [])
        XCTAssertNil(try s.activeId())
        XCTAssertNil(try kc.read())
    }

    func testSurvivesNewStoreOnSameBacking() throws {
        let kc = InMemoryKeychain()
        let p = profile(idA)
        try RelayStore(backing: kc).add(p)
        let again = RelayStore(backing: kc)
        XCTAssertEqual(try again.list(), [p])
        XCTAssertEqual(try again.activeId(), idA)
    }

    func testDamagedBlobThrowsNotEmpty() throws {
        let kc = InMemoryKeychain()
        try kc.write(Data("not json".utf8))
        XCTAssertThrowsError(try RelayStore(backing: kc).list())
    }

    func testResetClearsADamagedItem() throws {
        let kc = InMemoryKeychain()
        try kc.write(Data("not json".utf8))
        let s = RelayStore(backing: kc)
        XCTAssertThrowsError(try s.remove(id: idA))
        try s.reset()
        XCTAssertEqual(try s.list(), [])
        try s.add(profile(idA))
        XCTAssertEqual(try s.activeId(), idA)
    }
}

final class RelayDescriptorTests: XCTestCase {
    private func decode(minApp: String = "0.0.0", id: String = idA) throws -> RelayDescriptor {
        let j = #"{"protocol":1,"relay_version":"1.2.3","relay_id":"\#(id)","kind":"self","min_app":"\#(minApp)"}"#
        return try JSONDecoder().decode(RelayDescriptor.self, from: Data(j.utf8))
    }

    func testDecodes() throws {
        let d = try decode()
        XCTAssertEqual(d.relayId, idA)
        XCTAssertEqual(d.kind, .self)
        XCTAssertEqual(d.relayVersion, "1.2.3")
        XCTAssertEqual(d.protocol, 1)
    }

    func testRefusesBadRelayId() {
        XCTAssertThrowsError(try decode(id: "r_short"))
    }

    func testAdvisoryCheck() throws {
        XCTAssertEqual(try decode(minApp: "0.0.0").check(appVersion: "1.0.0"), .ok)
        XCTAssertEqual(try decode(minApp: "1.2.0").check(appVersion: "1.2"), .ok)
        XCTAssertEqual(try decode(minApp: "1.10.0").check(appVersion: "1.9.9"), .updateAdvised(minApp: "1.10.0"))
        XCTAssertEqual(try decode(minApp: "2.0.0").check(appVersion: "1.99.99"), .updateAdvised(minApp: "2.0.0"))
        XCTAssertNotNil(try decode(minApp: "2.0.0").check(appVersion: "1.0.0").note)
        XCTAssertNil(DescriptorCheck.ok.note)
    }

    func testUnreadableVersionNeverBlocks() throws {
        XCTAssertEqual(try decode(minApp: "soon").check(appVersion: "1.0.0"), .ok)
        XCTAssertEqual(try decode(minApp: "1.0.0").check(appVersion: "dev"), .ok)
    }
}
