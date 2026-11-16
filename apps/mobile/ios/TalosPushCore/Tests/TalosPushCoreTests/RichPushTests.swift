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
        // the title is part of it too, and it is the one the extension sets
        XCTAssertEqual(RichPush.noticeTitle, a["title"] as? String)
        XCTAssertEqual(RichPush.shownHash(c.body, subtitle: c.subtitle, title: RichPush.noticeTitle), a["shown"] as? String)
        XCTAssertNotEqual(RichPush.shownHash(c.body, subtitle: c.subtitle, title: "Approve this"), a["shown"] as? String)
    }

    func testTheShownHashCountsBytesAsTheRelayAndTheMacDo() throws {
        let w = try vectors()["shown_wide"] as! [String: String]
        XCTAssertEqual(RichPush.shownHash(w["body"]!, subtitle: w["subtitle"], title: w["title"]!), w["shown"])
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
        XCTAssertEqual(body, ["a": "approve", "card_id": a["card_id"] as! String, "payload_hash": a["payload_hash"] as! String, "shown": a["shown"] as! String, "shown_v": "3"])
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

    private static let anyShown = RichPush.Shown(title: "Talos", subtitle: "", body: "x")

    func testAReplyNeedsTheThreadFromTheSealAndTheTypedText() {
        let info: [AnyHashable: Any] = ["talos_rich": ["t": "general", "shown": "sha256:x"]]
        XCTAssertEqual(RichPush.act(for: .reply, shown: Self.anyShown, userInfo: info, userText: "ok"), .reply(threadId: "general", text: "ok"))
        XCTAssertNil(RichPush.act(for: .reply, shown: Self.anyShown, userInfo: info, userText: nil))
        XCTAssertNil(RichPush.act(for: .reply, shown: Self.anyShown, userInfo: ["talos_rich": ["shown": "x"]], userText: "ok"))
        XCTAssertNil(RichPush.act(for: .reply, shown: Self.anyShown, userInfo: ["talos": ["thread_id": "general"]], userText: "ok"), "the plain payload names a thread, but only the seal may choose where a Reply goes")
    }

    func testAnApproveNeedsTheCardTheHashAndTheShownTextFromTheSeal() {
        let s = RichPush.shownHash(Self.anyShown.body, subtitle: Self.anyShown.subtitle, title: Self.anyShown.title)
        let info: [AnyHashable: Any] = ["talos_rich": ["c": "c_1", "h": "sha256:h", "shown": s]]
        XCTAssertEqual(RichPush.act(for: .approveLow, shown: Self.anyShown, userInfo: info, userText: nil), .approve(cardId: "c_1", payloadHash: "sha256:h", shown: s))
        XCTAssertNil(RichPush.act(for: .approveLow, shown: Self.anyShown, userInfo: ["talos_rich": ["c": "c_1", "shown": "s"]], userText: nil))
        XCTAssertNil(RichPush.act(for: .approveLow, shown: Self.anyShown, userInfo: ["talos": ["card_id": "c_1"]], userText: nil), "the card id in the plain payload is not enough to approve")
    }

    func testAnApproveIsRefusedWhenWhatWasDisplayedIsNotTheCardItCarries() {
        // A push the extension never rewrote (no seal, or no mutable-content): it displays one card but carries another
        // card's id, hash and that card's correct shown hash. Pressing Approve must sign nothing.
        let other = RichPush.shownHash("Archive 3 old drafts", subtitle: "General")
        let forged: [AnyHashable: Any] = ["talos_rich": ["c": "c_other", "h": "sha256:other", "shown": other]]
        let displayed = RichPush.Shown(title: "Talos", subtitle: "General", body: "Rename the notes folder")
        XCTAssertNil(RichPush.act(for: .approveLow, shown: displayed, userInfo: forged, userText: nil))
        // the same fields under the words they belong to are signed, with the hash of what was displayed
        let honest = RichPush.Shown(title: "Talos", subtitle: "General", body: "Archive 3 old drafts")
        XCTAssertEqual(RichPush.act(for: .approveLow, shown: honest, userInfo: forged, userText: nil),
                       .approve(cardId: "c_other", payloadHash: "sha256:other", shown: other))
    }

    func testAnApproveIsRefusedWhenOnlyTheTitleDiffersFromWhatTheExtensionShowed() {
        let body = "Archive 3 old drafts"
        let info: [AnyHashable: Any] = ["talos_rich": ["c": "c_1", "h": "sha256:h", "shown": RichPush.shownHash(body, subtitle: "General")]]
        XCTAssertNotNil(RichPush.act(for: .approveLow, shown: RichPush.Shown(title: "Talos", subtitle: "General", body: body), userInfo: info, userText: nil))
        let retitled = RichPush.Shown(title: "Approve: pay the invoice", subtitle: "General", body: body)
        XCTAssertNil(RichPush.act(for: .approveLow, shown: retitled, userInfo: info, userText: nil))
    }

    // MARK: what the extension delivers

    private func inbound(category: String = "TALOS_CARD", rich: [String: String]? = nil) -> RichPush.Delivery {
        var info: [AnyHashable: Any] = ["talos": ["v": 1, "kind": "card", "card_id": "c_1", "navigate": "/card/c_1"]]
        if let rich { info["talos_rich"] = rich }
        return RichPush.Delivery(title: "Talos", subtitle: "", body: "A card needs you", category: category, userInfo: info)
    }

    private let highRiskCard = RichContent(subtitle: nil, body: "Send the report", kind: "card", threadId: "general", cardId: "c_1", risk: "high", payloadHash: nil)

    func testTheExtensionDropsButtonDataItDidNotMakeFromASeal() {
        let forged = ["c": "c_other", "h": "sha256:other", "shown": "sha256:x", "t": "general"]
        // no seal, or one that did not open
        XCTAssertNil(RichPush.deliver(inbound(rich: forged), opened: nil).userInfo["talos_rich"])
        // a seal that opened but offers no button keeps none of the relay's either
        XCTAssertNil(RichPush.deliver(inbound(rich: forged), opened: highRiskCard).userInfo["talos_rich"])
    }

    func testTheExtensionResetsAReplyOrApproveCategoryItDidNotSet() {
        for category in [RichPush.replyCategory, RichPush.cardLowCategory] {
            XCTAssertEqual(RichPush.deliver(inbound(category: category), opened: nil).category, "", category)
            XCTAssertEqual(RichPush.deliver(inbound(category: category), opened: highRiskCard).category, "", category)
        }
        // the relay's own categories only open the app, so they stay
        XCTAssertEqual(RichPush.deliver(inbound(category: "TALOS_CARD"), opened: nil).category, "TALOS_CARD")
        XCTAssertEqual(RichPush.deliver(inbound(category: "TALOS_OPEN"), opened: highRiskCard).category, "TALOS_OPEN")
    }

    func testAnOpenedSealSetsEverythingDisplayedAndTheHashAPressChecks() {
        let card = RichContent(subtitle: nil, body: "Archive 3 old drafts", kind: "card", threadId: "general", cardId: "c_1", risk: "low", payloadHash: "sha256:h")
        var sent = inbound(category: "TALOS_CARD")
        sent.title = "Approve: pay the invoice"
        sent.subtitle = "Payroll"
        let d = RichPush.deliver(sent, opened: card)
        // the relay's title and subtitle are not what is displayed
        XCTAssertEqual(d.title, RichPush.noticeTitle)
        XCTAssertEqual(d.subtitle, "")
        XCTAssertEqual(d.body, "Archive 3 old drafts")
        XCTAssertEqual(d.category, RichPush.cardLowCategory)
        XCTAssertEqual(d.userInfo[PushCore.textMarkerKey] as? String, PushCore.textMarkerValue)
        XCTAssertNil((d.userInfo["talos"] as? [String: Any])?["enc"])
        // a press on exactly that notification signs it
        let shown = RichPush.Shown(title: d.title, subtitle: d.subtitle, body: d.body)
        XCTAssertEqual(RichPush.act(for: .approveLow, shown: shown, userInfo: d.userInfo, userText: nil),
                       .approve(cardId: "c_1", payloadHash: "sha256:h", shown: RichPush.shownHash("Archive 3 old drafts")))
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
