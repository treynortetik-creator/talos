import Foundation
import Testing
@testable import TalosDesktopCore

/// Running a script in the owner's shell pane (docs/TERMINAL-PANE.md "One path to the shell"): the parts that need no window. The
/// witness table, the click window, the text that goes to the shell, the request's shape, the socket ops, the page's `run_witness`.
/// The table behind a class, so a `#expect` can call it (a macro cannot mutate a captured struct).
final class Book {
  var b = RunWitnessBook()
  var count: Int { b.count }
  @discardableResult func record(id: String, thread: String, sha: [UInt8], at: Double) -> RunWitnessBook.Recorded { b.record(id: id, thread: thread, sha: sha, at: at) }
  func consume(id: String, thread: String, sha: [UInt8], now: Double) -> RunWitnessBook.Outcome { b.consume(id: id, thread: thread, sha: sha, now: now) }
}

@Suite("Pane run")
struct PaneRunTests {
  let A = "m_01HZZZZZZZZZZZZZZZZZZZZZZA"
  let B = "m_01HZZZZZZZZZZZZZZZZZZZZZZB"
  let SCRIPT = "echo hello\nls -la\n"
  var sha: [UInt8] { PaneRun.sha256(SCRIPT) }
  var shaHex: String { PaneRun.sha256Hex(SCRIPT) }

  // MARK: the text that goes to the shell

  @Test func aScriptIsOneBracketedPasteThenExactlyOneReturnAndThereIsNoOtherWay() {
    #expect(PaneRun.bytes(script: SCRIPT) == Array("\u{1b}[200~echo hello\nls -la\u{1b}[201~\r".utf8))
  }

  @Test func theScriptsOwnFinalLineBreakIsDroppedOnceAndTheReturnIsNeverDoubled() {
    let one = [0x1b] + Array("[200~ls".utf8) + [0x1b] + Array("[201~".utf8) + [0x0d]
    #expect(PaneRun.bytes(script: "ls\n") == one)
    #expect(PaneRun.bytes(script: "ls") == one, "a script with no final line break is pasted as it is")
    #expect(PaneRun.bytes(script: "ls\n\n") == [0x1b] + Array("[200~ls\n".utf8) + [0x1b] + Array("[201~".utf8) + [0x0d], "only one is dropped")
    #expect(PaneRun.bytes(script: "a\tb\n").contains(0x09), "a tab goes as a tab: inside a paste it is not completion")
    #expect(PaneRun.bytes(script: SCRIPT).filter { $0 == 0x0d }.count == 1, "one Return, at the end")
  }

  @Test func theOutputPulseKeepsACountAndATimeAndNothingElse() {
    let p = OutputPulse()
    #expect(p.state.count == 0)
    p.tick(now: 10)
    p.tick(now: 12.5)
    #expect(p.state.count == 2 && p.state.lastAt == 12.5)
  }

  // MARK: what may be sent at all

  @Test func aPlainScriptPassesAndEverythingThatIsNotPlainTextIsRefused() {
    #expect(PaneRun.scriptProblem(SCRIPT) == nil)
    #expect(PaneRun.scriptProblem("for f in a b; do\n\techo $f\ndone\n") == nil)
    let bad: [String] = [
      "", "\n", " \n\t", "no newline", "echo hi\u{1b}[201~\nrm -rf x\n", "echo\u{0}x\n", "echo\rx\n", "echo \u{202E}x\n", "echo\u{200B}x\n",
      "echo\u{7f}\n", "echo \u{85}x\n", "echo \u{2028}x\n", String(repeating: "a", count: PaneRun.maxScriptChars) + "\n",
    ]
    for s in bad { #expect(PaneRun.scriptProblem(s) != nil, "\(s.debugDescription) was let through") }
    #expect(PaneRun.scriptProblem(String(repeating: "a", count: PaneRun.maxScriptChars - 1) + "\n") == nil)
  }

  @Test func everyC0AndC1ControlButLineFeedAndTabIsRefused() {
    for c in Array(UInt32(0x00)...0x08) + Array(UInt32(0x0b)...0x1f) + Array(UInt32(0x7f)...0x9f) {
      let scalar = Unicode.Scalar(c)!
      let script = "echo a" + String(Character(scalar)) + "b\n"
      #expect(PaneRun.scriptProblem(script) != nil, "U+\(String(c, radix: 16)) was let through")
    }
    #expect(PaneRun.scriptProblem("echo a\tb\n") == nil, "a tab is plain")
    #expect(PaneRun.scriptProblem("echo a\n\necho b\n") == nil, "so are line feeds")
    // both ways to end a bracketed paste early
    #expect(PaneRun.scriptProblem("echo a\u{1b}[201~\ntouch pwned\n") != nil)
    #expect(PaneRun.scriptProblem("echo a\u{9b}201~\ntouch pwned\n") != nil)
  }

  @Test func aPastedEndMarkerCannotEndTheBracketedPasteEarly() {
    // the one way a paste could carry a second command is an escape sequence in the text; it never gets that far
    #expect(PaneRun.scriptProblem("echo a\u{1b}[201~\ntouch pwned\n") != nil)
  }

  // MARK: the Run's budget and the bridge's patience

  @Test func theBridgeWaitsLongerThanTheAppCanTakeAndTheTwoSidesAgreeOnTheBudget() throws {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let ts = try String(contentsOf: url.appending(path: "apps/bridge/src/pane-run.ts"), encoding: .utf8)
    let b = try #require(ts.range(of: #"PANE_RUN_APP_BUDGET_MS = [0-9_]+"#, options: .regularExpression))
    let budgetMs = try #require(Double(ts[b].split(separator: "=").last!.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "")))
    #expect(budgetMs / 1000 == PaneRun.totalBudgetSeconds, "the bridge's idea of the app's budget and PaneRun.totalBudgetSeconds drifted")
    let t = try #require(ts.range(of: #"PANE_RUN_TIMEOUT_MS = PANE_RUN_APP_BUDGET_MS \+ [0-9_]+"#, options: .regularExpression))
    let margin = try #require(Double(ts[t].split(separator: "+").last!.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "")))
    #expect(margin >= 2000, "the bridge waits at least two seconds more than the app's whole budget")
    // every wait fits in the budget with room to write
    #expect(PaneRun.witnessWaitSeconds + PaneRun.paneWaitSeconds + PaneRun.clearWaitSeconds < PaneRun.totalBudgetSeconds)
    #expect(PaneRun.clearWaitSeconds >= 3, "a prompt with a slow hook gets time to come back")
  }

  // MARK: the click window

  @Test func aClickCountsInsideTwoSecondsAndNotAfter() {
    var h = HumanActivation()
    let never = h.isFresh(now: 100)
    h.record(at: 100)
    let a = h.isFresh(now: 101.9), b = h.isFresh(now: 102.0), c = h.isFresh(now: 102.1), d = h.isFresh(now: 99)
    #expect(!never)
    #expect(a)
    #expect(b)
    #expect(!c)
    #expect(!d, "a clock reading from before the click is nothing")
  }

  @Test func oneClickVouchesForOneThing() {
    var h = HumanActivation()
    h.record(at: 100)
    let first = h.take(now: 100.5)
    let second = h.take(now: 100.6)
    h.record(at: 200)
    let old = h.take(now: 202.1)
    #expect(first)
    #expect(!second, "the stamp is spent by the first witness after it")
    #expect(!old, "and a click that is too old is not spent into a witness")
  }

  @Test func theWindowIsTheSameTwoSecondsAsTheProtocolSays() throws {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let ts = try String(contentsOf: url.appending(path: "packages/protocol/src/run.ts"), encoding: .utf8)
    let m = try #require(ts.range(of: #"RUN_PANE_CLICK_MS = (\d+)"#, options: .regularExpression))
    let ms = try #require(Double(ts[m].split(separator: " ").last ?? ""))
    #expect(ms / 1000 == PaneRun.clickSeconds, "RUN_PANE_CLICK_MS and PaneRun.clickSeconds drifted")
  }

  // MARK: the witness table

  @Test func aWitnessIsSpentOnceAndAReplayIsRefused() {
    let b = Book()
    #expect(b.record(id: A, thread: "trip", sha: sha, at: 10) == .kept)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 11) == .granted)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 11.1) == .missing, "it is gone once used")
    #expect(b.record(id: A, thread: "trip", sha: sha, at: 12) == .spent, "a witness is never taken again for a Run that ran")
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 12.1) == .missing)
  }

  @Test func aSecondWitnessForAWaitingMessageIsNotTaken() {
    let b = Book()
    #expect(b.record(id: A, thread: "trip", sha: sha, at: 10) == .kept)
    #expect(b.record(id: A, thread: "trip", sha: PaneRun.sha256("rm -rf ~\n"), at: 10.5) == .duplicate)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 11) == .granted, "the first claim stands")
  }

  @Test func aWitnessForOneIdDoesNotOpenAnother() {
    let b = Book()
    b.record(id: A, thread: "trip", sha: sha, at: 10)
    #expect(b.consume(id: B, thread: "trip", sha: sha, now: 11) == .missing)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 11) == .granted)
  }

  @Test func aMismatchBurnsTheWitnessSoAWrongRunCannotBeFollowedByARightOne() {
    let b = Book()
    b.record(id: A, thread: "trip", sha: sha, at: 10)
    #expect(b.consume(id: A, thread: "trip", sha: PaneRun.sha256("rm -rf ~\n"), now: 11) == .otherScript)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 11) == .missing)
    b.record(id: B, thread: "trip", sha: sha, at: 10)
    #expect(b.consume(id: B, thread: "other", sha: sha, now: 11) == .otherThread)
    #expect(b.consume(id: B, thread: "trip", sha: sha, now: 11) == .missing)
  }

  @Test func theHashIsOfTheExactBytesAndATrailingLineFeedIsPartOfIt() {
    #expect(PaneRun.sha256("echo hi\n") != PaneRun.sha256("echo hi"))
    #expect(PaneRun.sha256("echo hi\n") != PaneRun.sha256("echo hi\n "))
    #expect(PaneRun.hexBytes(PaneRun.sha256Hex("echo hi\n")) == PaneRun.sha256("echo hi\n"))
    #expect(PaneRun.hexBytes(String(repeating: "A", count: 64)) == nil)
    #expect(PaneRun.hexBytes("zz" + String(repeating: "a", count: 62)) == nil)
    // a decomposed accent and the composed one are different scripts: bytes, never Swift's canonical String equality
    #expect(PaneRun.sha256("caf\u{e9}\n") != PaneRun.sha256("cafe\u{301}\n"))
    let b = Book()
    b.record(id: A, thread: "trip", sha: PaneRun.sha256("caf\u{e9}\n"), at: 1)
    #expect(b.consume(id: A, thread: "trip", sha: PaneRun.sha256("cafe\u{301}\n"), now: 2) == .otherScript)
  }

  @Test func aWitnessExpiresAfterThirtySecondsAndIsGone() {
    let b = Book()
    b.record(id: A, thread: "trip", sha: sha, at: 10)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 40.1) == .expired)
    #expect(b.consume(id: A, thread: "trip", sha: sha, now: 40.2) == .missing)
    b.record(id: B, thread: "trip", sha: sha, at: 100)
    #expect(b.consume(id: B, thread: "trip", sha: sha, now: 130) == .granted)
    let c = Book()
    c.record(id: A, thread: "trip", sha: sha, at: 100)
    #expect(c.consume(id: A, thread: "trip", sha: sha, now: 50) == .expired, "a clock that moved back is not fresh")
  }

  @Test func aFullTableRefusesTheNewWitnessAndNeverDropsOneThatIsWaiting() {
    let b = Book()
    func id(_ n: Int) -> String { "m_01HZZZZZZZZZZZZZZZZZZZZZ" + String(format: "%02d", n) }
    for n in 0..<16 { #expect(b.record(id: id(n), thread: "trip", sha: sha, at: Double(n)) == .kept) }
    #expect(b.record(id: id(16), thread: "trip", sha: sha, at: 16) == .full)
    #expect(b.count == 16)
    #expect(b.consume(id: id(0), thread: "trip", sha: sha, now: 17) == .granted, "the oldest is still there")
    #expect(b.record(id: id(16), thread: "trip", sha: sha, at: 17) == .kept, "room again once one is used")
    // witnesses past their thirty seconds leave by themselves
    #expect(b.record(id: id(17), thread: "trip", sha: sha, at: 17) == .full)
    #expect(b.record(id: id(17), thread: "trip", sha: sha, at: 100) == .kept)
  }

  @Test func twoRunsForOneWitnessAtOnceHaveOneWinner() async {
    actor Holder { let b = Book(); func put(_ id: String, _ s: [UInt8]) { b.record(id: id, thread: "trip", sha: s, at: 1) }
      func take(_ id: String, _ s: [UInt8]) -> RunWitnessBook.Outcome { b.consume(id: id, thread: "trip", sha: s, now: 2) } }
    let h = Holder()
    let (id, s) = (A, sha)
    await h.put(id, s)
    let r = await withTaskGroup(of: RunWitnessBook.Outcome.self) { g in
      for _ in 0..<8 { g.addTask { await h.take(id, s) } }
      var out: [RunWitnessBook.Outcome] = []
      for await o in g { out.append(o) }
      return out
    }
    #expect(r.filter { $0 == .granted }.count == 1)
    #expect(r.filter { $0 == .missing }.count == 7)
  }

  // MARK: shapes

  @Test func idsAndHashesHaveTheirExactShape() {
    #expect(PaneRun.isMsgId(A))
    for bad in ["", "m_", "x_01HZZZZZZZZZZZZZZZZZZZZZZA", "m_01HZZZZZZZZZZZZZZZZZZZZZZ", "m_01hzzzzzzzzzzzzzzzzzzzzzza", "m_01HZZZZZZZZZZZZZZZZZZZZZZAI", A + "\n"] {
      #expect(!PaneRun.isMsgId(bad), "\(bad)")
    }
    #expect(PaneRun.isSha256Hex(shaHex))
    #expect(!PaneRun.isSha256Hex(shaHex.uppercased()))
    #expect(!PaneRun.isSha256Hex(String(shaHex.dropLast())))
    #expect(PaneRun.sha256Hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }

  @Test func aRequestHasExactlyItsFields() {
    let ok: [String: Any] = ["v": 1, "id": A, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": A]
    #expect(PaneRunRequest.parse(ok).request == PaneRunRequest(threadId: "trip", script: SCRIPT, clientMsgId: A))
    for (k, v) in [("extra", "x"), ("signed_by", "d_x")] as [(String, Any)] {
      var o = ok
      o[k] = v
      #expect(PaneRunRequest.parse(o).request == nil, "\(k)")
    }
    for (k, v) in [("thread_id", "All"), ("thread_id", "all"), ("client_msg_id", "x"), ("script", 7)] as [(String, Any)] {
      var o = ok
      o[k] = v
      let p = PaneRunRequest.parse(o)
      #expect(p.request == nil && p.problem != nil, "\(k)=\(v)")
    }
  }

  // MARK: the page's witness message

  @Test func aWitnessMessageDecodesAndTheDecoderRefusesWhatCannotBeOne() throws {
    let good: [String: Any] = ["type": "run_witness", "thread_id": "trip", "client_msg_id": A, "script_sha256": shaHex]
    #expect(WebToNative.decode(good) == .runWitness(threadId: "trip", clientMsgId: A, scriptSha256: shaHex))
    let cases: [(String, Any?)] = [
      ("script", "echo hi\n"), ("input", "ls\n"), ("at", 1_800_000_000), ("time", "2026-11-18T10:00:00Z"), ("command", "x"), ("cwd", "/home/alex"),
    ]
    for (k, v) in cases {
      var o = good
      o[k] = v
      #expect(WebToNative.decode(o) == nil, "a witness with `\(k)` was taken")
    }
    var o = good
    o["script_sha256"] = shaHex.uppercased()
    #expect(WebToNative.decode(o) == nil, "capital hex")
    o["script_sha256"] = String(shaHex.prefix(63))
    #expect(WebToNative.decode(o) == nil, "short hash")
    o = good
    o.removeValue(forKey: "client_msg_id")
    #expect(WebToNative.decode(o) == nil, "no id")
    o = good
    o["client_msg_id"] = "m_short"
    #expect(WebToNative.decode(o) == nil, "bad id")
    o = good
    o["thread_id"] = "all"
    #expect(WebToNative.decode(o) == nil, "all is not a thread")
  }

  @Test func aRunResultIsTheOnlyThingTheAppSaysAboutARun() throws {
    let ok = NativeToWeb.runResult(clientMsgId: A, ok: true, reason: nil)
    #expect(NativeToWeb.validated(ok) == ok)
    #expect(ok.object["type"] as? String == "run_result" && ok.object["reason"] == nil)
    for r in [RunResultReason.noWitness, .expired, .notStarted, .paneBusy, .appClosed, .badScript] {
      let m = NativeToWeb.runResult(clientMsgId: A, ok: false, reason: r)
      #expect(NativeToWeb.validated(m) == m)
      #expect(m.object["reason"] as? String == r.rawValue)
      #expect(m.object.keys.sorted() == ["client_msg_id", "ok", "reason", "type"], "no text from the shell, no script")
    }
    #expect(NativeToWeb.validated(.runResult(clientMsgId: A, ok: false, reason: nil)) == nil, "a failure says why")
    #expect(NativeToWeb.validated(.runResult(clientMsgId: A, ok: true, reason: .expired)) == nil)
    #expect(NativeToWeb.validated(.runResult(clientMsgId: "x", ok: true, reason: nil)) == nil)
    // every refusal the app makes has a code the page has a word for
    for a in [PaneRunAnswer.noWitness, .mismatch, .witnessExpired, .noPane, .noShell, .busy, .badScript("x")] { #expect(RunResultReason(rawValue: a.code) != nil, "\(a.code)") }
    // a script refused for what it holds is told to the page as `bad_script`, and as nothing else
    #expect(RunResultReason.forAnswer(.badScript("x")) == .badScript)
    #expect(RunResultReason.forAnswer(.no("something_new", "x")) == .notStarted, "a code the page has no word for is never ok")
    #expect(RunResultReason.forAnswer(.done) == nil)
    // a hostile id is not sent
    #expect(NativeToWeb.validated(.runResult(clientMsgId: "../x", ok: false, reason: .expired)) == nil)
    #expect(NativeToWeb.validated(.runResult(clientMsgId: "m_01JBF3V7Q8K2M4N6P8R0S1T2V3\n", ok: true, reason: nil)) == nil)
  }

  // MARK: the socket

  final class Recorder: PaneRunService, @unchecked Sendable {
    let lock = NSLock()
    var requests: [PaneRunRequest] = []
    var reply = PaneRunAnswer.done
    func ready() async -> Bool { true }
    func run(_ r: PaneRunRequest) async -> PaneRunAnswer { lock.withLock { requests.append(r) }; return reply }
  }

  private func ask(_ p: ScreenProtocol, _ o: [String: Any]) async throws -> [String: Any] {
    let d = await p.answer(try JSONSerialization.data(withJSONObject: o))
    return try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
  }
  private func proto(_ r: Recorder?) -> ScreenProtocol {
    ScreenProtocol(service: FakeScreenService(), allowList: EmptyScreenAllowList(), signing: FakeSigning(), paneRun: r)
  }

  @Test func theSocketHandsAPaneRunToTheChannelAndAnswersItsAnswer() async throws {
    let r = Recorder()
    let o = try await ask(proto(r), ["v": 1, "id": A, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": A])
    #expect(o["ok"] as? Bool == true)
    #expect(r.requests == [PaneRunRequest(threadId: "trip", script: SCRIPT, clientMsgId: A)])
    r.reply = .noWitness
    let n = try await ask(proto(r), ["v": 1, "id": A, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": A])
    #expect(n["ok"] as? Bool == false)
    let e = try #require(n["error"] as? [String: Any])
    #expect(e["code"] as? String == "no_witness")
    #expect((e["text"] as? String)?.contains("click") == true)
  }

  @Test func aBadRequestNeverReachesTheChannel() async throws {
    let r = Recorder()
    for o in [
      ["v": 1, "op": "pane_run", "thread_id": "trip", "script": 7, "client_msg_id": A],
      ["v": 1, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": A, "signed_by": "d_x"],
      ["v": 1, "op": "pane_run", "thread_id": "Trip", "script": SCRIPT, "client_msg_id": A],
      ["v": 1, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": "m_x"],
    ] as [[String: Any]] {
      let a = try await ask(proto(r), o)
      #expect(a["ok"] as? Bool == false)
    }
    #expect(r.requests.isEmpty)
  }

  @Test func withNoChannelTheSocketSaysSoAndOnlyPaneRunTouchesTheChannel() async throws {
    let none = try await ask(proto(nil), ["v": 1, "op": "pane_run", "thread_id": "trip", "script": SCRIPT, "client_msg_id": A])
    #expect((none["error"] as? [String: Any])?["code"] as? String == "pane_unavailable")
    let st = try await ask(proto(nil), ["v": 1, "op": "pane_status"])
    #expect((st["error"] as? [String: Any])?["code"] as? String == "pane_unavailable")
    let r = Recorder()
    #expect(try await ask(proto(r), ["v": 1, "op": "pane_status"])["ok"] as? Bool == true)
    // every other op, and a made-up one: the channel is never asked
    for op in ["apps", "key", "type", "click", "scroll", "open_app", "ask_info", "allow", "shot", "pane_runs", "PANE_RUN"] {
      _ = try await ask(proto(r), ["v": 1, "op": op, "keys": "return", "text": "ls\n", "x": 1, "y": 1, "script": SCRIPT, "thread_id": "trip", "client_msg_id": A])
    }
    #expect(r.requests.isEmpty)
  }
}
