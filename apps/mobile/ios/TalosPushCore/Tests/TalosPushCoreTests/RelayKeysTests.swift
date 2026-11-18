import CryptoKit
import XCTest
@testable import TalosPushCore

/// The notification keys, the grant and the buttons belong to one pairing each (named by an id the phone minted, never by the
/// relay's own id): a push opens only with the key of the pairing that sealed it, and its buttons work only while that pairing is
/// the active one and only if the extension made them.
final class RelayKeysTests: XCTestCase {
    private let keyA = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA"
    private let keyB = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB"

    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("packages/protocol/fixtures/push-rich")

    private func vectors() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func theKeyThatOpensTheVectors(_ v: [String: Any]) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: try XCTUnwrap(Base64URL.decode(v["enc_priv_d"] as! String)))
    }

    // MARK: Keychain accounts

    func testEachPairingHasItsOwnAccountsAndNoneIsTheOldSharedOne() {
        let a = PushCore.keychainAccounts(keyId: keyA)
        let b = PushCore.keychainAccounts(keyId: keyB)
        XCTAssertEqual(a.count, 3)
        XCTAssertTrue(Set(a).isDisjoint(with: b), "one pairing's items are never another's")
        XCTAssertTrue(Set(a).isDisjoint(with: PushCore.keychainAccounts), "and none is the old single-relay account")
        XCTAssertTrue(a.allSatisfy { $0.hasSuffix(keyA) })
        XCTAssertEqual(PushCore.keychainAccount("enc", keyId: keyA), a[0])
    }

    // MARK: Which pairing a push came from

    func testAPushOpensWithTheKeyOfThePairingThatSealedIt() throws {
        let v = try vectors()
        let r = v["reply"] as! [String: Any]
        let deviceId = v["device_id"] as! String
        let candidates = [
            RichPush.SealCandidate(keyId: keyB, key: P256.KeyAgreement.PrivateKey(), deviceId: deviceId),
            RichPush.SealCandidate(keyId: keyA, key: try theKeyThatOpensTheVectors(v), deviceId: deviceId),
        ]
        let opened = try XCTUnwrap(RichPush.open(envelope: r["envelope"] as! [String: Any], candidates: candidates, kind: "reply", cardId: nil))
        XCTAssertEqual(opened.keyId, keyA, "the pairing is the one whose key opened the seal, not a name the push carries")
        XCTAssertEqual(opened.content.threadId, "general")
    }

    func testAPushNoStoredKeyOpensStaysClosed() throws {
        let v = try vectors()
        let r = v["reply"] as! [String: Any]
        let deviceId = v["device_id"] as! String
        let candidates = [RichPush.SealCandidate(keyId: keyB, key: P256.KeyAgreement.PrivateKey(), deviceId: deviceId)]
        XCTAssertNil(RichPush.open(envelope: r["envelope"] as! [String: Any], candidates: candidates, kind: "reply", cardId: nil))
        XCTAssertNil(RichPush.open(envelope: r["envelope"] as! [String: Any], candidates: [], kind: "reply", cardId: nil))
    }

    func testAKeyOnlyOpensASealMadeForItsOwnDeviceId() throws {
        let v = try vectors()
        let r = v["reply"] as! [String: Any]
        let candidates = [RichPush.SealCandidate(keyId: keyA, key: try theKeyThatOpensTheVectors(v), deviceId: "another-device")]
        XCTAssertNil(RichPush.open(envelope: r["envelope"] as! [String: Any], candidates: candidates, kind: "reply", cardId: nil))
    }

    // MARK: What the extension delivers for a pairing

    private let replyContent = RichContent(subtitle: "General", body: "Done", kind: "reply", threadId: "general", cardId: nil, risk: nil, payloadHash: nil)
    private let sealKey = P256.KeyAgreement.PrivateKey()

    private func inbound() -> RichPush.Delivery {
        RichPush.Delivery(title: "Talos", subtitle: "", body: "New reply", category: "TALOS_OPEN", userInfo: ["talos": ["v": 1, "kind": "reply"]])
    }

    func testAPushFromTheActivePairingGetsItsButtonsNamedAndMaced() {
        let d = RichPush.deliver(inbound(), opened: replyContent, keyId: keyA, sealKey: sealKey, activeKeyId: keyA)
        XCTAssertEqual(d.category, RichPush.replyCategory)
        let rich = d.userInfo[RichPush.richKey] as? [String: String]
        XCTAssertEqual(rich?["r"], keyA)
        XCTAssertNotNil(rich?["m"])
        XCTAssertEqual(d.body, "Done")
        XCTAssertTrue(RichPush.pressIsAuthentic(userInfo: d.userInfo, sealKey: sealKey))
    }

    func testAPushFromAnotherPairingShowsItsWordsWithNoButtonAndNoButtonData() {
        for active in [keyB, nil] as [String?] {
            let d = RichPush.deliver(inbound(), opened: replyContent, keyId: keyA, sealKey: sealKey, activeKeyId: active)
            XCTAssertEqual(d.body, "Done", "the owner paired that relay, so its words show")
            XCTAssertEqual(d.category, "TALOS_OPEN", "but nothing that signs is offered")
            XCTAssertNil(d.userInfo[RichPush.richKey])
            XCTAssertEqual(d.userInfo[PushCore.textMarkerKey] as? String, PushCore.textMarkerValue, "it is still taken back when text goes off")
        }
    }

    // MARK: A button press

    func testAPressIsForTheActivePairingOnly() {
        let info: [AnyHashable: Any] = [RichPush.richKey: ["t": "general", "shown": "x", "r": keyA]]
        XCTAssertTrue(RichPush.pressMatchesActiveKey(userInfo: info, activeKeyId: keyA))
        XCTAssertFalse(RichPush.pressMatchesActiveKey(userInfo: info, activeKeyId: keyB))
        XCTAssertFalse(RichPush.pressMatchesActiveKey(userInfo: info, activeKeyId: nil))
        XCTAssertFalse(RichPush.pressMatchesActiveKey(userInfo: [RichPush.richKey: ["t": "general"]], activeKeyId: keyA), "a push that names no pairing signs nothing")
        XCTAssertFalse(RichPush.pressMatchesActiveKey(userInfo: [:], activeKeyId: keyA))
    }

    // MARK: The MAC on the button data

    private func maced(_ fields: [String: String]) -> [AnyHashable: Any] {
        var rich = fields
        rich["m"] = RichPush.richMac(fields, key: sealKey)
        return [RichPush.richKey: rich]
    }

    func testButtonDataTheExtensionMadeIsAuthenticAndAnyChangeIsNot() {
        let fields = ["r": keyA, "t": "general", "shown": "sha256:abc"]
        XCTAssertTrue(RichPush.pressIsAuthentic(userInfo: maced(fields), sealKey: sealKey))
        for (field, forged) in [("t", "other"), ("c", "c_1"), ("h", "sha256:h"), ("shown", "sha256:zzz"), ("r", keyB)] {
            var info = maced(fields)
            var rich = info[RichPush.richKey] as! [String: String]
            rich[field] = forged
            info[RichPush.richKey] = rich
            XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: info, sealKey: sealKey), "a changed \(field)")
        }
    }

    func testButtonDataWithNoMacOrAnotherKeysMacIsRefused() {
        let fields = ["r": keyA, "t": "general", "shown": "sha256:abc"]
        XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: [RichPush.richKey: fields], sealKey: sealKey), "a push that skipped the extension")
        XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: [RichPush.richKey: fields.merging(["m": "AAAA"]) { $1 }], sealKey: sealKey))
        XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: [RichPush.richKey: fields.merging(["m": "not base64 !"]) { $1 }], sealKey: sealKey))
        XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: maced(fields), sealKey: P256.KeyAgreement.PrivateKey()), "another pairing's key")
        XCTAssertFalse(RichPush.pressIsAuthentic(userInfo: [:], sealKey: sealKey))
    }

    func testTheMacInputIsFixedAndOneFieldCannotRunIntoTheNext() {
        let input = String(decoding: RichPush.richMacInput(["r": "k", "t": "ab", "shown": "s"]), as: UTF8.self)
        XCTAssertEqual(input, "talos-rich/v1\nr=1:k\nt=2:ab\nc=0:\nh=0:\nshown=1:s")
        XCTAssertNotEqual(RichPush.richMacInput(["t": "a", "c": "bc"]), RichPush.richMacInput(["t": "ab", "c": "c"]))
        XCTAssertEqual(RichPush.richMacInput(["t": "x", "m": "ignored"]), RichPush.richMacInput(["t": "x"]), "m is not covered")
    }
}
