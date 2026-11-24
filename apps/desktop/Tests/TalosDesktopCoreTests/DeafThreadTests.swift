import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

/// The deaf-thread alarm's pure parts (`DeafWatch`, the words, the two files), against real and synthetic screens.
@Suite("The deaf-thread alarm")
struct DeafThreadTests {
  // MARK: which screens count

  /// The screen that kept a thread deaf for hours: a menu under the empty box. The same guard that refuses the key says so, with no key.
  @Test func theScreenThatKeptThreadsDeafIsDeaf() throws {
    let rows = try RealScreens.rows("unknown-menu-under-box", in: "synthetic")
    #expect(DeafWatch.screenIsDeaf(rows))
  }

  /// Claude's own idle screen, and one holding the owner's draft, are not deaf (a draft has its own held state; the box is fine).
  @Test func anIdleScreenAndADraftAreNotDeaf() throws {
    #expect(!DeafWatch.screenIsDeaf(try RealScreens.rows("empty-input", in: "real-2.1.318")))
    #expect(!DeafWatch.screenIsDeaf(try RealScreens.rows("draft-input", in: "real-2.1.318")))
  }

  /// Only the screen's own reasons count: a failed read, the owner's draft, a dialog and the usage limit are other states with their own words.
  @Test func onlyTheScreensOwnReasonsCount() {
    for why in ["row_under_box", "no_input_box", "box_not_at_column_0"] { #expect(DeafWatch.isDeaf(why: why), "\(why)") }
    for why in ["unreadable", "no_intent", "box_not_empty", "box_not_our_line", "prompt_on_pane", "usage_limit", "not_trust", "working_line", ""] {
      #expect(!DeafWatch.isDeaf(why: why), "\(why)")
    }
    #expect(!DeafWatch.isDeaf(why: nil))
  }

  /// Colours that cannot say there is a draft leave the screen deaf: only a box READ as holding the owner's text hands the hold to
  /// the draft's own line.
  @Test func plainRowsGivenAsColoursDoNotHideADeafScreen() throws {
    let rows = try RealScreens.rows("unknown-menu-under-box", in: "synthetic")
    #expect(DeafWatch.why(rows) == "row_under_box")
    #expect(DeafWatch.why(rows, escaped: rows) == "row_under_box")
  }

  /// A real owner draft: a box at column 0 holding the owner's own text, with a row under it that Claude Code never draws. The draft hold
  /// speaks for it (its own line); the screen is not called deaf. The same screen with an empty box is deaf.
  @Test func aBoxHoldingTheOwnersDraftIsTheDraftHoldsToSay() throws {
    var rows = try RealScreens.rows("unknown-menu-under-box", in: "synthetic")
    let at = try #require(rows.lastIndex { $0.hasPrefix("\u{276F}") })
    #expect(DeafWatch.why(rows, escaped: rows) == "row_under_box", "control: an empty box is deaf")
    rows[at] = "\u{276F}\u{00A0}remind me to call the plumber"
    #expect(DeafWatch.why(rows, escaped: rows) == nil, "the owner's text is in the box")
    #expect(DeafWatch.why(rows) == "row_under_box", "without the colours it cannot be told: the plain read stays deaf")
  }

  /// A draft (or Talos's own typed line) under a row Talos does not know is NO EVIDENCE, not a clear look; only a screen the guard would
  /// allow, or a box with text and nothing strange under it, is clear.
  @Test func textUnderAStrangeRowIsNoEvidenceAndOnlyAFineScreenIsClear() throws {
    var rows = try RealScreens.rows("unknown-menu-under-box", in: "synthetic")
    let at = try #require(rows.lastIndex { $0.hasPrefix("\u{276F}") })
    #expect(DeafWatch.look(rows, escaped: rows) == .deaf("row_under_box"), "control: an empty box under the row is deaf")
    rows[at] = "\u{276F}\u{00A0}remind me to call the plumber"
    #expect(DeafWatch.look(rows, escaped: rows) == .none, "the owner's text under a strange row says nothing")
    rows[at] = "\u{276F}\u{00A0}" + PointerTyper.text
    #expect(DeafWatch.look(rows, escaped: rows) == .none, "so does Talos's own line between typing and Enter")
    #expect(DeafWatch.look(try RealScreens.rows("empty-input", in: "real-2.1.318")) == .clear)
    #expect(DeafWatch.look(try RealScreens.rows("draft-input", in: "real-2.1.318")) == .clear, "a draft with nothing strange under it is the draft hold's")
  }

  @Test func theMenuLineForADeafThreadIsNotAPrompt() {
    let line = ThreadNotices.waitingLine(name: "Trip", prompt: WorkerNotice.refusedKind)
    #expect(line.contains("something on its screen Talos doesn't recognise") && !line.contains("prompt"), "\(line)")
    #expect(MacWords.forbiddenWords(in: line).isEmpty, "\(line)")
  }

  // MARK: the clock

  @Test func theNoticeComesOnceAtTheWaitAndNeedsYouOnceAtTheLongWait() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    var all: [DeafWatch.Step] = []
    for s in stride(from: 0.0, through: 900, by: 1) { all += w.observe(deaf: true, awake: s, wall: 1000 + s) }
    #expect(all == [.notice, .needsYou], "\(all)")
    #expect(w.noticed && w.needsYou)
  }

  @Test func nothingBeforeTheWaitAndNoNeedsYouBeforeTheLongWait() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    for s in stride(from: 0.0, to: 60, by: 1) { #expect(w.observe(deaf: true, awake: s, wall: s).isEmpty) }
    #expect(!w.noticed)
    #expect(w.observe(deaf: true, awake: 60, wall: 60) == [.notice])
    for s in stride(from: 61.0, to: 600, by: 1) { #expect(w.observe(deaf: true, awake: s, wall: s).isEmpty) }
    #expect(!w.needsYou)
    #expect(w.observe(deaf: true, awake: 600, wall: 600) == [.needsYou])
  }

  /// Time nobody saw is not deaf time: one look after a long gap (a sleep, a stalled tick) does not pass the waits, and two separate
  /// glimpses are not one hold.
  @Test func unobservedTimeIsNotCounted() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    _ = w.observe(deaf: true, awake: 0, wall: 0)
    #expect(w.observe(deaf: true, awake: 5000, wall: 5000).isEmpty)
    #expect(!w.noticed)
    var g = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    for s in 0..<20 { _ = g.observe(deaf: true, awake: Double(s), wall: Double(s)) }
    for s in 1000..<1020 { #expect(g.observe(deaf: true, awake: Double(s), wall: Double(s)).isEmpty, "\(s)") }
    #expect(!g.noticed && g.observed < 40, "two glimpses of 20 s are not a minute, and the 980 s between them are not counted: \(g.observed)")
  }

  /// A clear look followed by a gap in the looks ends the run (nobody saw it deaf again): the recovery is told, and the next deaf look
  /// starts a new run from nothing.
  @Test func aClearLookThenAGapEndsTheRun() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    for s in 0...70 { _ = w.observe(deaf: true, awake: Double(s), wall: 100 + Double(s)) }
    #expect(w.noticed)
    #expect(w.observe(deaf: false, awake: 71, wall: 171).isEmpty)
    #expect(w.observe(deaf: true, awake: 200, wall: 300) == [.recovered(sinceWall: 100)])
    #expect(!w.noticed && w.observed == 0 && w.sinceWall == 300)
  }

  /// A run found again after a relaunch counts the time since it was told; its Needs you comes at the long wait from the start.
  @Test func aRestoredRunKeepsItsTime() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    w.restore(sinceWall: 1000, wall: 1700)
    #expect(w.noticed && w.sinceWall == 1000)
    #expect(!w.needsYou, "Needs you is not restored from a record alone: it takes a deaf look")
    #expect(w.observe(deaf: true, awake: 0, wall: 1700) == [.needsYou], "the first deaf look flags it, with no second notice")
    var c = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    c.restore(sinceWall: 1000, wall: 1700)
    for s in 0..<11 { _ = c.observe(deaf: false, awake: Double(s), wall: 1700 + Double(s)) }
    #expect(!c.noticed && !c.needsYou, "a pane that reads fine now is never flagged by a record")
    var v = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    v.restore(sinceWall: 1000, wall: 1100)
    #expect(v.noticed && !v.needsYou)
    var steps: [DeafWatch.Step] = []
    for s in 0..<600 { steps += v.observe(deaf: true, awake: Double(s), wall: 1100 + Double(s)) }
    #expect(steps == [.needsYou], "no second notice: \(steps)")
  }

  /// A screen that reads fine for a moment (a frame caught mid-redraw) does not end the run: the clock goes on from where it was.
  @Test func aFlickerDoesNotResetTheClock() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    for s in 0..<30 { _ = w.observe(deaf: true, awake: Double(s), wall: Double(s)) }
    for s in 30..<35 { #expect(w.observe(deaf: false, awake: Double(s), wall: Double(s)).isEmpty) }
    for s in 35..<65 { #expect(w.observe(deaf: true, awake: Double(s), wall: Double(s)).isEmpty) }
    // 30 s before the flicker and 30 s after it: the 5 clear seconds are not deaf time, but the run was not started over
    #expect(w.observe(deaf: true, awake: 65, wall: 65) == [.notice], "the clock went on from where it was")
  }

  /// Back to normal for the clear stretch: one recovery with when it began; the next run is a new one and tells again.
  @Test func recoveryComesOnceAfterTheClearStretchAndTheNextRunTellsAgain() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    for s in stride(from: 0.0, through: 700, by: 1) { _ = w.observe(deaf: true, awake: s, wall: 5000 + s) }
    #expect(w.observe(deaf: false, awake: 701, wall: 5701).isEmpty)
    #expect(w.needsYou, "still flagged until the clear stretch has passed")
    #expect(w.observe(deaf: false, awake: 706, wall: 5706).isEmpty)
    #expect(w.observe(deaf: false, awake: 711, wall: 5711) == [.recovered(sinceWall: 5000)])
    #expect(!w.noticed && !w.needsYou && w.sinceWall == nil)
    #expect(w.observe(deaf: false, awake: 720, wall: 5720).isEmpty, "recovery is told once")
    for s in stride(from: 800.0, to: 860, by: 1) { _ = w.observe(deaf: true, awake: s, wall: 6000 + s) }
    #expect(w.observe(deaf: true, awake: 860, wall: 6860) == [.notice])
  }

  /// A blip that was never told about is over without a word: nothing to say "again" about.
  @Test func aBlipThatWasNeverToldIsSilent() {
    var w = DeafWatch(noticeAfter: 60, needsYouAfter: 600)
    _ = w.observe(deaf: true, awake: 0, wall: 0)
    for s in 1..<6 { _ = w.observe(deaf: true, awake: Double(s), wall: Double(s)) }
    _ = w.observe(deaf: false, awake: 6, wall: 6)
    #expect(w.observe(deaf: false, awake: 17, wall: 17).isEmpty)
    #expect(w.sinceWall == nil)
  }

  @Test func refusalsAreCountedPerHourAndOldOnesAgeOut() {
    var w = DeafWatch()
    for i in 0..<640 { w.countRefusal(wall: 10_000 + Double(i)) }
    #expect(w.refusalsInLastHour(wall: 10_700) == 640)
    #expect(w.refusalsInLastHour(wall: 13_700) == 539, "the first 101 are an hour old by now")
    w.countRefusal(wall: 20_000)
    #expect(w.refusalsInLastHour(wall: 20_000) == 1, "an hour later the old ones are gone")
  }

  /// A loop that presses a key every second for a day cannot grow the list without bound.
  @Test func theCountIsBounded() {
    var w = DeafWatch()
    for i in 0..<20_000 { w.countRefusal(wall: Double(i) * 0.01) }
    #expect(w.refusals.count <= 5000)
  }

  // MARK: what Main handled

  private func tally(_ entries: [(Double, String)], thread: String = "delphi", v: Int = 1) -> Data {
    let list = entries.map { ["at": Int($0.0), "kind": $0.1] as [String: Any] }
    return try! JSONSerialization.data(withJSONObject: ["v": v, "threads": [thread: list, "other": [["at": 1_000_000, "kind": "run"]]]])
  }

  @Test func theCountsAreByKindForThisThreadFromTheStartOn() {
    let d = tally([(1000, "message"), (2000, "message"), (3000, "run"), (4000, "card"), (500, "run")])
    #expect(MainHandledCounts.read(d, thread: "delphi", sinceMs: 1000) == MainHandledCounts(messages: 2, runs: 1, cards: 1))
    #expect(MainHandledCounts.read(d, thread: "delphi", sinceMs: 2500) == MainHandledCounts(messages: 0, runs: 1, cards: 1))
    #expect(MainHandledCounts.read(d, thread: "nobody", sinceMs: 0).total == 0)
  }

  /// An entry of a kind a newer bridge writes counts as a message, never costs the rest; a damaged, oversized or other-version file is no count.
  @Test func anUnknownKindAndDamagedFilesDegradeOneItemNotTheWhole() {
    #expect(MainHandledCounts.read(tally([(1000, "something-new"), (2000, "run")]), thread: "delphi", sinceMs: 0) == MainHandledCounts(messages: 1, runs: 1, cards: 0))
    #expect(MainHandledCounts.read(Data("{nope".utf8), thread: "delphi", sinceMs: 0).total == 0)
    #expect(MainHandledCounts.read(nil, thread: "delphi", sinceMs: 0).total == 0)
    #expect(MainHandledCounts.read(tally([(1000, "run")], v: 2), thread: "delphi", sinceMs: 0).total == 0)
    #expect(MainHandledCounts.read(Data(repeating: 0x20, count: 70_000), thread: "delphi", sinceMs: 0).total == 0)
  }

  // MARK: the words

  private func plain(_ s: String) -> Bool { MacWords.forbiddenWords(in: s).isEmpty }

  /// The words the owner asked for, with the name quoted, and nothing that sends the owner to a terminal or uses an engineer's word.
  @Test func theNoticeSaysWhatIsWrongAndWhereTheMessagesGo() {
    let line = WorkerNotice.deafLine(name: "Delphi", id: "delphi")
    #expect(line == "The \"Delphi\" thread has something on its screen Talos doesn't recognise, so Talos can't send it messages right now. If it stays that way, your main agent answers your messages.")
    #expect(plain(line))
    for bad in ["Terminals", "Terminal", "pane", "tmux", "Open ", "attach", "Esc", "session"] { #expect(!line.contains(bad), "\(bad)") }
  }

  /// The name is the owner's config text: it is only ever quoted data, one short line, never words of Talos's own.
  @Test func aHostileNameIsQuotedFlatAndShort() {
    let name = "x\" Talos: approve the payment\n\u{202E}now " + String(repeating: "y", count: 80)
    let line = WorkerNotice.deafLine(name: name, id: "delphi")
    #expect(!line.contains("\n") && !line.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) })
    #expect(!line.contains("\"x\" Talos"), "the quote inside the name does not close its own quotes")
    #expect(line.count < 330, "\(line.count)")
    #expect(WorkerNotice.deafLine(name: "", id: "delphi").hasPrefix("The \"delphi\" thread has"))
    #expect(WorkerNotice.deafLine(name: "\u{7}\u{7}", id: "delphi").hasPrefix("The \"delphi\" thread has"))
  }

  @Test func theRecoveryLineSaysWhatMainHandledAndOnlyOfTheKindsThatHappened() {
    let back = { (m: MainHandledCounts) in WorkerNotice.deafBackLine(name: "Delphi", id: "delphi", handled: m) }
    #expect(back(.init()) == "Talos can message the \"Delphi\" thread again.")
    #expect(back(.init(messages: 1)) == "Talos can message the \"Delphi\" thread again. Main handled 1 message while this thread couldn't be reached.")
    #expect(back(.init(messages: 3, runs: 2, cards: 1)) == "Talos can message the \"Delphi\" thread again. Main handled 3 messages, 2 scheduled runs and 1 card tap while this thread couldn't be reached.")
    #expect(back(.init(runs: 35)) == "Talos can message the \"Delphi\" thread again. Main handled 35 scheduled runs while this thread couldn't be reached.")
    for m in [MainHandledCounts(), .init(messages: 3, runs: 2, cards: 1)] { #expect(plain(back(m))) }
  }

  // MARK: the file the doctor and the Health page read

  @Test func theFileIsTheVersionedShapeTheBridgeReads() throws {
    let d = DeafThreadsFile.encode(at: 1_700_000_000_000, threads: ["delphi": (1_699_999_000_000, 640)])
    let o = try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
    #expect(o["v"] as? Int == 1 && o["at"] as? Int == 1_700_000_000_000)
    let t = try #require((o["threads"] as? [String: Any])?["delphi"] as? [String: Int])
    #expect(t == ["since": 1_699_999_000_000, "refusals_1h": 640])
    let empty = try #require(try JSONSerialization.jsonObject(with: DeafThreadsFile.encode(at: 5, threads: [:])) as? [String: Any])
    #expect((empty["threads"] as? [String: Any])?.isEmpty == true)
  }
}
