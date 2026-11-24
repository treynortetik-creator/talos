import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// Pane-prompts plan rows 8 and 9 on a thread session's pane (the Mac): a tool permission (the REAL 2.1.318 `bash-permission` capture) and the agent's own
/// question (the REAL `askuser-select` capture) are offered as a card with the owner's words, and a signed tap presses ONE number key (and, for a
/// free-text answer, types the owner's signed words and presses Enter). Real private tmux server; `pane-select.sh` draws the captures, logs every key it
/// receives and takes a digit as a chosen row, as the real Select is ASSUMED to (the fixtures README says what is captured and what is not).
extension KeyLog {
  /// What the pane received that is a key of the prompt: the keys typed after it is answered (the thread's own pointer, once the prompt is gone) are `KEY`.
  var answers: [String] { keys.filter { $0 != "KEY" } }
}

@Suite("Tool permission and question cards on a thread", .serialized, .enabled(if: Rig.hasTmux))
struct PaneSelectThreadTests {
  private func make(_ pane: String, _ extra: [String: String] = [:], ackWait: Double = 600, owner: TestOwner? = nil) throws -> (WorkerRig, KeyLog, NoticeLog, TestOwner) {
    let keys = KeyLog()
    var env = ["FAKE_PANE": pane, "FAKE_DLG_KEYLOG": keys.path]
    env.merge(extra) { _, b in b }
    let r = try WorkerRig(scenario: "pane-select.sh", extraEnv: env)
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
    #expect(r.wait(20) { r.offer != nil }, "no offer: \(r.why("trip")) \(r.mgr.needsYou())")
    return try #require(r.offer)
  }

  private func result(_ r: WorkerRig, _ control: String) -> [String: Any]? {
    #expect(r.wait(20) { r.resultControl() == control }, "no result for \(control)")
    return r.result
  }

  private func nothing(_ r: WorkerRig, _ keys: KeyLog, control: String, sourceLocation: SourceLocation = #_sourceLocation) {
    #expect(r.wait(20) { r.resultControl() == control }, "no result: \(keys.keys)", sourceLocation: sourceLocation)
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))", sourceLocation: sourceLocation)
    #expect(keys.keys.isEmpty, "a key was sent: \(keys.keys)", sourceLocation: sourceLocation)
  }

  // MARK: the offer

  @Test func aToolPermissionIsACardNamingTheToolAndTheCommandWithOnlyAllowOnceAndDeny() throws {
    let (r, keys, log, _) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .toolPermission && o.free_text == nil && o.cursor == nil)
    #expect(o.subject == "Bash command \u{00B7} touch hello.txt && ls -l hello.txt")
    #expect(o.options == ["Allow once", "Deny"])
    #expect(!o.options.joined().lowercased().contains("always") && !o.options.joined().lowercased().contains("don't ask"), "a standing grant is never offered")
    #expect(r.wait(3) { WorkersFile.decode((try? Data(contentsOf: URL(fileURLWithPath: r.talosHome + "/workers.json"))) ?? Data())?.threads["trip"]?.dialog == o }, "it is in the file the bridge reads")
    // the popup lists the same two, and nothing is pressed or said by itself while the card waits
    let item = try #require(r.mgr.popupOffers().first)
    let c = NeedsYouPopupContent.make(item)
    #expect(c.title == "Allow this tool request?" && c.buttons.map(\.text) == ["Allow once", "Deny"] && c.subject == o.subject)
    usleep(1_500_000)
    #expect(keys.keys.isEmpty && log.all.isEmpty, "\(keys.keys) \(log.all)")
    #expect(r.offer?.id == o.id, "the same prompt, still there: the same card")
  }

  @Test func aQuestionIsACardWithItsRowsAndOtherForItsFreeTextRow() throws {
    let (r, keys, _, _) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.kind == .agentQuestion && o.subject == "Which color do you prefer?")
    #expect(o.options == ["Red", "Blue", "Other\u{2026}"] && o.free_text == 2, "Chat about this is not an answer and is not offered")
    // a popup has no text field: it lists every option but the free-text one
    let c = NeedsYouPopupContent.make(try #require(r.mgr.popupOffers().first))
    #expect(c.buttons.map(\.text) == ["Red", "Blue"])
    #expect(keys.keys.isEmpty)
  }

  /// L14. Old code: `offerPane` returned for the same screen whatever the offer's time, so the question's number never changed and the phone's card
  /// stayed dead; the wait below fails.
  @Test func aQuestionStillOnTheScreenWhenItsCardRunsOutIsOfferedAgainUnderANewNumberAndTheOldTapPressesNothing() throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 2 }
    let o = try offered(r)
    r.mgr.tune { $0.cardLifetime = 600 }  // o keeps its 2 s; the offer that follows it is made with 600 and cannot run out under the tap
    #expect(r.wait(25) { r.offer.map { $0.id != o.id } ?? false }, "never offered again: \(String(describing: r.offer))")
    let n = try #require(r.offer)
    #expect(n.kind == .agentQuestion && n.subject == o.subject && n.options == o.options && n.free_text == o.free_text)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_old")
    nothing(r, keys, control: "ctl_old")
    #expect(r.result?["reason"] as? String == "unverified", "refused for its number: \(String(describing: r.result))")
    #expect(r.offer?.id == n.id)
    // the new card answers
    try r.writeAnswer(n, owner: owner, choice: 0, control: "ctl_new")
    #expect(r.wait(20) { r.resultControl() == "ctl_new" })
    #expect(r.result?["outcome"] as? String == "pressed" && r.result?["dialog_id"] as? String == n.id, "\(String(describing: r.result))")
  }

  /// L14: a verified tap that pressed nothing (a client is typing) ends a question's offer too, so the next settled look makes a new id.
  @Test func aTapOfTheOwnersThatPressedNothingEndsAQuestionsOfferAndTheNextLookMakesANewOne() throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.clientQuiet = 60 }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    let client = try r.attachClient()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    nothing(r, keys, control: "ctl_1")
    client.terminate()
    client.waitUntilExit()
    r.mgr.tune { $0.dialogSettle = 1 }
    #expect(r.wait(25) { r.offer.map { $0.id != o.id } ?? false }, "no new offer: \(String(describing: r.offer))")
  }

  /// A question the owner answered at the phone is gone from the screen: its time running out afterwards offers nothing again.
  @Test func aQuestionAnsweredAtThePhoneIsNotOfferedAgainAfterItsTimeRunsOut() throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 6 }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "pressed", "\(String(describing: r.result))")
    usleep(9_000_000)
    #expect(r.offer == nil || r.offer?.id == o.id, "an answered question was offered again: \(String(describing: r.offer))")
  }

  @Test func aGarbledPromptGetsNoCardAndTheLineSaysSoWithoutATerminal() throws {
    let (r, keys, log, _) = try make("garbled", ackWait: 0)
    defer { r.teardown(); keys.remove() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { !log.all.isEmpty }, "no line: \(r.mgr.needsYou())")
    #expect(r.offer == nil && r.mgr.popupOffers().isEmpty)
    let text = try #require(log.all.first?.text)
    #expect(text.contains("could not put it on a card") && !text.localizedCaseInsensitiveContains("terminal"), "\(text)")
    usleep(800_000)
    #expect(r.offer == nil && keys.keys.isEmpty)
  }

  /// The question with several tabs is not carded: the line says to answer at the Mac. (The decision this round: a multi-question form is NOT answered
  /// question by question; it is said, once, that it is answered at the Mac.)
  @Test func aQuestionWithSeveralTabsGetsALineSayingAnswerAtTheMac() throws {
    let (r, keys, log, _) = try make("multi", ackWait: 0)
    defer { r.teardown(); keys.remove() }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { !log.all.isEmpty }, "no line: \(r.mgr.needsYou())")
    #expect(r.offer == nil)
    #expect(log.all.first?.text == "This thread's session is asking several questions at once, which Talos cannot put on a card. Answer them at the Mac.")
    #expect(keys.keys.isEmpty)
  }

  // MARK: a signed tap presses one number key

  @Test(arguments: [(0, "DIGIT:1", "Allow once"), (1, "DIGIT:4", "Deny")])
  func allowOnceAndDenyFeedTheNumberOfTheirRows(choice: Int, key: String, label: String) throws {
    let (r, keys, _, owner) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: choice, control: "ctl_1")
    let res = try #require(result(r, "ctl_1"))
    #expect(res["outcome"] as? String == "pressed" && res["label"] as? String == label && res["choice"] as? Int == choice, "\(res)")
    #expect(r.wait(10) { keys.answers == [key] }, "\(keys.keys)")
    // Allow once is the row `1. Yes`, never `2. Yes, and always allow…` or `3. … switch to auto mode`
    #expect(!keys.answers.contains("DIGIT:2") && !keys.answers.contains("DIGIT:3"))
    #expect(r.wait(10) { r.offer == nil }, "the offer goes with the prompt")
  }

  @Test(arguments: [(0, "DIGIT:1"), (1, "DIGIT:2")])
  func aQuestionsOptionPickPressesItsNumber(choice: Int, key: String) throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: choice, control: "ctl_1")
    let res = try #require(result(r, "ctl_1"))
    #expect(res["outcome"] as? String == "pressed" && res["choice"] as? Int == choice, "\(res)")
    #expect(r.wait(10) { keys.answers == [key] }, "\(keys.keys)")
  }

  @Test func otherTextIsTypedThroughTheGateAndThenEnter() throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_1", edit: ProofEdit(text: "purple"))
    let res = try #require(result(r, "ctl_1"))
    #expect(res["outcome"] as? String == "pressed" && res["choice"] as? Int == 2 && res["label"] as? String == "Other\u{2026}", "\(res)")
    #expect(r.wait(10) { keys.answers.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.answers == ["DIGIT:3"] + "purple".map { "CHAR:\($0)" } + ["TEXT:purple", "ENTER"], "\(keys.keys)")
  }

  /// R1-2 against the REAL 2.1.329 screens: its free-text row is 4, the digit only moves the cursor there, and the footer then reads `… ctrl+g to edit in VS Code …`.
  @Test func otherOnTheReal2329QuestionIsTypedAndEnteredThroughTheOtherFooter() throws {
    let (r, keys, _, owner) = try make("question329")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.options == ["Red", "Green", "Blue", "Other\u{2026}"] && o.free_text == 3, "\(o.options)")
    try r.writeAnswer(o, owner: owner, choice: 3, control: "ctl_1", edit: ProofEdit(text: "purple"))
    let res = try #require(result(r, "ctl_1"))
    #expect(res["outcome"] as? String == "pressed" && res["label"] as? String == "Other\u{2026}", "\(res) \(keys.keys)")
    #expect(r.wait(10) { keys.answers.last == "ENTER" }, "\(keys.keys)")
    #expect(keys.answers == ["DIGIT:4"] + "purple".map { "CHAR:\($0)" } + ["TEXT:purple", "ENTER"], "\(keys.keys)")
  }

  @Test func aPickOnTheReal2329QuestionAndTheToolPromptPressTheirOwnNumbers() throws {
    let (r, keys, _, owner) = try make("tool329")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(o.subject == "Bash command \u{00B7} touch probe-a.txt" && o.options == ["Allow once", "Deny"])
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(try #require(result(r, "ctl_1"))["outcome"] as? String == "pressed")
    #expect(r.wait(10) { keys.answers == ["DIGIT:3"] }, "Deny is the `3. No` row of this prompt: \(keys.keys)")
  }

  // MARK: refused

  @Test func aTextForAnOptionThatTakesNoneAndNoTextForOtherPressNothing() throws {
    let (r, keys, _, owner) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1", edit: ProofEdit(text: "sneaky"))
    nothing(r, keys, control: "ctl_1")
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_2")
    nothing(r, keys, control: "ctl_2")
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_3", edit: ProofEdit(text: "two\nlines"))
    nothing(r, keys, control: "ctl_3")
    try r.writeAnswer(o, owner: owner, choice: 2, control: "ctl_4", edit: ProofEdit(text: String(repeating: "x", count: 501)))
    nothing(r, keys, control: "ctl_4")
    #expect(r.result?["reason"] as? String == "unverified", "\(String(describing: r.result))")
  }

  @Test func anAnswerNotFromAPairedDeviceOrWithAnotherCardPressesNothing() throws {
    let (r, keys, _, owner) = try make("tool")
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
    // the card said Allow once and Deny: a card that lists the standing grant row too is not this offer's
    let grants = ["Yes", "Yes, and always allow access to /private/tmp/tcap/proj from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_3", edit: ProofEdit(options: grants))
    nothing(r, keys, control: "ctl_3")
    // another subject, another kind
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_4", edit: ProofEdit(subject: .some("Bash command \u{00B7} rm -rf build && ls -l")))
    nothing(r, keys, control: "ctl_4")
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_5", edit: ProofEdit(kind: "agent_question"))
    nothing(r, keys, control: "ctl_5")
    // control: the real owner's tap works
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_6")
    #expect(try #require(result(r, "ctl_6"))["outcome"] as? String == "pressed")
    #expect(r.wait(10) { keys.answers == ["DIGIT:1"] }, "\(keys.keys)")
  }

  @Test func aSignedTapIsUsedOnceAndAnotherForTheSameOfferPressesNothingMore() throws {
    let (r, keys, _, owner) = try make("tool", ["FAKE_PANE_STICKY": "1"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(try #require(result(r, "ctl_1"))["reason"] as? String == "unconfirmed", "the prompt stayed: the key did not take")
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(keys.answers == ["DIGIT:1"], "one key for one offer: \(keys.keys)")
  }

  // MARK: a popup click

  @Test func aPopupClickOnAllowOnceFeedsTheSameKeyAndTheFreeTextOptionHasNoClick() throws {
    let (r, keys, _, _) = try make("tool")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let got = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(0, label: "Allow once")) { got.set($0) }
    #expect(r.wait(15) { got.get() != nil })
    #expect(got.get() == .pressed(choice: 0, label: "Allow once"), "\(String(describing: got.get()))")
    #expect(r.wait(10) { keys.answers == ["DIGIT:1"] }, "\(keys.keys)")
  }

  @Test func aPopupClickOnTheFreeTextOptionPressesNothing() throws {
    let (r, keys, _, _) = try make("question")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let got = Locked<PopupAnswerResult?>(nil)
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(2, label: "Other\u{2026}")) { got.set($0) }
    #expect(r.wait(15) { got.get() != nil })
    #expect(got.get() == .nothing(.screenChanged) && keys.keys.isEmpty, "\(String(describing: got.get())) \(keys.keys)")
    // another option of the same card works
    r.mgr.popupAnswer(thread: "trip", dialogId: o.id, action: .choose(1, label: "Blue")) { got.set($0) }
    #expect(r.wait(15) { got.get() == .pressed(choice: 1, label: "Blue") }, "\(String(describing: got.get()))")
    #expect(r.wait(10) { keys.answers == ["DIGIT:2"] }, "\(keys.keys)")
  }

  // MARK: the screen changes under the offer

  /// Another prompt (another command) takes the place of the offered one. The old card's tap, signed and valid for the old sighting, presses nothing: the
  /// offer ended or was replaced, and the key gate would refuse the new screen whatever the offer said.
  @Test func aScreenChangeBetweenTheOfferAndTheAnswerPressesNothing() throws {
    let swap = TestTemp.base + "talos-pane-swap-\(UUID().uuidString.prefix(8))"
    defer { unlink(swap) }
    let (r, keys, _, owner) = try make("tool", ["FAKE_PANE_SWAP": swap])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    FileManager.default.createFile(atPath: swap, contents: Data())
    #expect(r.wait(10) { r.tmuxCmd(["capture-pane", "-p", "-J", "-t", "=t-trip:"]).out.contains("rm -rf build") }, "the other prompt is drawn")
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    nothing(r, keys, control: "ctl_1")
    // the new prompt is its own card, with its own command
    #expect(r.wait(20) { r.offer != nil && r.offer?.id != o.id }, "\(String(describing: r.offer))")
    #expect(r.offer?.subject == "Bash command \u{00B7} rm -rf build && ls -l")
  }

  // MARK: delivery that is not known

  /// A digit whose tmux call timed out may have landed: never sent again for that card, not recorded as answered, and (the screen being unchanged) the same prompt
  /// is offered again with a new id after the short memory; the old card then presses nothing, the new one does.
  @Test func aTimedOutKeyIsNotRepeatedAndTheUnchangedPromptIsOfferedAgain() throws {
    let keys = KeyLog()
    let r = try WorkerRig(scenario: "pane-select.sh", extraEnv: ["FAKE_PANE": "tool", "FAKE_DLG_KEYLOG": keys.path])
    defer { r.teardown(); keys.remove() }
    let modePath = r.root + "/digit-mode"
    try "hang".write(toFile: modePath, atomically: true, encoding: .utf8)
    let shim = r.root + "/tmux-steer-digit"
    try """
    #!/bin/bash
    digit=
    for a in "$@"; do [ "$a" = 1 ] && digit=1; done
    if [ -n "$digit" ]; then
      echo x >> '\(r.root)/digit-attempts'
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
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = 600; $0.callTimeout = 1; $0.unsentEnterMemory = 11; $0.dialogSettle = 1 }
    let owner = TestOwner()
    try r.writeDevices([owner.entry()])
    let o = try offered(r)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")
    #expect(r.wait(20) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unconfirmed", "sent, not seen to take: never reported as an answer: \(String(describing: r.result))")
    let attempts = { ((try? String(contentsOfFile: r.root + "/digit-attempts", encoding: .utf8)) ?? "").split(separator: "\n").count }
    #expect(attempts() == 1)
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_f")
    #expect(r.wait(15) { r.resultControl() == "ctl_f" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
    #expect(attempts() == 1, "no second key inside the memory: \(attempts())")
    #expect(r.offer?.id == o.id, "inside the memory it is not offered again")
    #expect(r.wait(40) { r.offer != nil && r.offer?.id != o.id }, "offered again with a new card: \(String(describing: r.offer))")
    #expect(keys.keys.isEmpty, "the key never reached the prompt: \(keys.keys)")
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_2")
    nothingResult(r, "ctl_2")
    try "pass".write(toFile: modePath, atomically: true, encoding: .utf8)
    let again = try #require(r.offer)
    try r.writeAnswer(again, owner: owner, choice: 1, control: "ctl_3")
    #expect(r.wait(20) { r.resultControl() == "ctl_3" })
    #expect(r.result?["outcome"] as? String == "pressed")
    #expect(r.wait(10) { keys.answers == ["DIGIT:4"] }, "\(keys.keys)")
  }

  private func nothingResult(_ r: WorkerRig, _ control: String) {
    #expect(r.wait(15) { r.resultControl() == control })
    #expect(r.result?["outcome"] as? String == "nothing_pressed", "\(String(describing: r.result))")
  }
}
