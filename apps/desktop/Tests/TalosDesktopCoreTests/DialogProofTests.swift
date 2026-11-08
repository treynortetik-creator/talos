import CryptoKit
import Foundation
import Testing
@testable import TalosDesktopCore

/// Needs-you prompts: an answer file proves itself. The Mac presses only after the owner's own signature on the tap checks out against a
/// key in devices.json, for the card the Mac itself made from the dialog on its pane. Built against part A2's goldens
/// (packages/protocol/fixtures/needs-you): answers signed with the committed test device key, and the tampered ones a Mac must refuse, at the step the
/// bridge's reference check refuses them.
@Suite("DialogProofCheck")
struct DialogProofTests {
  static let pinned: [String: [String: String]] = {
    let o = try! A2Fixtures.object("pinned-devices")
    return o.mapValues { $0 as! [String: String] }
  }()
  static func key(_ jwk: [String: String]) -> P256.Signing.PublicKey? { DeviceKeys.publicKey(x: jwk["x"] ?? "", y: jwk["y"] ?? "") }

  static func pane(_ name: String) throws -> DialogProofCheck.Pane {
    let o = try A2Fixtures.object(name)
    return .init(
      thread: o["thread"] as! String, dialogId: o["dialog_id"] as! String,
      kind: DialogReader.Kind(rawValue: o["dialog_kind"] as! String)!, subject: o["subject"] as? String, options: o["options"] as! [String])
  }
  static func env(
    _ pane: DialogProofCheck.Pane, nowMs: Double = A2Fixtures.nowMs, pinnedKey: ((String) -> P256.Signing.PublicKey?)? = nil,
    alreadyPressed: Bool = false, screenLabel: ((Int) -> String?)? = nil
  ) -> DialogProofCheck.Env {
    .init(pinnedKey: pinnedKey ?? { id in pinned[id].flatMap(key) }, nowMs: nowMs, pane: pane, alreadyPressed: alreadyPressed, screenLabel: screenLabel)
  }
  static func verify(_ name: String, _ pane: DialogProofCheck.Pane, _ e: DialogProofCheck.Env? = nil) throws -> DialogProofCheck.Verdict {
    guard let a = try A2Fixtures.answer(name) else { return .no(reason: .unverified, step: 0) }
    return DialogProofCheck.verify(a, env: e ?? env(pane))
  }

  // MARK: a good answer

  @Test func theDeviceIdIsTheBridgesDeviceId() throws {
    let a = try #require(Self.pinned["d_rjxnk4xufxem5xago5zd"].flatMap(Self.key))
    #expect(DeviceKeys.deviceId(of: a) == "d_rjxnk4xufxem5xago5zd")
    let bj = try A2Fixtures.object("device-b")
    let b = try #require(Self.key(bj["publicJwk"] as! [String: String]))
    #expect(bj["deviceId"] as? String == DeviceKeys.deviceId(of: b), "device B's key is made fresh whenever the fixtures are written; its id is derived, not pinned")
    #expect(DeviceKeys.deviceId(of: b) != DeviceKeys.deviceId(of: a))
    #expect(DeviceKeys.publicKey(x: "!!", y: "??") == nil)
    #expect(DeviceKeys.publicKey(x: "AAAA", y: "AAAA") == nil, "not 32 bytes, not a point")
  }

  @Test func aGoodAnswerPassesEveryStepAndNamesTheSignedChoice() throws {
    let trip = try Self.pane("pane-trip")
    #expect(try Self.verify("dialog-answer", trip) == .ok(choice: 1, label: "Yes, I trust this folder", deviceId: "d_rjxnk4xufxem5xago5zd"))
    #expect(try Self.verify("dialog-answer-open", Self.pane("pane-login")) == .ok(choice: nil, label: nil, deviceId: "d_rjxnk4xufxem5xago5zd"))
  }

  @Test func itPressesFromTheSignedChoiceNotFromTheWordsAtTheTopOfTheFile() throws {
    let a = try #require(try A2Fixtures.answer("dialog-answer-display-differs"))
    #expect(a.action == .choose(0) && a.label == "No, exit", "control: the display says the other option")
    #expect(try Self.verify("dialog-answer-display-differs", Self.pane("pane-trip")) == .ok(choice: 1, label: "Yes, I trust this folder", deviceId: "d_rjxnk4xufxem5xago5zd"))
  }

  @Test func theScreenLabelIsCheckedAndOncePerDialog() throws {
    let trip = try Self.pane("pane-trip")
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, screenLabel: { trip.options[$0] })) != .no(reason: .screenChanged, step: 5))
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, screenLabel: { _ in "No, exit" })) == .no(reason: .screenChanged, step: 5))
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, screenLabel: { _ in nil })) == .no(reason: .screenChanged, step: 5))
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, alreadyPressed: true)) == .no(reason: .alreadyAnswered, step: 5))
  }

  // MARK: every tampered answer is refused at its step

  @Test(arguments: [
    ("dialog-answer-missing-proof", 0), ("dialog-answer-wrong-device", 1), ("dialog-answer-bad-signature", 2), ("dialog-answer-wrong-choice", 2),
    ("dialog-answer-old-ts", 3), ("dialog-answer-kill", 3), ("dialog-answer-edited", 3), ("dialog-answer-signed-device-differs", 3),
    ("dialog-answer-changed-binding", 4), ("dialog-answer-changed-binding-title", 4), ("dialog-answer-wrong-card-thread", 4),
    ("dialog-answer-wrong-payload-thread", 4), ("dialog-answer-other-card-id", 4), ("dialog-answer-subject-differs", 4),
    ("dialog-answer-wrong-thread", 4), ("dialog-answer-other-dialog", 4),
  ])
  func aTamperedAnswerIsRefusedAtItsStepAndNothingIsPressed(name: String, step: Int) throws {
    #expect(try Self.verify(name, Self.pane("pane-trip")) == .no(reason: .unverified, step: step), "\(name)")
  }

  /// A good answer for one thread's dialog given to another worker's pane.
  @Test func aGoodAnswerForAnotherDialogIsNotForThisPane() throws {
    #expect(try Self.verify("dialog-answer", Self.pane("pane-login")) == .no(reason: .unverified, step: 0))
  }

  @Test func noPinForTheDeviceOrADifferentKeyUnderThatIdIsRefused() throws {
    let trip = try Self.pane("pane-trip")
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, pinnedKey: { _ in nil })) == .no(reason: .unverified, step: 1))
    let b = try #require(Self.key(try A2Fixtures.object("device-b")["publicJwk"] as! [String: String]))
    #expect(try Self.verify("dialog-answer", trip, Self.env(trip, pinnedKey: { _ in b })) == .no(reason: .unverified, step: 1))
  }

  @Test func whatTheMacSawMustBeExactlyWhatTheCardSays() throws {
    let trip = try Self.pane("pane-trip")
    func other(_ c: (inout DialogProofCheck.Pane) -> Void) -> DialogProofCheck.Pane { var p = trip; c(&p); return p }
    let mine: [DialogProofCheck.Pane] = [
      other { $0.subject = "/home/alex/notes" }, other { $0.subject = nil },
      other { $0.options = ["Yes, I trust this folder", "No, exit"] }, other { $0.options = ["No, exit"] },
      other { $0.options = ["No, exit", "Yes, I trust this folder", "Extra"] }, other { $0.kind = .mcpConsent },
      other { $0.thread = "garden" },
    ]
    for p in mine { #expect(try Self.verify("dialog-answer", p) == .no(reason: .unverified, step: 4), "\(p)") }
    #expect(try Self.verify("dialog-answer", other { $0.dialogId = "Aq5Lm8ZtRx3Cv9PkNa2HdB" }) == .no(reason: .unverified, step: 0))
  }

  @Test func theTapTimeIsJudgedOnTheMacClock() throws {
    let trip = try Self.pane("pane-trip")
    let tap = ISOTime.parse("2026-11-07T10:00:09.000Z")! * 1000
    func ok(_ now: Double) throws -> Bool { if case .ok = try Self.verify("dialog-answer", trip, Self.env(trip, nowMs: now)) { return true } else { return false } }
    #expect(try ok(tap + 15 * 60_000))
    #expect(try !ok(tap + 15 * 60_000 + 1))
    #expect(try ok(tap - 2 * 60_000))
    #expect(try !ok(tap - 2 * 60_000 - 1))
  }
}

/// The one place a signer's key comes from: devices.json, the bridge's file of paired devices. Missing, unreadable, a link, big, or
/// not in the bridge's shape: no key. A revoked device and a key that is not that id's: no key.
@Suite("DeviceKeys reads devices.json")
struct DeviceKeysTests {
  static let id = "d_rjxnk4xufxem5xago5zd"
  static func entry(id: String = DeviceKeysTests.id, jwk: [String: String]? = nil, revoked: String? = nil, name: String = "Alex's iPhone") throws -> [String: Any] {
    var e: [String: Any] = ["id": id, "name": name, "pubkey_jwk": jwk ?? DialogProofTests.pinned[DeviceKeysTests.id]!, "pinned_at": "2026-11-01T00:00:00.000Z"]
    if let revoked { e["revoked_at"] = revoked }
    return e
  }
  static func write(_ dir: String, _ devices: [[String: Any]], version: Any = 1) throws -> String {
    let p = dir + "/devices.json"
    try JSONSerialization.data(withJSONObject: ["version": version, "devices": devices]).write(to: URL(fileURLWithPath: p))
    return p
  }

  @Test func aPairedNotRevokedDeviceHasItsKey() throws {
    let d = try DialogFilesTests.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    let p = try Self.write(d, [Self.entry(id: "d_other00000000000000", jwk: nil), try Self.entry()])
    let k = try #require(DeviceKeys.pinnedKey(Self.id, devicesPath: p))
    #expect(DeviceKeys.deviceId(of: k) == Self.id)
    #expect(DeviceKeys.pinnedKey("d_nobody0000000000000", devicesPath: p) == nil)
  }

  @Test func aRevokedDeviceHasNoKeyEvenWithAnotherEntryForTheSameId() throws {
    let d = try DialogFilesTests.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [try Self.entry(revoked: "2026-11-02T00:00:00.000Z")])) == nil)
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [try Self.entry(), try Self.entry(revoked: "2026-11-02T00:00:00.000Z")])) == nil)
  }

  @Test func aKeyThatIsNotThatIdsKeyIsNoKey() throws {
    let d = try DialogFilesTests.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    let b = try A2Fixtures.object("device-b")["publicJwk"] as! [String: String]
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [try Self.entry(jwk: b)])) == nil, "an entry that names one device and holds another's key")
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [[ "id": Self.id, "name": "x" ]])) == nil, "no key at all")
  }

  @Test func missingUnreadableLinkedBigOrWrongShapedIsNoKey() throws {
    let d = try DialogFilesTests.tmp()
    defer { try? FileManager.default.removeItem(atPath: d) }
    let p = d + "/devices.json"
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: p) == nil, "missing")
    try Data("junk".utf8).write(to: URL(fileURLWithPath: p))
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: p) == nil, "junk")
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [])) == nil, "empty")
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: try Self.write(d, [try Self.entry()], version: 2)) != nil, "the bridge reads any object with a devices array")
    try JSONSerialization.data(withJSONObject: ["devices": [try Self.entry()]]).write(to: URL(fileURLWithPath: p))
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: p) != nil, "no version at all")
    try JSONSerialization.data(withJSONObject: ["version": 1, "devices": "none"]).write(to: URL(fileURLWithPath: p))
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: p) == nil, "devices is not an array")
    try JSONSerialization.data(withJSONObject: ["devices": [try Self.entry(), 7]]).write(to: URL(fileURLWithPath: p))
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: p) == nil, "an entry that is not an object fails the whole file closed")
    let good = try Self.write(d, [try Self.entry()])
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: good) != nil, "control")
    let big = d + "/big.json"
    var padded = try Data(contentsOf: URL(fileURLWithPath: good))
    padded.append(Data(repeating: 0x20, count: 300_000))
    try padded.write(to: URL(fileURLWithPath: big))
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: big) == nil, "too big to be read whole")
    let link = d + "/link.json"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: good)
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: link) == nil, "a link")
    let dir = d + "/dir.json"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    #expect(DeviceKeys.pinnedKey(Self.id, devicesPath: dir) == nil, "a folder")
  }
}
