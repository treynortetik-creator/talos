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

  /// The manager has LOOKED at the box in a tick after it typed the pointer and found our line there. Until then an emptied box reads
  /// as a screen that has not caught up, and a line never seen is held, never typed again (`unseenSince`, WorkerOwedPointer.swift). A
  /// fixed pause is not that look: a loaded machine can have the tick late. Read on the manager's own queue, between ticks.
  func lineSeenByManager(_ id: String = "trip") -> Bool {
    mgr.queue.sync {
      guard let r = mgr.rt[id] else { return false }
      return r.enterOwed && r.owed.unseenSince == nil
    }
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
      // the copy's own first look at our line (not a fixed pause: a loaded machine can have that tick late)
      #expect(r.wait(10) { r.lineSeenByManager() }, "the restored manager never looked at the line: \(r.why("trip"))")
      #expect(r.screen().contains(PointerTyper.text))
    } else {
      // the manager's own look at our line, in a tick after the typing: only after it is an empty box "gone" (not a screen still catching up)
      #expect(r.wait(10) { r.lineSeenByManager() }, "the manager never looked at the line: \(r.why("trip"))")
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

  /// The app goes between the Enter and the end of that tick: the Enter went out, so the file must already say nothing is owed. It used
  /// to be written at the tick's end, and the relaunch read an empty box as "the owner cleared it" and typed the line a second time.
  /// The tick is held where it stands (the shim's `afterEnter`), the file is copied as it is then, and that copy is what the next
  /// copy of the app finds.
  @Test func anAppGoneRightAfterTheEnterDoesNotTypeTheLineAgain() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("capture-pane", "afterEnter")
    try r.wake("trip")
    #expect(r.wait(20) { FileManager.default.fileExists(atPath: r.faultDir + "/blocked") }, "the Enter never went: \(r.why("trip"))")
    #expect(r.wait(5) { r.typedLines.count == 1 }, "\(r.typedLines)")
    let atTheMoment = FileManager.default.contents(atPath: r.talosHome + "/workers.json")
    #expect(r.owed().until == nil && r.owed().enter == nil, "the Enter went out and the file still owes the pointer: \(r.owed())")
    r.clearFault("capture-pane")  // the held tick ends, and the first copy goes
    r.appGone("crash")
    try #require(atTheMoment).write(to: URL(fileURLWithPath: r.talosHome + "/workers.json"))
    _ = r.comeBack(tmux: shim)
    r.ticksPass(5)
    #expect(r.typedLines.count == 1, "the line was typed again after the relaunch: \(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "\(r.emptyEnters)")
  }

  /// The other crash point: the line is typed and the Enter has not gone. The relaunch finds our line in the box, and it is
  /// entered, once.
  @Test func anAppGoneBetweenTheTextAndTheEnterEntersTheLineOnce() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    r.firstCopy("crash", tmux: shim).startTicking()
    try r.fault("Enter", "hold")
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") && r.screen().contains(PointerTyper.text) }, "\(r.why("trip"))")
    #expect(r.wait(5) { r.owed().enter == true })
    r.appGone("crash")
    r.clearFault("Enter")
    _ = r.comeBack(tmux: shim)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the line never went in: \(r.typedLines) \(r.screen())")
    r.ticksPass(5)
    #expect(r.typedLines == [line], "\(r.typedLines)")
    #expect(r.emptyEnters.isEmpty, "\(r.emptyEnters)")
    #expect(r.screen().components(separatedBy: "Talos:").count - 1 == 0, "the line is still in the box: \(r.screen())")
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

  /// A line that never reached the screen at all (Claude dropped the keys, or a menu kept the focus with an empty box drawn under it):
  /// `screenLag` after the typing it is held as never seen, NEVER typed a second time on top and never followed by an Enter, and the
  /// thread is told once, in its own words (the Linux typer's Fable R5-1). Once the box shows the line after all, its Enter goes.
  @Test func aLineThatNeverReachedTheScreenIsHeldNeverTypedAgainAndSaid() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let letIn = r.root + "/let-in"
    r.env["FAKE_RV_SWALLOW_UNTIL"] = letIn
    let m = r.firstCopy("quit")
    let log = NoticeLog()
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 1 }
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    #expect(r.wait(WorkerManager.screenLag + 10) { m.needsYou()["trip"] == WorkerNotice.unseenKind }, "\(m.needsYou()) \(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == WorkerNotice.unseenLine())
    usleep(3_000_000)  // more ticks, held
    #expect(r.typedLines.isEmpty && r.boxIsEmpty, "\(r.typedLines)\n\(r.screen())")
    #expect(r.emptyEnters.isEmpty, "an Enter went into an empty box: \(r.emptyEnters)")
    #expect(log.all.count == 1, "said once: \(log.all)")
    // the fake now lets keys in: nothing more is typed, so the box stays empty and the message stays with main
    FileManager.default.createFile(atPath: letIn, contents: nil)
    usleep(3_000_000)
    #expect(r.typedLines.isEmpty && r.boxIsEmpty, "typed a second time: \(r.typedLines)\n\(r.screen())")
  }

  /// An Enter that went and left our line in the box (`EnterDetection`): the pane read right after and `laterDelay` on still shows the
  /// line, so the Enter may have gone somewhere else (a select that opened as it went). Flagged in the audit by classes alone, the thread
  /// told once in the agreed words, the pointer held as Needs you, and NEVER a second Enter; at its claim deadline it is dropped with no
  /// second line. The shim reports the Enter as sent and lets nothing reach the pane.
  @Test func anEnterThatLeavesOurLineInTheBoxIsFlaggedHeldAndNeverSentAgain() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    let c = OwedClock()
    let m = r.manager(tmux: shim, readyTimeout: WorkerRig.owedReadyTimeout, now: { c.now })
    let audit = r.root + "/audit.log"
    m.tune { $0.auditLogPath = audit }
    let log = NoticeLog()
    r.trackNotices(log, on: m)
    try r.fault("Enter", "swallow")
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { m.needsYou()["trip"] == WorkerNotice.enterUncertainKind }, "\(m.needsYou()) \(r.why("trip"))")
    #expect(r.wait(5) { log.all.map(\.text) == [WorkerNotice.enterUncertainLine()] }, "\(log.all)")
    #expect(r.swallowed("Enter") == 1)
    let flagged = r.lines(audit).filter { $0.contains(EnterDetection.auditEvent) }
    #expect(flagged.count == 1 && flagged[0].hasSuffix("thread=trip pre=box_ours after=box_ours later=box_ours latest=box_ours why=line_still_in_box"), "\(flagged)")
    usleep(2_500_000)  // more ticks: held, never entered again, said once
    #expect(r.swallowed("Enter") == 1, "a second Enter: \(r.swallowed("Enter"))")
    #expect(log.all.count == 1 && r.typedLines.isEmpty, "\(log.all) \(r.typedLines)")
    #expect(r.owed().until != nil, "still owed while held: \(r.owed())")
    c.jump(PointerTyper.claimDeadlineCold + 30)
    #expect(r.wait(10) { r.owed().until == nil }, "not dropped at the deadline: \(r.owed())")
    // settled as a late pointer is: no client attached, so our own line is taken out of the box
    #expect(r.wait(10) { r.boxIsEmpty }, "our line left in the box: \(r.screen())")
    usleep(1_500_000)
    #expect(log.all.count == 1 && r.swallowed("Enter") == 1, "\(log.all) \(r.swallowed("Enter"))")
    #expect(m.needsYou()["trip"] == nil, "\(m.needsYou())")
  }

  /// One flagged Enter never holds the messages after it: a new wake is a fresh pointer, typed and entered as any is (Fable R2-1).
  @Test func aNewMessageAfterAFlaggedEnterIsAFreshPointer() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    let m = r.manager(tmux: shim, readyTimeout: WorkerRig.owedReadyTimeout)
    try r.fault("Enter", "swallow")
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { m.needsYou()["trip"] == WorkerNotice.enterUncertainKind }, "\(m.needsYou()) \(r.why("trip"))")
    r.clearFault("Enter")
    r.ownerClears()  // the old line out of the box (as Claude would have it after a real Enter)
    try r.wake("trip", ids: ["m_01JBF3V7Q8K2M4N6P8R0S2T402"])
    #expect(r.wait(15) { r.typedLines.count == 1 }, "the new message's pointer never went in: \(r.typedLines) \(r.screen())")
    #expect(r.typedLines.first == line, "\(r.typedLines)")
    #expect(r.wait(10) { m.needsYou()["trip"] == nil && r.owed().until == nil }, "\(m.needsYou()) \(r.owed())")
    #expect(r.swallowed("Enter") == 1)
  }

  /// A flagged Enter's hold outlives the app: `enter_uncertain` is in workers.json, and the copy that comes back holds the pointer too
  /// (Needs you, never an Enter), and drops it at its deadline.
  @Test func aFlaggedEnterIsStillHeldAfterARelaunch() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    let c = OwedClock()
    let m = r.manager(tmux: shim, readyTimeout: WorkerRig.owedReadyTimeout, now: { c.now })
    try r.fault("Enter", "swallow")
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(20) { m.needsYou()["trip"] == WorkerNotice.enterUncertainKind }, "\(m.needsYou()) \(r.why("trip"))")
    #expect(r.wait(10) { r.fileOnDisk?.threads["trip"]?.enter_uncertain == true }, "not in workers.json")
    r.appGone("crash")
    let back = r.comeBack(clock: c, tmux: shim)
    #expect(r.wait(10) { back.needsYou()["trip"] == WorkerNotice.enterUncertainKind }, "\(back.needsYou())")
    usleep(2_500_000)
    #expect(r.swallowed("Enter") == 1, "entered again after the relaunch: \(r.swallowed("Enter"))")
    c.jump(PointerTyper.claimDeadlineCold + 30)
    #expect(r.wait(10) { r.owed().until == nil }, "not dropped at the deadline: \(r.owed())")
    #expect(r.swallowed("Enter") == 1)
  }

  /// The Enter check flags the Enter on the queue, between ticks: the flag is in `workers.json` at once, not at the next tick's end. No
  /// timer here (only the ticks this test drives), so nothing else can write the file after the flag; an app gone at that point must
  /// find the hold, or the notice and the cleanup at the deadline are lost.
  @Test func aFlaggedEnterIsInTheFileAtOnceNotAtTheNextTick() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    let shim = try r.faultShim()
    let c = OwedClock()
    let m = r.manager(tmux: shim, readyTimeout: WorkerRig.owedReadyTimeout, now: { c.now })
    m.tune { $0.auditLogPath = r.root + "/audit.log" }
    try r.fault("Enter", "swallow")
    try r.wake("trip")
    #expect(r.wait(30) { m.tickOnce(); return r.swallowed("Enter") == 1 }, "the Enter never went: \(r.why("trip"))")
    #expect(r.wait(10) { r.fileOnDisk?.threads["trip"]?.enter_uncertain == true }, "flagged in memory only, no tick has written it: \(r.owed())")
    r.appGone("crash")
    let back = r.comeBack(clock: c, tmux: shim)
    #expect(r.wait(10) { back.needsYou()["trip"] == WorkerNotice.enterUncertainKind }, "\(back.needsYou())")
    c.jump(PointerTyper.claimDeadlineCold + 30)
    #expect(r.wait(10) { r.owed().until == nil }, "not dropped at the deadline: \(r.owed())")
    #expect(r.swallowed("Enter") == 1, "entered again: \(r.swallowed("Enter"))")
  }

  /// The same, with the hold's wait longer than the claim deadline: at the deadline the hub has given the message to main, so the pointer
  /// is dropped then (nothing owed any more, Needs you over) and the thread is told at that moment, once; nothing is typed, ever.
  @Test func aNeverSeenLineIsDroppedAtItsDeadlineAndSaidThen() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_SWALLOW_UNTIL"] = r.root + "/never"
    let c = OwedClock()
    let m = r.manager(readyTimeout: WorkerRig.owedReadyTimeout, now: { c.now })
    let log = NoticeLog()
    r.trackNotices(log, on: m)
    m.tune { $0.draftNoticeAfter = 600 }
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    usleep(UInt32((WorkerManager.screenLag + 2) * 1_000_000))  // typed, never seen, held
    #expect(r.owed().until != nil && log.all.isEmpty, "\(r.owed()) \(log.all)")
    c.jump(PointerTyper.claimDeadlineCold + 30)
    #expect(r.wait(10) { r.owed().until == nil }, "not dropped at the deadline: \(r.owed())")
    #expect(r.wait(5) { log.all.map(\.text) == [WorkerNotice.unseenLine()] }, "\(log.all)")
    usleep(2_000_000)
    #expect(log.all.count == 1 && r.typedLines.isEmpty && r.emptyEnters.isEmpty, "\(log.all) \(r.typedLines)")
    #expect(m.needsYou()["trip"] == nil, "\(m.needsYou())")
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

  /// The screen draws our text later than `screenLag` (the keys were only buffered): it is held as never seen meanwhile and never typed
  /// again, so one copy lands; once the box shows exactly our line, its Enter goes, once.
  @Test func aLineTheScreenDrawsAfterTheLagIsTypedOnceAndSentOnce() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    r.echoBox()
    r.env["FAKE_RV_DRAW_LAG"] = "7.5"
    r.firstCopy("quit").startTicking()
    try r.wake("trip")
    func copies() -> Int { r.screen().components(separatedBy: "Talos:").count - 1 }
    #expect(r.wait(25) { r.typedLines.count == 1 }, "\(copies()) copies on the screen:\n\(r.screen())")
    #expect(r.typedLines == [line], "typed a second time on top: \(r.typedLines)")
    usleep(3_000_000)
    #expect(r.typedLines == [line] && r.emptyEnters.isEmpty, "\(r.typedLines) \(r.emptyEnters)")
  }
}
