import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Needs-you prompts, the Mac popup: the click. `WorkerManager.popupAnswer` is what the popup's button calls; it is the same press path as
/// a verified card answer (arrows, then Enter from the fresh cursor row, the typing guard failing closed, the once-per-dialog rule shared),
/// and it writes `dialog-result.json` as `source: 'mac'` before the dialog can leave workers.json. Real private tmux server and the REAL
/// Claude Code 2.1.319 dialogs drawn by `dialog-real.sh`, as NeedsYouTests does. No window is made here.
final class Got: @unchecked Sendable {
  private let lock = NSLock()
  private var value: PopupAnswerResult?
  /// What workers.json (on disk) and the result file looked like at the moment the answer was reported.
  private(set) var dialogOnDiskAtReport: String?
  private(set) var resultOnDiskAtReport = false
  func set(_ r: PopupAnswerResult, dialogOnDisk: String?, result: Bool) {
    lock.withLock {
      value = r
      dialogOnDiskAtReport = dialogOnDisk
      resultOnDiskAtReport = result
    }
  }
  var result: PopupAnswerResult? { lock.withLock { value } }
}

private let sanFile = "/dialog-result.json"
nonisolated(unsafe) private var lastReport: Got?

@Suite("Needs-you popup: the click", .serialized, .enabled(if: Rig.hasTmux))
struct NeedsYouPopupTests {
  private func make(
    _ dlg: String, _ extra: [String: String] = [:], ackWait: Double = 600, owner: TestOwner? = nil
  ) throws -> (WorkerRig, KeyLog, TestOwner) {
    let keys = KeyLog()
    var env = ["FAKE_DLG": dlg, "FAKE_DLG_KEYLOG": keys.path]
    env.merge(extra) { _, b in b }
    let r = try WorkerRig(scenario: "dialog-real.sh", extraEnv: env)
    r.trackNotices(NoticeLog())
    r.mgr.tune { $0.cardAckWait = ackWait }
    let o = owner ?? TestOwner()
    try r.writeDevices([o.entry()])
    return (r, keys, o)
  }

  private func offered(_ r: WorkerRig) throws -> DialogOffer {
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(15) { r.offer != nil }, "no dialog offered: \(r.why("trip"))")
    let o = try #require(r.offer)
    #expect(r.wait(5) { r.mgr.popupOffers().contains { $0.dialog.id == o.id } }, "the popup was not offered: \(r.mgr.popupOffers())")
    return o
  }

  /// The popup's button: what it asks, and what comes back. Waits for the answer.
  @discardableResult
  private func click(_ r: WorkerRig, _ o: DialogOffer, choice: Int?, id: String? = nil, label: String? = nil, on m: WorkerManager? = nil) -> PopupAnswerResult? {
    let got = Got()
    let sem = DispatchSemaphore(value: 0)
    let mgr = m ?? r.mgr!
    let talosHome = r.talosHome
    let action: NeedsYouPopupAction = choice.map { .choose($0, label: label ?? (o.options.indices.contains($0) ? o.options[$0] : "")) } ?? .open
    mgr.popupAnswer(thread: "trip", dialogId: id ?? o.id, action: action) { res in
      // on the worker queue, right after the answer: no tick can have run since
      let onDisk = FileManager.default.contents(atPath: talosHome + "/workers.json").flatMap { WorkersFile.decode($0) }?.threads["trip"]?.dialog?.id
      got.set(res, dialogOnDisk: onDisk, result: FileManager.default.fileExists(atPath: talosHome + "/workers/trip" + sanFile))
      sem.signal()
    }
    guard sem.wait(timeout: .now() + 30) == .success else { return nil }
    lastReport = got
    return got.result
  }

  /// The pane as the owner sees it now.
  private func screen(_ r: WorkerRig) -> String { r.tmuxCmd(["capture-pane", "-p", "-t", "=t-trip:"]).out }

  private func macResult(_ r: WorkerRig) -> [String: Any]? { r.result }

  // MARK: 1. the click presses the clicked option

  @Test(arguments: [
    ("trust", 1, ["DOWN", "ENTER"], "Yes, I trust this folder"), ("mcp", 0, ["UP", "UP", "ENTER"], "Use this MCP server"),
    ("mcp", 1, ["UP", "ENTER"], "Use this and all future MCP servers in this project"),
    ("mcp", 2, ["ENTER"], "Continue without using this MCP server"),
  ])
  func aClickPressesTheClickedOptionAndTheMacSaysSo(dlg: String, choice: Int, expected: [String], label: String) throws {
    let (r, keys, _) = try make(dlg)
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, choice: choice) == .pressed(choice: choice, label: label))
    #expect(keys.keys == expected, "arrows and one Enter, nothing else (no digit): \(keys.keys)")
    let res = try #require(macResult(r))
    #expect(Set(res.keys) == ["v", "dialog_id", "source", "outcome", "choice", "label", "at"], "the contract's popup shape, no control_id: \(res)")
    #expect(res["v"] as? Int == 1 && res["source"] as? String == "mac" && res["outcome"] as? String == "pressed" && res["dialog_id"] as? String == o.id)
    #expect(res["choice"] as? Int == choice && res["label"] as? String == label, "the label the screen showed")
    #expect(ISOTime.parse(res["at"] as? String ?? "") != nil)
    var st = stat()
    #expect(stat(r.resultPath, &st) == 0 && (st.st_mode & 0o777) == 0o600 && (st.st_mode & S_IFMT) == S_IFREG)
    #expect(r.wait(15) { r.up("trip") }, "the session carries on: \(r.why("trip"))")
    #expect(r.mgr.popupOffers().isEmpty)
  }

  @Test func theResultIsOnDiskBeforeWorkersJsonDropsTheDialog() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
    let report = try #require(lastReport)
    #expect(report.resultOnDiskAtReport, "the result file was not there when the click was reported")
    #expect(report.dialogOnDiskAtReport == o.id, "workers.json already dropped the dialog: \(String(describing: report.dialogOnDiskAtReport))")
    // and it is still there when workers.json later does drop it
    #expect(r.wait(15) { r.offer == nil })
    let onDisk = FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap { WorkersFile.decode($0) }
    #expect(r.wait(5) { (FileManager.default.contents(atPath: r.talosHome + "/workers.json").flatMap { WorkersFile.decode($0) })?.threads["trip"]?.dialog == nil })
    #expect(onDisk != nil && FileManager.default.fileExists(atPath: r.resultPath))
  }

  @Test func theLabelThatIsPressedIsTheOneTheOwnerSawOnTheButton() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    // the popup says "Yes, I trust this folder" for row 1; a click that names another label for that row is not that button
    #expect(click(r, o, choice: 1, label: "No, exit") == .nothing(.screenChanged))
    #expect(keys.keys.isEmpty && macResult(r) == nil)
    // and a row that is not there
    #expect(click(r, o, choice: 5, label: "x") == .nothing(.screenChanged))
    #expect(keys.keys.isEmpty && macResult(r) == nil)
  }

  // MARK: 2. popup first, then a valid card answer

  @Test func aCardAnswerAfterAPopupClickGetsAlreadyAnsweredAndOnePressIsAllThereIs() throws {
    let (r, keys, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the offer stays up after the Enter: the late answer meets it
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
    try r.writeAnswer(o, owner: owner, choice: 0, control: "ctl_1")  // a valid, signed tap for the same dialog id
    #expect(r.wait(15) { r.resultControl() == "ctl_1" }, "no result: \(keys.keys)")
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "already_answered" && r.result?["source"] as? String == "card", "\(String(describing: r.result))")
    #expect(keys.keys == ["DOWN", "ENTER"], "one press: \(keys.keys)")
  }

  @Test func aLoginOpenedFromThePopupIsAlsoOnceAndTheCardGetsAlreadyAnswered() throws {
    let (r, keys, owner) = try make("login")
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openTerminals = { spy.opened($0); return true }
    let o = try offered(r)
    #expect(click(r, o, choice: nil) == .opened)
    try r.writeAnswer(o, owner: owner, choice: nil, control: "ctl_1", open: true)
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "already_answered", "\(String(describing: r.result))")
    #expect(spy.all == ["trip"], "Terminals was brought forward once")
  }

  // MARK: 3. card answer first, then a popup click

  @Test func aPopupClickAfterACardAnswerPressesNothingWritesNothingAndSaysWhoWon() throws {
    let (r, keys, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" } && r.result?["outcome"] as? String == "pressed")
    let before = try #require(FileManager.default.contents(atPath: r.resultPath))
    // the bridge's card file says the phone won
    let card: [String: Any] = ["v": 1, "dialog_id": o.id, "card_id": "c_01JBF3V7Q8K2M4N6P8R0S2T403", "thread_id": "trip", "status": "answered", "by": "Ada's iPhone", "label": "Yes, I trust this folder", "at": ISOTime.string(Date().timeIntervalSince1970)]
    try JSONSerialization.data(withJSONObject: card).write(to: URL(fileURLWithPath: r.talosHome + "/workers/trip/dialog-card.json"))
    #expect(click(r, o, choice: 0) == .nothing(.alreadyAnswered(by: "Ada's iPhone")))
    #expect(keys.keys == ["DOWN", "ENTER"], "no second press: \(keys.keys)")
    #expect(FileManager.default.contents(atPath: r.resultPath) == before, "no second result")
    #expect(r.mgr.popupOffers().isEmpty, "the popup is closed once a card answer was taken")
  }

  @Test func withNoCardFileTheLoserIsToldItWasAnotherDevice() throws {
    let (r, keys, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_1")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(click(r, o, choice: 0) == .nothing(.alreadyAnswered(by: nil)))
  }

  // MARK: 4. the screen changed between show and click

  @Test(arguments: ["trust-changed", "mcp", "trust-other"])
  func aScreenThatChangedBeforeTheClickGetsNoKeyAndNoResult(to: String) throws {
    let swap = NSTemporaryDirectory() + "swap-\(UUID().uuidString.prefix(6))"
    let (r, keys, _) = try make("trust", ["FAKE_DLG_SWAP": swap, "FAKE_DLG_SWAP_TO": to])
    defer { r.teardown(); keys.remove(); unlink(swap) }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }  // the offer is not refreshed by the new screen: the click meets it
    let before = screen(r)
    FileManager.default.createFile(atPath: swap, contents: nil)
    #expect(r.wait(15) { screen(r) != before }, "the fake never changed its screen")
    #expect(click(r, o, choice: 1) == .nothing(.screenChanged))
    #expect(keys.keys.isEmpty, "a key was sent: \(keys.keys)")
    #expect(!FileManager.default.fileExists(atPath: r.resultPath), "the schema has no mac nothing_pressed: no file at all")
  }

  @Test func aClickForAnOlderSightingOfTheDialogIsNotOffered() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, choice: 1, id: "Aq5Lm8ZtRx3Cv9PkNa2HdB") == .nothing(.notOffered))
    #expect(keys.keys.isEmpty && !FileManager.default.fileExists(atPath: r.resultPath))
  }

  @Test func aThreadThatIsNotOneOfOursPressesNothing() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let sem = DispatchSemaphore(value: 0)
    let got = Got()
    r.mgr.popupAnswer(thread: "../../etc", dialogId: o.id, action: .choose(1, label: o.options[1])) { got.set($0, dialogOnDisk: nil, result: false); sem.signal() }
    #expect(sem.wait(timeout: .now() + 10) == .success && got.result == .nothing(.notOffered))
    #expect(keys.keys.isEmpty)
  }

  /// The owner's own Down in the pane: the cursor is somewhere else than the offer said. The row of the clicked label is found from the fresh
  /// cursor and only that label is entered, so the owner gets what the button said.
  @Test func aCursorMovedByTheOwnerStillGetsTheLabelClickedAndNothingElse() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    let before = screen(r)
    #expect(r.tmuxCmd(["send-keys", "-t", "=t-trip:", "Down"]).ok)
    #expect(r.wait(5) { keys.keys == ["DOWN"] })
    #expect(r.wait(10) { screen(r) != before }, "the cursor row never moved on the screen")
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
    #expect(keys.keys == ["DOWN", "ENTER"], "the cursor was already on the row: just the Enter")
  }

  @Test func theDialogGoingAwayBeforeTheClickIsNothingToPress() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.ownerPressesEnter("trip")  // "No, exit" ... the session ends or moves on: the owner answered in the pane
    #expect(r.wait(15) { r.offer == nil })
    #expect(click(r, o, choice: 1) == .nothing(.notOffered))
    #expect(keys.presses == ["ENTER"], "only the owner's own Enter: \(keys.keys)")
    #expect(!FileManager.default.fileExists(atPath: r.resultPath))
  }

  // MARK: 5. a record read back from workers.json

  @Test func aRecordReadBackFromDiskShowsNoPopupAndAClickOnItPressesNothing() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    usleep(900_000)
    r.mgr.detach()
    // planted while the app is down: no subject
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
    let again = r.makeManager()
    r.trackNotices(NoticeLog(), on: again)
    again.tune {
      $0.cardAckWait = 600
      $0.dialogSettle = 60  // this process has not yet seen the screen hold still
    }
    r.firstTick(again)
    again.startTicking()
    #expect(r.wait(5) { r.offer?.id == o.id && r.offer?.subject == nil }, "control: the planted record was adopted")
    #expect(again.popupOffers().isEmpty, "a record only read from disk is not offered to the owner")
    usleep(1_500_000)
    #expect(again.popupOffers().isEmpty)
    var forged = o
    forged.subject = nil
    #expect(click(r, forged, choice: 1, on: again) == .nothing(.notOffered))
    #expect(keys.keys.isEmpty && !FileManager.default.fileExists(atPath: r.resultPath), "pressed on a record only read from disk: \(keys.keys)")
    // once this process has seen the dialog hold still it is the screen's own read, under a new id, and only then is it offered
    again.tune { $0.dialogSettle = 0.5 }
    #expect(r.wait(15) { again.popupOffers().count == 1 })
    let fresh = try #require(again.popupOffers().first?.dialog)
    #expect(fresh.id != o.id && fresh.subject == o.subject && fresh.subject != nil)
    #expect(click(r, forged, choice: 1, on: again) == .nothing(.notOffered), "the planted id is not the offered one")
    #expect(keys.keys.isEmpty)
    #expect(click(r, fresh, choice: 1, on: again) == .pressed(choice: 1, label: "Yes, I trust this folder"))
  }

  // MARK: 6. the typing guard

  @Test func whileTheOwnerIsTypingNothingIsSent() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.clientQuiet = 60 }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    let client = try r.attachClient()
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    #expect(click(r, o, choice: 1) == .nothing(.typing), "the owner was typing: its own words, not 'the screen changed'")
    #expect(keys.keys.isEmpty && !FileManager.default.fileExists(atPath: r.resultPath))
  }

  @Test func ifTheClientsCannotBeReadNothingIsPressed() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
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
    #expect(click(r, o, choice: 1) == .nothing(.couldNotCheck))
    #expect(keys.keys.isEmpty && !FileManager.default.fileExists(atPath: r.resultPath))
    r.mgr.tune { $0.tmux = real }  // control: with clients readable again the click goes through
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
  }

  // MARK: 7. login

  @Test func aLoginClickBringsTerminalsForwardTypesNothingAndTheResultIsOpened() throws {
    let (r, keys, _) = try make("login")
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openTerminals = { spy.opened($0); return true }
    let o = try offered(r)
    #expect(click(r, o, choice: nil) == .opened)
    #expect(spy.all == ["trip"] && keys.keys.isEmpty)
    let res = try #require(macResult(r))
    #expect(Set(res.keys) == ["v", "dialog_id", "source", "outcome", "at"] && res["outcome"] as? String == "opened" && res["source"] as? String == "mac" && res["dialog_id"] as? String == o.id)
    #expect(try #require(lastReport).resultOnDiskAtReport)
    #expect(r.mgr.popupOffers().isEmpty, "answered: the popup is closed")
  }

  @Test func whenNoWindowCanBeBroughtNothingIsOpenedAndNoResultIsWritten() throws {
    let (r, keys, _) = try make("login")
    defer { r.teardown(); keys.remove() }
    r.mgr.openTerminals = { _ in false }
    let o = try offered(r)
    #expect(click(r, o, choice: nil) == .nothing(.noWindow))
    #expect(!FileManager.default.fileExists(atPath: r.resultPath) && keys.keys.isEmpty)
    r.mgr.openTerminals = nil
    #expect(click(r, o, choice: nil) == .nothing(.noWindow))
    #expect(!FileManager.default.fileExists(atPath: r.resultPath))
  }

  @Test func aChoiceOnALoginDialogOrAnOpenOnATrustDialogPressesNothing() throws {
    let (l, lkeys, _) = try make("login")
    defer { l.teardown(); lkeys.remove() }
    let spy = OpenSpy()
    l.mgr.openTerminals = { spy.opened($0); return true }
    let lo = try offered(l)
    #expect(click(l, lo, choice: 0, label: "x") == .nothing(.notOffered))
    #expect(lkeys.keys.isEmpty && spy.all.isEmpty)
    let (t, tkeys, _) = try make("trust")
    defer { t.teardown(); tkeys.remove() }
    let tspy = OpenSpy()
    t.mgr.openTerminals = { tspy.opened($0); return true }
    let to = try offered(t)
    #expect(click(t, to, choice: nil) == .nothing(.notOffered))
    #expect(tkeys.keys.isEmpty && tspy.all.isEmpty)
  }

  // MARK: 9. what closes the popup, on the manager's side

  @Test func theOfferIsGoneFromThePopupAtItsExpiry() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.cardLifetime = 2 }
    let o = try offered(r)
    #expect(r.wait(10) { r.mgr.popupOffers().isEmpty }, "still offered past expires_at")
    #expect(r.offer?.id == o.id, "control: the dialog itself is still on the pane")
    #expect(click(r, o, choice: 1) == .nothing(.notOffered))
    #expect(keys.keys.isEmpty)
  }

  @Test func theOfferIsGoneWhenTheDialogIsAnsweredInThePaneAndANewSightingIsANewPopup() throws {
    let (r, keys, _) = try make("mcpwrap", ["FAKE_DLG_AGAIN": "1"])
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.ownerPressesEnter("trip")  // the first server is answered in the pane; a second dialog that looks the same follows
    #expect(r.wait(15) { r.mgr.popupOffers().first.map { $0.dialog.id != o.id } == true }, "\(r.mgr.popupOffers().map(\.dialog.id)) vs \(o.id)")
    #expect(click(r, o, choice: 2) == .nothing(.notOffered), "the old popup's click is for a dialog that is gone")
  }

  /// A forged answer, or a phone that is not paired, gets `unverified`: nothing was pressed and the card says "Answer on the Mac". The popup is
  /// the way to answer there, so it stays. Only something actually pressed or opened closes it.
  @Test func aResultThatPressedNothingLeavesThePopupUp() throws {
    let (r, keys, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    r.mgr.tune { $0.dialogSettle = 60 }
    // an answer for another dialog id: its result is for that id
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_0", dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB")
    #expect(r.wait(15) { r.resultControl() == "ctl_0" })
    #expect(r.mgr.popupOffers().map(\.dialog.id) == [o.id])
    // a forged answer: garbage where the proof should be
    try r.writeRaw([
      "v": 2, "dialog_id": o.id, "choice": 1, "label": "Yes, I trust this folder", "by": "Test phone", "at": ISOTime.string(Date().timeIntervalSince1970), "control_id": "ctl_1",
      "proof": ["signed": "{}", "osig": String(repeating: "A", count: 86), "device_id": "d_aaaaaaaaaaaaaaaaaaaa", "binding": "{}"],
    ])
    #expect(r.wait(15) { r.resultControl() == "ctl_1" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified")
    #expect(r.mgr.popupOffers().map(\.dialog.id) == [o.id], "a forged answer closed the popup")
    // a valid signature by a phone that is not in devices.json
    try r.writeAnswer(o, owner: TestOwner(), choice: 1, control: "ctl_2")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "unverified")
    #expect(r.mgr.popupOffers().map(\.dialog.id) == [o.id], "an unpaired phone closed the popup")
    #expect(keys.keys.isEmpty)
    // and the click still works
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
    #expect(r.mgr.popupOffers().isEmpty)
  }

  // MARK: a card answer that comes after the dialog is gone

  /// The popup pressed, the dialog left the pane, and then the phone's answer arrives. There is no offer to meet it, but the Mac knows which
  /// dialog id it pressed for: the answer gets `already_answered` instead of waiting for the bridge to give up.
  @Test(arguments: ["trust", "login"])
  func aLateCardAnswerForADialogTheMacAlreadyAnsweredGetsAlreadyAnswered(dlg: String) throws {
    let (r, keys, owner) = try make(dlg)
    defer { r.teardown(); keys.remove() }
    let spy = OpenSpy()
    r.mgr.openTerminals = { spy.opened($0); return true }
    let o = try offered(r)
    let before = screen(r)
    if dlg == "trust" {
      #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
      #expect(r.wait(15) { r.offer == nil && screen(r) != before }, "the dialog is still offered")
    } else {
      #expect(click(r, o, choice: nil) == .opened)
      r.mgr.tune { $0.dialogSettle = 0.5 }
    }
    // trust: the offer is gone, so the Mac's own record of what it pressed answers. Login: the screen still shows under the same id, so the
    // ordinary check meets it and says the same.
    try r.writeAnswer(o, owner: owner, choice: dlg == "trust" ? 0 : nil, control: "ctl_1", open: dlg == "login")
    #expect(r.wait(15) { r.resultControl() == "ctl_1" }, "the late answer was never read")
    #expect(r.result?["outcome"] as? String == "nothing_pressed" && r.result?["reason"] as? String == "already_answered" && r.result?["source"] as? String == "card", "\(String(describing: r.result))")
    #expect(r.result?["dialog_id"] as? String == o.id)
    #expect(!FileManager.default.fileExists(atPath: r.answerPath), "taken")
    #expect(keys.presses == (dlg == "trust" ? ["DOWN", "ENTER"] : []), "\(keys.keys)")
    // once per control id, with the file rules of every other result
    unlink(r.resultPath)
    try r.writeAnswer(o, owner: owner, choice: dlg == "trust" ? 0 : nil, control: "ctl_1", open: dlg == "login")
    usleep(1_500_000)
    #expect(r.result == nil, "the same control id was answered twice")
    var st = stat()
    try r.writeAnswer(o, owner: owner, choice: dlg == "trust" ? 0 : nil, control: "ctl_2", open: dlg == "login")
    #expect(r.wait(15) { r.resultControl() == "ctl_2" })
    #expect(stat(r.resultPath, &st) == 0 && (st.st_mode & 0o777) == 0o600)
  }

  @Test func aLateAnswerForAnotherDialogIsLeftAloneAndAnswerForNothingWeDidIsToo() throws {
    let (r, keys, owner) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    #expect(click(r, o, choice: 1) == .pressed(choice: 1, label: "Yes, I trust this folder"))
    #expect(r.wait(15) { r.offer == nil })
    try r.writeAnswer(o, owner: owner, choice: 1, control: "ctl_9", dialogId: "Aq5Lm8ZtRx3Cv9PkNa2HdB")
    usleep(2_000_000)
    #expect(FileManager.default.fileExists(atPath: r.answerPath), "an answer for another dialog is not ours to take")
    #expect(r.result?["control_id"] as? String != "ctl_9")
  }

  @Test func aLinkedWorkerFolderIsNeitherReadNorWrittenByAClick() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    let o = try offered(r)
    let elsewhere = r.root + "/elsewhere"
    try FileManager.default.createDirectory(atPath: elsewhere, withIntermediateDirectories: true)
    let real = r.talosHome + "/workers/trip"
    try FileManager.default.moveItem(atPath: real, toPath: r.root + "/moved")
    try FileManager.default.createSymbolicLink(atPath: real, withDestinationPath: elsewhere)
    #expect(click(r, o, choice: 1) == .nothing(.notOffered))
    #expect(keys.keys.isEmpty && !FileManager.default.fileExists(atPath: elsewhere + sanFile))
  }

  @Test func nothingIsOfferedToThePopupBeforeThisProcessHasSeenTheDialogHoldStill() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    r.mgr.tune { $0.dialogSettle = 60 }
    r.mgr.startTicking()
    try r.wake("trip")
    usleep(4_000_000)
    #expect(r.mgr.popupOffers().isEmpty && r.offer == nil)
  }

  @Test func theThreadNameOnThePopupIsTheThreadsOwn() throws {
    let (r, keys, _) = try make("trust")
    defer { r.teardown(); keys.remove() }
    _ = try offered(r)
    let it = try #require(r.mgr.popupOffers().first)
    #expect(it.thread == "trip" && it.threadName == "trip")
  }
}
