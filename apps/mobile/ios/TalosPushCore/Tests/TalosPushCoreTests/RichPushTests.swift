import CryptoKit
import XCTest
@testable import TalosPushCore

/// Checked against bytes the TypeScript side produced (packages/protocol/fixtures/push-rich/vectors.json), and against a
/// signature this code produced that the TypeScript side verifies (swift-act.json, checked by push-rich-vectors.test.ts).
final class RichPushTests: XCTestCase {
    private static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()
    private static let fixtures = root.appendingPathComponent("packages/protocol/fixtures/push-rich")

    private func vectors() throws -> [String: Any] {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func encKey(_ v: [String: Any]) throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: try XCTUnwrap(Base64URL.decode(v["enc_priv_d"] as! String)))
    }

    // MARK: seal

    func testOpensTheSealTheRelaySideMade() throws {
        let v = try vectors()
        let r = v["reply"] as! [String: Any]
        let c = try XCTUnwrap(RichPush.open(
            envelope: r["envelope"] as! [String: Any], key: try encKey(v), deviceId: v["device_id"] as! String, kind: "reply", cardId: nil))
        XCTAssertEqual(c.body, "Done. The report is in Drive \u{2014} caf\u{e9} \u{1F680}")
        XCTAssertEqual(c.subtitle, "General")
        XCTAssertEqual(c.threadId, "general")
        XCTAssertEqual(RichPush.category(for: c), "TALOS_REPLY")
    }

    func testACardSealCarriesTheIdRiskAndHashThatOfferApprove() throws {
        let v = try vectors()
        let a = v["approve"] as! [String: Any]
        let c = try XCTUnwrap(RichPush.open(
            envelope: a["envelope"] as! [String: Any], key: try encKey(v), deviceId: v["device_id"] as! String, kind: "card",
            cardId: a["card_id"] as? String))
        XCTAssertEqual(c.body, a["notice"] as? String)
        XCTAssertEqual(c.cardId, a["card_id"] as? String)
        XCTAssertEqual(c.risk, "low")
        XCTAssertEqual(RichPush.category(for: c), "TALOS_CARD_LOW")
        // the hash the phone signs for "what I showed" is the one the relay and the Mac rebuild
        XCTAssertEqual(c.subtitle, a["subtitle"] as? String)
        XCTAssertEqual(RichPush.shownHash(c.body, subtitle: c.subtitle), a["shown"] as? String)
        XCTAssertNotEqual(RichPush.shownHash(c.body), a["shown"] as? String)
    }

    func testARefusedSealLeavesTheFixedPhrase() throws {
        let v = try vectors()
        let dev = v["device_id"] as! String
        let a = v["approve"] as! [String: Any]
        let env = a["envelope"] as! [String: Any]
        let card = a["card_id"] as? String
        // another phone's key, another kind, another card, another device, a changed push id, flipped ciphertext
        XCTAssertNil(RichPush.open(envelope: env, key: P256.KeyAgreement.PrivateKey(), deviceId: dev, kind: "card", cardId: card))
        XCTAssertNil(RichPush.open(envelope: env, key: try encKey(v), deviceId: dev, kind: "reply", cardId: card))
        XCTAssertNil(RichPush.open(envelope: env, key: try encKey(v), deviceId: dev, kind: "card", cardId: "c_01JBF3V7Q8K2M4N6P8R0S2T4V8"))
        XCTAssertNil(RichPush.open(envelope: env, key: try encKey(v), deviceId: "d_other", kind: "card", cardId: card))
        var moved = env; moved["id"] = String(repeating: "A", count: 22)
        XCTAssertNil(RichPush.open(envelope: moved, key: try encKey(v), deviceId: dev, kind: "card", cardId: card))
        var flipped = env
        var ct = Array((env["ct"] as! String).utf8)
        ct[4] = ct[4] == UInt8(ascii: "A") ? UInt8(ascii: "B") : UInt8(ascii: "A")
        flipped["ct"] = String(decoding: ct, as: UTF8.self)
        XCTAssertNil(RichPush.open(envelope: flipped, key: try encKey(v), deviceId: dev, kind: "card", cardId: card))
        // shapes it must not crash on
        for bad: [String: Any] in [[:], ["v": 2], ["v": 1, "id": "x"], ["v": 1, "id": String(repeating: "A", count: 22), "epk": "AA", "iv": "AA", "ct": "AA"],
                                    ["v": 1, "id": 5, "epk": 5, "iv": 5, "ct": 5]] {
            XCTAssertNil(RichPush.open(envelope: bad, key: try encKey(v), deviceId: dev, kind: "card", cardId: card))
        }
    }

    func testTheButtonsFollowWhatTheSealSaid() {
        func c(_ kind: String, thread: String? = "general", card: String? = nil, risk: String? = nil, hash: String? = nil) -> RichContent {
            RichContent(subtitle: nil, body: "x", kind: kind, threadId: thread, cardId: card, risk: risk, payloadHash: hash)
        }
        XCTAssertEqual(RichPush.category(for: c("reply")), "TALOS_REPLY")
        XCTAssertNil(RichPush.category(for: c("reply", thread: nil)), "a Reply needs a thread to go to")
        XCTAssertEqual(RichPush.category(for: c("card", card: "c_1", risk: "low", hash: "sha256:x")), "TALOS_CARD_LOW")
        XCTAssertNil(RichPush.category(for: c("card", card: "c_1", risk: "high", hash: "sha256:x")), "a high-risk card opens the app")
        XCTAssertNil(RichPush.category(for: c("card", card: nil, risk: "low", hash: nil)), "no id and hash means the text is not the whole card")
        XCTAssertNil(RichPush.category(for: c("card", card: "c_1", risk: nil, hash: "sha256:x")))
        XCTAssertNil(RichPush.category(for: c("digest")))
    }

    func testRichContentWithAFieldOfTheWrongTypeIsRefused() {
        XCTAssertNil(RichPush.content(from: Data(#"{"v":1,"b":"hi","k":"reply","t":5}"#.utf8)))
        XCTAssertNil(RichPush.content(from: Data(#"{"v":1,"k":"reply"}"#.utf8)))
        XCTAssertNotNil(RichPush.content(from: Data(#"{"v":1,"b":"hi","k":"reply","extra":[1]}"#.utf8)), "a field this build does not know is ignored")
    }

    // MARK: acting

    private func actKeyAndGrant(_ v: [String: Any]) throws -> (P256.Signing.PrivateKey, String) {
        (try P256.Signing.PrivateKey(rawRepresentation: try XCTUnwrap(Base64URL.decode(v["act_priv_d"] as! String))), v["grant"] as! String)
    }

    func testSigningInputIsTheExactStringTheMacRebuilds() throws {
        let v = try vectors()
        let wire = (v["act"] as! [String: Any])["wire"] as! [String: Any]
        let g = try XCTUnwrap(RichPush.grantInfo(wire["grant"] as! String))
        let input = RichPush.actSigningInput(
            deviceId: wire["device_id"] as! String, id: wire["id"] as! String, ts: wire["ts"] as! String, grantOsig: g.osig, body: wire["body"] as! String)
        // verify the signature the TypeScript signer made, with CryptoKit and the public key the grant names
        let (actKey, _) = try actKeyAndGrant(v)
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: try XCTUnwrap(Base64URL.decode(wire["asig"] as! String)))
        XCTAssertTrue(actKey.publicKey.isValidSignature(sig, for: Data(input.utf8)))
        XCTAssertFalse(actKey.publicKey.isValidSignature(sig, for: Data((input + " ").utf8)))
    }

    func testSignsAReplyThatVerifiesAndWritesTheFixtureTheTypeScriptSideChecks() throws {
        let v = try vectors()
        let (key, grant) = try actKeyAndGrant(v)
        let now = Date(timeIntervalSince1970: (v["now_ms"] as! Double) / 1000 + 90)
        let id = RichPush.newActId(nowMs: UInt64(now.timeIntervalSince1970 * 1000))
        let frame = try RichPush.signAct(.reply(threadId: "general", text: "On my way \u{2014} \"quoted\" \u{1F680}"), grantJson: grant, id: id, now: now, key: key)
        XCTAssertEqual(frame["type"], "native.act")
        XCTAssertEqual(frame["grant"], grant, "the grant goes back byte for byte: the relay compares it to the one it holds")
        let g = try XCTUnwrap(RichPush.grantInfo(grant))
        let sig = try P256.Signing.ECDSASignature(rawRepresentation: try XCTUnwrap(Base64URL.decode(frame["asig"]!)))
        let input = RichPush.actSigningInput(deviceId: g.deviceId, id: id, ts: frame["ts"]!, grantOsig: g.osig, body: frame["body"]!)
        XCTAssertTrue(key.publicKey.isValidSignature(sig, for: Data(input.utf8)))
        // the JSON the relay's strict parser takes: v is a number, no other field is added
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: RichPush.wireJson(frame)) as? [String: Any])
        XCTAssertEqual(json["v"] as? Int, 1)
        XCTAssertEqual(Set(json.keys), ["v", "id", "ts", "type", "device_id", "grant", "body", "asig"])
        if let out = ProcessInfo.processInfo.environment["TALOS_WRITE_SWIFT_ACT"] {
            try JSONSerialization.data(withJSONObject: ["note": "Signed by TalosPushCore RichPush.signAct; verified by push-rich-vectors.test.ts", "wire": json], options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: out))
        }
    }

    func testAnApproveBindsTheCardHashAndTheShownText() throws {
        let v = try vectors()
        let (key, grant) = try actKeyAndGrant(v)
        let a = v["approve"] as! [String: Any]
        let now = Date(timeIntervalSince1970: (v["now_ms"] as! Double) / 1000)
        let f = try RichPush.signAct(
            .approve(cardId: a["card_id"] as! String, payloadHash: a["payload_hash"] as! String, shown: RichPush.shownHash(a["notice"] as! String, subtitle: a["subtitle"] as? String)),
            grantJson: grant, id: RichPush.newActId(), now: now, key: key)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(f["body"]!.utf8)) as? [String: String])
        XCTAssertEqual(body, ["a": "approve", "card_id": a["card_id"] as! String, "payload_hash": a["payload_hash"] as! String, "shown": a["shown"] as! String])
    }

    func testNothingIsSignedForAnExpiredGrantAMissingScopeABlankOrOversizeReply() throws {
        let v = try vectors()
        let (key, grant) = try actKeyAndGrant(v)
        let now = Date(timeIntervalSince1970: (v["now_ms"] as! Double) / 1000)
        let late = now.addingTimeInterval(31 * 86_400)
        XCTAssertThrowsError(try RichPush.signAct(.reply(threadId: "general", text: "hi"), grantJson: grant, id: "x", now: late, key: key)) {
            XCTAssertEqual($0 as? RichPush.ActError, .grantExpired)
        }
        XCTAssertThrowsError(try RichPush.signAct(.reply(threadId: "general", text: "hi"), grantJson: "{}", id: "x", now: now, key: key)) {
            XCTAssertEqual($0 as? RichPush.ActError, .noGrant)
        }
        let noScope = grant.replacingOccurrences(of: "\"approve_low\"", with: "\"other\"")
        XCTAssertThrowsError(try RichPush.signAct(.approve(cardId: "c", payloadHash: "h", shown: "s"), grantJson: noScope, id: "x", now: now, key: key)) {
            XCTAssertEqual($0 as? RichPush.ActError, .noScope)
        }
        XCTAssertThrowsError(try RichPush.signAct(.reply(threadId: "general", text: " \n "), grantJson: grant, id: "x", now: now, key: key)) {
            XCTAssertEqual($0 as? RichPush.ActError, .empty)
        }
        XCTAssertThrowsError(try RichPush.signAct(.reply(threadId: "general", text: String(repeating: "a", count: 4001)), grantJson: grant, id: "x", now: now, key: key)) {
            XCTAssertEqual($0 as? RichPush.ActError, .tooLong)
        }
    }

    func testActIdsAreUlidsThatSortByTimeAndDoNotRepeat() {
        let a = RichPush.newActId(nowMs: 1_793_556_000_000)
        let b = RichPush.newActId(nowMs: 1_793_556_000_001)
        XCTAssertEqual(a.count, 26)
        XCTAssertNotNil(a.range(of: "^[0-9A-HJKMNP-TV-Z]{26}$", options: .regularExpression))
        XCTAssertLessThan(a.prefix(10), b.prefix(10))
        XCTAssertNotEqual(RichPush.newActId(nowMs: 1), RichPush.newActId(nowMs: 1))
    }

    func testBase64URLRoundTripsAndRefusesOtherAlphabets() {
        let d = Data((0..<255).map { UInt8($0) })
        XCTAssertEqual(Base64URL.decode(Base64URL.encode(d)), d)
        XCTAssertNil(Base64URL.decode("ab+/"))
        XCTAssertNil(Base64URL.decode("ab=="))
    }

    // MARK: a button press

    func testAReplyNeedsTheThreadFromTheSealAndTheTypedText() {
        let info: [AnyHashable: Any] = ["talos_rich": ["t": "general", "shown": "sha256:x"]]
        XCTAssertEqual(RichPush.act(for: .reply, userInfo: info, userText: "ok"), .reply(threadId: "general", text: "ok"))
        XCTAssertNil(RichPush.act(for: .reply, userInfo: info, userText: nil))
        XCTAssertNil(RichPush.act(for: .reply, userInfo: ["talos_rich": ["shown": "x"]], userText: "ok"))
        XCTAssertNil(RichPush.act(for: .reply, userInfo: ["talos": ["thread_id": "general"]], userText: "ok"), "the plain payload names a thread, but only the seal may choose where a Reply goes")
    }

    func testAnApproveNeedsTheCardTheHashAndTheShownTextFromTheSeal() {
        let info: [AnyHashable: Any] = ["talos_rich": ["c": "c_1", "h": "sha256:h", "shown": "sha256:s"]]
        XCTAssertEqual(RichPush.act(for: .approveLow, userInfo: info, userText: nil), .approve(cardId: "c_1", payloadHash: "sha256:h", shown: "sha256:s"))
        XCTAssertNil(RichPush.act(for: .approveLow, userInfo: ["talos_rich": ["c": "c_1", "shown": "s"]], userText: nil))
        XCTAssertNil(RichPush.act(for: .approveLow, userInfo: ["talos": ["card_id": "c_1"]], userText: nil), "the card id in the plain payload is not enough to approve")
    }

    func testEveryAnswerIsEitherDoneRetriedOrToldToTheOwner() {
        XCTAssertEqual(RichPush.outcome(status: 200, code: nil), .done)
        XCTAssertEqual(RichPush.outcome(status: nil, code: nil), .retry)
        XCTAssertEqual(RichPush.outcome(status: 503, code: nil), .retry)
        XCTAssertEqual(RichPush.outcome(status: 429, code: "rate_limited"), .retry)
        for (status, code) in [(409, "mac_update_needed"), (403, "stepup_required"), (403, "grant_not_current"), (409, "card_not_pending"), (400, "act_stale"), (404, "unknown_thread"), (400, "whatever"), (401, "bad_signature"), (401, "")] {
            guard case let .failed(msg) = RichPush.outcome(status: status, code: code) else { return XCTFail("\(status) \(code)") }
            XCTAssertFalse(msg.isEmpty)
            XCTAssertTrue(msg.contains("Talos"), msg)
        }
        XCTAssertNotEqual(RichPush.outcome(status: 403, code: "mac_update_needed"), RichPush.outcome(status: 403, code: "stepup_required"))
    }

    func testAnUnknownOrRevokedPhoneIsToldToRenewAndNotToRetry() {
        // The relay answers a device it does not trust with 401 bad_signature (it used to say 403 device_not_trusted).
        // Both must tell the owner to open Talos, and neither may be retried in the background.
        let renew = RichPush.Outcome.failed("Notification buttons need Talos opened once to renew. Open Talos.")
        XCTAssertEqual(RichPush.outcome(status: 401, code: "bad_signature"), renew)
        XCTAssertEqual(RichPush.outcome(status: 403, code: "device_not_trusted"), renew)
    }

    func testTheFrameGoesOnlyToTheCompiledHttpsRelay() throws {
        XCTAssertEqual(RichPush.actURL(relay: try XCTUnwrap(URL(string: "https://relay.example.com/some/path?x=1")))?.absoluteString, "https://relay.example.com/api/native/act")
        XCTAssertNil(RichPush.actURL(relay: try XCTUnwrap(URL(string: "http://relay.example.com"))))
        XCTAssertNil(RichPush.actURL(relay: try XCTUnwrap(URL(string: "file:///etc/passwd"))))
    }

    func testAGrantOnlyCountsWhenItNamesTheKeysOnThisPhone() throws {
        let v = try vectors()
        let grant = v["grant"] as! String
        XCTAssertTrue(RichPush.grantNamesKeys(grant, encPub: v["enc_pub"] as! String, actPub: v["act_pub"] as! String))
        XCTAssertFalse(RichPush.grantNamesKeys(grant, encPub: v["act_pub"] as! String, actPub: v["enc_pub"] as! String))
        XCTAssertFalse(RichPush.grantNamesKeys("{}", encPub: "a", actPub: "b"))
    }
}
