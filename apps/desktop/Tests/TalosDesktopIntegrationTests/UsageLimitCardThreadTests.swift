import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// Pane-prompts plan row 7 on a thread session's pane (the Mac): Claude Code's usage-limit menu (SYNTHETIC `usage-limit.txt`, drawn by `dialog-real.sh`
/// with FAKE_DLG=ul; no real capture exists yet) is offered as a card that says when the limit resets and has two buttons. A signed tap on Stop and wait
/// presses ONE Escape; Switch model presses Escape, types `/model` and presses Enter; nothing else is ever pressed on it. Real private tmux server; the
/// fake logs every key it receives (FAKE_DLG_UL_ESC_ENDS=1 makes a lone Escape do what the menu's own `Esc to cancel` does).
@Suite("Usage-limit card on a thread", .serialized, .enabled(if: Rig.hasTmux))
struct UsageLimitCardThreadTests {
  private func make(_ extra: [String: String] = [:], ackWait: Double = 600) throws -> (WorkerRig, KeyLog, NoticeLog, TestOwner) {
    let keys = KeyLog()
    var env = ["FAKE_DLG": "ul", "FAKE_DLG_KEYLOG": keys.path, "FAKE_DLG_UL_ESC_ENDS": "1"]
    env.merge(extra) { _, b in b }
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: env)
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.cardAckWait = ackWait }
    let o = TestOwner()
    try r.writeDevices([o.entry()])
    return (r, keys, log, o)
  }

  private func offered(_ r: WorkerRig) throws -> DialogOffer {
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { r.offer != nil }, "no offer: \(r.why("trip")) \(r.mgr.needsYou())")
    return try #require(r.offer)
  }

  private func nothing(_ r: WorkerRig, _ keys: KeyLog, control: String, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(r.wait(20) { r.resultControl() == control }, "no result: \(keys.keys)", sourceLocation: sourceLocation)
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))", sourceLocation: sourceLocation)
    #expect(keys.keys.isEmpty, "a key was sent: \(keys.keys)", sourceLocation: sourceLocation)
  }

  // MARK: the offer

  @Test func theMenuIsACardWithTheResetInWordsAndOnlyWaitAndSwitchModel() throws {
    let (r, keys, log, _) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .usageLimit && o.free_text == nil && o.cursor == nil)
    #expect(o.subject == "Fable limit reached. It resets 4pm (Europe/Paris).")
    #expect(o.options == ["Stop and wait", "Switch model"])
    #expect(r.wait(3) { WorkersFile.decode((try? Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/workers.json"))) ?? Data())?.threads["trip"]?.dialog == o }, "it is in the file the bridge reads")
    let c = NeedsYouPopupContent.make(try #require(r.mgr.popupOffers().first))
    #expect(c.title == "trip's session hit its usage limit" && c.buttons.map(\.text) == ["Stop and wait", "Switch model"] && c.subject == o.subject)
    // nothing is pressed or said by itself while the card waits (its line is the fallback, after the card wait)
    usleep(1_500_000)
    #expect(keys.keys.isEmpty && log.all.isEmpty, "\(keys.keys) \(log.all)")
    #expect(r.offer?.id == o.id, "the same screen, still there: the same card")
  }

  @Test func withNoCardTheLineIsTheFallbackAndNamesNoTerminal() throws {
    let (r, keys, log, _) = try make(ackWait: 0)
    defer { r.teardown(); keys.remove() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { !log.all.isEmpty }, "no line: \(r.mgr.needsYou())")
    let text = try #require(log.all.first?.text)
    #expect(text == "This thread's session hit the usage limit for Fable. It resets 4pm (Europe/Paris). Talos pressed nothing on that screen. Its choices come as a card when Talos can read them.", "\(text)")
    for w in ["Terminal", "pane", "Esc", "/model"] { #expect(!text.contains(w), "\(w): \(text)") }
    #expect(keys.keys.isEmpty)
  }

  /// The window a pressed key gets to show on the pane is the product's two seconds unless a test widens it (the rig does, by `waitScale`).
  @Test func aKeyGetsTwoSecondsToShowUnlessATestWidensIt() {
    let o = WorkerManager.Options(
      talosHome: "/home/alex/.talos-app", agentDir: "/home/alex/agent", claudePath: "/home/alex/bin/claude",
      permissionFlag: "--dangerously-skip-permissions", tmux: "/usr/bin/tmux", tmuxConf: "/dev/null")
    #expect(o.echoWait == 2)
  }

  // MARK: a signed tap

  @Test func waitForResetIsOneEscapeAndNothingElse() throws {
    let (r, keys, _, owner) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    let res = try #require(r.result)
    #expect(res["outcome"] as? String == "pressed" && res["label"] as? String == "Stop and wait" && res["choice"] as? Int == 0, "\(res)")
    #expect(r.wait(10) { keys.answers == ["ESC"] }, "\(keys.keys)")
    #expect(r.wait(10) { r.offer == nil }, "the offer goes with the menu")
  }

  @Test func switchModelIsEscapeThenSlashModelThenEnterAndNeverARowsNumber() throws {
    let (r, keys, _, owner) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(30) { r.resultControl() == "ctl_1" })
    let res = try #require(r.result)
    #expect(res["outcome"] as? String == "pressed" && res["label"] as? String == "Switch model", "\(res)")
    #expect(r.wait(10) { keys.answers.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.answers == ["ESC"] + "/model".map { "CHAR:\($0)" } + ["ENTER"], "\(keys.keys)")
    #expect(!keys.keys.contains { $0.hasPrefix("DIGIT") || $0 == "UP" || $0 == "DOWN" || $0 == "CHAR:3" }, "no row of the menu is ever chosen: \(keys.keys)")
  }

  /// R1-1 and R1-2 against the fake's slash list: with the cursor on /model the Enter goes; with it on /memory the Enter would run another command, so it is
  /// refused, the typed `/model` is taken out again by guarded Backspaces, and the card says it closed the menu and cleared the words (never "nothing pressed").
  @Test func aSlashListWithItsCursorOnModelGetsTheEnter() throws {
    let (r, keys, _, owner) = try make(["FAKE_DLG_UL_LIST": "model"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(30) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    #expect(r.wait(10) { keys.answers.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.answers == ["ESC"] + "/model".map { "CHAR:\($0)" } + ["ENTER"], "\(keys.keys)")
  }

  @Test func aSlashListWithItsCursorOnMemoryGetsNoEnterAndTheTypedWordsAreCleared() throws {
    let (r, keys, _, owner) = try make(["FAKE_DLG_UL_LIST": "memory"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(40) { r.resultControl() == "ctl_1" })
    let res = try #require(r.result)
    #expect(res["outcome"] as? String == "partial" && res["reason"] as? String == "cleared" && res["label"] as? String == "Switch model", "\(res)")
    #expect(r.wait(10) { keys.answers.filter { $0 == "BSPACE" }.count == 6 }, "\(keys.keys)")
    #expect(keys.answers == ["ESC"] + "/model".map { "CHAR:\($0)" } + Array(repeating: "BSPACE", count: 6), "no Enter: \(keys.keys)")
  }

  @Test func aPopupClickThatStoppedPartWaySaysSoAndNeverNothingPressed() throws {
    let (r, keys, _, _) = try make(["FAKE_DLG_UL_LIST": "memory"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let got = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(1, label: "Switch model")) { got.set($0) }
    #expect(r.wait(40) { got.get() != nil })
    #expect(got.get() == .nothing(.stopped(.cleared)), "\(String(describing: got.get()))")
    #expect(!NeedsYouPopupContent.failureText(.stopped(.cleared), threadName: "trip").lowercased().contains("nothing pressed"))
    #expect(!keys.keys.contains("ENTER"), "\(keys.keys)")
  }

  @Test func anEscapeThatDidNotTakeIsNotAnAnswerAndIsNotSentTwice() throws {
    let (r, keys, _, owner) = try make(["FAKE_DLG_UL_ESC_ENDS": ""])  // the menu stays after Escape
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(30) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unconfirmed", "\(String(describing: r.result))")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(20) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.answers == ["ESC"], "one key for one offer: \(keys.keys)")
  }

  @Test func anAnswerNotFromAPairedDeviceOrForAnotherCardPressesNothing() throws {
    let (r, keys, _, owner) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // an agent's own key: not in devices.json
    try r.writeAnswer(o, owner: TestOwner(), choice: 0, control: "ctl_1")
    nothing(r, keys, control: "ctl_1")
    #expect(r.result?["reason"] as? String == "unverified")
    // a revoked device
    try r.writeDevices([owner.entry(revoked: "2026-11-19T00:00:00.000Z")])
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    nothing(r, keys, control: "ctl_2")
    try r.writeDevices([owner.entry()])
    // a card that lists a row that spends credits is not this offer's
    let credits = ["Stop and wait", "Add funds to continue with usage credits"]
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_3", edit: ProofEdit(options: credits))
    nothing(r, keys, control: "ctl_3")
    // another reset time, another kind
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_4", edit: ProofEdit(subject: .some("Fable limit reached. It resets 5pm (Europe/Paris).")))
    nothing(r, keys, control: "ctl_4")
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_5", edit: ProofEdit(kind: "tool_permission"))
    nothing(r, keys, control: "ctl_5")
    // control: the real owner's tap works
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_6")
    #expect(r.wait(20) { r.resultControl() == "ctl_6" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    #expect(r.wait(10) { keys.answers == ["ESC"] }, "\(keys.keys)")
  }

  @Test func aSignedTapIsUsedOnce() throws {
    let (r, keys, _, owner) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.answers == ["ESC"], "\(keys.keys)")
  }

  // MARK: a popup click

  @Test func aPopupClickOnSwitchModelFeedsTheSameKeys() throws {
    let (r, keys, _, _) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let got = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(1, label: "Switch model")) { got.set($0) }
    #expect(r.wait(30) { got.get() != nil })
    #expect(got.get() == .pressed(choice: 1, label: "Switch model"), "\(String(describing: got.get()))")
    #expect(r.wait(10) { keys.answers.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.answers == ["ESC"] + "/model".map { "CHAR:\($0)" } + ["ENTER"], "\(keys.keys)")
  }

  @Test func aPopupClickOnALabelTheCardDoesNotHavePressesNothing() throws {
    let (r, keys, _, _) = try make()
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let got = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(1, label: "Switch to usage credits")) { got.set($0) }
    #expect(r.wait(15) { got.get() != nil })
    #expect(keys.keys.isEmpty, "\(keys.keys)")
    #expect(got.get() != .pressed(choice: 1, label: "Switch to usage credits"))
  }

  // MARK: the menu goes first

  @Test func aTapForAMenuThatWentPressesNothing() throws {
    let end = TestTemp.base + "talos-ul-end-\(UUID().uuidString.prefix(8))"
    defer { unlink(end) }
    let (r, keys, _, owner) = try make(["FAKE_DLG_UL_END": end])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    FileManager.default.createFile(atPath: end, contents: Data())  // the owner pressed Esc at the Mac
    #expect(r.wait(20) { r.offer == nil }, "the offer ends with the menu")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    // a tap for an offer that is gone is not answered with a key: no result that says pressed, and nothing reaches the pane
    Thread.sleep(forTimeInterval: 4)
    #expect(r.result?["outcome"] as? String != "pressed", "\(String(describing: r.result))")
    // (the thread's own owed pointer may be typed into the idle box once the menu is gone: that is not this answer, and is never `/model`)
    #expect(!keys.keys.contains("ESC") && !keys.keys.contains("CHAR:/"), "\(keys.keys)")
  }
}
