import Foundation
import Testing
@testable import TalosDesktopCore

/// The missed turn ("Dante falls asleep", 2026-11-19): a model response that streamed only an empty thinking block (assistant record, content
/// ["thinking"], stop_reason null), after which Claude Code ended the turn with no error and no Stop record. Main sits idle at its prompt and
/// the owner's message goes unanswered. Records below have the shapes of the real transcript (types, flags and block kinds only; no content).
@Suite struct MissedTurnTests {
  private let told = Date(timeIntervalSince1970: 1_000)
  private let idle = ["❯ hello", "", "⏺ Read(file)", "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on"]
  private func working(_ s: Int = 9) -> [String] {
    ["❯ hello", "", "✻ Pondering… (\(s)s · still thinking)", "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on · esc to interrupt"]
  }
  private func status(unseen: Date?, resends: Bool = true, stop: Date? = nil) -> BridgeStatus {
    var s = BridgeStatus(pid: 42, mode: .live, relayConnected: true, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false, updatedAt: Date())
    s.unseenOldestAt = unseen
    s.mainResend = resends
    s.lastStopAt = stop
    return s
  }
  private let thinkingTail = MainStall.Transcript(size: 100, tail: .thinking(since: Date(timeIntervalSince1970: 1_003)))

  /// One supervisor tick as `watchMain` makes it: the pane's own idle reading is what the watch is told.
  private func tick(_ w: inout MainWatch, at t: Double, unseen: Date? = nil, resends: Bool = true, rows: [String]?, transcript: MainStall.Transcript? = nil, stop: Date? = nil) {
    w.observe(status: status(unseen: unseen ?? told, resends: resends, stop: stop), paneOutputAt: told.addingTimeInterval(1 + t), awakeNow: t)
    w.observeStall(rows: rows, transcript: transcript ?? thinkingTail, awakeNow: t, idle: rows.map { MainStall.idlePrompt(escapedRows: $0) })
  }

  /// The first tick of every case is 0: the thinking record is already the tail, nothing has changed since.
  private func run(_ rows: [String], to end: Int, transcript: MainStall.Transcript? = nil, resends: Bool = true, stop: Date? = nil) -> MainWatch {
    var w = MainWatch()
    for t in 0...end { tick(&w, at: Double(t), resends: resends, rows: rows, transcript: transcript, stop: stop) }
    return w
  }

  // MARK: the real records

  private func rec(_ type: String, _ extra: String = "", at: String, blocks: String? = nil, stop: String = "null", sidechain: Bool = false) -> String {
    let msg = blocks.map { #","message":{"role":"assistant","stop_reason":\#(stop),"content":[\#($0)]}"# } ?? ""
    return #"{"type":"\#(type)","isSidechain":\#(sidechain)\#(extra),"timestamp":"\#(at)"\#(msg)}"#
  }
  /// Stall 1 of Dante's transcript: tool_use, its result, an api-request record, then the thinking-only record, then an owner enqueue.
  private var stallOne: [String] {
    [
      rec("assistant", at: "2026-11-19T20:00:50.444Z", blocks: #"{"type":"tool_use"}"#, stop: #""tool_use""#),
      #"{"type":"attachment","timestamp":"2026-11-19T20:00:50.508Z"}"#,
      #"{"type":"user","timestamp":"2026-11-19T20:00:50.616Z","message":{"content":[{"type":"tool_result"}]}}"#,
      #"{"type":"api-request","timestamp":"2026-11-19T20:00:50.643Z"}"#,
      rec("assistant", at: "2026-11-19T20:00:53.129Z", blocks: #"{"type":"thinking","thinking":""}"#),
    ]
  }
  private func tail(_ lines: [String]) -> MainStall.Transcript.Tail { MainStall.tail(of: Data((lines.joined(separator: "\n") + "\n").utf8), startsMidFile: false) }
  private let thinkingAt = Date(timeIntervalSince1970: 1_795_118_453.129)

  @Test func theRealThinkingOnlyRecordIsTheTailThroughTheNoiseThatFollowsIt() {
    #expect(tail(stallOne) == .thinking(since: thinkingAt))
    // stall 2: a system record (subtype away_summary) three minutes later, and queue-operation records, are not a turn
    let away = #"{"type":"system","subtype":"away_summary","isSidechain":false,"timestamp":"2026-11-19T20:07:02.558Z"}"#
    let queue = #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-19T20:11:45.938Z"}"#
    let dequeue = #"{"type":"queue-operation","operation":"dequeue","timestamp":"2026-11-19T20:11:45.953Z"}"#
    #expect(tail(stallOne + [away]) == .thinking(since: thinkingAt))
    #expect(tail(stallOne + [away, queue, dequeue, #"{"type":"last-prompt"}"#, #"{"type":"mode"}"#]) == .thinking(since: thinkingAt))
    // a new owner message after it is a new pending turn
    let user = #"{"type":"user","isSidechain":false,"timestamp":"2026-11-19T20:11:45.985Z","message":{"role":"user","content":"hello"}}"#
    #expect(tail(stallOne + [away, queue, dequeue, user]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_119_105.985)))
  }

  // MARK: the case

  @Test func itFiresOnceAtNinetySecondsNotAtEightyNine() {
    let w89 = run(idle, to: 89)
    #expect(w89.takeMissed(awakeNow: 89) == nil, "89 s")
    let w90 = run(idle, to: 90)
    #expect(w90.takeMissed(awakeNow: 90) == told, "90 s")
    #expect(MainRestartContract.stallBlankS == 90)
  }

  @Test func theWaitRunsFromTheLastChange() {
    var w = MainWatch()
    for t in 0...60 { tick(&w, at: Double(t), rows: idle) }
    // the transcript grew at 61 (the record is rewritten): the 90 s start over
    for t in 61...150 { tick(&w, at: Double(t), rows: idle, transcript: .init(size: 140, tail: .thinking(since: nil))) }
    #expect(w.takeMissed(awakeNow: 150) == nil)
    tick(&w, at: 151, rows: idle, transcript: .init(size: 140, tail: .thinking(since: nil)))
    #expect(w.takeMissed(awakeNow: 151) == told)
  }

  @Test func aWorkingLineKeepsTheThreeHundredSecondRuleAndNeverMissedTurn() {
    var w = MainWatch()
    for t in 0...299 { tick(&w, at: Double(t), rows: working(t)) }
    #expect(w.takeMissed(awakeNow: 299) == nil)
    #expect(w.stalled() == nil, "still inside the long think")
    tick(&w, at: 300, rows: working(300))
    #expect(w.takeMissed(awakeNow: 300) == nil, "the spinner's case is the stall line, never this")
    #expect(w.stalled() == told)
  }

  @Test func theIdleCheckIsThePanesOwnReadingEachTick() {
    var w = run(idle, to: 100)
    #expect(w.takeMissed(awakeNow: 100) == told)
    // the next tick the pane shows a working line (Main woke up): not ready
    tick(&w, at: 101, rows: working())
    #expect(w.takeMissed(awakeNow: 101) == nil)
    // a draft in the box, a dialog, an unreadable pane: none is the idle prompt
    let draft = Array(idle.prefix(5)) + ["❯ half a sentence"] + Array(idle.suffix(2))
    let dialog = Array(idle.prefix(4)) + ["Do you trust this folder?", "❯ 1. Yes, proceed", "  2. No, exit"]
    for (name, pane) in [("draft", draft), ("dialog", dialog)] as [(String, [String])] {
      let x = run(pane, to: 100)
      #expect(x.takeMissed(awakeNow: 100) == nil, "\(name)")
    }
    var unreadable = MainWatch()
    for t in 0...100 { tick(&unreadable, at: Double(t), rows: nil) }
    #expect(unreadable.takeMissed(awakeNow: 100) == nil)
    // a pane never read as idle (the caller did not say so) is not idle
    var unsaid = MainWatch()
    for t in 0...100 {
      unsaid.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(1 + Double(t)), awakeNow: Double(t))
      unsaid.observeStall(rows: idle, transcript: thinkingTail, awakeNow: Double(t))
    }
    #expect(unsaid.takeMissed(awakeNow: 100) == nil)
  }

  @Test func aTranscriptThatCannotBeReadOrIsNotThinkingOnlyIsNotThisCase() {
    var w = MainWatch()
    for t in 0...100 { w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(1 + Double(t)), awakeNow: Double(t)); w.observeStall(rows: idle, transcript: nil, awakeNow: Double(t), idle: true) }
    #expect(w.takeMissed(awakeNow: 100) == nil, "unknown transcript")
    for tailKind in [MainStall.Transcript.Tail.answered, .unknown] {
      let x = run(idle, to: 100, transcript: .init(size: 100, tail: tailKind))
      #expect(x.takeMissed(awakeNow: 100) == nil)
    }
  }

  @Test func whenMainRepliedThereIsNothingToResend() {
    var w = run(idle, to: 100)
    #expect(w.takeMissed(awakeNow: 100) == told)
    // the model's record appears
    tick(&w, at: 101, rows: idle, transcript: .init(size: 300, tail: .answered))
    #expect(w.takeMissed(awakeNow: 101) == nil)
    // and the reply (a bridge tool call) clears the bridge's unseen time: nothing is waiting
    var replied = run(idle, to: 100)
    replied.observe(status: status(unseen: nil), paneOutputAt: told.addingTimeInterval(120), awakeNow: 101)
    #expect(replied.takeMissed(awakeNow: 101) == nil)
  }

  @Test func anInterruptRecordIsNeverAMissedTurn() {
    let interrupt = #"{"type":"user","timestamp":"2026-11-19T20:00:54.000Z","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#
    let t = tail(stallOne + [interrupt])
    #expect(t == .answered)
    let w = run(idle, to: 200, transcript: .init(size: 100, tail: t))
    #expect(w.takeMissed(awakeNow: 200) == nil)
  }

  @Test func theUnstickLatchMakesItOncePerMessage() {
    var w = run(idle, to: 90)
    #expect(w.takeMissed(awakeNow: 90) == told)
    w.refused(awakeNow: 90)
    #expect(w.takeMissed(awakeNow: 91) == nil, "waits after a refusal")
    #expect(w.takeMissed(awakeNow: 90 + MainWatch.retryAfter) == told, "a refusal spends nothing")
    w.askedMissed(unseenAt: told, min: 2, awakeNow: 105)
    for t in 106...1000 { tick(&w, at: Double(t), rows: idle) }
    #expect(w.takeMissed(awakeNow: 1000) == nil, "second time for the same message")
    // the bridge's answer does not re-open it
    _ = w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 1000)
    #expect(w.takeMissed(awakeNow: 1001) == nil)
    // a request that could not be written is spent too
    var x = run(idle, to: 90)
    x.missedNotAsked()
    #expect(x.takeMissed(awakeNow: 500) == nil)
    // a new message starts over
    let next = Date(timeIntervalSince1970: 5_000)
    for t in 2000...2100 { tick(&w, at: Double(t), unseen: next, rows: idle) }
    #expect(w.takeMissed(awakeNow: 2100) == next)
  }

  @Test func theLatchIsSharedWithTheEscUnstick() {
    var w = run(idle, to: 90)
    w.pressed(unseenAt: told, min: 2, awakeNow: 90)  // the Esc case already spent this message's one try
    w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 91).map { _ in }
    #expect(w.takeMissed(awakeNow: 1000) == nil)
  }

  @Test func anOlderBridgeIsNeverAsked() {
    let w = run(idle, to: 200, resends: false)
    #expect(w.takeMissed(awakeNow: 200) == nil)
  }

  @Test func theBridgesAnswerIsTheOnlyThingTheLineSays() {
    var w = run(idle, to: 90)
    w.askedMissed(unseenAt: told, min: 2, awakeNow: 90)
    #expect(w.unstick == .none, "no Esc, so no stall line state")
    #expect(w.takeMissed(awakeNow: 91) == nil, "one request at a time")
    let (done, sent) = w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 92) ?? (.init(unseenAt: told, since: 0, min: 0), false)
    #expect(done.missed && sent)
    #expect(w.unstick == .none)
    var failed = run(idle, to: 90)
    failed.askedMissed(unseenAt: told, min: 2, awakeNow: 90)
    let r = failed.settleAwaiting(answer: nil, awakeNow: 90 + MainWatch.answerWithin)
    #expect(r?.sent == false && r?.0.missed == true, "no answer in time is not sent")
  }

  // MARK: the owner stopped the agent (Dante's two "stalls" of 2026-11-19 were Stop presses)

  /// The real shape of a stopped-mid-stream turn: delivery, a thinking-only record, no Stop record, nothing after.
  private var stoppedMidStream: MainStall.Transcript { .init(size: 100, tail: tail(stallOne)) }

  @Test func aStopTheBridgeRecordedAfterTheDeliveryMeansNoResendAndNoLine() {
    let stopAfter = told.addingTimeInterval(5)
    let w = run(idle, to: 300, transcript: stoppedMidStream, stop: stopAfter)
    #expect(w.takeMissed(awakeNow: 300) == nil, "idle, thinking-only, 90 s and then some, but the owner stopped it")
    #expect(w.stalled() == nil)
    // the same shapes with no stop record are the genuine miss
    let genuine = run(idle, to: 90, transcript: stoppedMidStream)
    #expect(genuine.takeMissed(awakeNow: 90) == told)
    // a stop at the very moment of delivery counts (not strictly later)
    #expect(run(idle, to: 300, transcript: stoppedMidStream, stop: told).takeMissed(awakeNow: 300) == nil)
  }

  @Test func aStopForAnEarlierTurnDoesNotHideALaterGenuineMiss() {
    let earlier = told.addingTimeInterval(-300)
    let w = run(idle, to: 90, transcript: stoppedMidStream, stop: earlier)
    #expect(w.takeMissed(awakeNow: 90) == told)
  }

  @Test func aStopAfterTheResendEndsTheSecondMissLine() {
    var w = resentWatch()
    let stop = told.addingTimeInterval(120)
    for t in 93...400 { tick(&w, at: Double(t), rows: idle, stop: stop) }
    #expect(w.takeMissedAgain(awakeNow: 400) == nil)
    var other = resentWatch()
    for t in 93...400 { tick(&other, at: Double(t), rows: idle) }
    #expect(other.takeMissedAgain(awakeNow: 400) == told, "without the stop it is the second miss")
  }

  @Test func anEscTypedInThePaneAfterTheMessageIsAlsoNotAMiss() {
    var w = MainWatch()
    for t in 0...200 {
      tick(&w, at: Double(t), rows: idle, transcript: stoppedMidStream)
      if t == 40 { w.notePaneKeys(told.addingTimeInterval(40)) }
    }
    #expect(w.takeMissed(awakeNow: 200) == nil)
    var early = MainWatch()
    early.notePaneKeys(told.addingTimeInterval(-50))  // typed before the message arrived
    for t in 0...90 { tick(&early, at: Double(t), rows: idle, transcript: stoppedMidStream) }
    #expect(early.takeMissed(awakeNow: 90) == told)
  }

  @Test func theBridgesStatusCarriesTheStopAndAnOlderBridgeHasNone() throws {
    let base = #"{"v":1,"pid":42,"mode":"live","relay":{"connected":true},"updated_at":"2026-11-19T20:00:00.000Z""#
    let with = try #require(BridgeStatus.decode(Data((base + #","last_stop_at":"2026-11-19T20:00:56.500Z"}"#).utf8)))
    #expect(with.lastStopAt == BridgeStatus.isoDate("2026-11-19T20:00:56.500Z"))
    #expect(try #require(BridgeStatus.decode(Data((base + "}").utf8))).lastStopAt == nil)
    #expect(try #require(BridgeStatus.decode(Data((base + #","last_stop_at":"soon"}"#).utf8))).lastStopAt == nil, "an unknown value degrades to none")
  }

  @Test func theBridgesAnswerOfStoppedIsReadAndSilencesTheLine() throws {
    let a = try #require(MainResendAnswer.decode(Data(#"{"v":1,"unseen_at":"2026-11-19T20:00:00.000Z","outcome":"failed","why":"stopped"}"#.utf8)))
    #expect(a.why == "stopped" && !a.sent)
  }

  // MARK: missed again (the re-delivered message was missed too)

  /// The thinking-only tail of the real shapes, after the bridge said the message was sent again.
  private func resentWatch() -> MainWatch {
    var w = run(idle, to: 90)
    w.askedMissed(unseenAt: told, min: 2, awakeNow: 90)
    _ = w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 92)
    return w
  }

  @Test func aSecondMissIsToldOnceAtNinetySecondsFromTheResendAndAsksForNoSecondResend() {
    var w = resentWatch()
    #expect(w.takeMissedAgain(awakeNow: 92) == nil, "not at once: the resend itself is not a miss")
    for t in 93...181 { tick(&w, at: Double(t), rows: idle) }
    #expect(w.takeMissedAgain(awakeNow: 181) == nil, "89 s after the resend")
    tick(&w, at: 182, rows: idle)
    #expect(w.takeMissedAgain(awakeNow: 182) == told, "90 s after the resend")
    #expect(w.takeMissed(awakeNow: 182) == nil, "never a second request")
    w.missedAgainNoted()
    for t in 183...2000 { tick(&w, at: Double(t), rows: idle) }
    #expect(w.takeMissedAgain(awakeNow: 2000) == nil && w.takeMissed(awakeNow: 2000) == nil, "once per message")
    // the next message starts over
    let next = Date(timeIntervalSince1970: 9_000)
    for t in 3000...3100 { tick(&w, at: Double(t), unseen: next, rows: idle) }
    #expect(w.takeMissedAgain(awakeNow: 3100) == nil && w.takeMissed(awakeNow: 3100) == next)
  }

  @Test func noSecondMissWhenTheResendWasRefusedOrMainAnsweredOrIsWorking() {
    var refused = run(idle, to: 90)
    refused.askedMissed(unseenAt: told, min: 2, awakeNow: 90)
    _ = refused.settleAwaiting(answer: .init(unseenAt: told, sent: false), awakeNow: 92)
    for t in 93...400 { tick(&refused, at: Double(t), rows: idle) }
    #expect(refused.takeMissedAgain(awakeNow: 400) == nil, "nothing was re-delivered, so nothing was missed twice")
    var answered = resentWatch()
    for t in 93...300 { tick(&answered, at: Double(t), rows: idle, transcript: .init(size: 400, tail: .answered)) }
    #expect(answered.takeMissedAgain(awakeNow: 300) == nil)
    var busy = resentWatch()
    for t in 93...300 { tick(&busy, at: Double(t), rows: working(t)) }
    #expect(busy.takeMissedAgain(awakeNow: 300) == nil, "a working line is Main taking it in")
  }

  // MARK: the line

  @Test func theLineWording() {
    #expect(SupervisorNotice.missedTurnResent == "Your agent missed your message; sent it again")
    #expect(SupervisorNotice.missedTurnFailed == "Your agent missed your message and Talos couldn't send it again; please send it again")
    #expect(!SupervisorNotice.missedTurnResent.contains("Esc"), "nothing was pressed")
    #expect(SupervisorNotice.missedTurnAgain == "Your agent missed your message again; please send it again or restart it")
  }
}
