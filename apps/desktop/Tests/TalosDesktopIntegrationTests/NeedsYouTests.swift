import CryptoKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// Needs-you prompts, the Mac side: a known dialog on a worker's pane is offered in `workers.json`, a tap's answer (a file from the
/// bridge) is turned into arrows and Enter, and the Mac says what it pressed. Real private tmux server; the screens are the REAL Claude
/// Code 2.1.319 dialogs (Fixtures/real-2.1.319/needs-you-capture) drawn by `dialog-real.sh`, which moves its cursor on Up and Down,
/// ignores digits, and confirms on Enter, as the captures show the real Select doing. The owner's tmux, Claude config and bridge are
/// never touched.
final class KeyLog: @unchecked Sendable {
  let path: String
  init() { path = TestTemp.base + "keys-\(UUID().uuidString.prefix(8)).log" }
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
  /// A free-text answer's words, signed into the frame (`text`), and what the card binds as its free-text option (nil: the offer's own).
  var text: String?
  var freeText: Int??
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
    if let f = edit.freeText ?? offer.free_text { payload["free_text"] = f }
    let binding = TestOwner.json([
      "id": cardId, "kind": "dialog", "thread_id": edit.thread ?? "trip", "payload": payload, "title": "Trust this folder?", "primary_label": "Answer",
    ])
    var frame: [String: Any] = [
      "type": "card.resolve", "v": 1, "id": "01JBF3V7Q8K2M4N6P8R0S2T4AA", "card_id": cardId, "action": edit.action, "device_id": owner.deviceId,
      "payload_hash": "sha256:" + TestOwner.hex(binding), "ts": ISOTime.string(Date().timeIntervalSince1970 + edit.tsOffset),
    ]
    if let choice { frame["choice"] = choice }
    if let text = edit.text { frame["text"] = text }
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
    #expect(abs(expires - seen - 86400) < 0.01, "a card lives a day from the first sighting")
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

  /// A relaunch does not vouch for the dialog on the pane: the app was not looking while it was away. Whatever is there when it comes
  /// back is a new sighting with a new id, however exactly it reads as the record in the file, and a tap signed for the old id presses nothing.
  @Test func aRelaunchIsANewSightingEvenOfTheSameDialog() throws {
    let (r, keys, _, owner) = try make("trust")
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
    #expect(r.wait(10) { r.offer != nil && r.offer?.id != o.id && again.popupOffers().count == 1 }, "the id from the file was kept: \(String(describing: r.offer?.id))")
    let fresh = try #require(r.offer)
    #expect(fresh.kind == o.kind && fresh.subject == o.subject && fresh.options == o.options, "control: it reads as the same dialog")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")
    try r.writeAnswer(fresh, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed" && keys.keys == ["DOWN", "ENTER"], "\(String(describing: r.result)) \(keys.keys)")
  }

  /// The lookalike across a relaunch: while the app is away the offered dialog is answered in the pane and another that reads exactly
  /// the same takes its place. The file's record equals the screen, and the card for the old id is still on the phone. The copy that
  /// comes back must not carry the old id over to the dialog it finds: a tap signed for the first dialog presses nothing on the second.
  @Test func aDialogReplacedWhileTheAppWasAwayIsNotAnsweredByTheOldCard() throws {
    let (r, keys, _, owner) = try make("mcp", ["FAKE_DLG_AGAIN": "same"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let offeredScreen = r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out
    usleep(900_000)  // one heartbeat with the offer
    r.mgr.detach()
    r.ownerPressesEnter("trip")  // answered in the pane; the second dialog is drawn, the same down to the cursor row
    #expect(r.wait(5) { keys.keys == ["ENTER"] && r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out == offeredScreen }, "control: \(keys.keys)")
    let again = r.makeManager()
    r.trackNotices(NoticeLog(), on: again)
    again.tune { $0.cardAckWait = 600 }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { r.offer != nil && r.offer?.id != o.id && again.popupOffers().count == 1 }, "the old id stands for the dialog that replaced it: \(String(describing: r.offer?.id))")
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_1")  // the row the cursor is on: one Enter would answer the second dialog
    #expect(r.wait(15) { r.resultControl() == "ctl_1" }, "no result: \(keys.keys)")
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.keys == ["ENTER"], "the old card's tap went onto the dialog that replaced it: \(keys.keys)")
  }

  // MARK: the answer

  @Test(arguments: [
    ("trust", 1, ["DOWN", "ENTER"], "Yes, I trust this folder"), ("mcp", 0, ["UP", "UP", "ENTER"], "Use this MCP server"),
    ("mcp", 1, ["UP", "ENTER"], "Use this and all future MCP servers in this project"),
    ("mcp", 2, ["ENTER"], "Continue without using this MCP server"),
    ("bypass", 1, ["DOWN", "ENTER"], "Yes, I accept"), ("dev", 0, ["ENTER"], "I am using this for local development"),
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
    // The result can be written before the fake tmux has logged the keys it was sent, so wait for the log to catch up.
    _ = r.wait(5) { keys.keys.count >= expected.count }
    #expect(keys.keys == expected, "arrows and one Enter, nothing else (no digit): \(keys.keys)")
    // the answer file is taken, and the session carries on: its input box, ready, the pointer typed once
    #expect(!FileManager.default.fileExists(atPath: r.answerPath))
    #expect(r.wait(15) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { r.typedLines.count == 1 })
    #expect(r.wait(10) { r.offer == nil })
  }

  /// "Don't trust": the signed tap presses "No, exit", Claude exits, and the thread ends failed with its own words: not a crash, no
  /// retry on its own.
  @Test func aSignedNoOnTheTrustQuestionStopsTheSessionCleanly() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["label"] as? String == "No, exit")
    #expect(r.wait(15) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    let e = try #require(r.entry("trip")?.error)
    #expect(e.code == "start_failed")
    #expect(e.detail == WorkerManager.declinedTrustText)
    #expect(r.entry("trip")?.restarts.isEmpty == true, "not a crash")
    usleep(1_500_000)
    #expect(r.state("trip") == "failed", "it does not start itself again")
    #expect(keys.keys == ["ENTER"])
  }

  /// An Enter on "No, exit" whose tmux call timed out may or may not have landed: it is counted as pressed (never repeated) but is not
  /// remembered as the owner's decline, so the exit that follows reads as what it is, not as a "Don't trust".
  @Test func anEnterOnNoThatTimedOutIsNotRememberedAsADecline() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "trust", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let shim = r.root + "/tmux-slow-enter"
    try """
    #!/bin/bash
    slow=
    for a in "$@"; do case "$a" in *Enter*) slow=1 ;; esac; done
    '\(Rig.tmuxPath!)' "$@"; rc=$?
    [ -z "$slow" ] || sleep 3
    exit $rc
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeManager()
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.cardAckWait = 600; $0.callTimeout = 1 }
    let owner = TestOwner()
    try r.writeDevices([owner.entry()])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    let e = try #require(r.entry("trip")?.error)
    #expect(e.detail != WorkerManager.declinedTrustText, "an unconfirmed Enter is not a decline: \(e.detail)")
    #expect(keys.keys == ["ENTER"], "pressed once, never repeated: \(keys.keys)")
  }

  /// A tmux whose Enter is steered by the file `mode` beside it: `drop` swallows the key and says it was sent, `hang` swallows it and runs past
  /// the call timeout, anything else (or no file) passes it on. Every other call is the real tmux.
  private func steerEnter(_ r: WorkerRig, mode: String) throws -> String {
    let modePath = r.root + "/enter-mode"
    try mode.write(toFile: modePath, atomically: true, encoding: .utf8)
    let shim = r.root + "/tmux-steer-enter"
    try """
    #!/bin/bash
    enter=
    for a in "$@"; do case "$a" in *Enter*) enter=1 ;; esac; done
    if [ -n "$enter" ]; then
      echo x >> '\(r.root)/enter-attempts'
      case "$(cat '\(modePath)' 2>/dev/null)" in
        drop) exit 0 ;;
        hang) sleep 3; exit 0 ;;
      esac
    fi
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeManager()
    return modePath
  }

  /// An Enter that timed out, on a screen that never changed (the key did not reach Claude): not answered for good. After the short memory the
  /// same dialog is offered again as a new sighting with a new id; the old card's answer then presses nothing; the new card's answer works.
  @Test func anEnterThatTimedOutOnAnUnchangedScreenIsOfferedAgainWithANewCard() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "trust", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let modePath = try steerEnter(r, mode: "hang")
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = 600; $0.callTimeout = 1; $0.unsentEnterMemory = 11 }  // longer than the 5 s a still screen takes to settle: only the memory holds it back
    let owner = TestOwner()
    try r.writeDevices([owner.entry()])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    // DURING the memory the old card presses nothing: a fresh signed tap and a popup click are both refused, and tmux was asked for one Enter only
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_f")
    #expect(r.wait(15) { r.resultControl() == "ctl_f" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "screen_changed", "\(String(describing: r.result))")
    let clicked = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(0, label: o.options[0])) { clicked.set($0) }
    #expect(r.wait(5) { clicked.get() != nil })
    #expect(clicked.get() == .nothing(.screenChanged), "\(String(describing: clicked.get()))")
    #expect(r.mgr.popupOffers().isEmpty, "the old card is not on the popup either")
    let attempts = { ((try? String(contentsOfFile: r.root + "/enter-attempts", encoding: .utf8)) ?? "").split(separator: "\n").count }
    #expect(attempts() == 1, "one Enter asked of tmux: \(attempts())")
    usleep(8_000_000)  // the screen has settled by now: a counted-as-sent Enter would already have a new card
    #expect(r.offer?.id == o.id, "inside the memory it is not offered again")
    #expect(r.wait(30) { r.offer != nil && r.offer?.id != o.id }, "offered again with a new card: \(String(describing: r.offer))")
    let again = try #require(r.offer)
    #expect(again.kind == o.kind && again.options == o.options && again.subject == o.subject)
    #expect(keys.keys.isEmpty, "the key never reached the dialog: \(keys.keys)")
    // the old card cannot press anything now
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty, "the old card pressed: \(keys.keys)")
    // the new one does, once
    try "pass".write(toFile: modePath, atomically: true, encoding: .utf8)
    try r.writeAnswer(again, owner: owner, choice: 0, control: "ctl_3")
    #expect(r.wait(20) { r.resultControl() == "ctl_3" })
    #expect(r.result?["outcome"] as? String == "pressed")
    #expect(r.wait(10) { keys.keys == ["ENTER"] }, "\(keys.keys)")
  }

  /// An Enter whose delivery was unknown but which DID land: the dialog goes. A late tap for that card is answered (already_answered, nothing
  /// pressed, the file taken) instead of lingering until the bridge gives up.
  @Test func aLateTapForATimedOutEnterThatLandedIsAnsweredAlreadyAnswered() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "trust", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let shim = r.root + "/tmux-slow-enter"
    try """
    #!/bin/bash
    slow=
    for a in "$@"; do case "$a" in *Enter*) slow=1 ;; esac; done
    '\(Rig.tmuxPath!)' "$@"; rc=$?
    [ -z "$slow" ] || sleep 3
    exit $rc
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeManager()
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = 600; $0.callTimeout = 1; $0.unsentEnterMemory = 11 }
    let owner = TestOwner()
    try r.writeDevices([owner.entry()])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    #expect(r.wait(15) { r.offer == nil || r.entry("trip")?.dialog == nil }, "the dialog went: it landed")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_late")
    #expect(r.wait(15) { r.resultControl() == "ctl_late" }, "a late tap is answered: \(String(describing: r.result))")
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "already_answered", "\(String(describing: r.result))")
    #expect(!FileManager.default.fileExists(atPath: r.answerPath), "the answer file is taken")
    #expect(keys.presses.filter { $0 == "ENTER" } == ["ENTER"], "one Enter only: \(keys.keys)")
  }

  /// An Enter tmux confirmed is the answer for good: a second tap for the same card presses nothing, and no memory of an unknown send is kept.
  @Test func aConfirmedEnterIsTheAnswerAndASecondTapForTheCardPressesNothing() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: ["FAKE_DLG": "trust", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    _ = try steerEnter(r, mode: "drop")
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = 600 }
    let owner = TestOwner()
    try r.writeDevices([owner.entry()])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed")
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty, "the dropped Enter was the only one sent: \(keys.keys)")
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
    let swap = TestTemp.base + "swap-\(UUID().uuidString.prefix(6))"
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
    r.mgr.tune { $0.dialogSettle = 600 }  // not offered again meanwhile (its own test below): the old id is what this one asserts
    try r.ack(o.id)
    usleep(3_000_000)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
    #expect(log.all.isEmpty, "a dialog that had a card is the bridge's to speak for, expired or not: \(log.all)")
    #expect(r.state("trip") == "starting", "a dialog nobody answered stops no worker here: \(r.why("trip"))")
  }

  // MARK: a question left standing (L14)

  /// Old code: an offer whose time was up was never replaced while the same dialog stood, so `r.offer.id` stayed `o.id` for good and the wait fails.
  @Test func aDialogStillOnTheScreenWhenItsCardRunsOutIsOfferedAgainUnderANewNumber() throws {
    let (r, keys, _, _) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 2 }
    let o = try offered(r)
    #expect(r.wait(20) { r.offer.map { $0.id != o.id } ?? false }, "never offered again: \(String(describing: r.offer))")
    let n = try #require(r.offer)
    #expect(n.kind == o.kind && n.subject == o.subject && n.options == o.options, "the same question, not another")
    #expect((ISOTime.parse(n.expires_at) ?? 0) > Date().timeIntervalSince1970, "a new offer has its own time")
    #expect(keys.keys.isEmpty, "offering again presses nothing: \(keys.keys)")
  }

  /// Old code: nothing changed the offer, so the old card's tap met the same id and only the time check refused it; with a new offer standing the
  /// refusal must be for the number, and the new card must still answer.
  @Test func aTapOnTheOldCardPressesNothingAndTheNewCardStillAnswers() throws {
    let (r, keys, _, owner) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 2 }
    let o = try offered(r)
    r.mgr.tune { $0.cardLifetime = 600 }  // o keeps its 2 s (fixed when it was made); the offer that follows it is made with 600, so it cannot run out under a tap
    #expect(r.wait(20) { r.offer.map { $0.id != o.id } ?? false })
    let n = try #require(r.offer)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")  // refused for its NUMBER (the new offer has time left, so it is not the time check)
    #expect(r.offer?.id == n.id, "the old tap changed the standing offer")
    try r.writeAnswer(n, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["dialog_id"] as? String == n.id, "\(String(describing: r.result))")
    _ = r.wait(5) { keys.keys.count >= 2 }
    #expect(keys.keys == ["DOWN", "ENTER"], "one answer, one set of keys: \(keys.keys)")
  }

  /// L14, a verified tap of the owner's that pressed nothing ends the offer: the card has failed, so the next look at the same dialog on a settled screen
  /// makes a new id (a new card) instead of leaving the question with a dead card. Old code left the same id standing, so the wait below fails.
  @Test func aTapOfTheOwnersThatPressedNothingEndsTheOfferAndTheNextLookMakesANewOne() throws {
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
    nothing(r, keys, reason: nil)  // the typing guard: nothing pressed
    client.terminate()
    client.waitUntilExit()
    r.mgr.tune { $0.dialogSettle = 1 }
    #expect(r.wait(25) { r.offer.map { $0.id != o.id } ?? false }, "no new offer for the same dialog: \(String(describing: r.offer))")
    #expect(keys.keys.isEmpty)
  }

  /// A tap that does not prove itself (an unpaired device) never ends an offer: a forged file cannot take the card away.
  @Test func aForgedTapNeverEndsTheOffer() throws {
    let (r, keys, _, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: TestOwner(), choice: 1, control: "ctl_1")
    nothing(r, keys, reason: "unverified")
    usleep(3_000_000)
    #expect(r.offer?.id == o.id, "a forged answer ended the offer")
  }

  /// Time not up: the same offer stands (no churn of numbers, no second card).
  @Test func aDialogWhoseCardHasTimeLeftKeepsItsNumber() throws {
    let (r, keys, _, _) = try make("trust", ackWait: 1)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    usleep(3_000_000)
    #expect(r.offer?.id == o.id, "an offer with time left was replaced")
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

  @Test func openOnTheMacStartsTheInAppSignInAndSendsNoKey() throws {
    let (r, keys, _, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openSignIn = { spy.opened($0); return true }
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
    r.mgr.openSignIn = { spy.opened($0); return true }
    let o = try offered(r)
    try r.writeAnswer(o, owner: TestOwner(), choice: nil, control: "ctl_1", open: true)
    nothing(r, keys, reason: "unverified")
    #expect(spy.all.isEmpty)
  }

  @Test func openWhenNoWindowCanBeShownIsNotOpened() throws {
    let (r, keys, _, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    r.mgr.openSignIn = { _ in false }
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
    let (r, keys, log, owner) = try make("mcp", ["FAKE_DLG_AGAIN": "same"], ackWait: 1)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .mcpConsent && o.subject == "harmless")
    try r.ack(o.id)
    if byTap {
      try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_1")
      #expect(r.wait(15) { r.resultControl() == "ctl_1" })
      #expect(r.result?["outcome"] as? String == "pressed")
    } else {
      // the owner answers in the pane, on another row: the Mac sees the cursor move before the second dialog is drawn. (An Enter alone,
      // followed at once by a dialog that reads the same, leaves no frame to see: docs/OPTION-C.md "Known gaps".)
      let before = r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out
      #expect(r.tmuxCmd(["send-keys", "-t", "=t-trip:", "Up"]).ok)
      #expect(r.wait(5) { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out != before }, "control: the Up never showed")
      r.mgr.tickOnce()
      r.ownerPressesEnter("trip")
    }
    #expect(r.wait(15) { r.offer != nil && r.offer?.id != o.id }, "the next dialog kept the old id: \(String(describing: r.offer?.id))")
    let next = try #require(r.offer)
    #expect(next.kind == .mcpConsent && next.options == o.options && next.subject == o.subject && next.cursor == o.cursor, "control: it does read the same")
    // the old card does not stand for it: the Mac's line comes, as for any dialog with no card
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    // and an old proof does not apply to it
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_9")
    #expect(r.wait(15) { r.resultControl() == "ctl_9" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified")
    #expect(keys.presses.filter { $0 == "ENTER" } == ["ENTER"], "one Enter, the one that answered the first dialog: \(keys.keys)")
  }

  /// A dialog whose subject cannot be read (here the MCP consent with its server name wrapped over two rows) has nothing to tell it from
  /// another of its kind, so a card for it could be answered onto a lookalike. It gets the thread's line at once, however long the bridge
  /// is given for a card, and is never offered: not in workers.json, not in the popup. An answer that claims to be for it presses nothing.
  @Test func aDialogWithNoReadableSubjectGetsTheLineAndIsNeverOffered() throws {
    let (r, keys, log, owner) = try make("mcpwrap")  // ackWait 600: only a dialog that is NOT offered gets its line inside that
    defer { r.teardown(); keys.remove() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { log.all.count == 1 }, "no line: \(r.mgr.needsYou()) offer \(String(describing: r.offer)) \(r.why("trip"))")
    #expect(log.all.first?.text == "This thread's session is waiting on a 'approve a project MCP server' prompt. Talos could not put it on a card, so nothing was pressed and it still waits for your answer.")
    #expect(r.mgr.needsYou()["trip"] == "approve a project MCP server")
    #expect(r.offer == nil && r.mgr.popupOffers().isEmpty, "offered with no subject: \(String(describing: r.offer))")
    let rows = r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out.components(separatedBy: "\n")
    let d = try #require(DialogReader.read(rows: rows), "control: the reader does read the dialog")
    #expect(d.kind == .mcpConsent && d.subject == nil && d.options.count == 3, "control: it is the dialog, with no subject: \(d)")
    // an answer made for exactly what the screen shows, by the paired phone
    let t = Date().timeIntervalSince1970
    let made = DialogOffer(
      id: "Aq5Lm8ZtRx3Cv9PkNa2HdB", kind: d.kind, subject: nil, options: d.options, cursor: d.cursor, seen_at: ISOTime.string(t),
      expires_at: ISOTime.string(t + 900))
    try r.writeAnswer(made, owner: owner, choice: 0, control: "ctl_1")
    for _ in 0..<8 { r.mgr.tickOnce() }
    #expect(keys.keys.isEmpty, "pressed on a dialog that was never offered: \(keys.keys)")
    #expect(r.result == nil && r.offer == nil)
  }

  /// The lookalike. The offered dialog is answered in the pane and another takes its place that reads exactly the same (same kind, same
  /// server name, same rows, the cursor where it was). The Mac saw the screen change in between. A tap signed for the dialog the card
  /// showed must not be pressed onto the one that replaced it: nothing is pressed, and what holds still next is a new sighting, a new id.
  @Test func aTapNeverLandsOnADialogThatReplacedTheOneOffered() throws {
    let (r, keys, _, owner) = try make("mcp", ["FAKE_DLG_AGAIN": "same"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let offeredScreen = r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out
    r.mgr.tune { $0.dialogSettle = 60 }  // the window (5 s in the app) in which the old offer still stands
    // the owner moves the cursor and answers in the pane: the Mac sees the screen change, then the second dialog is drawn
    #expect(r.tmuxCmd(["send-keys", "-t", "=t-trip:", "Up"]).ok)
    #expect(r.wait(5) { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out != offeredScreen }, "control: the Up never showed")
    r.mgr.tickOnce()  // a look at the changed screen
    r.ownerPressesEnter("trip")
    #expect(r.wait(5) { keys.keys == ["UP", "ENTER"] && r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out == offeredScreen }, "control: the second dialog reads as the first did: \(keys.keys)")
    #expect(r.offer?.id == o.id, "control: the old offer still stands")
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_1")  // the row the cursor is on: one Enter would answer the second dialog
    #expect(r.wait(15) { r.resultControl() == "ctl_1" }, "no result: \(keys.keys)")
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "screen_changed", "\(String(describing: r.result))")
    #expect(keys.keys == ["UP", "ENTER"], "a key went onto the dialog that replaced the offered one: \(keys.keys)")
    #expect(r.mgr.popupOffers().isEmpty, "the popup still shows a button that can only say the screen changed")
    // the second dialog, once it has held still, is its own sighting, and a tap for THAT one presses
    r.mgr.tune { $0.dialogSettle = 0.5 }
    #expect(r.wait(15) { r.offer != nil && r.offer?.id != o.id }, "no new sighting: \(String(describing: r.offer?.id))")
    let next = try #require(r.offer)
    try r.writeAnswer(next, owner: owner, choice: 2, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    #expect(keys.keys == ["UP", "ENTER", "ENTER"], "\(keys.keys)")
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
    // the owner's tap that pressed nothing ended that offer: the next look makes a new id, and the tap is for that one (the old id's is refused)
    #expect(r.wait(25) { r.offer.map { $0.id != o.id } ?? false }, "no new offer: \(String(describing: r.offer))")
    let n = try #require(r.offer)
    try r.writeAnswer(n, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed")
  }

  // MARK: a proof is used once

  @Test func aSignedProofIsUsedOncePerDialogEvenAfterNothingWasPressed() throws {
    let swap = TestTemp.base + "swap-\(UUID().uuidString.prefix(6))"
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

  /// A signed tap that pressed nothing (the owner was typing at the pane) does not press after the app relaunches either: a copy of that
  /// answer dropped in again, under a new control id, must not press what the owner was told was not pressed. The dialog the new copy
  /// finds is a new sighting under a new id, so the old tap applies to nothing (and is in the used list besides).
  @Test func aSignedProofThatPressedNothingStillPressesNothingAfterARelaunch() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.clientQuiet = 60 }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the client's attach may redraw the pane; the offer is the one the tap meets
    let client = try r.attachClient()
    var first = try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
    client.terminate()
    client.waitUntilExit()
    usleep(900_000)  // one heartbeat with the offer
    r.mgr.detach()
    let again = r.makeManager()
    r.trackNotices(NoticeLog(), on: again)
    again.tune { $0.cardAckWait = 600 }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(10) { again.needsYou()["trip"] != nil && again.popupOffers().count == 1 }, "re-adopted: \(r.why("trip"))")
    #expect(again.snapshot().threads["trip"]?.dialog?.id != o.id, "the relaunch kept the id from the file")
    first["control_id"] = "ctl_2"
    try r.writeRaw(first)
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty, "the replayed tap pressed: \(keys.keys)")
  }

  /// The tap is on disk as used before any key is sent. When that cannot be written (here a folder stands where the file goes), nothing
  /// is pressed: a press the Mac could not record could be repeated after a relaunch.
  @Test func aTapThatCannotBeRecordedAsUsedPressesNothing() throws {
    let (r, keys, _, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try FileManager.default.createDirectory(
      atPath: r.talosHome + "/workers/trip/" + DialogProofsUsed.fileName, withIntermediateDirectories: true)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    nothing(r, keys, reason: nil)
  }

  // MARK: the safety questions (pane-prompts rows 2 to 4)

  @Test func aRealBypassDisclaimerIsOfferedWithNoSubjectAndItsTwoRows() throws {
    let (r, keys, log, _) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .bypass && o.subject == nil && o.options == ["No, exit", "Yes, I accept"] && o.cursor == 0)
    #expect(keys.keys.isEmpty && log.all.isEmpty, "offering it presses nothing and, inside the card window, says nothing")
    let c = NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "trip", threadName: "Trip", dialog: o))
    #expect(c.title == "Run with permission checks off?" && c.buttons.map(\.text) == ["No, exit", "Yes, I accept"])
  }

  @Test func theDevelopmentChannelsQuestionOnAThreadIsOfferedWithItsChannelsAsTheSubject() throws {
    let (r, keys, _, _) = try make("dev")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .devChannels && o.subject == "server:talos-app" && o.options == ["I am using this for local development", "Exit"] && o.cursor == 0)
    #expect(r.mgr.needsYou()["trip"] == "development channels")
  }

  /// A server name the question wrapped over two rows is a subject (and a card) only when the thread folder's own `.mcp.json` defines exactly
  /// that name: not from the screen alone, and not with another name there.
  @Test func aWrappedMcpNameIsOfferedOnlyWhenTheFoldersMcpJsonDefinesExactlyThatName() throws {
    let (r, keys, _, _) = try make("mcpwrap")
    defer { r.teardown(); keys.remove() }
    try #"{"mcpServers":{"first-server-name-wrapped-a":{"command":"x"},"other":{"command":"y"}}}"#.write(toFile: r.agentDir + "/.mcp.json", atomically: true, encoding: .utf8)
    let o = try offered(r)
    #expect(o.kind == .mcpConsent && o.subject == "first-server-name-wrapped-a", "\(String(describing: o.subject))")
    #expect(NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "trip", threadName: "Trip", dialog: o)).title == "Use first-server-name-wrapped-a?")
    let (r2, keys2, log2, _) = try make("mcpwrap")
    defer { r2.teardown(); keys2.remove() }
    try #"{"mcpServers":{"first-server-name":{"command":"x"}}}"#.write(toFile: r2.agentDir + "/.mcp.json", atomically: true, encoding: .utf8)
    r2.mgr.startTicking()
    try r2.wake("trip")
    #expect(r2.wait(15) { log2.all.count == 1 }, "no line: \(r2.mgr.needsYou())")
    #expect(r2.offer == nil, "a half of the name is not a subject: \(String(describing: r2.offer))")
  }

  /// "No, exit" on the bypass disclaimer: the session ends as the owner's answer, failed with its own words, never a crash, no retry.
  @Test func aSignedNoOnTheBypassDisclaimerStopsTheSessionCleanly() throws {
    let (r, keys, _, owner) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["label"] as? String == "No, exit")
    #expect(r.wait(15) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    let e = try #require(r.entry("trip")?.error)
    #expect(e.code == "start_failed" && e.detail == WorkerManager.declinedExitText(.bypass))
    #expect(e.detail?.contains("permission checks off") == true)
    #expect(r.entry("trip")?.restarts.isEmpty == true, "not a crash")
    usleep(1_500_000)
    #expect(r.state("trip") == "failed", "it does not start itself again")
    #expect(keys.keys == ["ENTER"])
  }

  @Test func aSignedExitOnTheDevelopmentChannelQuestionStopsTheSessionCleanly() throws {
    let (r, keys, _, owner) = try make("dev")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(15) { r.result != nil })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["label"] as? String == "Exit")
    #expect(r.wait(15) { r.state("trip") == "failed" }, "\(r.why("trip"))")
    #expect(r.entry("trip")?.error?.detail == WorkerManager.declinedExitText(.devChannels))
    #expect(r.entry("trip")?.restarts.isEmpty == true)
    #expect(keys.keys == ["DOWN", "ENTER"])
  }

  /// The HARD RULE: these answer safety questions, so only the owner's signed tap does. An answer file anything else could write presses nothing.
  @Test(arguments: ["bypass", "mcp", "dev"])
  func aProoflessGarbledOrUnlistedAnswerOnASafetyQuestionPressesNothing(dlg: String) throws {
    let (r, keys, _, _) = try make(dlg)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let accept = o.options.count - 1
    // no proof at all
    try r.writeRaw(["v": 2, "dialog_id": o.id, "choice": accept, "label": o.options[accept], "by": "an agent", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_1"])
    usleep(2_000_000)
    #expect(r.result == nil && keys.keys.isEmpty && !FileManager.default.fileExists(atPath: r.answerPath), "taken, nothing pressed")
    // a proof with garbage in it
    try r.writeRaw([
      "v": 2, "dialog_id": o.id, "choice": accept, "label": o.options[accept], "by": "an agent", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_2",
      "proof": ["signed": "{}", "osig": String(repeating: "A", count: 86), "device_id": "d_aaaaaaaaaaaaaaaaaaaa", "binding": "{}"],
    ])
    nothing(r, keys, reason: "unverified", control: "ctl_2")
    // a valid signature by a key nobody paired
    try r.writeAnswer(o, owner: TestOwner(), choice: accept, control: "ctl_3")
    nothing(r, keys, reason: "unverified", control: "ctl_3")
  }

  /// A card the owner signed for another kind of dialog, or other rows, is not an answer to this one.
  @Test func aBypassAnswerSignedAsAnotherKindOrOtherRowsPressesNothing() throws {
    let (r, keys, _, owner) = try make("bypass")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1", edit: ProofEdit(kind: "mcp_consent"))
    nothing(r, keys, reason: "unverified", control: "ctl_1")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_2", edit: ProofEdit(options: ["No, exit", "Yes, I accept", "Always"]))
    nothing(r, keys, reason: "unverified", control: "ctl_2")
  }

  /// A different dialog in the bypass disclaimer's place by the time of the tap: nothing is pressed (the key gate checks the live screen is the
  /// one the key states).
  @Test func aTapForTheBypassDisclaimerNeverLandsOnAnotherDialogThatTookItsPlace() throws {
    let trigger = TestTemp.base + "swap-\(UUID().uuidString.prefix(6))"
    let (r, keys, _, owner) = try make("bypass", ["FAKE_DLG_SWAP": trigger, "FAKE_DLG_SWAP_TO": "mcp"])
    defer { r.teardown(); keys.remove(); unlink(trigger) }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the old offer still stands; the screen under it is another dialog
    FileManager.default.createFile(atPath: trigger, contents: nil)
    // the other dialog is on the pane (the fake swaps within its own poll), not a guess at how long that takes
    #expect(r.wait(10) { r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out.contains("MCP server") }, "control: the other dialog was drawn")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty, "a key went onto the dialog that replaced the offered one: \(keys.keys)")
  }

  // MARK: the line

  @Test func anUnreadableKnownDialogKeepsTodaysLineAndABypassDisclaimerThatIsNotReadableGetsTheNoTerminalLine() throws {
    // the old hand-drawn (SYNTHETIC) trust dialog has no colours: not a dialog the reader will read. And a real bypass disclaimer with its last row
    // gone (synthetic/bypass-disclaimer-partial.txt): not read either, so no card, and its line names no terminal.
    for (scenario, env, text, line) in [
      ("worker-trust.sh", [String: String](), "trust this folder",
       "This thread's session is waiting on a 'trust this folder' prompt; open this thread in Terminals on the Mac to answer."),
      ("worker-real.sh", ["FAKE_REAL_START": "screen:bypass-disclaimer-partial"], "bypass permissions",
       "This thread's session is waiting on a 'bypass permissions' prompt. Talos could not put it on a card, so nothing was pressed and it still waits for your answer."),
    ] {
      let r = try WorkerRig(scenario: scenario, extraEnv: env)
      defer { r.teardown() }
      let log = NoticeLog()
      r.trackNotices(log)
      r.mgr.tune { $0.cardAckWait = 600 }
      r.mgr.startTicking()
      try r.wake("trip")
      #expect(r.wait(10) { log.all.count == 1 }, "\(text): \(r.mgr.needsYou()) \(r.why("trip"))")
      #expect(log.all.first?.text == line)
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
    let late = TestTemp.base + "late-\(UUID().uuidString.prefix(6))"
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
