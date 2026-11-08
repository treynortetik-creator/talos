import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// An owed Enter is sent only onto our own line (docs/OPTION-C.md): the box holds exactly the pointer line, at normal intensity, on a
/// capture taken right before the send. An empty box means the text is gone, and the whole line is typed again; a lone Enter into an
/// empty box would be dropped by Claude, the pointer would be marked done, and the message would silently go to main. The fake
/// `claude` logs such an Enter (`FAKE_RV_EMPTY_ENTER_LOG`), so each test can say that none was sent. Real private tmux; never `-L talos`.
private let scenario = "review-worker.sh"
private let notes = " and my own notes"

extension WorkerRig {
  /// The owner clearing the whole box in one redraw (Ctrl-U), so no half-cleared frame is ever on the screen.
  func ownerClears() { #expect(tmuxCmd(["send-keys", "-t", "=t-trip:", "C-u"]).ok) }

  /// The Enters the fake got with nothing in its box.
  var emptyEnters: [String] { lines(root + "/empty-enter.log") }

  /// The fake with its box echo on, and the log of Enters into an empty box.
  func echoBox() {
    env["FAKE_RV_ECHO_BOX"] = "1"
    env["FAKE_RV_EMPTY_ENTER_LOG"] = root + "/empty-enter.log"
  }

  /// The box is on the screen and holds nothing.
  var boxIsEmpty: Bool {
    let s = screen()
    return s.contains("\u{276F}") && !s.contains("Talos:") && !s.contains("notes")
  }
}

@Suite("An owed Enter goes only onto our own line", .serialized, .enabled(if: Rig.hasTmux))
struct PointerOwedEnterTests {
  private let line = "trip \(PointerTyper.text)"

  /// The CI failure (PointerOwedTests, the owner adds to our line and clears it): after a relaunch the box holds our line and the
  /// owner's notes, the owner clears it, and one redraw in the middle shows no box at all. That tick ends the draft hold; the empty
  /// box that follows used to get a lone Enter.
  @Test func aBlankFrameWhileTheOwnerClearsTheBoxDoesNotLoseTheMessage() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_BLANK_BSPACE"] = "1.2"
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    r.ownerTypes(notes)
    let m = r.comeBack()
    m.tune { $0.draftNoticeAfter = 0.5 }
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.draftKind }, "\(m.needsYou())")
    r.ownerBackspaces(PointerTyper.text.count + notes.count)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.screen())")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "an Enter went into an empty box: \(r.emptyEnters)")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
  }

  /// Door 1, in one session: a draft hold is running (`draftSince`), a no-box tick ends it, then the box is empty. The line is typed
  /// again; the Enter that was held by tmux is not let through onto nothing.
  @Test func aDraftHoldEndedByANoBoxTickStillRetypesTheLine() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_BLANK_BSPACE"] = "1.2"
    let shim = try r.faultShim()
    let m = r.firstCopy("quit", tmux: shim)
    m.tune { $0.draftNoticeAfter = 0.5 }
    m.startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    r.ownerTypes(notes)
    #expect(r.wait(10) { m.needsYou()["trip"] == WorkerNotice.draftKind }, "\(m.needsYou())")
    r.ownerBackspaces(PointerTyper.text.count + notes.count)
    usleep(2_000_000)  // the blank frame (1.2 s: several ticks), and then the box, cleared
    r.clearFault("Enter")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.screen())")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "an Enter went into an empty box: \(r.emptyEnters)")
  }

  /// Door 2: no draft hold was ever running, and (for a restored pointer) the first look at the box is long past. The text is gone
  /// all the same, and the Enter is not sent onto an empty box.
  @Test(arguments: ["session", "restored"])
  func aLineThatIsGoneFromTheBoxIsTypedAgainNotEntered(how: String) throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    if how == "restored" {
      r.appGone("crash")
      _ = r.comeBack(tmux: shim)  // the Enter is still held: it looks at our line, and that is the first look
      usleep(1_000_000)
      #expect(r.screen().contains(PointerTyper.text))
    } else {
      usleep(600_000)
    }
    r.ownerClears()
    usleep(1_000_000)  // several ticks with the box empty (or, once the fix is in, our line typed again)
    r.clearFault("Enter")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.screen())")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "an Enter went into an empty box: \(r.emptyEnters)")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
  }

  /// The same-tick catch: the screen draws the text we just typed late. An empty box right after our own typing is a screen that has
  /// not caught up, not a line that is gone: it is never typed twice (that would read as the owner's draft and be held for good).
  @Test func aLineTheScreenDrawsLateIsNotTypedTwice() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_DRAW_LAG"] = "1.5"
    r.firstCopy("quit").startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    usleep(2_500_000)
    #expect(r.typedLines == [line], "typed again, or held on a double line: \(r.typedLines)\n\(r.screen())")
    #expect(r.emptyEnters.isEmpty, "an Enter went into an empty box: \(r.emptyEnters)")
  }

  /// A line that never reached the screen at all (Claude dropped the keys): after a few seconds the box is read as empty, the line
  /// is typed again and sent; the Enter is never sent onto the empty box before that.
  @Test func aLineThatNeverReachedTheScreenIsTypedAgain() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let letIn = r.root + "/let-in"
    r.env["FAKE_RV_SWALLOW_UNTIL"] = letIn
    r.firstCopy("quit").startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    usleep(1_200_000)  // typed, and dropped
    #expect(r.typedLines.isEmpty && r.boxIsEmpty, "\(r.typedLines)\n\(r.screen())")
    #expect(r.emptyEnters.isEmpty)
    FileManager.default.createFile(atPath: letIn, contents: nil)
    #expect(r.wait(15) { r.typedLines.count == 1 }, "the dropped line was never typed again: \(r.typedLines) \(r.why("trip"))")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    usleep(800_000)
    #expect(r.typedLines.count == 1, "\(r.typedLines)")
  }

  /// The colour read decides whether the text in the box is real or a dim suggestion, so it is read once, with the text, right before
  /// the Enter, and a read that fails or finds no box does not count as text. The box here holds only a dim copy of our line: with the
  /// colour read failing, nothing is sent (an Enter would go onto an empty box); once it works the line is typed in full.
  @Test func aDimCopyOfOurLineWithAFailedColourReadGetsNoEnter() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_DIM_TEXT"] = PointerTyper.text
    let shim = try r.faultShim()
    try r.fault("-e", "hold")
    r.firstCopy("quit", tmux: shim).startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    usleep(1_500_000)  // several ticks with only the plain read working
    #expect(r.emptyEnters.isEmpty, "an Enter went onto a box that only showed a dim copy: \(r.emptyEnters)")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    r.clearFault("-e")
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line was never typed in full: \(r.typedLines) \(r.screen())")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "\(r.emptyEnters)")
  }

  /// The screen draws our text later than `screenLag` and the keys were only buffered, not dropped: the line is retyped ONCE (the
  /// cap cannot tell the two apart), both copies land, the box reads as the owner's draft and holds it, and it never repeats.
  @Test func aLineTheScreenDrawsAfterTheCapIsRetypedAtMostOnce() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_DRAW_LAG"] = "7.5"
    r.firstCopy("quit").startTicking()
    try r.wake("trip")
    func copies() -> Int { r.screen().components(separatedBy: "Talos:").count - 1 }
    #expect(r.wait(20) { copies() == 2 }, "\(copies()) copies on the screen:\n\(r.screen())")
    usleep(7_000_000)  // more than one more cap
    #expect(copies() == 2, "typed again after the one retype: \(copies()) copies\n\(r.screen())")
    #expect(r.typedLines.isEmpty && r.emptyEnters.isEmpty, "\(r.typedLines) \(r.emptyEnters)")
  }
}
