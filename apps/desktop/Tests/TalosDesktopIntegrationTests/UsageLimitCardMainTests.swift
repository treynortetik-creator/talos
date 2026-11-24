import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// Pane-prompts plan row 7 on MAIN's pane: the usage-limit menu is a Mac popup (a real click) and an offer for the phone card (`supervisor.main_dialog`,
/// answered only by the owner's signed tap in `main-dialog-answer.json`). Stop and wait is one Escape; Switch model is Escape, `/model`, Enter. Real
/// private tmux server; `main-usage-limit.sh` draws the SYNTHETIC screen (no real capture exists yet) and logs every key.
@Suite("Usage-limit card on Main", .serialized, .enabled(if: Rig.hasTmux))
struct UsageLimitCardMainTests {
  private func make(_ extra: [String: String] = [:]) throws -> (Rig, KeyLog) {
    let keys = KeyLog()
    var t = Rig.defaultTimings()
    t.promptSettle = 0.6
    var env = ["FAKE_DLG_KEYLOG": keys.path, "FAKE_UL_ESC_ENDS": "1"]
    env.merge(extra) { _, b in b }
    let r = try Rig(.tmux, scenario: "main-usage-limit.sh", env: env, timings: t)
    return (r, keys)
  }

  private func offered(_ r: Rig) throws -> DialogOffer {
    r.start()
    #expect(r.wait(20) { isRunning(r.phase()) }, "\(r.phase()) audit: \(r.audit)")
    FileManager.default.createFile(atPath: r.stateDir + "/ul", contents: nil)
    #expect(r.wait(25) { r.sup.panePopupItem() != nil }, "audit: \(r.audit)")
    return try #require(r.sup.panePopupItem()).dialog
  }

  /// The rig's awake clock moves only when a test moves it, and the driver waits for a screen to change by that clock: `moveClock` keeps it going while a
  /// click that may wait is in flight (a menu that stays after Escape).
  private func click(_ r: Rig, _ o: DialogOffer, _ choice: Int, label: String? = nil, moveClock: Bool = false) -> PopupAnswerResult? {
    let stop = Locked<Bool>(false)
    if moveClock {
      Thread.detachNewThread {
        while !stop.get() {
          r.clock.advance(0.5)
          usleep(50_000)
        }
      }
    }
    defer { stop.set(true) }
    let box = ResultBox()
    r.sup.popupAnswerMain(dialogId: o.id, action: .choose(choice, label: label ?? o.options[choice])) { box.value = $0 }
    _ = r.wait(20) { box.value != nil }
    return box.value
  }

  @discardableResult
  private func tap(_ r: Rig, _ o: DialogOffer, owner: TestOwner, choice: Int, control: String) throws -> [String: Any] {
    let cardId = "c_01JBF3V7Q8K2M4N6P8R0S2T406"
    var payload: [String: Any] = ["dialog_id": o.id, "dialog_kind": o.kind.rawValue, "expires_at": o.expires_at, "options": o.options, "thread": "general"]
    payload["subject"] = o.subject.map { $0 as Any } ?? NSNull()
    let binding = TestOwner.json(["id": cardId, "kind": "dialog", "thread_id": "general", "payload": payload, "title": "x", "primary_label": "Answer"])
    let frame: [String: Any] = [
      "type": "card.resolve", "v": 1, "id": "01JBF3V7Q8K2M4N6P8R0S2T4AD", "card_id": cardId, "action": "primary", "device_id": owner.deviceId,
      "payload_hash": "sha256:" + TestOwner.hex(binding), "ts": ISOTime.string(Date().timeIntervalSince1970), "choice": choice,
    ]
    let signed = TestOwner.json(frame)
    let file: [String: Any] = [
      "v": 2, "dialog_id": o.id, "choice": choice, "label": o.options[choice], "by": "Test phone", "at": ISOTime.string(Date().timeIntervalSince1970),
      "control_id": control, "proof": ["signed": signed, "osig": owner.osig(signed), "device_id": owner.deviceId, "binding": binding],
    ]
    try FileManager.default.createDirectory(atPath: r.generalDir, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: file).write(to: URL(fileURLWithPath: r.answerPath), options: .atomic)
    return file
  }

  @Test func theMenuOnMainIsAPopupAndAnOfferForThePhoneAndNothingIsPressedByItself() throws {
    let (r, keys) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let c = NeedsYouPopupContent.make(try #require(r.sup.panePopupItem()))
    #expect(c.title == "Main's session hit its usage limit" && c.buttons.map(\.text) == ["Stop and wait", "Switch model"])
    #expect(c.subject == "Fable limit reached. It resets 4pm (Europe/Paris).")
    #expect(o.kind == .usageLimit && r.sup.status.paneDialog == o, "the offer the bridge's card is made from")
    Thread.sleep(forTimeInterval: 2)
    #expect(keys.keys.isEmpty, "nothing is pressed by itself: \(keys.keys)")
    #expect(!r.allEvents.contains(.openTerminal))
    #expect(isRunning(r.phase()), "Main was not stopped for it")
  }

  @Test func aClickOnWaitForResetIsOneEscape() throws {
    let (r, keys) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, 0, label: "Switch to usage credits") == .nothing(.screenChanged), "a click naming another label presses nothing")
    #expect(keys.keys.isEmpty)
    #expect(click(r, o, 0) == .pressed(choice: 0, label: "Stop and wait"), "audit: \(r.audit)")
    #expect(r.wait(5) { keys.keys == ["ESC"] }, "\(keys.keys)")
    #expect(r.audit.contains("main_pane_answered"))
    #expect(r.wait(10) { r.sup.panePopupItem() == nil })
  }

  @Test func aClickOnSwitchModelIsEscapeSlashModelEnter() throws {
    let (r, keys) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, 1) == .pressed(choice: 1, label: "Switch model"), "audit: \(r.audit)")
    #expect(r.wait(10) { keys.keys.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.keys == ["ESC"] + "/model".map { "CHAR:\($0)" } + ["ENTER"], "\(keys.keys)")
  }

  @Test func aSignedTapPressesOnceAndAForgedOneNothing() throws {
    let (r, keys) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let owner = TestOwner()
    try r.pairPhone(owner)
    try tap(r, o, owner: TestOwner(), choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified", "\(String(describing: r.result))")
    #expect(keys.keys.isEmpty)
    try tap(r, o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(20) { r.sup.tickNow(); return r.result?["control_id"] as? String == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    #expect(r.wait(5) { keys.keys == ["ESC"] }, "\(keys.keys)")
  }

  @Test func aMenuThatStaysAfterTheEscapeIsNotAnAnswerThatStood() throws {
    let (r, keys) = try make(["FAKE_UL_ESC_ENDS": ""])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, 0, moveClock: true) == .nothing(.unconfirmed), "audit: \(r.audit)")
    // (the fake reads a lone Escape for a second before it logs it)
    #expect(r.wait(10) { keys.keys == ["ESC"] }, "\(keys.keys)")
    #expect(click(r, o, 1, moveClock: true) != .pressed(choice: 1, label: "Switch model"))
    Thread.sleep(forTimeInterval: 2.5)
    #expect(keys.keys == ["ESC"], "one key for one offer: \(keys.keys)")
  }
}
