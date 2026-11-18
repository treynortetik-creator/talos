import CryptoKit
import Foundation
import Security
import TalosRelayCore
import XCTest
@testable import TalosPushCore

@testable import App

/// Runs inside the real app on the simulator, against the real Keychain. These are the parts the Swift packages cannot reach
/// because they import Security with the app's access group: key creation, saving a grant, what sign-out leaves behind, and that
/// every pairing keeps its own keys, named by an id the phone minted ("device keys never mix", BYOR.md 3.1).
final class NativeKeyStoreTests: XCTestCase {
    private let keyA = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
    private let keyB = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"
    private let keyC = "CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC"

    override func setUp() { clean() }
    override func tearDown() { clean() }

    private func clean() {
        for id in [keyA, keyB, keyC] { NativeKeyStore.clearAll(keyId: id) }
        NativeKeyStore.clearLegacy()
    }

    private func grant(enc: String, act: String, device: String = "dev1") -> String {
        let osig = String(repeating: "A", count: 86)
        return """
        {"type":"native.grant","device_id":"\(device)","osig":"\(osig)","exp":"2099-01-01T00:00:00Z","scopes":["reply"],"enc_pub":"\(enc)","act_pub":"\(act)"}
        """
    }

    func testTheBuildCarriesAKeychainGroupAndKeysAreMadeOnce() throws {
        XCTAssertNotNil(NativeKeyStore.group(), "TalosKeychainGroup is in the app's Info.plist")
        let first = try NativeKeyStore.ensureKeys(keyId: keyA)
        let second = try NativeKeyStore.ensureKeys(keyId: keyA)
        XCTAssertEqual(first.encPub, second.encPub, "the second call reads the keys the first made")
        XCTAssertEqual(first.actPub, second.actPub)
        XCTAssertNotNil(NativeKeyStore.encKey(keyId: keyA))
        XCTAssertNotNil(NativeKeyStore.actKey(keyId: keyA))
    }

    func testAGrantThatNamesOtherKeysIsNotKept() throws {
        _ = try NativeKeyStore.ensureKeys(keyId: keyA)
        XCTAssertFalse(try NativeKeyStore.saveGrant(grant(enc: "other", act: "other"), keyId: keyA))
        XCTAssertNil(NativeKeyStore.grant(keyId: keyA))
    }

    func testSignOutLeavesNoKeyAndNoGrantInTheKeychain() throws {
        let keys = try NativeKeyStore.ensureKeys(keyId: keyA)
        XCTAssertTrue(try NativeKeyStore.saveGrant(grant(enc: keys.encPub, act: keys.actPub), keyId: keyA))
        XCTAssertNotNil(NativeKeyStore.grant(keyId: keyA))

        XCTAssertTrue(NativeKeyStore.clearAll(keyId: keyA))

        XCTAssertNil(NativeKeyStore.encKey(keyId: keyA))
        XCTAssertNil(NativeKeyStore.actKey(keyId: keyA))
        XCTAssertNil(NativeKeyStore.grant(keyId: keyA))
        // and a new Turn on makes NEW keys, not the old ones
        let again = try NativeKeyStore.ensureKeys(keyId: keyA)
        XCTAssertNotEqual(again.encPub, keys.encPub)
    }

    // MARK: Each pairing has its own

    func testTwoPairingsGetDifferentKeysAndOnesGrantIsNotTheOthers() throws {
        let a = try NativeKeyStore.ensureKeys(keyId: keyA)
        let b = try NativeKeyStore.ensureKeys(keyId: keyB)
        XCTAssertNotEqual(a.encPub, b.encPub)
        XCTAssertNotEqual(a.actPub, b.actPub)
        XCTAssertTrue(try NativeKeyStore.saveGrant(grant(enc: a.encPub, act: a.actPub, device: "devA"), keyId: keyA))
        XCTAssertNil(NativeKeyStore.grant(keyId: keyB), "B never sees A's grant")
        XCTAssertFalse(try NativeKeyStore.saveGrant(grant(enc: a.encPub, act: a.actPub, device: "devA"), keyId: keyB),
                       "a grant made for A's keys cannot be stored as B's")
        XCTAssertNil(NativeKeyStore.grant(keyId: keyB))
        XCTAssertEqual(NativeKeyStore.grant(keyId: keyA)?.contains("devA"), true)
    }

    func testSigningOutOfOnePairingKeepsTheOthersKeys() throws {
        _ = try NativeKeyStore.ensureKeys(keyId: keyA)
        let b = try NativeKeyStore.ensureKeys(keyId: keyB)
        XCTAssertTrue(try NativeKeyStore.saveGrant(grant(enc: b.encPub, act: b.actPub), keyId: keyB))
        NativeKeyStore.clearAll(keyId: keyA)
        XCTAssertNil(NativeKeyStore.encKey(keyId: keyA))
        XCTAssertEqual(try NativeKeyStore.ensureKeys(keyId: keyB).encPub, b.encPub)
        XCTAssertNotNil(NativeKeyStore.grant(keyId: keyB))
    }

    func testAnIdThatIsNotACanonicalKeyIdNamesNothing() {
        for bad in ["enc", "", "../x", "r_abcdefghijklmnopqrst", keyA.lowercased(), keyA + "x"] {
            XCTAssertThrowsError(try NativeKeyStore.ensureKeys(keyId: bad), bad)
            XCTAssertNil(NativeKeyStore.encKey(keyId: bad), bad)
            XCTAssertFalse(NativeKeyStore.clearAll(keyId: bad), bad)
        }
    }

    func testAProfilesKeyIdIsTheOneTheStoreAcceptsAndNotTheRelaysOwnId() throws {
        let ds = UUID()
        let p = RelayProfile(id: "r_abcdefghijklmnopqrst", origin: URL(string: "https://a.example.com")!, kind: .self, label: "a",
                             bridgeFp: String(repeating: "A", count: 43), deviceId: "", dataStoreId: ds, addedAt: Date(timeIntervalSince1970: 1))!
        XCTAssertEqual(p.keyId, ds.uuidString)
        XCTAssertTrue(NativeKeyStore.isValid(keyId: p.keyId))
        XCTAssertFalse(NativeKeyStore.isValid(keyId: p.id), "a relay-chosen id never names an item")
    }

    func testKeysOfAPairingThatLeftTheListCanBeFoundAndRemoved() throws {
        _ = try NativeKeyStore.ensureKeys(keyId: keyA)
        _ = try NativeKeyStore.ensureKeys(keyId: keyB)
        XCTAssertEqual(Set(NativeKeyStore.keyIdsWithKeys()).intersection([keyA, keyB, keyC]), [keyA, keyB])
        NativeKeyStore.removeKeys(exceptKeyIds: [keyB])
        XCTAssertNil(NativeKeyStore.encKey(keyId: keyA))
        XCTAssertNotNil(NativeKeyStore.encKey(keyId: keyB))
    }

    // MARK: Keys made before relays had their own

    private func plantLegacy(_ accounts: [String: Data]) throws {
        let group = try XCTUnwrap(NativeKeyStore.group())
        for (account, data) in accounts {
            let q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "app.talos.push", kSecAttrAccount: account,
                                      kSecAttrAccessGroup: group, kSecValueData: data,
                                      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            XCTAssertEqual(SecItemAdd(q as CFDictionary, nil), errSecSuccess, account)
        }
    }

    func testTheSingleRelayKeysAreDeletedAndNeverGivenToAnyPairing() throws {
        let enc = P256.KeyAgreement.PrivateKey(), act = P256.Signing.PrivateKey()
        try plantLegacy(["enc": enc.rawRepresentation, "act": act.rawRepresentation, "grant": Data(grant(enc: "x", act: "y").utf8)])
        XCTAssertTrue(NativeKeyStore.hasLegacyKeys())
        for id in [keyA, keyB] {
            XCTAssertNil(NativeKeyStore.encKey(keyId: id), "a pairing never reads the old shared items")
            XCTAssertNil(NativeKeyStore.grant(keyId: id))
        }
        NativeKeyStore.clearLegacy()
        XCTAssertFalse(NativeKeyStore.hasLegacyKeys())
    }

    func testClearingTheSingleRelayKeysLeavesPerPairingKeys() throws {
        let a = try NativeKeyStore.ensureKeys(keyId: keyA)
        try plantLegacy(["enc": P256.KeyAgreement.PrivateKey().rawRepresentation])
        NativeKeyStore.clearLegacy()
        XCTAssertFalse(NativeKeyStore.hasLegacyKeys())
        XCTAssertEqual(try NativeKeyStore.ensureKeys(keyId: keyA).encPub, a.encPub)
    }

    // MARK: What the notification extension does with a push

    private func relayId(_ keyId: String) -> String { "r_" + String(repeating: keyId.prefix(1).lowercased(), count: 20) }

    private func profile(_ keyId: String, device: String) -> RelayProfile {
        RelayProfile(id: relayId(keyId), origin: URL(string: "https://\(keyId.prefix(4).lowercased()).example.com")!, kind: .self,
                     label: keyId, bridgeFp: String(repeating: "A", count: 43), deviceId: device,
                     dataStoreId: UUID(uuidString: keyId)!, addedAt: Date(timeIntervalSince1970: 1000))!
    }

    /// A relay list holding several pairings (the stored shape is a list; the add flow keeps one until phase 4 lifts it).
    private func list(_ keyIds: [String], active: String) throws -> RelayStore {
        struct Blob: Encodable { var relays: [RelayProfile]; var active: String }
        let backing = InMemoryKeychain()
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        try backing.write(try e.encode(Blob(relays: keyIds.map { profile($0, device: "dev-\($0)") }, active: relayId(active))))
        return RelayStore(backing: backing)
    }

    /// Keys and a grant for one pairing, as its own page would have made them.
    private func pair(_ keyId: String) throws -> P256.KeyAgreement.PublicKey {
        let keys = try NativeKeyStore.ensureKeys(keyId: keyId)
        XCTAssertTrue(try NativeKeyStore.saveGrant(grant(enc: keys.encPub, act: keys.actPub, device: "dev-\(keyId)"), keyId: keyId))
        return try XCTUnwrap(NativeKeyStore.encKey(keyId: keyId)).publicKey
    }

    /// The seal the relay builds (the same bytes RichPush.open reads).
    private func seal(to key: P256.KeyAgreement.PublicKey, device: String) throws -> [String: Any] {
        let eph = P256.KeyAgreement.PrivateKey()
        let epk = eph.publicKey.x963Representation
        let aes = try eph.sharedSecretFromKeyAgreement(with: key).hkdfDerivedSymmetricKey(
            using: SHA256.self, salt: epk, sharedInfo: Data("talos-push/v1 aes-256-gcm".utf8), outputByteCount: 32)
        let pushId = String(repeating: "p", count: 22)
        let plain = Data(#"{"v":1,"b":"Done","k":"reply","s":"General","t":"general"}"#.utf8)
        let box = try AES.GCM.seal(plain, using: aes, nonce: AES.GCM.Nonce(),
                                   authenticating: RichPush.sealAad(deviceId: device, kind: "reply", cardId: nil, pushId: pushId))
        return ["v": 1, "id": pushId, "epk": Base64URL.encode(epk), "iv": Base64URL.encode(Data(box.nonce)),
                "ct": Base64URL.encode(box.ciphertext + box.tag)]
    }

    private func deliver(_ envelope: [String: Any], store: RelayStore, activeKeyId: String?) -> (key: String?, d: RichPush.Delivery) {
        let inbound = RichPush.Delivery(title: "Talos", subtitle: "", body: "New reply", category: "TALOS_OPEN",
                                        userInfo: ["talos": ["v": 1, "kind": "reply", "enc": envelope]])
        let opened = RichPush.open(envelope: envelope, candidates: NativeKeyStore.sealCandidates(store: store), kind: "reply", cardId: nil)
        return (opened?.keyId, RichPush.deliver(inbound, opened: opened?.content, keyId: opened?.keyId, sealKey: opened?.key,
                                                 activeKeyId: activeKeyId))
    }

    func testAPushOpensWithItsOwnPairingsKeyAndKeepsItsButtonsOnlyWhileThatPairingIsActive() throws {
        let pubA = try pair(keyA)
        _ = try pair(keyB)
        let sealFromA = try seal(to: pubA, device: "dev-\(keyA)")
        let store = try list([keyA, keyB], active: keyA)

        let onA = deliver(sealFromA, store: store, activeKeyId: keyA)
        XCTAssertEqual(onA.key, keyA)
        XCTAssertEqual(onA.d.category, RichPush.replyCategory)
        XCTAssertEqual((onA.d.userInfo[RichPush.richKey] as? [String: String])?["r"], keyA)
        let encA = try XCTUnwrap(NativeKeyStore.encKey(keyId: keyA))
        XCTAssertTrue(RichPush.pressIsAuthentic(userInfo: onA.d.userInfo, sealKey: encA))

        // the same push after the app moved to B: still readable (A is paired), but nothing in it can sign
        let onB = deliver(sealFromA, store: store, activeKeyId: keyB)
        XCTAssertEqual(onB.key, keyA)
        XCTAssertEqual(onB.d.body, "Done")
        XCTAssertEqual(onB.d.category, "TALOS_OPEN")
        XCTAssertNil(onB.d.userInfo[RichPush.richKey])
        XCTAssertFalse(RichPush.pressMatchesActiveKey(userInfo: onA.d.userInfo, activeKeyId: keyB),
                       "and a press on the notification made while A was active is refused once B is")
    }

    func testAPushFromAPairingThatIsNoLongerStoredStaysClosed() throws {
        let pubA = try pair(keyA)
        _ = try pair(keyB)
        let sealFromA = try seal(to: pubA, device: "dev-\(keyA)")
        // A left the list: its keys are still in the Keychain until swept, but only listed pairings' keys are tried
        let result = deliver(sealFromA, store: try list([keyB], active: keyB), activeKeyId: keyB)
        XCTAssertNil(result.key)
        XCTAssertEqual(result.d.body, "New reply", "the fixed phrase Apple delivered")
        XCTAssertEqual(result.d.category, "TALOS_OPEN", "the relay's own category only opens the app")
        XCTAssertNil(result.d.userInfo[RichPush.richKey])
    }

    func testAPairingsSealNeverOpensWithAnotherPairingsKey() throws {
        _ = try pair(keyA)
        let pubB = try pair(keyB)
        let sealFromB = try seal(to: pubB, device: "dev-\(keyB)")
        let candidates = NativeKeyStore.sealCandidates(store: try list([keyA], active: keyA))
        XCTAssertEqual(candidates.map(\.keyId), [keyA])
        XCTAssertNil(RichPush.open(envelope: sealFromB, candidates: candidates, kind: "reply", cardId: nil))
    }

    func testTheActivePairingIsTheOneTheStoreMarks() throws {
        _ = try pair(keyA)
        let pubB = try pair(keyB)
        let store = try list([keyA, keyB], active: keyB)
        XCTAssertEqual(NativeKeyStore.activeKeyId(store: store), keyB)
        let sealFromB = try seal(to: pubB, device: "dev-\(keyB)")
        XCTAssertEqual(deliver(sealFromB, store: store, activeKeyId: NativeKeyStore.activeKeyId(store: store)).d.category, RichPush.replyCategory)
        XCTAssertEqual(NativeKeyStore.sealCandidates(store: store).first?.keyId, keyB, "the active pairing's key is tried first")
    }

    func testTheActivePairingsKeyIsTriedFirstAndAPairingWithoutAGrantIsLeftOut() throws {
        _ = try pair(keyA)
        _ = try pair(keyB)
        _ = try NativeKeyStore.ensureKeys(keyId: keyC)  // keys but no grant yet: no device id, so no candidate
        let store = try list([keyA, keyB, keyC], active: keyA)
        XCTAssertEqual(NativeKeyStore.sealCandidates(store: store).map(\.keyId).sorted(), [keyA, keyB])
        XCTAssertNil(NativeKeyStore.activeKeyId(store: RelayStore(backing: InMemoryKeychain())))
        XCTAssertNil(NativeKeyStore.activeKeyId(store: nil))
    }
}
