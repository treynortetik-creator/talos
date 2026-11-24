import Foundation
import Testing
@testable import TalosDesktopCore

/// A Main whose model request hangs: the message was told to it, no bridge tool call followed, and its screen only redraws the
/// working line's elapsed counter (2026-11-19, a 10.5 minute stall nobody was told about).
@Suite struct MainStallTests {
  private let told = Date(timeIntervalSince1970: 1_000)
  /// `resends`: whether the status says the bridge answers resend requests (an older bridge's does not).
  private func status(unseen: Date?, resends: Bool = true) -> BridgeStatus {
    var s = BridgeStatus(
      pid: 42, mode: .live, relayConnected: true, lastConnectAt: nil, lastCloseCode: nil, queueDepth: 0, permissionRelay: false,
      updatedAt: Date())
    s.unseenOldestAt = unseen
    s.mainResend = resends
    return s
  }
  /// The pane as Claude Code draws a request in flight: the working line, then the input box.
  private func rows(_ working: String = "✻ Pondering… (19s · still thinking)", above: String = "❯ hello") -> [String] {
    [above, "", working, "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on · esc to interrupt"]
  }
  /// The transcript as Claude Code has it when the delivered message is the newest turn: a user record, nothing from the model after.
  private func waiting(_ size: Int64 = 100, since: Date? = nil) -> MainStall.Transcript {
    .init(size: size, tail: .awaitingModel(since: since ?? told))
  }
  private func tick(_ w: inout MainWatch, at t: Double, unseen: Date? = nil, resends: Bool = true, rows r: [String]?, transcript: MainStall.Transcript?? = nil) {
    w.observe(status: status(unseen: unseen ?? told, resends: resends), paneOutputAt: told.addingTimeInterval(1 + t), awakeNow: t)
    w.observeStall(rows: r, transcript: transcript ?? waiting(), awakeNow: t)
  }
  /// The same request a second later: only the elapsed counter moved. (A label that is not "thinking": the short limit applies.)
  private func counter(_ s: Int) -> [String] { rows("✻ Working… (\(s)s · ↓ 77 tokens)") }
  private func thinking(_ s: Int) -> [String] { rows("✻ Pondering… (\(s)s · still thinking)") }

  @Test func theMaskHidesOnlyTheElapsedCounter() {
    let a = MainStall.maskedBody(rows: rows("✢ Perambulating… (4s · ↓ 77 tokens)"))
    let b = MainStall.maskedBody(rows: rows("✢ Perambulating… (5s · ↓ 77 tokens)"))
    let c = MainStall.maskedBody(rows: rows("✢ Perambulating… (5s · ↓ 78 tokens)"))
    let d = MainStall.maskedBody(rows: rows("✢ Perambulating… (1m 5s · ↓ 77 tokens)"))
    #expect(a == b && a == d)
    #expect(a != c, "a moving token count is progress")
    #expect(MainStall.hasWorkingLine(rows: rows("✻ Working… (esc to interrupt)")))
    #expect(MainStall.hasWorkingLine(rows: rows("✢ Perambulating… (4s · ↓ 77 tokens)")))
    #expect(!MainStall.hasWorkingLine(rows: rows("✻ Cooked for 9s")), "a finished turn is not a request in flight")
    #expect(!MainStall.hasWorkingLine(rows: rows("⏺ Let me look at that…")), "the answer's own text is not the working line")
  }

  @Test func itFiresAtTheContractsTimeAndOnlyOnce() {
    var w = MainWatch()
    for t in stride(from: 0.0, to: MainRestartContract.stallS, by: 1) { tick(&w, at: t, rows: counter(Int(t) + 19)) }
    #expect(w.stalled() == nil)
    tick(&w, at: MainRestartContract.stallS, rows: counter(300))
    #expect(w.stalled() == told)
    #expect(w.wantsStallReads, "it keeps reading while the line is up, to clear it")
    for t in stride(from: MainRestartContract.stallS + 1, to: 600, by: 1) { tick(&w, at: t, rows: counter(Int(t) + 19)) }
    #expect(w.stalled() == told)
  }

  @Test func aRedrawOfTheElapsedCounterAloneIsNotProgress() {
    var w = MainWatch()
    // the pane's own output time moves every second (tick() feeds it), the body does not
    for t in 0...Int(MainRestartContract.stallS) { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told)
  }

  @Test func aMovingTokenCountResetsTheWait() {
    var w = MainWatch()
    for t in 0..<170 { tick(&w, at: Double(t), rows: rows("✢ Perambulating… (\(t)s · ↓ 77 tokens)")) }
    tick(&w, at: 170, rows: rows("✢ Perambulating… (170s · ↓ 90 tokens)"))
    for t in 171...340 { tick(&w, at: Double(t), rows: rows("✢ Perambulating… (\(t)s · ↓ 90 tokens)")) }
    #expect(w.stalled() == nil, "170 s since the count moved")
    tick(&w, at: 351, rows: rows("✢ Perambulating… (351s · ↓ 90 tokens)"))
    #expect(w.stalled() == told)
  }

  /// Opening the pane (which the line itself asks for) resizes and redraws it: a changed body never takes the line away.
  @Test func onceToldItStaysToldWhateverThePaneDoes() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told)
    tick(&w, at: 181, rows: rows("✻ Pondering… (181s · thinking)", above: "a different, rewrapped pane"))
    #expect(w.stalled() == told)
    for t in 182...600 { tick(&w, at: Double(t), rows: rows("✻ Working… (\(t)s · ↓ \(t) tokens)")) }
    #expect(w.stalled() == told)
  }

  /// The model answered (an assistant record after the stall point): the line comes down, and is not told again for this message.
  @Test func anAssistantRecordAfterTheStallPointClearsItForGood() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told)
    tick(&w, at: 181, rows: counter(181), transcript: .init(size: 300, tail: .answered))
    #expect(w.stalled() == nil)
    #expect(!w.wantsStallReads)
    for t in 182...900 { tick(&w, at: Double(t), rows: counter(t), transcript: waiting(300)) }
    #expect(w.stalled() == nil, "told once for this message")
  }

  /// A Main running a tool or a sub-agent: the newest turn is the model's own tool_use, no result back. Not a stalled request.
  @Test func aMainRunningAToolOrSubAgentIsNeverStalled() {
    var w = MainWatch()
    for t in 0...900 { tick(&w, at: Double(t), rows: counter(t), transcript: .init(size: 500, tail: .answered)) }
    #expect(w.stalled() == nil)
  }

  /// The wait runs from the user or tool_result record that the model has not answered, not from the message's first sighting: a
  /// tool that took 5 minutes and then returned starts a fresh 180 s.
  @Test func theWaitRunsFromTheNewestTurnThatNobodyAnswered() {
    var w = MainWatch()
    for t in 0...400 { tick(&w, at: Double(t), rows: counter(t), transcript: .init(size: 500, tail: .answered)) }
    let result = told.addingTimeInterval(400)
    tick(&w, at: 401, rows: counter(401), transcript: .init(size: 600, tail: .awaitingModel(since: result)))
    for t in 402...580 { tick(&w, at: Double(t), rows: counter(t), transcript: .init(size: 600, tail: .awaitingModel(since: result))) }
    #expect(w.stalled() == nil, "179 s since the tool result")
    tick(&w, at: 581, rows: counter(581), transcript: .init(size: 600, tail: .awaitingModel(since: result)))
    #expect(w.stalled() == told)
  }

  /// A real, long think: the label says thinking and the token count is frozen. It gets the longer limit.
  @Test func aLongThinkStaysQuietAtTheShortLimitAndFiresAtTheLongOne() {
    var w = MainWatch()
    for t in 0..<Int(MainRestartContract.stallThinkingS) { tick(&w, at: Double(t), rows: thinking(t)) }
    #expect(w.stalled() == nil, "quiet at 180 s and well past it, until 300 s")
    tick(&w, at: MainRestartContract.stallThinkingS, rows: thinking(300))
    #expect(w.stalled() == told)
  }

  @Test func aToolCallClearsIt() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told)
    w.observe(status: status(unseen: nil), paneOutputAt: nil, awakeNow: 181)
    w.observeStall(rows: counter(181), transcript: waiting(), awakeNow: 181)
    #expect(w.stalled() == nil)
    #expect(!w.wantsStallReads)
  }

  @Test func aNextMessageStartsOverAndIsToldInItsTurn() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t)) }
    let next = told.addingTimeInterval(400)
    for t in 200...300 { tick(&w, at: Double(t), unseen: next, rows: counter(t)) }
    #expect(w.stalled() == nil)
    for t in 301...381 { tick(&w, at: Double(t), unseen: next, rows: counter(t)) }
    #expect(w.stalled() == next)
  }

  @Test func transcriptGrowthResets() {
    var w = MainWatch()
    for t in 0..<170 { tick(&w, at: Double(t), rows: counter(t), transcript: waiting(100)) }
    tick(&w, at: 170, rows: counter(170), transcript: waiting(160))
    for t in 171...340 { tick(&w, at: Double(t), rows: counter(t), transcript: waiting(160)) }
    #expect(w.stalled() == nil)
    tick(&w, at: 350, rows: counter(350), transcript: waiting(160))
    #expect(w.stalled() == told)
  }

  @Test func anUnknownTranscriptFallsBackToTheOtherTwoSignals() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t), transcript: .some(nil)) }
    #expect(w.stalled() == told)
  }

  @Test func aScreenThatCouldNotBeReadSaysNothing() {
    var w = MainWatch()
    for t in 0...400 { tick(&w, at: Double(t), rows: nil) }
    #expect(w.stalled() == nil)
  }

  @Test func aTurnThatFinishedWithNoWorkingLineIsNeverStalled() {
    var w = MainWatch()
    // a finished turn: the model's reply is the transcript's newest record
    for t in 0...400 { tick(&w, at: Double(t), rows: rows("✻ Cooked for 3s", above: "⏺ thanks"), transcript: .init(size: 100, tail: .answered)) }
    #expect(w.stalled() == nil)
  }

  @Test func longThinkingBeforeTheTimeNeverFires() {
    var w = MainWatch()
    for t in 0..<Int(MainRestartContract.stallS) { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == nil)
  }

  /// The Mac asleep is not a stall: the awake clock does not move, so the wait does not either.
  @Test func timeAsleepIsNotWaited() {
    var w = MainWatch()
    tick(&w, at: 0, rows: counter(0))
    tick(&w, at: 100, rows: counter(100))
    w.observe(status: status(unseen: told), paneOutputAt: told.addingTimeInterval(9_999), awakeNow: 101)
    w.observeStall(rows: counter(101), transcript: waiting(), awakeNow: 101)
    #expect(w.stalled() == nil)
  }

  // MARK: reading the transcript's tail

  private let incident = [
    #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-19T02:37:46.100Z"}"#,
    #"{"type":"user","timestamp":"2026-11-19T02:37:47.000Z","origin":{"kind":"channel"},"message":{"role":"user","content":"hi"}}"#,
    #"{"type":"attachment","timestamp":"2026-11-19T02:37:47.200Z"}"#,
    #"{"type":"system","subtype":"api_request","timestamp":"2026-11-19T02:37:47.900Z"}"#,
  ]
  private func tail(_ lines: [String]) -> MainStall.Transcript.Tail { MainStall.tail(of: Data((lines.joined(separator: "\n") + "\n").utf8), startsMidFile: false) }

  @Test func theIncidentTranscriptEndsOnAnUnansweredUserTurn() {
    let t = tail(incident)
    #expect(t == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_055_867)))
  }

  @Test func aToolUseOrAReplyAfterItMeansTheModelAnswered() {
    #expect(tail(incident + [#"{"type":"assistant","timestamp":"2026-11-19T02:37:50.000Z","message":{"content":[{"type":"tool_use"}]}}"#]) == .answered)
    let result = #"{"type":"user","timestamp":"2026-11-19T02:40:00.000Z","message":{"content":[{"type":"tool_result"}]}}"#
    #expect(tail(incident + [#"{"type":"assistant","timestamp":"2026-11-19T02:37:50.000Z"}"#, result]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_056_000)))
  }

  /// Both stalls of 2026-11-19, record for record (times as in the real transcript), each with the non-message records Claude Code
  /// writes between them (queue-operation, attachment, api-request, system, frame-link), which are never a turn.
  private let noise = [
    #"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-11-19T02:48:27.100Z"}"#,
    #"{"type":"attachment","timestamp":"2026-11-19T02:48:27.700Z"}"#,
    #"{"type":"system","subtype":"api_request","timestamp":"2026-11-19T02:48:27.808Z"}"#,
    #"{"type":"frame-link","timestamp":"2026-11-19T02:48:28.000Z"}"#,
  ]
  private let secondUser = #"{"type":"user","timestamp":"2026-11-19T02:48:27.675Z","origin":{"kind":"channel"},"message":{"role":"user","content":"are you there"}}"#
  private let thinkingOnly = #"{"type":"assistant","timestamp":"2026-11-19T02:48:33.535Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":""}]}}"#

  @Test func theSecondStallEndsOnAThinkingOnlyRecordWhichIsNotAnAnswer() {
    let since = Date(timeIntervalSince1970: 1_795_056_513.535)
    #expect(tail([noise[0], secondUser, noise[1], noise[2], thinkingOnly, noise[3]]) == .thinking(since: since))
    #expect(tail([noise[0], secondUser, noise[1], noise[2]]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_056_507.675)))
  }

  /// Claude Code gives up on a hung request with a synthetic assistant record ("API Error: Request timed out"). That is a failed turn,
  /// not an answer: the record is skipped, so the turn before it still reads as unanswered.
  @Test func aSyntheticApiErrorRecordIsNotAnAnswer() {
    let flagged = #"{"type":"assistant","isApiErrorMessage":true,"timestamp":"2026-11-19T02:58:00.000Z","message":{"content":[{"type":"text","text":"API Error: Request timed out"}]}}"#
    let synthetic = #"{"type":"assistant","timestamp":"2026-11-19T02:58:00.000Z","message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: Request timed out"}]}}"#
    let since = Date(timeIntervalSince1970: 1_795_056_507.675)
    for rec in [flagged, synthetic] {
      #expect(tail([noise[0], secondUser, noise[2], rec]) == .awaitingModel(since: since))
      #expect(tail([secondUser, thinkingOnly, rec]) == .thinking(since: Date(timeIntervalSince1970: 1_795_056_513.535)))
    }
    #expect(tail([secondUser, #"{"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"hi"}]}}"#]) == .answered)
  }

  /// Stalled, then the CLI writes its API-error record: the line stays up (the message is still unread).
  @Test func theLineSurvivesTheApiErrorRecord() {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told)
    let after = MainStall.tail(of: Data((secondUser + "\n" + #"{"type":"assistant","isApiErrorMessage":true,"message":{"content":[{"type":"text","text":"API Error"}]}}"# + "\n").utf8), startsMidFile: false)
    tick(&w, at: 181, rows: counter(181), transcript: .init(size: 400, tail: after))
    #expect(w.stalled() == told)
  }

  @Test func aTextOrToolUseBlockAmongTheThinkingIsAnAnswer() {
    let withText = #"{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"text","text":"hi"}]}}"#
    let withTool = #"{"type":"assistant","message":{"content":[{"type":"thinking"},{"type":"tool_use"}]}}"#
    #expect(tail([secondUser, thinkingOnly, withText]) == .answered)
    #expect(tail([secondUser, thinkingOnly, withTool]) == .answered)
    #expect(tail([secondUser, #"{"type":"assistant","message":{"content":"plain"}}"#]) == .answered)
  }

  /// First stall: nothing from the model after the message. Second: only a thinking record. Both fire, the second on the thinking limit
  /// counted from the thinking record, whatever the label says.
  @Test func bothStallsFireOnTheirOwnClocks() {
    let user = Date(timeIntervalSince1970: 1_795_056_507.675)
    let thought = Date(timeIntervalSince1970: 1_795_056_513.535)
    var first = MainWatch()
    for t in 0...180 { tick(&first, at: Double(t), rows: counter(t), transcript: .init(size: 100, tail: .awaitingModel(since: user))) }
    #expect(first.stalled() == told)
    var second = MainWatch()
    for t in 0..<6 { tick(&second, at: Double(t), rows: counter(t), transcript: .init(size: 100, tail: .awaitingModel(since: user))) }
    let think = MainStall.Transcript(size: 160, tail: .thinking(since: thought))
    for t in 6..<Int(6 + MainRestartContract.stallThinkingS) { tick(&second, at: Double(t), rows: counter(t), transcript: think) }
    #expect(second.stalled() == nil, "the thinking limit runs from the thinking record: quiet at 180 s")
    tick(&second, at: 6 + MainRestartContract.stallThinkingS, rows: counter(400), transcript: think)
    #expect(second.stalled() == told)
  }

  @Test func aSubAgentsRecordsAreNotMainsTurn() {
    let side = #"{"type":"assistant","isSidechain":true,"timestamp":"2026-11-19T02:38:00.000Z"}"#
    #expect(tail(incident + [side]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_055_867)))
  }

  @Test func damagedOrPartialLinesAreSkippedAndNothingReadableIsUnknown() {
    #expect(tail(incident + ["{\"type\":\"assistant\",\"time"]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_055_867)))
    #expect(tail(["", "not json", "[1,2]", #"{"type":"attachment"}"#]) == .unknown)
    #expect(MainStall.tail(of: Data(), startsMidFile: false) == .unknown)
    // a read that began mid-file: its first line is a fragment and is never parsed as a record
    let cut = Data((#"ssistant","timestamp":"x"}"# + "\n" + incident[1] + "\n").utf8)
    #expect(MainStall.tail(of: cut, startsMidFile: true) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_055_867)))
  }

  @Test func onlyTheEndOfABigFileIsRead() throws {
    let dir = NSTemporaryDirectory() + "stall-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let file = dir + "/s.jsonl"
    let filler = String(repeating: #"{"type":"assistant","message":{"content":"x"}}"# + "\n", count: 20_000)  // ~1 MB, all model
    try (filler + incident.joined(separator: "\n") + "\n").write(toFile: file, atomically: true, encoding: .utf8)
    let t = try #require(MainStall.transcript(atPath: file))
    #expect(t.size > 900_000)
    #expect(t.tail == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_055_867)))
    #expect(MainStall.transcript(atPath: dir + "/missing.jsonl") == nil)
  }

  @Test func theLineSaysWhenWhatAndWhatToDoInPlainWords() throws {
    let utc = try #require(TimeZone(identifier: "UTC"))
    let line = SupervisorNotice.mainStalled(since: Date(timeIntervalSince1970: 1_794_304_500), timeZone: utc)
    #expect(line.contains("9:55") && line.contains("3 min") && line.contains("Restart agent in Settings") && !line.contains("Esc") && line.contains("send again"), "\(line)")
  }

  // MARK: a frozen request with no working line on the pane (the owner's Mac, 2026-11-19: 186 s of nothing after a tool result)

  /// The pane with the box and no working line: Claude Code drew no spinner.
  private var blank: [String] { ["❯ hello", "", "⏺ Read(file)", "", String(repeating: "─", count: 80), "❯ ", String(repeating: "─", count: 80), "  ⏵⏵ bypass permissions on"] }

  @Test func aBlankPaneUnderAPendingTurnIsToldAtNinetySecondsNotBefore() {
    #expect(MainRestartContract.stallBlankS == 90)
    var w = MainWatch()
    for t in 0...89 { tick(&w, at: Double(t), rows: blank) }
    #expect(w.stalled() == nil, "89 s: not yet")
    tick(&w, at: 90, rows: blank)
    #expect(w.stalled() == told, "90 s")
  }

  @Test func theBlankWaitRunsFromTheLastChangeInThePaneOrTheTranscript() {
    var w = MainWatch()
    for t in 0...60 { tick(&w, at: Double(t), rows: blank, transcript: waiting(100)) }
    tick(&w, at: 61, rows: blank, transcript: waiting(200))  // the tool result was written
    for t in 62...150 { tick(&w, at: Double(t), rows: blank, transcript: waiting(200)) }
    #expect(w.stalled() == nil, "89 s after the last change")
    tick(&w, at: 151, rows: blank, transcript: waiting(200))
    #expect(w.stalled() == told)
  }

  @Test func aBlankPaneUnderAnAnsweredTurnIsNeverAStall() {
    var w = MainWatch()
    for t in 0...600 { tick(&w, at: Double(t), rows: blank, transcript: .init(size: 100, tail: .answered)) }
    #expect(w.stalled() == nil)
  }

  @Test func aBlankPaneWithNoReadableTranscriptIsAnIdlePromptNotAStall() {
    var w = MainWatch()
    for t in 0...600 { tick(&w, at: Double(t), rows: blank, transcript: .some(nil)) }
    #expect(w.stalled() == nil)
    // a transcript read once and then lost does not keep counting on the old reading
    var lost = MainWatch()
    for t in 0...60 { tick(&lost, at: Double(t), rows: blank) }
    for t in 61...600 { tick(&lost, at: Double(t), rows: blank, transcript: .some(nil)) }
    #expect(lost.stalled() == nil)
  }

  @Test func aSpinnerKeepsTheLongWaits() {
    var w = MainWatch()
    for t in 0...179 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == nil, "a working line: 90 s is not enough")
    tick(&w, at: 180, rows: counter(180))
    #expect(w.stalled() == told)
    var thinking = MainWatch()
    for t in 0..<Int(MainRestartContract.stallThinkingS) { tick(&thinking, at: Double(t), rows: self.thinking(t)) }
    #expect(thinking.stalled() == nil, "a thinking line: still 300 s")
  }

  @Test func theUnstickAppliesToABlankStallThroughTheSameGates() {
    var w = MainWatch()
    for t in 0...90 { tick(&w, at: Double(t), rows: blank) }
    #expect(w.takeUnstick(awakeNow: 90) == told, "a blank stall is an unstick candidate like any other")
    #expect(w.blankStallReady(awakeNow: 90), "so the Escape goes as the blank intent")
    // the gate: the spinner's intent is refused on a blank pane, the blank one is allowed on the idle prompt
    #expect(KeyGuard.refusal(blank, intent: .interrupt)?.why == "not_working")
    #expect(KeyGuard.refusal(blank, intent: .interruptBlank) == nil)
  }

  // MARK: records Claude Code writes that are not a pending turn (read from real transcripts)

  private let interrupt = #"{"type":"user","timestamp":"2026-11-19T02:50:00.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#
  private let interruptForTool = #"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#
  private let interruptResult = #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"[Request interrupted by user for tool use]"}]}}"#
  private let slashCommand = #"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"}}"#
  private let slashOutput = #"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model to Opus</local-command-stdout>"}}"#
  private let caveat = #"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>"}}"#
  private let reply = #"{"type":"assistant","message":{"model":"claude-x","content":[{"type":"text","text":"done"}]}}"#

  @Test func theOwnersInterruptEndsTheTurnItIsNotAPendingMessage() {
    for rec in [interrupt, interruptForTool, interruptResult] {
      #expect(tail([secondUser, rec]) == .answered, "\(rec)")
      #expect(tail([secondUser, thinkingOnly, rec]) == .answered)
    }
    // a message sent after the interrupt is a new pending turn
    #expect(tail([secondUser, interrupt, secondUser]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_056_507.675)))
  }

  @Test func anInterruptedTurnNeverStallsBlankOrNot() {
    let stopped = MainStall.Transcript(size: 100, tail: tail([secondUser, interrupt]))
    var blankPane = MainWatch()
    for t in 0...600 { tick(&blankPane, at: Double(t), rows: blank, transcript: stopped) }
    #expect(blankPane.stalled() == nil)
    var spinner = MainWatch()
    for t in 0...600 { tick(&spinner, at: Double(t), rows: counter(t), transcript: stopped) }
    #expect(spinner.stalled() == nil)
  }

  @Test func aLocalSlashCommandIsNotAPendingMessage() {
    // after an idle turn: still answered, whatever the command wrote
    #expect(tail([secondUser, reply, caveat, slashCommand, slashOutput]) == .answered)
    #expect(tail([secondUser, reply, slashCommand]) == .answered)
    // and it does not hide a message that really is pending
    #expect(tail([secondUser, slashCommand, slashOutput]) == .awaitingModel(since: Date(timeIntervalSince1970: 1_795_056_507.675)))
    var w = MainWatch()
    let idle = MainStall.Transcript(size: 100, tail: tail([secondUser, reply, caveat, slashCommand, slashOutput]))
    for t in 0...600 { tick(&w, at: Double(t), rows: blank, transcript: idle) }
    #expect(w.stalled() == nil)
  }

  @Test func aRealHungOwnerTurnStillFiresAtNinetySeconds() {
    let hung = MainStall.Transcript(size: 100, tail: tail([secondUser, noise[1], noise[2]]))  // the message, an attachment, an api-request
    var w = MainWatch()
    for t in 0...89 { tick(&w, at: Double(t), rows: blank, transcript: hung) }
    #expect(w.stalled() == nil)
    tick(&w, at: 90, rows: blank, transcript: hung)
    #expect(w.stalled() == told)
  }

  // MARK: the auto-unstick's latch, the bridge's answer and the line

  private func stalledWatch(unseen: Date? = nil) -> MainWatch {
    var w = MainWatch()
    for t in 0...180 { tick(&w, at: Double(t), unseen: unseen, rows: counter(t)) }
    return w
  }

  @Test func theUnstickMayTryOnlyWhileStalledAndOnlyAgainstABridgeThatAnswers() {
    var w = MainWatch()
    for t in 0..<60 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.takeUnstick(awakeNow: 60) == nil, "not stalled yet")
    for t in 60...200 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.takeUnstick(awakeNow: 200) == told)
    var old = MainWatch()
    for t in 0...200 { tick(&old, at: Double(t), resends: false, rows: counter(t)) }
    #expect(old.stalled() == told && old.takeUnstick(awakeNow: 200) == nil, "an older bridge: nothing is pressed, the alarm line stands")
    tick(&w, at: 201, rows: counter(201), transcript: .init(size: 300, tail: .answered))
    #expect(w.stalled() == nil && w.takeUnstick(awakeNow: 201) == nil, "the model answered: nothing to unstick")
  }

  @Test func aRefusalSpendsNothingAndAnEscapeSpendsTheOneTry() {
    var w = stalledWatch()
    #expect(w.takeUnstick(awakeNow: 181) == told)
    w.refused(awakeNow: 181)  // the owner was typing
    #expect(w.takeUnstick(awakeNow: 182) == nil, "looks again after the wait, not on every tick")
    #expect(w.takeUnstick(awakeNow: 181 + MainWatch.retryAfter) == told, "still its one try")
    w.pressed(unseenAt: told, min: 3, awakeNow: 200)
    #expect(w.takeUnstick(awakeNow: 1000) == nil, "one Esc per message")
    for t in 201...600 { tick(&w, at: Double(t), rows: counter(t)) }
    #expect(w.stalled() == told && w.takeUnstick(awakeNow: 600) == nil, "stalling again is the line only")
  }

  @Test func aNewMessageGetsItsOwnOneTry() {
    var w = stalledWatch()
    w.pressed(unseenAt: told, min: 3, awakeNow: 181)
    let next = Date(timeIntervalSince1970: 5_000)
    for t in 1000...1200 { tick(&w, at: Double(t), unseen: next, rows: counter(t), transcript: waiting(since: next)) }
    #expect(w.unstick == .none, "what was done for the old message is not said of the new one")
    #expect(w.takeUnstick(awakeNow: 1200) == next)
  }

  @Test func theLineWaitsForTheBridgesAnswer() {
    var w = stalledWatch()
    w.pressed(unseenAt: told, min: 3, awakeNow: 181)
    #expect(w.unstick == .awaiting(min: 3))
    #expect(w.settleAwaiting(answer: nil, awakeNow: 190) == nil, "no answer, inside the wait")
    #expect(w.settleAwaiting(answer: .init(unseenAt: told.addingTimeInterval(-9), sent: true), awakeNow: 190) == nil, "another message's answer")
    let done = w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 190)
    #expect(done?.1 == true && done?.0.min == 3)
    #expect(w.unstick == .resent(min: 3) && w.awaiting == nil)
    #expect(w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 191) == nil, "told once")
  }

  @Test func aFailedAnswerOrNoAnswerIsNotSent() {
    var a = stalledWatch()
    a.pressed(unseenAt: told, min: 3, awakeNow: 181)
    #expect(a.settleAwaiting(answer: .init(unseenAt: told, sent: false), awakeNow: 185)?.sent == false)
    #expect(a.unstick == .failed(min: 3))
    var b = stalledWatch()
    b.pressed(unseenAt: told, min: 3, awakeNow: 181)
    #expect(b.settleAwaiting(answer: nil, awakeNow: 181 + MainWatch.answerWithin - 1) == nil)
    #expect(b.settleAwaiting(answer: nil, awakeNow: 181 + MainWatch.answerWithin)?.sent == false)
    #expect(b.unstick == .failed(min: 3))
  }

  @Test func aMessageTakenInWhileWaitingStillGetsItsLine() {
    var w = stalledWatch()
    w.pressed(unseenAt: told, min: 3, awakeNow: 181)
    let next = Date(timeIntervalSince1970: 5_000)
    w.observe(status: status(unseen: next), paneOutputAt: nil, awakeNow: 183)  // another message is now the oldest
    #expect(w.unstick == .none && w.awaiting != nil, "the request is still owed its answer")
    let done = w.settleAwaiting(answer: .init(unseenAt: told, sent: true), awakeNow: 184)
    #expect(done?.0.unseenAt == told && done?.sent == true)
    #expect(w.unstick == .none, "and it is not said of the new message")
  }

  @Test func theBridgesAnswerFileIsReadAsItIsWritten() throws {
    let sent = MainResendAnswer.decode(Data(#"{"v":1,"unseen_at":"2026-11-19T02:48:27.675Z","outcome":"sent","delivered":1}"#.utf8))
    #expect(sent == .init(unseenAt: Date(timeIntervalSince1970: 1_795_056_507.675), sent: true))
    let failed = MainResendAnswer.decode(Data(#"{"v":1,"unseen_at":"2026-11-19T02:48:27.675Z","outcome":"failed","delivered":0,"why":"not_held"}"#.utf8))
    #expect(failed?.sent == false)
    let unknown = MainResendAnswer.decode(Data(#"{"v":1,"unseen_at":"2026-11-19T02:48:27.675Z","outcome":"maybe","extra":[1]}"#.utf8))
    #expect(unknown?.sent == false, "an outcome this build does not know is not a send")
    for bad in ["", "[]", #"{"v":2,"unseen_at":"2026-11-19T02:48:27.675Z","outcome":"sent"}"#, #"{"v":1,"outcome":"sent"}"#, #"{"v":1,"unseen_at":"x","outcome":"sent"}"#] {
      #expect(MainResendAnswer.decode(Data(bad.utf8)) == nil, "\(bad)")
    }
  }

  @Test func theBridgesStatusSaysWhetherItAnswersResendRequests() throws {
    let base = #"{"v":1,"pid":4,"mode":"live","relay":{"connected":true},"updated_at":"2026-11-19T02:48:27.675Z""#
    #expect(try #require(BridgeStatus.decode(Data((base + #","main_resend":true}"#).utf8))).mainResend)
    #expect(!(try #require(BridgeStatus.decode(Data((base + "}").utf8))).mainResend), "an older bridge's file")
    #expect(!(try #require(BridgeStatus.decode(Data((base + #","main_resend":"yes"}"#).utf8))).mainResend))
  }

  @Test func theLineSaysWhatTalosDidInPlainWords() throws {
    let utc = try #require(TimeZone(identifier: "UTC"))
    let at = Date(timeIntervalSince1970: 1_794_304_500)
    #expect(SupervisorNotice.mainStalled(since: at, did: .resent(min: 3), timeZone: utc)
      == "Main looked stuck for 3 min on your message; Talos pressed Esc and sent it again")
    #expect(SupervisorNotice.mainStalled(since: at, did: .failed(min: 5), timeZone: utc)
      == "Main looked stuck for 5 min on your message; Talos pressed Esc but couldn't send your message again; please resend it")
    let waiting = SupervisorNotice.mainStalled(since: at, did: .awaiting(min: 3), timeZone: utc)
    #expect(waiting.contains("pressed Esc") && !waiting.contains("sent it again"), "never claims a send before the bridge says so")
    #expect(SupervisorNotice.mainStalled(since: at, did: .none, timeZone: utc) == SupervisorNotice.mainStalled(since: at, timeZone: utc))
  }
}
