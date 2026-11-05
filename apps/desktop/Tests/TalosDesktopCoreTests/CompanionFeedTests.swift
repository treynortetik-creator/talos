import Foundation
import Testing
@testable import TalosDesktopCore

/// The companion feed decoder, the staleness gate and the last-reply tracker (DESKTOP-COMPANION-SPEC 7).
private func frame(_ over: [String: Any] = [:], drop: [String] = []) -> [String: Any] {
  var o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": false, "needs": 1, "working": 2, "queued": 0,
    "on_call": 0, "unread": 3, "failed": 0,
    "rows": [["thread_id": "general", "state": "needs_you"], ["thread_id": "daily", "state": "working"]],
    "last_reply": ["thread_id": "general", "seq": 48123],
  ]
  for (k, v) in over { o[k] = v }
  for k in drop { o[k] = nil }
  return o
}

private func feed(_ m: WebToNative?) -> CompanionFeed? {
  if case .companionState(let f)? = m { return f }
  return nil
}

@Suite("Companion feed decoding")
struct CompanionFeedDecodingTests {
  @Test func aGoodFrameDecodes() throws {
    let f = try #require(feed(WebToNative.decode(frame())))
    #expect(f.link == .online && f.macOnline && !f.busy)
    #expect(f.needs == 1 && f.working == 2 && f.queued == 0 && f.onCall == 0 && f.unread == 3 && f.failed == 0)
    #expect(f.rows.map(\.threadId) == ["general", "daily"])
    #expect(f.lastReply == .init(threadId: "general", seq: 48123))
  }

  @Test func lastReplyMayBeNull() throws {
    let f = try #require(feed(WebToNative.decode(frame(["last_reply": NSNull()]))))
    #expect(f.lastReply == nil)
  }

  @Test func anUnknownRowStateDropsThatRowNotTheFrame() throws {
    let rows: [[String: Any]] = [
      ["thread_id": "a", "state": "needs_you"], ["thread_id": "b", "state": "dreaming"], ["thread_id": "c", "state": "ready"],
    ]
    let f = try #require(feed(WebToNative.decode(frame(["rows": rows]))))
    #expect(f.rows == [.init(threadId: "a", state: .needsYou), .init(threadId: "c", state: .ready)])
    #expect(f.needs == 1 && f.working == 2)  // the counts are untouched
  }

  @Test func aMalformedRowDropsOnlyItself() throws {
    let rows: [Any] = [
      "just a string", ["thread_id": "All", "state": "ready"], ["thread_id": "ok", "state": "ready", "name": "Name"],
      ["thread_id": "fine", "state": "queued"], ["thread_id": "fine", "state": "ready"], 7,
    ]
    let f = try #require(feed(WebToNative.decode(frame(["rows": rows]))))
    #expect(f.rows == [.init(threadId: "fine", state: .queued)])  // one row per thread, the first wins
  }

  @Test func moreThanTwelveRowsAreTrimmedToTwelve() throws {
    let rows = (0..<20).map { ["thread_id": "t\($0)", "state": "working"] }
    let f = try #require(feed(WebToNative.decode(frame(["rows": rows]))))
    #expect(f.rows.count == CompanionFeed.maxRows)
    #expect(f.rows.first?.threadId == "t0" && f.rows.last?.threadId == "t11")
  }

  @Test func everyBadTopLevelFrameIsInvalidNeverNilAndNeverTheOldFeed() {
    let bad: [(String, [String: Any])] = [
      ("extra field", frame(["text": "a name"])),
      ("missing busy", frame(drop: ["busy"])),
      ("missing rows", frame(drop: ["rows"])),
      ("negative count", frame(["needs": -1])),
      ("count over the cap", frame(["unread": 100_000])),
      ("fractional count", frame(["working": 2.5])),
      ("bool as count", frame(["failed": true])),
      ("string count", frame(["queued": "2"])),
      ("number as bool", frame(["busy": 1])),
      ("unknown link", frame(["link": "asleep"])),
      ("link not a string", frame(["link": 3])),
      ("rows not an array", frame(["rows": "none"])),
      ("last_reply not an object", frame(["last_reply": "x"])),
      ("last_reply extra key", frame(["last_reply": ["thread_id": "general", "seq": 1, "text": "hi"]])),
      ("last_reply negative seq", frame(["last_reply": ["thread_id": "general", "seq": -1]])),
      ("last_reply bad thread", frame(["last_reply": ["thread_id": "All", "seq": 1]])),
      ("last_reply fractional seq", frame(["last_reply": ["thread_id": "general", "seq": 1.5]])),
      ("missing last_reply", frame(drop: ["last_reply"])),
    ]
    for (name, f) in bad { #expect(WebToNative.decode(f) == .companionInvalid, "\(name)") }
  }

  @Test func anOldPagesUnknownCompanionLikeTypeIsStillJustUnknown() {
    #expect(WebToNative.decode(["type": "companion_state2", "link": "online"]) == nil)
    #expect(WebToNative.decode(["type": "companion_reply_request", "req": "r1", "thread_id": "general"]) == nil)  // wrong direction
  }

  @Test func theReplyDecodesStrictly() {
    let ok: [String: Any] = ["type": "companion_reply", "req": "r12", "thread_id": "general", "text": "Hi", "truncated": false]
    #expect(WebToNative.decode(ok) == .companionReply(.init(req: "r12", threadId: "general", text: "Hi", truncated: false)))
    var nullText = ok
    nullText["text"] = NSNull()
    #expect(WebToNative.decode(nullText) == .companionReply(.init(req: "r12", threadId: "general", text: nil, truncated: false)))
    var long = ok
    long["text"] = String(repeating: "a", count: 500)
    #expect(WebToNative.decode(long) != nil)
    long["text"] = String(repeating: "a", count: 501)
    #expect(WebToNative.decode(long) == nil)
    for (k, v) in [("req", "" as Any), ("req", "r 1"), ("req", String(repeating: "r", count: 33)), ("thread_id", "ALL"), ("truncated", 1), ("text", 5), ("extra", 1)] {
      var b = ok
      b[k] = v
      #expect(WebToNative.decode(b) == nil, "\(k)=\(v)")
    }
    var missing = ok
    missing["req"] = nil
    #expect(WebToNative.decode(missing) == nil)
  }

  @Test func theReplyRequestIsBuiltOnlyWhenValid() throws {
    let m = NativeToWeb.companionReplyRequest(req: "r12", threadId: "general")
    #expect(NativeToWeb.validated(m) == m)
    let js = try #require(m.javascript())
    #expect(js.hasPrefix("window.talosNative && window.talosNative.receive("))
    #expect(NativeToWeb.companionReplyRequest(req: "", threadId: "general").javascript() == nil)
    #expect(NativeToWeb.companionReplyRequest(req: "r 1", threadId: "general").javascript() == nil)
    #expect(NativeToWeb.companionReplyRequest(req: "r1", threadId: "all").javascript() == nil)
    #expect(NativeToWeb.companionReplyRequest(req: "r1", threadId: "Bad Id").javascript() == nil)
  }
}

@Suite("Companion feed gate")
struct CompanionFeedGateTests {
  let t0 = ContinuousClock.now
  let f1 = CompanionFeed(link: .online, macOnline: true, busy: false, needs: 1)
  let f2 = CompanionFeed(link: .online, macOnline: true, busy: true, needs: 1)

  @Test func aFrameIsStoredAndAnEqualOneOnlyRefreshesTheClock() {
    var g = CompanionFeedGate()
    #expect(g.feed == nil)
    let r1 = g.accept(f1, at: t0)
    #expect(r1)
    let r2 = g.accept(f1, at: t0.advanced(by: .seconds(30)))
    #expect(!r2) // equal: no change reported
    let r3 = g.accept(f2, at: t0.advanced(by: .seconds(31)))
    #expect(r3)
    #expect(g.feed == f2)
  }

  @Test func ninetySecondsOfSilenceClearsIt() {
    var g = CompanionFeedGate()
    g.accept(f1, at: t0)
    let r4 = g.expireIfStale(at: t0.advanced(by: .seconds(89)))
    #expect(!r4)
    #expect(g.feed == f1)
    let r5 = g.expireIfStale(at: t0.advanced(by: .seconds(90)))
    #expect(r5)
    #expect(g.feed == nil)
    let r6 = g.expireIfStale(at: t0.advanced(by: .seconds(500)))
    #expect(!r6) // nothing left to clear
  }

  @Test func theThirtySecondTickKeepsItAliveForever() {
    var g = CompanionFeedGate()
    var t = t0
    for _ in 0..<200 {  // an hour and a half of identical frames
      g.accept(f1, at: t)
      t = t.advanced(by: .seconds(30))
      let r7 = g.expireIfStale(at: t)
      #expect(!r7)
    }
    #expect(g.feed == f1)
  }

  @Test func theStaleDeadlineMovesWithEachFrameAndEndsAtNilWithNoFeed() {
    var g = CompanionFeedGate()
    #expect(g.untilStale(at: t0) == nil)
    g.accept(f1, at: t0)
    #expect(g.untilStale(at: t0.advanced(by: .seconds(30))) == .seconds(60))
    g.accept(f1, at: t0.advanced(by: .seconds(30)))
    #expect(g.untilStale(at: t0.advanced(by: .seconds(30))) == .seconds(90))
    #expect(g.untilStale(at: t0.advanced(by: .seconds(500))) == .zero)  // never negative
    g.clear()
    #expect(g.untilStale(at: t0) == nil)
  }

  @Test func clearReportsWhetherThereWasAFeed() {
    var g = CompanionFeedGate()
    let r8 = g.clear()
    #expect(!r8)
    g.accept(f1, at: t0)
    let r9 = g.clear()
    #expect(r9)
    #expect(g.feed == nil)
    let r10 = g.expireIfStale(at: t0.advanced(by: .seconds(1000)))
    #expect(!r10)
  }
}

@Suite("Last reply tracker")
struct LastReplyTrackerTests {
  func answer(_ req: String, _ thread: String = "general", text: String? = "Hi") -> CompanionReply {
    CompanionReply(req: req, threadId: thread, text: text, truncated: false)
  }

  @Test func theCurrentAnswerIsShownOnce() {
    var t = LastReplyTracker()
    let (req, old) = t.begin(thread: "general")
    #expect(old == nil && CompanionReq.isValid(req))
    let r11 = t.accept(answer(req))
    #expect(r11 == .text("Hi", truncated: false))
    let r12 = t.accept(answer(req))
    #expect(r12 == nil) // the same answer twice
  }

  @Test func anEmptyAnswerIsEmptyNotText() {
    var t = LastReplyTracker()
    let (a, _) = t.begin(thread: "general")
    let r13 = t.accept(answer(a, text: nil))
    #expect(r13 == .empty)
    let (b, _) = t.begin(thread: "general")
    let r14 = t.accept(answer(b, text: ""))
    #expect(r14 == .empty)
  }

  @Test func aLateAnswerToAnOlderClickIsDropped() {
    var t = LastReplyTracker()
    let (first, _) = t.begin(thread: "general")
    let (second, replaced) = t.begin(thread: "daily")
    #expect(replaced == first && first != second)
    let r15 = t.accept(answer(first))
    #expect(r15 == nil)
    let r16 = t.accept(answer(second, "general"))
    #expect(r16 == nil) // right request, wrong thread
    let r17 = t.accept(answer(second, "daily"))
    #expect(r17 == .text("Hi", truncated: false))
  }

  @Test func aLateAnswerToAnOlderClickOnTheSameThreadIsDropped() {
    var t = LastReplyTracker()
    let (first, _) = t.begin(thread: "general")
    let (second, _) = t.begin(thread: "general")
    let late = t.accept(answer(first))
    #expect(late == nil, "the first click's answer must not be shown for the second click")
    let current = t.accept(answer(second, text: "second"))
    #expect(current == .text("second", truncated: false))
  }

  @Test func anAnswerWithNoRequestIsDropped() {
    var t = LastReplyTracker()
    let r18 = t.accept(answer("r1"))
    #expect(r18 == nil)
  }

  @Test func timeoutEndsOnlyTheRequestItBelongsTo() {
    var t = LastReplyTracker()
    let (first, _) = t.begin(thread: "general")
    let (second, _) = t.begin(thread: "general")
    let r19 = t.expire(req: first)
    #expect(!r19) // the old one's timer fires late: nothing happens
    let r20 = t.expire(req: second)
    #expect(r20)
    let r21 = t.accept(answer(second))
    #expect(r21 == nil) // and a late answer after the timeout is dropped
  }

  @Test func cancelEndsWhateverIsPending() {
    var t = LastReplyTracker()
    let r22 = t.cancel()
    #expect(r22 == nil)
    let (req, _) = t.begin(thread: "general")
    let r23 = t.cancel()
    #expect(r23 == req)
    let r24 = t.accept(answer(req))
    #expect(r24 == nil)
  }

  @Test func theTimeoutIsThreeSeconds() {
    #expect(LastReplyTracker.timeout == .seconds(3))
  }
}
