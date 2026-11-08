import CryptoKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Needs-you prompts, the Mac side: a known dialog on a worker's pane is offered in `workers.json`, a tap's answer (a file from the
/// bridge) is turned into arrows and Enter, and the Mac says what it pressed. Real private tmux server; the screens are the REAL Claude
/// Code 2.1.319 dialogs (Fixtures/real-2.1.319/needs-you-capture) drawn by `dialog-real.sh`, which moves its cursor on Up and Down,
/// ignores digits, and confirms on Enter, as the captures show the real Select doing. The owner's tmux, Claude config and bridge are
/// never touched.
final class KeyLog: @unchecked Sendable {
  let path: String
  init() { path = NSTemporaryDirectory() + "keys-\(UUID().uuidString.prefix(8)).log" }
  var keys: [String] { completeLines(path) }
  /// What the pane received that is not the pointer line: the arrows and Enters (a normal session's typed text is `CHAR:` and the Enter
  /// after it, which only follow once the dialog is gone).
  var presses: [String] { keys.filter { ["UP", "DOWN", "ENTER"].contains($0) } }
  func remove() { unlink(path) }
}

final class OpenSpy: @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String] = []
  func opened(_ t: String) { lock.withLock { items.append(t) } }
  var all: [String] { lock.withLock { items } }
}

/// The owner's phone, as the Mac knows it from devices.json: a P-256 key whose id is the bridge's device id. It signs the tap exactly as the
/// bridge's proof says (the text signed is "talos-owner/v1\n" + device_id + "\n" + sha256Hex(signed)).
struct TestOwner {
  let key = P256.Signing.PrivateKey()
  var deviceId: String { DeviceKeys.deviceId(of: key.publicKey) }
  var jwk: [String: String] {
    let x963 = key.publicKey.x963Representation
    func b64(_ d: Data) -> String { d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    return ["kty": "EC", "crv": "P-256", "x": b64(x963.subdata(in: 1..<33)), "y": b64(x963.subdata(in: 33..<65))]
  }
  func entry(revoked: String? = nil) -> [String: Any] {
    var e: [String: Any] = ["id": deviceId, "name": "Test phone", "pubkey_jwk": jwk, "pinned_at": "2026-11-01T00:00:00.000Z"]
    if let revoked { e["revoked_at"] = revoked }
    return e
  }
  static func hex(_ s: String) -> String { SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined() }
  static func json(_ o: Any) -> String { String(decoding: (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data(), as: UTF8.self) }
  func osig(_ signed: String) -> String {
    let input = "talos-owner/v1\n\(deviceId)\n\(Self.hex(signed))"
    let sig = (try? key.signature(for: Data(input.utf8)).rawRepresentation) ?? Data()
    return sig.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

/// What a test changes in a proof it builds.
struct ProofEdit {
  var subject: String??
  var options: [String]?
  var kind: String?
  var dialogId: String?
  var thread: String?
  var action: String = "primary"
  var tsOffset: Double = 0
}

extension WorkerRig {
  var answerPath: String { talosHome + "/workers/trip/dialog-answer.json" }
  var resultPath: String { talosHome + "/workers/trip/dialog-result.json" }
  var devicesPath: String { talosHome + "/devices.json" }
  var offer: DialogOffer? { entry("trip")?.dialog }

  /// devices.json as the bridge writes it.
  func writeDevices(_ devices: [[String: Any]]) throws {
    try JSONSerialization.data(withJSONObject: ["version": 1, "devices": devices]).write(to: URL(fileURLWithPath: devicesPath), options: .atomic)
  }

  /// An answer file for `offer`, signed by `owner`, with the card binding the bridge would have made from it (`edit` changes what the card
  /// says or what was signed, the signature still being a valid one for what it covers).
  @discardableResult
  func writeAnswer(
    _ offer: DialogOffer, owner: TestOwner, choice: Int?, control: String, edit: ProofEdit = ProofEdit(), open: Bool = false,
    dialogId: String? = nil, displayLabel: String? = nil, at: Double = Date().timeIntervalSince1970
  ) throws -> [String: Any] {
    let cardId = "c_01JBF3V7Q8K2M4N6P8R0S2T403"
    let id = edit.dialogId ?? offer.id
    var payload: [String: Any] = [
      "dialog_id": id, "dialog_kind": edit.kind ?? offer.kind.rawValue, "expires_at": offer.expires_at, "options": edit.options ?? offer.options,
      "thread": edit.thread ?? "trip",
    ]
    var subject: String? = offer.subject
    if let changed = edit.subject { subject = changed }
    payload["subject"] = subject.map { $0 as Any } ?? NSNull()
    let binding = TestOwner.json([
      "id": cardId, "kind": "dialog", "thread_id": edit.thread ?? "trip", "payload": payload, "title": "Trust this folder?", "primary_label": "Answer",
    ])
    var frame: [String: Any] = [
      "type": "card.resolve", "v": 1, "id": "01JBF3V7Q8K2M4N6P8R0S2T4AA", "card_id": cardId, "action": edit.action, "device_id": owner.deviceId,
      "payload_hash": "sha256:" + TestOwner.hex(binding), "ts": ISOTime.string(Date().timeIntervalSince1970 + edit.tsOffset),
    ]
    if let choice { frame["choice"] = choice }
    let signed = TestOwner.json(frame)
    var o: [String: Any] = [
      "v": 2, "dialog_id": dialogId ?? offer.id, "label": displayLabel ?? (choice.map { offer.options[$0] } ?? "Open on the Mac"), "by": "Test phone",
      "at": ISOTime.string(at), "control_id": control,
      "proof": ["signed": signed, "osig": owner.osig(signed), "device_id": owner.deviceId, "binding": binding],
    ]
    if open { o["action"] = "open" } else if let choice { o["choice"] = choice }
    try writeRaw(o)
    return o
  }

  func writeRaw(_ o: [String: Any]) throws {
    try FileManager.default.createDirectory(atPath: talosHome + "/workers/trip", withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: answerPath), options: .atomic)
  }

  var result: [String: Any]? {
    FileManager.default.contents(atPath: resultPath).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }
  func resultControl() -> String? { result?["control_id"] as? String }

  /// The bridge's card file for a dialog.
  func ack(_ dialogId: String, status: String = "waiting") throws {
    let o: [String: Any] = ["v": 1, "dialog_id": dialogId, "card_id": "c_01JBF3V7Q8K2M4N6P8R0S2T403", "thread_id": "trip", "status": status, "at": ISOTime.string(Date().timeIntervalSince1970)]
    try JSONSerialization.data(withJSONObject: o).write(to: URL(fileURLWithPath: talosHome + "/workers/trip/dialog-card.json"), options: .atomic)
  }
}

@Suite("Needs-you prompts: the answer path", .serialized, .enabled(if: Rig.hasTmux))
struct NeedsYouTests {
  /// A rig on `dialog-real.sh`. `ackWait` is long unless a test is about the line: no card is made here, and the line must not interfere.
  /// devices.json lists `owner` unless a test says otherwise.
  private func make(
    _ dlg: String, _ extra: [String: String] = [:], ackWait: Double = 600, scenario: String = "dialog-real.sh", owner: TestOwner? = nil
  ) throws -> (WorkerRig, KeyLog, NoticeLog, TestOwner) {
    let keys = KeyLog()
    var env = ["FAKE_DLG": dlg, "FAKE_DLG_KEYLOG": keys.path]
    env.merge(extra) { _, b in b }
    let r = try WorkerRig(scenario: scenario, extraEnv: env)
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.cardAckWait = ackWait }
    let o = owner ?? TestOwner()
    try r.writeDevices([o.entry()])
    return (r, keys, log, o)
  }

  private func offered(_ r: WorkerRig) throws -> DialogOffer {
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.offer != nil }, "no dialog offered: \(r.why("trip")) \(r.mgr.needsYou())")
    return try #require(r.offer)
  }

  private func nothing(_ r: WorkerRig, _ keys: KeyLog, reason: String?, control: String = "ctl_1", sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(r.wait(15) { r.resultControl() == control }, "no result: \(keys.keys)", sourceLocation: sourceLocation)
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["source"] as? String == "card" && r.result?["v"] as? Int == 1, "\(String(describing: r.result))", sourceLocation: sourceLocation)
    if let reason { #expect(r.result?["reason"] as? String == reason, "\(String(describing: r.result))", sourceLocation: sourceLocation) }
    #expect(keys.keys.isEmpty, "a key was sent: \(keys.keys)", sourceLocation: sourceLocation)
  }

  // MARK: the offer

  @Test func aRealTrustDialogIsOfferedWithWhatTheScreenSays() throws {
    let (r, keys, log, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .trust && o.options == ["No, exit", "Yes, I trust this folder"] && o.cursor == 0)
    #expect(o.subject?.hasPrefix("/private/tmp/tcap-ny-proj.") == true)
    #expect(o.id.count == 22, "16 random bytes, base64url: \(o.id)")
    let seen = try #require(ISOTime.parse(o.seen_at)), expires = try #require(ISOTime.parse(o.expires_at))
    #expect(abs(expires - seen - 900) < 0.01, "a card lives 900 s from the first sighting")
    #expect(abs(Date().timeIntervalSince1970 - seen) < 30)
    // it is in the file the bridge reads
    let raw = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers.json"))
    #expect(r.wait(3) { WorkersFile.decode((try? Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/workers.json"))) ?? Data())?.threads["trip"]?.dialog == o }, "\(String(decoding: raw, as: UTF8.self))")
    #expect(keys.keys.isEmpty && log.all.isEmpty, "offering a dialog presses nothing and, inside the card window, says nothing")
    // the same dialog, still on screen: the same id, however long
    usleep(1_500_000)
    #expect(r.offer?.id == o.id)
  }

  @Test func aRealMcpDialogIsOfferedWithItsCursorOnTheLastRow() throws {
    let (r, keys, _, _) = try make("mcp")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .mcpConsent && o.subject == "harmless" && o.cursor == 2)
    #expect(o.options == ["Use this MCP server", "Use this and all future MCP servers in this project", "Continue without using this MCP server"])
  }

  @Test func theLoginScreenIsOfferedAsAKindWithNoKeys() throws {
    let (r, keys, _, _) = try make("login")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .login && o.options.isEmpty && o.cursor == nil && o.subject == nil)
  }

  @Test func theOfferGoesWhenTheDialogIsAnswered() throws {
    let (r, keys, _, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    _ = try offered(r)
    // the owner answers in the pane: Down, Enter
    #expect(r.tmuxCmd(["send-keys", "-t", "=t-trip:", "Down"]).ok)
    r.ownerPressesEnter("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.offer == nil }, "the offer stayed after the dialog went")
  }

  @Test func aRelaunchKeepsTheSameOfferForTheSameDialog() throws {
    let (r, keys, _, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    usleep(900_000)
    r.mgr.detach()
    let again = r.makeManager()
    r.trackNotices(NoticeLog(), on: again)
    again.tune { $0.cardAckWait = 600 }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] != nil }, "re-adopted and flagged: \(r.why("trip"))")
    usleep(1_500_000)
    #expect(again.snapshot().threads["trip"]?.dialog?.id == o.id, "a new sighting would be a new card")
  }

  // MARK: the answer

  @Test(arguments: [
    ("trust", 1, ["DOWN", "ENTER"], "Yes, I trust this folder"), ("mcp", 0, ["UP", "UP", "ENTER"], "Use this MCP server"),
    ("mcp", 1, ["UP", "ENTER"], "Use this and all future MCP servers in this project"),
    ("mcp", 2, ["ENTER"], "Continue without using this MCP server"),
  ])
  func aSignedTapIsArrowsAndEnterAndTheSessionContinues(dlg: String, choice: Int, expected: [String], label: String) throws {
    let (r, keys, _, owner) = try make(dlg)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: choice, control: "ctl_1")
    #expect(r.wait(15) { r.result != nil }, "no result: \(keys.keys)")
    let res = try #require(r.result)
    #expect(res["v"] as? Int == 1 && res["source"] as? String == "card" && res["outcome"] as? String == "pressed")
    #expect(res["choice"] as? Int == choice && res["label"] as? String == label && res["reason"] == nil)
    #expect(res["dialog_id"] as? String == o.id && res["control_id"] as? String == "ctl_1")
    #expect(res["at"] is String)
    #expect(keys.keys == expected, "arrows and one Enter, nothing else (no digit): \(keys.keys)")
    // the answer file is taken, and the session carries on: its input box, ready, the pointer typed once
    #expect(!FileManager.default.fileExists(atPath: r.answerPath))
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.typedLines.count == 1 })
    #expect(r.wait(10) { r.offer == nil })
  }

  /// The words at the top of the file are for display; the Mac presses from what was signed.
  @Test func aTapPressesFromTheSignedChoiceNotFromTheDisplayedWords() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1", displayLabel: "No, exit")
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["label"] as? String == "Yes, I trust this folder")
    #expect(keys.keys == ["DOWN", "ENTER"])
  }

  // MARK: not authentic: nothing is pressed (the five forgeries)

  /// 1. A forged answer file, with no proof or garbage in its place.
  @Test func aForgedAnswerPressesNothing() throws {
    let (r, keys, _, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // no proof at all: not an answer, so there is nobody to answer to, but the file is taken and nothing is pressed
    try r.writeRaw(["v": 2, "dialog_id": o.id, "choice": 1, "label": "Yes, I trust this folder", "by": "Test phone", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_1"])
    usleep(2_500_000)
    #expect(!FileManager.default.fileExists(atPath: r.answerPath), "taken")
    #expect(r.result == nil && keys.keys.isEmpty)
    // the old, proofless v1 shape
    try r.writeRaw(["v": 1, "dialog_id": o.id, "choice": 1, "label": "Yes, I trust this folder", "by": "phone", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_2"])
    usleep(2_500_000)
    #expect(r.result == nil && keys.keys.isEmpty)
    // a proof with garbage in it
    try r.writeRaw([
      "v": 2, "dialog_id": o.id, "choice": 1, "label": "Yes, I trust this folder", "by": "Test phone", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_3",
      "proof": ["signed": "{}", "osig": String(repeating: "A", count: 86), "device_id": "d_aaaaaaaaaaaaaaaaaaaa", "binding": "{}"],
    ])
    nothing(r, keys, reason: "unverified", control: "ctl_3")
  }

  /// 2. A valid signature by a key that is not in devices.json.
  @Test func aValidSignatureByAnUnlistedKeyPressesNothing() throws {
    let (r, keys, _, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: TestOwner(), choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")
  }

  @Test func withNoDevicesFileNobodyCanAnswer() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    unlink(r.devicesPath)
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")
  }

  /// 3. The card the owner signed is not the dialog the Mac saw.
  @Test(arguments: ["subject", "options", "kind", "dialog", "thread", "action", "old"])
  func aBindingThatIsNotWhatTheMacSawPressesNothing(what: String) throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    var e = ProofEdit()
    switch what {
    case "subject": e.subject = .some("/private/tmp/somewhere-else")
    case "options": e.options = Array(o.options.reversed())
    case "kind": e.kind = "mcp_consent"
    case "dialog": e.dialogId = "Aq5Lm8ZtRx3Cv9PkNa2HdB"
    case "thread": e.thread = "garden"
    case "action": e.action = "kill"
    default: e.tsOffset = -20 * 60  // signed twenty minutes ago
    }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1", edit: e)
    nothing(r, keys, reason: "unverified")
  }

  /// 4. A device marked revoked in devices.json.
  @Test func aRevokedDevicePressesNothing() throws {
    let owner = TestOwner()
    let (r, keys, _, _) = try make("trust", owner: owner)
    defer { r.teardown(); keys.remove() }
    try r.writeDevices([owner.entry(revoked: "2026-11-02T00:00:00.000Z")])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")
  }

  /// 5. A replay: the same proof again, or a proof for an older dialog: once per dialog id.
  @Test func aReplayPressesNothingAndOnceIsAllADialogGets() throws {
    let (r, keys, _, owner) = try make("trust", ["FAKE_DLG_STICKY": "1"])  // the dialog stays after the Enter, so there is something to replay onto
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // a proof for another (an older) sighting of a dialog with the same words
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_0", edit: ProofEdit(dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB"), dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB")
    nothing(r, keys, reason: nil, control: "ctl_0")
    // the real one
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed")
    #expect(keys.keys == ["DOWN", "ENTER"])
    // the same file again: the same control id, ignored
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    usleep(2_500_000)
    #expect(keys.keys == ["DOWN", "ENTER"] && r.result?["outcome"] as? String == "pressed")
    #expect(!FileManager.default.fileExists(atPath: r.answerPath), "taken, not left to be read every second")
    // another valid proof for the same dialog: already answered
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && ["already_answered", "unverified"].contains(r.result?["reason"] as? String ?? ""), "\(String(describing: r.result))")
    #expect(keys.keys == ["DOWN", "ENTER"], "\(keys.keys)")
  }

  // MARK: authentic, but not pressed

  @Test(arguments: ["trust-changed", "mcp", "trust-other"])
  func aScreenThatChangedBeforeTheKeyGetsNoKey(to: String) throws {
    let swap = NSTemporaryDirectory() + "swap-\(UUID().uuidString.prefix(6))"
    let (r, keys, _, owner) = try make("trust", ["FAKE_DLG_SWAP": swap, "FAKE_DLG_SWAP_TO": to])
    defer { r.teardown(); keys.remove(); unlink(swap) }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the offer is not refreshed by the new screen: the tap meets it
    FileManager.default.createFile(atPath: swap, contents: nil)
    usleep(2_000_000)  // the fake looks once a second
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "screen_changed")
  }

  @Test func anAnswerForAnotherDialogIdGetsNoKey() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1", dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB")
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["dialog_id"] as? String == "Aq5Lm8ZtRx3Cv9PkNa2HdB")
    #expect(r.result?["reason"] as? String == "unverified", "an id that is not on the pane is not for this pane, as in the reference check")
    #expect(keys.keys.isEmpty)
  }

  @Test func anAnswerFileTooOldGetsNoKey() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1", at: Date().timeIntervalSince1970 - 600)
    nothing(r, keys, reason: nil)
  }

  @Test func anAnswerAfterTheCardExpiredGetsNoKeyAndTheMacSaysNothingElse() throws {
    let (r, keys, log, owner) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 2 }
    let o = try offered(r)
    try r.ack(o.id)
    usleep(3_000_000)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
    #expect(log.all.isEmpty, "a dialog that had a card is the bridge's to speak for, expired or not: \(log.all)")
    #expect(r.state("trip") == "starting", "a dialog nobody answered stops no worker here: \(r.why("trip"))")
  }

  @Test func whileTheOwnerIsTypingNothingIsSent() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.clientQuiet = 60 }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the client's attach may redraw the pane; the offer is the one the tap meets
    let client = try r.attachClient()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
  }

  // MARK: open (login)

  @Test func openOnTheMacAsksTerminalsAndSendsNoKey() throws {
    let (r, keys, _, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openTerminals = { spy.opened($0); return true }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: nil, control: "ctl_1", open: true)
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "opened" && r.resultControl() == "ctl_1" && r.result?["source"] as? String == "card")
    #expect(spy.all == ["trip"])
    #expect(keys.keys.isEmpty, "\(keys.keys)")
  }

  @Test func aForgedOpenOpensNothing() throws {
    let (r, keys, _, _) = try make("login")
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openTerminals = { spy.opened($0); return true }
    let o = try offered(r)
    try r.writeAnswer(o, owner: TestOwner(), choice: nil, control: "ctl_1", open: true)
    nothing(r, keys, reason: "unverified")
    #expect(spy.all.isEmpty)
  }

  @Test func openWhenNoWindowCanBeShownIsNotOpened() throws {
    let (r, keys, _, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    r.mgr.openTerminals = { _ in false }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: nil, control: "ctl_1", open: true)
    nothing(r, keys, reason: nil)
    #expect(r.result?["reason"] == nil, "no reason in the contract's list fits, so none")
  }

  @Test func openWithNobodyToOpenItIsNotOpened() throws {
    let (r, keys, _, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: nil, control: "ctl_2", open: true)
    nothing(r, keys, reason: nil, control: "ctl_2")
  }

  // MARK: the record is this process's own

  /// An agent can edit workers.json while the app is down. A record read back from disk is nothing to press on until this process has seen
  /// the dialog on the screen and the screen has held still; and then the record is the screen's own read, not the planted one.
  @Test func aRecordReadBackFromDiskIsNeverPressedOn() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    usleep(900_000)
    r.mgr.detach()
    // planted while the app is down: no subject, which would switch the subject re-check off
    let url = URL(fileURLWithPath: r.talosHome + "/workers.json")
    var root = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var threads = try #require(root["threads"] as? [String: Any])
    var trip = try #require(threads["trip"] as? [String: Any])
    var planted = try #require(trip["dialog"] as? [String: Any])
    planted["subject"] = NSNull()
    trip["dialog"] = planted
    threads["trip"] = trip
    root["threads"] = threads
    try JSONSerialization.data(withJSONObject: root).write(to: url)
    var forged = o
    forged.subject = nil
    let again = r.makeManager()
    r.trackNotices(NoticeLog(), on: again)
    again.tune {
      $0.cardAckWait = 600
      $0.dialogSettle = 60  // this process has not yet seen the screen hold still
    }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(5) { r.offer != nil }, "control: the planted record was adopted")
    #expect(r.offer?.subject == nil, "control: it is the planted one")
    try r.writeAnswer(forged, owner: owner, choice: 1, control: "ctl_1")  // a valid proof for what was planted
    usleep(2_500_000)
    #expect(keys.keys.isEmpty, "pressed on a record only read from disk: \(keys.keys)")
    #expect(FileManager.default.fileExists(atPath: r.answerPath), "left for when this process has seen the dialog")
    #expect(r.result == nil)
    again.tune { $0.dialogSettle = 0.5 }
    nothing(r, keys, reason: "unverified")
    let fresh = try #require(r.offer)
    #expect(fresh.id != o.id && fresh.subject == o.subject && fresh.subject != nil, "the screen's own read, under a new id")
    // a tap for what the screen shows does press
    try r.writeAnswer(fresh, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed")
    #expect(keys.keys == ["DOWN", "ENTER"])
  }

  // MARK: a new dialog is a new sighting

  private func secondDialogGetsANewId(byTap: Bool) throws {
    let (r, keys, log, owner) = try make("mcpwrap", ["FAKE_DLG_AGAIN": "1"], ackWait: 1)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .mcpConsent && o.subject == nil, "control: the server name is wrapped, so there is no subject to tell two servers apart")
    try r.ack(o.id)
    if byTap {
      try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_1")
      #expect(r.wait(15) { r.resultControl() == "ctl_1" })
      #expect(r.result?["outcome"] as? String == "pressed")
    } else {
      r.ownerPressesEnter("trip")  // the owner answers in the pane
    }
    #expect(r.wait(15) { r.offer != nil && r.offer?.id != o.id }, "the next dialog kept the old id: \(String(describing: r.offer?.id))")
    let next = try #require(r.offer)
    #expect(next.kind == .mcpConsent && next.options == o.options && next.subject == nil, "control: it does look the same")
    // the old card does not stand for it: the Mac's line comes, as for any dialog with no card
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    // and an old proof does not apply to it
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_9")
    #expect(r.wait(15) { r.resultControl() == "ctl_9" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified")
    #expect(keys.keys == ["ENTER"], "one Enter, the one that answered the first dialog: \(keys.keys)")
  }

  @Test func theDialogThatFollowsOurEnterIsANewSighting() throws { try secondDialogGetsANewId(byTap: true) }
  @Test func theDialogThatFollowsTheOwnersEnterIsANewSighting() throws { try secondDialogGetsANewId(byTap: false) }

  // MARK: the typing guard fails closed

  @Test func ifTheClientsCannotBeReadNothingIsPressed() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // a tmux that cannot list clients: "nobody is typing" would be a guess
    let wrapper = r.root + "/tmux-no-clients"
    try """
    #!/bin/sh
    for a in "$@"; do
      if [ "$a" = list-clients ]; then echo "list-clients: broken" >&2; exit 1; fi
    done
    exec \(Rig.tmuxPath!) "$@"
    """.write(toFile: wrapper, atomically: true, encoding: .utf8)
    chmod(wrapper, 0o755)
    let real = r.mgr.options.tmux
    r.mgr.tune { $0.tmux = wrapper }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
    // control: with clients readable again, a tap goes through
    r.mgr.tune { $0.tmux = real }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed")
  }

  // MARK: a proof is used once

  @Test func aSignedProofIsUsedOncePerDialogEvenAfterNothingWasPressed() throws {
    let swap = NSTemporaryDirectory() + "swap-\(UUID().uuidString.prefix(6))"
    let (r, keys, _, owner) = try make("trust", ["FAKE_DLG_SWAP": swap, "FAKE_DLG_SWAP_TO": "trust-changed"])
    defer { r.teardown(); keys.remove(); unlink(swap) }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    FileManager.default.createFile(atPath: swap, contents: nil)
    usleep(2_000_000)
    var first = try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "screen_changed")
    // the same signed proof again under a control id nobody signed
    first["control_id"] = "ctl_2"
    try r.writeRaw(first)
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "already_answered", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty)
  }

  // MARK: the line

  @Test func anUnreadableKnownDialogAndTheBypassDisclaimerKeepTodaysLine() throws {
    // the old hand-drawn (SYNTHETIC) trust dialog has no colours: not a dialog the reader will read. And a real bypass disclaimer.
    for (scenario, env, text) in [
      ("worker-trust.sh", [String: String](), "trust this folder"),
      ("worker-real.sh", ["FAKE_REAL_START": "screen:bypass-disclaimer"], "bypass permissions"),
    ] {
      let r = try WorkerRig(scenario: scenario, extraEnv: env)
      defer { r.teardown() }
      let log = NoticeLog()
      r.trackNotices(log)
      r.mgr.tune { $0.cardAckWait = 600 }
      r.mgr.startTicking()
      try r.wake("trip")
      #expect(r.wait(10) { log.all.count == 1 }, "\(text): \(r.mgr.needsYou()) \(r.why("trip"))")
      #expect(log.all.first?.text == "trip's session is waiting on a '\(text)' prompt; open Terminals \u{2192} trip on the Mac to answer.")
      #expect(r.offer == nil, "\(text) was offered")
      #expect(r.typedLines.isEmpty)
    }
  }

  @Test func noCardFileInTheWindowMeansTodaysLine() throws {
    let (r, keys, log, _) = try make("trust", ackWait: 2)
    defer { r.teardown(); keys.remove() }
    _ = try offered(r)
    #expect(log.all.isEmpty, "inside the window")
    #expect(r.wait(10) { log.all.count == 1 }, "\(r.mgr.needsYou())")
    #expect(log.all.first?.text.contains("waiting on a 'trust this folder' prompt") == true)
    usleep(1_500_000)
    #expect(log.all.count == 1)
    #expect(r.offer != nil, "the offer stays while the dialog does")
  }

  @Test(arguments: ["waiting", "answered", "closed", "expired"])
  func aCardFileInAnyStatusMeansNoLineEver(status: String) throws {
    let (r, keys, log, _) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.ack(o.id, status: status)
    usleep(4_000_000)
    #expect(log.all.isEmpty, "\(log.all)")
  }

  @Test func aCardFileForAnotherDialogIsNoAck() throws {
    let (r, keys, log, _) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    _ = try offered(r)
    try r.ack("Aq5Lm8ZtRx3Cv9PkNa2HdB")
    #expect(r.wait(10) { log.all.count == 1 })
  }

  @Test func aLinkedWorkerFolderIsNeitherReadNorWritten() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // the thread's folder becomes a link to somewhere else, with a good answer in it
    let elsewhere = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    let real = r.talosHome + "/workers/trip"
    try FileManager.default.moveItem(atPath: real, toPath: r.root + "/moved")
    try FileManager.default.createSymbolicLink(atPath: real, withDestinationPath: elsewhere)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")  // lands in `elsewhere`
    usleep(3_000_000)
    #expect(keys.keys.isEmpty)
    #expect(!FileManager.default.fileExists(atPath: elsewhere + "/dialog-result.json"), "a result written through the link")
    #expect(FileManager.default.fileExists(atPath: elsewhere + "/dialog-answer.json"), "an answer taken through the link")
  }

  // MARK: not stopped

  @Test func aLiveWorkerOnADialogPastTheLimitIsNotStoppedAStartingOneStillIs() throws {
    // live: the dialog comes up on a running session
    let late = NSTemporaryDirectory() + "late-\(UUID().uuidString.prefix(6))"
    let (r, keys, _, _) = try make("trust", ["FAKE_DLG_LATE": late])
    defer { r.teardown(); keys.remove(); unlink(late) }
    r.mgr.tune { $0.dialogLimit = 1.5 }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    FileManager.default.createFile(atPath: late, contents: nil)
    #expect(r.wait(15) { r.offer != nil })
    usleep(4_000_000)  // well past the limit
    #expect(r.up("trip"), "a live worker is not stopped for a dialog: \(r.why("trip"))")
    #expect(r.entry("trip")?.error == nil)
    #expect(r.offer != nil)
    #expect(keys.presses.isEmpty)
    // starting: unchanged
    let (s, skeys, _, _) = try make("trust")
    defer { s.teardown(); skeys.remove() }
    s.mgr.tune { $0.dialogLimit = 1.5 }
    s.mgr.startTicking()
    try s.wake("trip")
    #expect(s.wait(15) { s.state("trip") == "failed" }, "\(s.why("trip"))")
    #expect(s.entry("trip")?.error?.code == "needs_mac")
    #expect(skeys.keys.isEmpty)
  }
}
