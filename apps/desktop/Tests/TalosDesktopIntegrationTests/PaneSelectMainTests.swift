import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// Pane-prompts plan rows 8 and 9 on MAIN's pane: a tool permission and the agent's own question are a Mac popup (answered only by a real click, which
/// reaches `popupAnswerMain` only from the popup button's action) and an offer for the phone card (`supervisor.main_dialog`, answered only by the owner's
/// signed tap in `main-dialog-answer.json`). Real private tmux server; `pane-select.sh` draws the REAL captures and logs every key.
@Suite("Tool permission and question on Main", .serialized, .enabled(if: Rig.hasTmux))
struct PaneSelectMainTests {
  private func make(_ pane: String, _ extra: [String: String] = [:], memory: Double? = nil) throws -> (Rig, KeyLog) {
    let keys = KeyLog()
    var t = Rig.defaultTimings()
    t.promptSettle = 0.6
    if let memory { t.safetyUnsentMemory = memory }
    var env = ["FAKE_DLG_KEYLOG": keys.path, "FAKE_PANE": pane]
    env.merge(extra) { _, b in b }
    let r = try Rig(.tmux, scenario: "pane-select.sh", env: env, timings: t)
    return (r, keys)
  }

  private func offered(_ r: Rig) throws -> DialogOffer {
    r.start()
    #expect(r.wait(25) { r.sup.panePopupItem() != nil }, "audit: \(r.audit)")
    return try #require(r.sup.panePopupItem()).dialog
  }

  private func click(_ r: Rig, _ o: DialogOffer, _ choice: Int, label: String? = nil) -> PopupAnswerResult? {
    let box = ResultBox()
    r.sup.popupAnswerMain(dialogId: o.id, action: .choose(choice, label: label ?? o.options[choice])) { box.value = $0 }
    _ = r.wait(10) { box.value != nil }
    return box.value
  }

  /// The owner's signed tap for Main's offer, as the bridge writes it (`main-dialog-answer.json` in the default thread's folder), free text signed in.
  @discardableResult
  private func tap(_ r: Rig, _ o: DialogOffer, owner: TestOwner, choice: Int, control: String, text: String? = nil) throws -> [String: Any] {
    let cardId = "c_01JBF3V7Q8K2M4N6P8R0S2T405"
    var payload: [String: Any] = ["dialog_id": o.id, "dialog_kind": o.kind.rawValue, "expires_at": o.expires_at, "options": o.options, "thread": "general"]
    payload["subject"] = o.subject.map { $0 as Any } ?? NSNull()
    if let f = o.free_text { payload["free_text"] = f }
    let binding = TestOwner.json(["id": cardId, "kind": "dialog", "thread_id": "general", "payload": payload, "title": "Allow this tool request?", "primary_label": "Answer"])
    var frame: [String: Any] = [
      "type": "card.resolve", "v": 1, "id": "01JBF3V7Q8K2M4N6P8R0S2T4AC", "card_id": cardId, "action": "primary", "device_id": owner.deviceId,
      "payload_hash": "sha256:" + TestOwner.hex(binding), "ts": ISOTime.string(Date().timeIntervalSince1970), "choice": choice,
    ]
    if let text { frame["text"] = text }
    let signed = TestOwner.json(frame)
    let file: [String: Any] = [
      "v": 2, "dialog_id": o.id, "choice": choice, "label": o.options[choice], "by": "Test phone", "at": ISOTime.string(Date().timeIntervalSince1970),
      "control_id": control, "proof": ["signed": signed, "osig": owner.osig(signed), "device_id": owner.deviceId, "binding": binding],
    ]
    try FileManager.default.createDirectory(atPath: r.generalDir, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: file).write(to: URL(fileURLWithPath: r.answerPath), options: .atomic)
    return file
  }

  // MARK: the popup

  @Test func aToolPermissionOnMainIsAPopupAndAnOfferForThePhoneAndNothingPressesItByItself() throws {
    let (r, keys) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let item = try #require(r.sup.panePopupItem())
    let c = NeedsYouPopupContent.make(item)
    #expect(item.thread == Supervisor.mainPopupThread && c.title == "Allow this tool request?")
    #expect(c.subject == "Bash command \u{00B7} touch hello.txt && ls -l hello.txt" && c.buttons.map(\.text) == ["Allow once", "Deny"])
    #expect(o.kind == .toolPermission && !o.options.joined().lowercased().contains("always"))
    #expect(r.sup.status.paneDialog == o, "the offer the bridge's card is made from")
    Thread.sleep(forTimeInterval: 2)
    #expect(keys.keys.isEmpty, "nothing is pressed by itself: \(keys.keys)")
    #expect(!r.allEvents.contains(.openTerminal))
    #expect(r.sup.status.paneDialog?.id == o.id, "the same prompt keeps its offer")
  }

  @Test(arguments: [(0, "DIGIT:1"), (1, "DIGIT:4")])
  func aClickOnAllowOnceOrDenyIsOneNumberKeyAndTheOfferIsOnce(choice: Int, key: String) throws {
    let (r, keys) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, choice, label: "Allow all of them") == .nothing(.screenChanged), "a click that names another label presses nothing")
    #expect(keys.keys.isEmpty)
    #expect(click(r, o, choice) == .pressed(choice: choice, label: o.options[choice]), "audit: \(r.audit)")
    #expect(r.wait(5) { keys.keys == [key] }, "\(keys.keys)")
    #expect(click(r, o, choice) == .nothing(.notOffered) || click(r, o, 1 - choice) == .nothing(.notOffered))
    #expect(keys.keys == [key], "\(keys.keys)")
    #expect(r.audit.contains("main_pane_answered"))
    #expect(r.wait(10) { r.sup.panePopupItem() == nil })
  }

  @Test func aQuestionOnMainIsAPopupWithItsRowsAndAClickPressesItsNumber() throws {
    let (r, keys) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let c = NeedsYouPopupContent.make(try #require(r.sup.panePopupItem()))
    #expect(c.buttons.map(\.text) == ["Red", "Blue"], "no text field in a popup (the free-text row is the phone card's), and Chat about this is not an answer")
    #expect(o.free_text == 2)
    #expect(click(r, o, 2, label: "Other\u{2026}") == .nothing(.screenChanged), "a click on the free-text option presses nothing")
    #expect(keys.keys.isEmpty)
    #expect(click(r, o, 1) == .pressed(choice: 1, label: "Blue"))
    #expect(r.wait(5) { keys.keys == ["DIGIT:2"] }, "\(keys.keys)")
  }

  // MARK: the phone card

  @Test func aSignedTapOnAToolPermissionPressesOnceAndAForgedOneNothing() throws {
    let (r, keys) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let owner = TestOwner()
    try r.pairPhone(owner)
    // an answer from a device that is not paired
    try tap(r, o, owner: TestOwner(), choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty)
    try tap(r, o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(20) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    #expect(r.wait(5) { keys.keys == ["DIGIT:1"] }, "\(keys.keys)")
  }

  @Test func aSignedTapWithOtherTextTypesItOnTheReal2329QuestionOnMain() throws {
    let (r, keys) = try make("question329")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.options == ["Red", "Green", "Blue", "Other\u{2026}"] && o.free_text == 3)
    let owner = TestOwner()
    try r.pairPhone(owner)
    try tap(r, o, owner: owner, choice: 3, control: "ctl_1", text: "purple")
    #expect(r.wait(25) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result)) \(keys.keys)")
    #expect(keys.keys == ["DIGIT:4"] + "purple".map { "CHAR:\($0)" } + ["TEXT:purple", "ENTER"], "\(keys.keys)")
  }

  @Test func aSignedTapWithOtherTextTypesItThroughTheGateOnMain() throws {
    let (r, keys) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let owner = TestOwner()
    try r.pairPhone(owner)
    try tap(r, o, owner: owner, choice: 2, control: "ctl_1", text: "purple")
    #expect(r.wait(25) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result)) \(keys.keys)")
    #expect(r.wait(5) { keys.keys.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.keys == ["DIGIT:3"] + "purple".map { "CHAR:\($0)" } + ["TEXT:purple", "ENTER"], "\(keys.keys)")
  }

  // MARK: the phone line and the stall alarm (R1-4)

  private func writeAck(_ r: Rig, _ o: DialogOffer) throws {
    try FileManager.default.createDirectory(atPath: r.generalDir, withIntermediateDirectories: true)
    let ack: [String: Any] = ["v": 1, "dialog_id": o.id, "card_id": "c_01JBF3V7Q8K2M4N6P8R0S2T403", "thread_id": "general", "status": "waiting", "at": ISOTime.string(Date().timeIntervalSince1970)]
    try JSONSerialization.data(withJSONObject: ack).write(to: URL(fileURLWithPath: r.generalDir + "/dialog-card.json"), options: .atomic)
  }

  /// No card acknowledged by the phone within `paneCardWait` (the bridge is down, or the relay has no card feature): the plain line goes by the CLI path, once.
  @Test func aCardTheBridgeNeverAcknowledgedGetsThePlainLineAfterTheWait() throws {
    let (r, keys) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    for _ in 0..<5 { usleep(200_000); r.sup.tickNow() }
    #expect(r.phonePosts.isEmpty, "inside the wait: \(r.phonePosts)")
    r.clock.advance(16)
    #expect(r.wait(15) { r.sup.tickNow(); return r.phonePosts.count == 1 }, "posts \(r.phonePosts) audit \(r.audit)")
    #expect(r.phonePosts.first == "post general Testagent is waiting on a 'Bash command' prompt; Talos could not put it on a card, so nothing was pressed and it still waits for your answer.")
    for _ in 0..<10 { usleep(200_000); r.sup.tickNow() }
    #expect(r.phonePosts.count == 1, "once per offer: \(r.phonePosts)")
    #expect(r.sup.panePopupItem()?.dialog.id == o.id, "the popup still answers it")
  }

  @Test func aCardThePhoneAcknowledgedIsItsOwnNoticeAndGetsNoLine() throws {
    let (r, keys) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try writeAck(r, o)
    r.clock.advance(16)
    for _ in 0..<10 { usleep(200_000); r.sup.tickNow() }
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
  }

  /// While the offer stands the stall alarm (the unknown-question warning that opens Terminal) is held back; after `paneStallAfter` unanswered it runs.
  @Test func theStallAlarmRunsAfterAnOfferHasStoodUnansweredForTenMinutes() throws {
    let (r, keys) = try make("tool", ["FAKE_X": "1"])
    defer { r.teardown(); keys.remove() }
    _ = try offered(r)
    for _ in 0..<8 { usleep(200_000); r.sup.tickNow() }
    #expect(r.sup.status.needsYou == nil && !r.allEvents.contains(.openTerminal), "held back: \(String(describing: r.sup.status.needsYou))")
    r.clock.advance(601)
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou != nil }, "never raised: audit \(r.audit)")
  }

  // MARK: refused

  @Test func aGarbledPromptOnMainIsNoOfferAndNoKey() throws {
    let (r, keys) = try make("garbled")
    defer { r.teardown(); keys.remove() }
    r.start()
    Thread.sleep(forTimeInterval: 4)
    #expect(r.sup.panePopupItem() == nil && r.sup.status.paneDialog == nil && keys.keys.isEmpty)
  }

  @Test func aScreenChangeBetweenTheOfferAndTheClickPressesNothing() throws {
    let swap = TestTemp.base + "talos-pane-swap-\(UUID().uuidString.prefix(8))"
    defer { unlink(swap) }
    let (r, keys) = try make("tool", ["FAKE_PANE_SWAP": swap])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    FileManager.default.createFile(atPath: swap, contents: Data())
    let tmux = { ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "capture-pane", "-p", "-J", "-t", "=agent:"], env: ["PATH": "/usr/bin:/bin"]).out }
    #expect(r.wait(10) { tmux().contains("rm -rf build") }, "the other prompt is drawn")
    #expect(click(r, o, 0) == .nothing(.screenChanged) || click(r, o, 0) == .nothing(.notOffered), "the old offer presses nothing")
    #expect(keys.keys.isEmpty, "\(keys.keys)")
    #expect(r.wait(15) { r.sup.panePopupItem().map { $0.dialog.id != o.id } == true }, "the new prompt is its own offer")
    #expect(r.sup.panePopupItem()?.dialog.subject == "Bash command \u{00B7} rm -rf build && ls -l")
  }

  @Test func aClickWhileATmuxClientIsTypingPressesNothing() throws {
    let (r, keys) = try make("tool")
    r.timings.devDialogClientQuiet = 600
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let client = Process()
    client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
    client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=agent"]
    client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.home]
    client.standardInput = Pipe()
    client.standardOutput = FileHandle.nullDevice
    client.standardError = FileHandle.nullDevice
    try client.run()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    let listed = { !ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "list-clients", "-t", "=agent", "-F", "#{client_activity}"], env: ["PATH": "/usr/bin:/bin"]).out.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    #expect(r.wait(10) { listed() }, "control: the client attached")
    #expect(click(r, o, 0) == .nothing(.typing))
    #expect(keys.keys.isEmpty)
  }

  // MARK: delivery that is not known

  @Test func aTimedOutKeyIsNotAnsweredAndTheUnchangedPromptIsOfferedAgainAfterTheMemory() throws {
    let (r, keys) = try make("tool", memory: 2)
    defer { r.teardown(); keys.remove() }
    let box = UnknownDigitHost.Box()
    r.sup.detach()
    r.wrapHost = { UnknownDigitHost($0, box) }
    r.makeSupervisor()
    r.start()
    #expect(r.wait(25) { r.sup.panePopupItem() != nil }, "audit: \(r.audit)")
    let first = try #require(r.sup.panePopupItem()).dialog
    #expect(click(r, first, 0) == .nothing(.unconfirmed), "sent, not seen to take: never reported as Allowed")
    #expect(box.digits == 1)
    #expect(r.wait(5) { r.sup.panePopupItem() == nil }, "the popup goes once the key is sent")
    Thread.sleep(forTimeInterval: 1.2)
    #expect(r.sup.panePopupItem() == nil, "quiet while the key may still land")
    r.clock.advance(3)
    #expect(r.wait(15) { r.sup.panePopupItem() != nil }, "never offered again: \(r.audit)")
    #expect(r.sup.panePopupItem()?.dialog.id != first.id, "a new sighting, a new id")
    #expect(!r.audit.contains("main_pane_answered"), "an unconfirmed key is not logged as answered")
    #expect(r.audit.contains("main_pane_send_unconfirmed"))
  }
}

/// Puts a number key into the state a tmux timeout leaves: nothing reaches the pane and the result is `.unknown`.
final class UnknownDigitHost: PtyHost, @unchecked Sendable {
  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var digits: Int { lock.withLock { n } }
    func bump() { lock.withLock { n += 1 } }
  }
  private let base: PtyHost
  private let box: Box
  init(_ base: PtyHost, _ box: Box) {
    self.base = base
    self.box = box
  }
  var kind: HostKind { base.kind }
  func start(executable: String, args: [String], env: [String: String], cwd: String) throws { try base.start(executable: executable, args: args, env: env, cwd: cwd) }
  func restart(executable: String, args: [String], env: [String: String], cwd: String) throws { try base.restart(executable: executable, args: args, env: env, cwd: cwd) }
  func attachIfRunning() -> Bool { base.attachIfRunning() }
  func send(keys: [UInt8]) -> SendOutcome { base.send(keys: keys) }
  func sendDialogKey(_ key: DialogKey) -> SendOutcome { base.sendDialogKey(key) }
  func sendSelectNumber(_ n: SelectNumber) -> SendOutcome {
    box.bump()
    return .unknown
  }
  func sendAnswerText(_ t: AnswerText) -> SendOutcome { base.sendAnswerText(t) }
  func sendEscape() -> SendOutcome { base.sendEscape() }
  func visibleRows() -> [String]? { base.visibleRows() }
  func lastOutputAt() -> Date? { base.lastOutputAt() }
  func terminate(graceSeconds: Double) { base.terminate(graceSeconds: graceSeconds) }
  func close() { base.close() }
  func detach() { base.detach() }
  func clientActivity() -> Double? { base.clientActivity() }
  func clientActivities() -> [Double]? { base.clientActivities() }
  var childPid: Int32? { base.childPid }
  var onExit: (@Sendable (ExitInfo) -> Void)? {
    get { base.onExit }
    set { base.onExit = newValue }
  }
  func setMarker(_ key: String, _ value: String) { base.setMarker(key, value) }
  func marker(_ key: String) -> String? { base.marker(key) }
}
