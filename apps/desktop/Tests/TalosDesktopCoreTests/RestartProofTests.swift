import CryptoKit
import Foundation
import Testing
import TalosTestSupport
@testable import TalosDesktopCore

/// The owner's proof in agent-request.json: only a proof that checks out here makes a request the owner's. Built against the protocol's
/// shared fixtures (packages/protocol/fixtures/agent-request: a real `agent.recover` signed by the committed test key as the web app signs,
/// and the request file the bridge writes from it), and against frames a key made here signs, for every way a proof can be wrong.
@Suite("RestartProofCheck")
struct RestartProofTests {
  static let fixtures = A2Fixtures.dir.deletingLastPathComponent().appendingPathComponent("agent-request")
  static func data(_ name: String) throws -> Data { try Data(contentsOf: fixtures.appendingPathComponent(name)) }
  static let pinned: [String: [String: String]] = {
    let o = try! A2Fixtures.object("pinned-devices")
    return o.mapValues { $0 as! [String: String] }
  }()
  static func fixtureKey(_ id: String) -> P256.Signing.PublicKey? {
    pinned[id].flatMap { DeviceKeys.publicKey(x: $0["x"] ?? "", y: $0["y"] ?? "") }
  }
  /// The fixture frame's own time, plus a second: the Mac reads the request just after the tap.
  static let fixtureNow = ISOTime.parse("2026-11-12T17:00:01.000Z")! * 1000
  static let fixtureId = "01KA0000000000000000000002"

  /// A phone made here: a fresh P-256 key, signing exactly as owner-sig.ts does.
  struct Phone {
    let key = P256.Signing.PrivateKey()
    var id: String { DeviceKeys.deviceId(of: key.publicKey) }
    static func b64url(_ d: Data) -> String {
      d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    var jwk: [String: String] {
      let x = key.publicKey.x963Representation
      return ["kty": "EC", "crv": "P-256", "x": Self.b64url(x.subdata(in: 1..<33)), "y": Self.b64url(x.subdata(in: 33..<65))]
    }
    func sign(_ signed: Data, as device: String? = nil) -> String {
      let digest = SHA256.hash(data: signed).map { String(format: "%02x", $0) }.joined()
      return Self.b64url(try! key.signature(for: Data("talos-owner/v1\n\(device ?? id)\n\(digest)".utf8)).rawRepresentation)
    }
    /// The canonical text of an `agent.recover` (sorted keys, as JCS writes these ASCII fields), with `edit` applied first.
    func frame(controlId: String, tsMs: Double, _ edit: (inout [String: Any]) -> Void = { _ in }) -> Data {
      var o: [String: Any] = [
        "v": 1, "type": "agent.recover", "id": "01KA00000000000000000000F1", "ts": ISOTime.string(tsMs / 1000), "control_id": controlId,
        "action": "restart", "device_id": id,
      ]
      edit(&o)
      return try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    func proof(controlId: String, tsMs: Double, _ edit: (inout [String: Any]) -> Void = { _ in }) -> RestartProof {
      let signed = frame(controlId: controlId, tsMs: tsMs, edit)
      return RestartProof(deviceId: id, osig: sign(signed), signed: signed)
    }
  }

  static let now: Double = 1_794_500_000_000
  static func verify(_ p: RestartProof, phone: Phone, controlId: String = "c1", nowMs: Double = now, used: Set<String> = []) -> RestartProofCheck.Verdict {
    RestartProofCheck.verify(p, controlId: controlId, nowMs: nowMs, pinnedKey: { $0 == phone.id ? phone.key.publicKey : nil }, isUsed: { used.contains($0) })
  }

  // MARK: the bytes the web app signed, read the way the Mac reads them

  @Test func theSharedFixtureVerifiesHereByteForByte() throws {
    guard case .request(let r) = AgentRequestFile.parseForTest(try Self.data("agent-request-owner.json")) else { Issue.record("not a request"); return }
    guard case .present(let p) = r.proof else { Issue.record("no proof: \(r.proof)"); return }
    #expect(r.controlId == Self.fixtureId)
    let v = RestartProofCheck.verify(p, controlId: r.controlId, nowMs: Self.fixtureNow, pinnedKey: Self.fixtureKey, isUsed: { _ in false })
    #expect(v == .ok(deviceId: "d_rjxnk4xufxem5xago5zd", usedKey: RestartProofCheck.usedKey(p), signedMs: Self.fixtureNow - 1000))
    // the signed bytes are the frame's own fields, minus the signature: the same frame the protocol test signed
    let frame = try #require(JSONSerialization.jsonObject(with: try Self.data("agent-recover-signed.json")) as? [String: Any])
    let signed = try #require(JSONSerialization.jsonObject(with: p.signed) as? [String: Any])
    #expect(Set(signed.keys) == Set(frame.keys).subtracting(["osig"]))
    #expect(frame["osig"] as? String == p.osig)
    // control: one byte of what was signed changed, and the same check says no
    var bent = p
    bent.signed = Data(String(decoding: p.signed, as: UTF8.self).replacingOccurrences(of: "restart", with: "restarT").utf8)
    #expect(RestartProofCheck.verify(bent, controlId: r.controlId, nowMs: Self.fixtureNow, pinnedKey: Self.fixtureKey, isUsed: { _ in false }) == .no(.signature))
    // and the asker: the owner's
    #expect(AgentRecovery.asker(r, nowMs: Self.fixtureNow, pinnedKey: Self.fixtureKey, isUsed: { _ in false }) == .owner(usedKey: RestartProofCheck.usedKey(p), signedMs: Self.fixtureNow - 1000))
    let size = try Self.data("agent-request-owner.json").count
    #expect(size < 1024 && size < AgentRequest.maxBytes, "\(size) bytes, pretty-printed")
  }

  // MARK: every way a proof is wrong

  @Test func aGoodProofPassesAndAnyOtherKeyFails() {
    let phone = Phone()
    let p = phone.proof(controlId: "c1", tsMs: Self.now)
    #expect(Self.verify(p, phone: phone) == .ok(deviceId: phone.id, usedKey: RestartProofCheck.usedKey(p), signedMs: Self.now))
    let other = Phone()
    // signed by another key, claiming the pinned phone's id
    var forged = p
    forged.osig = other.sign(p.signed, as: phone.id)
    #expect(Self.verify(forged, phone: phone) == .no(.signature))
    // a key pinned for the id, but not that id's key
    let swapped = RestartProofCheck.verify(p, controlId: "c1", nowMs: Self.now, pinnedKey: { _ in other.key.publicKey }, isUsed: { _ in false })
    #expect(swapped == .no(.device))
  }

  @Test func revokedOrMissingInDevicesJsonIsNoSigner() throws {
    let phone = Phone()
    let p = phone.proof(controlId: "c1", tsMs: Self.now)
    let dir = TestTemp.base + "rproof-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let devices = dir + "/devices.json"
    func write(_ entries: [[String: Any]]) throws {
      try JSONSerialization.data(withJSONObject: ["version": 1, "devices": entries]).write(to: URL(fileURLWithPath: devices))
    }
    let check = { RestartProofCheck.verify(p, controlId: "c1", nowMs: Self.now, pinnedKey: { DeviceKeys.pinnedKey($0, devicesPath: devices) }, isUsed: { _ in false }) }
    let entry: [String: Any] = ["id": phone.id, "name": "Test phone", "pubkey_jwk": phone.jwk, "pinned_at": "2026-11-01T00:00:00.000Z"]
    try write([entry])
    #expect(check() == .ok(deviceId: phone.id, usedKey: RestartProofCheck.usedKey(p), signedMs: Self.now), "control: pinned, it passes")
    var revoked = entry
    revoked["revoked_at"] = "2026-11-02T00:00:00.000Z"
    try write([revoked])
    #expect(check() == .no(.device))
    try write([entry, revoked])
    #expect(check() == .no(.device), "any revoked entry for the id: the bridge keeps a tombstone")
    try write([["id": Phone().id, "name": "x", "pubkey_jwk": Phone().jwk, "pinned_at": "2026-11-01T00:00:00.000Z"]])
    #expect(check() == .no(.device), "not present")
    unlink(devices)
    #expect(check() == .no(.device), "no file")
  }

  @Test func signedForAnotherRequestActionOrFrameTypeFails() {
    let phone = Phone()
    #expect(Self.verify(phone.proof(controlId: "c2", tsMs: Self.now), phone: phone) == .no(.controlId))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["action"] = "restore_last_good" }, phone: phone) == .no(.frame))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["type"] = "card.resolve" }, phone: phone) == .no(.frame))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["type"] = "session.control" }, phone: phone) == .no(.frame))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["v"] = 2 }, phone: phone) == .no(.frame))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["device_id"] = Phone().id }, phone: phone) == .no(.frame))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["control_id"] = nil }, phone: phone) == .no(.controlId))
    #expect(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["control_id"] = 1 }, phone: phone) == .no(.controlId))
    // valid signature over bytes that are not JSON at all
    let junk = Data("not json".utf8)
    #expect(Self.verify(RestartProof(deviceId: phone.id, osig: phone.sign(junk), signed: junk), phone: phone) == .no(.frame))
  }

  /// A dialog answer's proof (the needs-you fixture, signed by the same test key) replayed as a restart: refused at what was signed.
  @Test func aDialogAnswersProofIsNotARestartProof() throws {
    let a = try #require(try A2Fixtures.answer("dialog-answer"))
    let p = RestartProof(deviceId: a.proof.deviceId, osig: a.proof.osig, signed: Data(a.proof.signed.utf8))
    let v = RestartProofCheck.verify(p, controlId: a.controlId, nowMs: A2Fixtures.nowMs, pinnedKey: Self.fixtureKey, isUsed: { _ in false })
    #expect(v == .no(.frame), "the signature is good; what it signed is a card.resolve")
  }

  /// And the other way: the restart fixture's proof put into a dialog answer is refused by the dialog check at what was signed (step 3).
  @Test func aRestartProofIsNotADialogAnswer() throws {
    guard case .request(let r) = AgentRequestFile.parseForTest(try Self.data("agent-request-owner.json")), case .present(let p) = r.proof else {
      Issue.record("fixture")
      return
    }
    let edited = try A2Fixtures.edited("dialog-answer") { o in
      var proof = o["proof"] as! [String: Any]
      proof["signed"] = String(decoding: p.signed, as: UTF8.self)
      proof["osig"] = p.osig
      o["proof"] = proof
    }
    let a = try #require(DialogAnswerRequest.parse(edited))
    let pane = try DialogProofTests.pane("pane-trip")
    let v = DialogProofCheck.verify(a, env: DialogProofTests.env(pane, nowMs: Self.fixtureNow))
    #expect(v == .no(reason: .unverified, step: 3), "\(v)")
  }

  /// Review R1-3/R1-4: a proof good in every way but its signed time is not a forgery: it is the owner's phone with its clock off, or one
  /// signed before this app started, and it goes the agent's way (`outOfTime`), never the hard refusal.
  @Test func aTimeOutsideTheWindowOrBeforeTheLaunchIsOutOfTimeNotBad() {
    let phone = Phone()
    let at = { (offset: Double) -> RestartProofCheck.Verdict in
      let p = phone.proof(controlId: "c1", tsMs: Self.now + offset)
      return Self.verify(p, phone: phone)
    }
    let skewed = { (v: RestartProofCheck.Verdict) -> Bool in if case .outOfTime(_, _, .skew) = v { return true } else { return false } }
    #expect(!skewed(at(-RestartProofCheck.maxAgeMs)), "five minutes old exactly is still in")
    #expect(skewed(at(-RestartProofCheck.maxAgeMs - 1000)))
    #expect(skewed(at(-8 * 24 * 3_600_000)), "the bridge takes a frame up to 8 days old; the Mac does not")
    #expect(!skewed(at(RestartProofCheck.maxFutureMs)))
    #expect(skewed(at(RestartProofCheck.maxFutureMs + 1000)))
    #expect(skewed(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["ts"] = "yesterday" }, phone: phone)))
    #expect(skewed(Self.verify(phone.proof(controlId: "c1", tsMs: Self.now) { $0["ts"] = Self.now }, phone: phone)))
    // signed before this app started, though in the window
    let p = phone.proof(controlId: "c1", tsMs: Self.now - 60_000)
    let v = RestartProofCheck.verify(
      p, controlId: "c1", nowMs: Self.now, launchedAtMs: Self.now - 30_000, pinnedKey: { _ in phone.key.publicKey }, isUsed: { _ in false })
    #expect(v == .outOfTime(usedKey: RestartProofCheck.usedKey(p), signedMs: Self.now - 60_000, .beforeLaunch))
    let r = AgentRequest(controlId: "c1", ts: Self.now, proof: .present(p))
    #expect(
      AgentRecovery.asker(r, nowMs: Self.now, launchedAtMs: Self.now - 30_000, pinnedKey: { _ in phone.key.publicKey }, isUsed: { _ in false })
        == .clockOff(usedKey: RestartProofCheck.usedKey(p), .beforeLaunch))
    // a forged signature with a bad time is still a forgery: the signature comes first
    var forged = phone.proof(controlId: "c1", tsMs: Self.now - 3_600_000)
    forged.osig = Phone().sign(forged.signed, as: phone.id)
    #expect(Self.verify(forged, phone: phone) == .no(.signature))
  }

  /// Review R1-1: the replay mark. A proof signed at or before the newest one this app accepted is a replay, whatever the used list says.
  @Test func aProofSignedNoLaterThanTheMarkIsUsed() {
    let phone = Phone()
    let p = phone.proof(controlId: "c1", tsMs: Self.now - 10_000)
    let mark = { (m: Double) in
      RestartProofCheck.verify(p, controlId: "c1", nowMs: Self.now, markMs: m, pinnedKey: { _ in phone.key.publicKey }, isUsed: { _ in false })
    }
    // review R2-1: a real tap never seen, signed at or before the mark, is a phone clock, not a forgery: the agent's way
    let key = RestartProofCheck.usedKey(p)
    #expect(mark(Self.now - 10_000) == .outOfTime(usedKey: key, signedMs: Self.now - 10_000, .beforeMark), "at the mark")
    #expect(mark(Self.now - 5_000) == .outOfTime(usedKey: key, signedMs: Self.now - 10_000, .beforeMark), "below it")
    // and only a key already spent is the replay
    let spent = RestartProofCheck.verify(
      p, controlId: "c1", nowMs: Self.now, markMs: Self.now - 5_000, pinnedKey: { _ in phone.key.publicKey }, isUsed: { $0 == key })
    #expect(spent == .no(.used))
    #expect(mark(Self.now - 10_001) == .ok(deviceId: phone.id, usedKey: RestartProofCheck.usedKey(p), signedMs: Self.now - 10_000), "control: newer")
    #expect(RestartProofCheck.readMark(RestartProofCheck.encodeMark(1_794_500_000_123)) == 1_794_500_000_123)
    for bad in [#"{"v":2,"signed_ms":1}"#, #"{"v":1,"signed_ms":"1"}"#, #"{"v":1,"signed_ms":true}"#, #"{"v":1,"signed_ms":-1}"#, "x"] {
      #expect(RestartProofCheck.readMark(Data(bad.utf8)) == nil, "\(bad)")
    }
  }

  /// Review R1-5: what is checked is exactly what was signed. A repeated key (the parser keeps one), bytes after the object, a byte-order
  /// mark or white space make the signed bytes differ from their canonical form, so a validly signed text like that is refused.
  @Test func signedTextThatIsNotExactlyOneCanonicalObjectIsRefused() throws {
    let phone = Phone()
    let good = String(decoding: phone.frame(controlId: "c1", tsMs: Self.now), as: UTF8.self)
    let sign = { (t: Data) in RestartProof(deviceId: phone.id, osig: phone.sign(t), signed: t) }
    #expect(Self.verify(sign(Data(good.utf8)), phone: phone) != .no(.frame), "control: the canonical text passes")
    // control_id twice: the second names another request
    let dup = good.replacingOccurrences(of: #""control_id":"c1""#, with: #""control_id":"c1","control_id":"c2""#)
    #expect(dup != good)
    #expect(Self.verify(sign(Data(dup.utf8)), phone: phone) == .no(.frame), "duplicate key")
    let dupSame = good.replacingOccurrences(of: #""control_id":"c1""#, with: #""control_id":"c2","control_id":"c1""#)
    #expect(Self.verify(sign(Data(dupSame.utf8)), phone: phone) == .no(.frame), "duplicate key, the last one right")
    #expect(Self.verify(sign(Data((good + "{}").utf8)), phone: phone) == .no(.frame), "trailing object")
    #expect(Self.verify(sign(Data((good + " ").utf8)), phone: phone) == .no(.frame), "trailing space")
    #expect(Self.verify(sign(Data([0xEF, 0xBB, 0xBF]) + Data(good.utf8)), phone: phone) == .no(.frame), "byte-order mark")
    #expect(Self.verify(sign(Data(good.replacingOccurrences(of: ",", with: ", ").utf8)), phone: phone) == .no(.frame), "white space")
    let parsed = try #require((try? JSONSerialization.jsonObject(with: Data(good.utf8))) as? [String: Any])
    #expect(RestartProofCheck.canonical(parsed) == Data(good.utf8))
  }

  /// Review R2-2: the Mac's canonicaliser writes exactly what the protocol's canonical.ts (JCS) writes, for the shared vectors.
  @Test func theCanonicalFormIsJCSByteForByte() throws {
    let list = try #require(JSONSerialization.jsonObject(with: try Self.data("canonical-vectors.json")) as? [[String: String]])
    #expect(list.count >= 10)
    for v in list {
      let o = try #require(JSONSerialization.jsonObject(with: Data(v["json"]!.utf8)) as? [String: Any])
      let mine = try #require(RestartProofCheck.canonical(o), "\(v["json"]!)")
      #expect(mine == Data(v["jcs"]!.utf8), "\(String(decoding: mine, as: UTF8.self)) vs \(v["jcs"]!)")
    }
  }

  /// A newer phone signing fields this version knows how to write: upper-case and digit-run keys verify; a value it cannot canonicalise
  /// (a nested object, a non-integer number) is not called forged: the agent's way, as a form it does not know.
  @Test func extraFieldsVerifyAndAnUnknownFormIsNotAForgery() throws {
    let phone = Phone()
    let signedWith = { (extra: [String: Any]) -> RestartProof in
      var o: [String: Any] = [
        "v": 1, "type": "agent.recover", "id": "01KA00000000000000000000F1", "ts": ISOTime.string(Self.now / 1000), "control_id": "c1",
        "action": "restart", "device_id": phone.id,
      ]
      o.merge(extra) { a, _ in a }
      let text: Data
      if let c = RestartProofCheck.canonical(o) {
        text = c
      } else {
        text = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
      }
      return RestartProof(deviceId: phone.id, osig: phone.sign(text), signed: text)
    }
    let p = signedWith(["X": "y", "x10": 1, "x2": 2])
    if case .ok = Self.verify(p, phone: phone) {} else { Issue.record("\(Self.verify(p, phone: phone))") }
    for extra: [String: Any] in [["n": ["a": 1]], ["n": [1, 2]], ["n": 1.5]] {
      let q = signedWith(extra)
      #expect(Self.verify(q, phone: phone) == .outOfTime(usedKey: RestartProofCheck.usedKey(q), signedMs: Self.now, .unknownForm), "\(extra)")
    }
  }

  @Test func theSameProofTwiceIsUsedAndTheKeyIsTheSignedBytesNotTheSpelling() throws {
    let phone = Phone()
    let p = phone.proof(controlId: "c1", tsMs: Self.now)
    let key = RestartProofCheck.usedKey(p)
    #expect(key.hasPrefix("restart|"), "its own namespace beside the dialog proofs'")
    #expect(Self.verify(p, phone: phone, used: [key]) == .no(.used))
    var again = p
    again.osig = phone.sign(p.signed)  // ECDSA: a fresh signature over the same bytes is spelled differently
    #expect(again.osig != p.osig)
    #expect(Self.verify(again, phone: phone, used: [key]) == .no(.used))
    // on disk, through the store the dialog proofs use: survives a relaunch, and stays capped
    let dir = TestTemp.base + "rproof-used-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/restart-proofs-used.json"
    let rec = DialogProofsUsed.record(key, memory: [], path: path) { true }
    #expect(rec.written)
    #expect(DialogProofsUsed.contains(key, memory: [], path: path), "a fresh process reads it back")
    var memory = rec.memory
    for k in 0..<100 { memory = DialogProofsUsed.record("restart|\(k)", memory: memory, path: path) { true }.memory }
    #expect(DialogProofsUsed.read(path: path).count == DialogProofsUsed.keep, "bounded")
  }

  // MARK: the proof field as read

  private func parse(_ proof: String) -> AgentRequest? {
    AgentRequest.parse(Data(#"{"v":1,"control_id":"c1","action":"restart","ts":1,"proof":\#(proof)}"#.utf8))
  }

  @Test func aProofFieldNotExactlyTheShapeIsMalformedNotNone() {
    let osig = String(repeating: "A", count: 86)
    let good = #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)","signed_b64url":"eyJ2IjoxfQ"}"#
    if case .present? = parse(good)?.proof {} else { Issue.record("control: the good shape reads: \(String(describing: parse(good)?.proof))") }
    for bad in [
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)","signed_b64url":"eyJ2IjoxfQ","extra":1}"#,
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)"}"#,
      #"{"device_id":"phone","osig":"\#(osig)","signed_b64url":"eyJ2IjoxfQ"}"#,
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig.dropLast())","signed_b64url":"eyJ2IjoxfQ"}"#,
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)","signed_b64url":"eyJ2Ijox+Q=="}"#,
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)","signed_b64url":""}"#,
      #"{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"\#(osig)","signed_b64url":"\#(String(repeating: "A", count: AgentRequest.signedMax + 4))"}"#,
      "null", #""signed""#, "[]", "7",
    ] {
      #expect(parse(bad)?.proof == .malformed, "\(bad)")
      #expect(parse(bad).map { AgentRecovery.asker($0, nowMs: 0, pinnedKey: { _ in nil }, isUsed: { _ in false }) } == .badProof(.shape))
    }
  }

  @Test func aFileOverTheCapIsNotARequestAtAll() throws {
    let dir = TestTemp.base + "rproof-big-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/agent-request.json"
    let pad = String(repeating: "A", count: AgentRequest.maxBytes)
    try #"{"v":1,"control_id":"c1","action":"restart","ts":1,"proof":{"device_id":"d_rjxnk4xufxem5xago5zd","osig":"x","signed_b64url":"\#(pad)"}}"#
      .write(toFile: path, atomically: true, encoding: .utf8)
    #expect(AgentRequestFile.read(path: path) == .invalid)
    // control: the real fixture, under the cap, reads
    try Self.data("agent-request-owner.json").write(to: URL(fileURLWithPath: path))
    #expect(AgentRequestFile.read(path: path).request != nil)
  }
}

extension AgentRequestFile {
  /// The parse `read` makes, on bytes in hand.
  static func parseForTest(_ d: Data) -> AgentRequestFile { AgentRequest.parse(d).map { .request($0) } ?? .invalid }
}
