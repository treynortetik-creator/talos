import Foundation
import Testing

@testable import TalosDesktopCore

/// C-LIVE review round: each finding is a test here, driven through the real reducer, tray builder and decoder.
private func frame(
  busy: Bool = false, needs: Int = 0, working: Int = 0, queued: Int = 0, unread: Int = 0, failed: Int = 0,
  rows: [[String: Any]] = [], reply: (String, Int)? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": busy, "needs": needs, "working": working, "queued": queued,
    "on_call": 0, "unread": unread, "failed": failed, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

private let threads = [
  CompanionThreadRef(id: "alpha", name: "Alpha"), CompanionThreadRef(id: "beta", name: "Beta"),
]

private extension Rig {
  mutating func feed(_ f: CompanionFeed?) {
    inputs.feed = f
    inputs.pageStatus = f == nil ? .down : .ready
    inputs.threads = threads
  }
}

@Suite("Companion LIVE review: a stale Working claim")
struct CompanionStaleWorkingTests {
  @Test func aRowTheRelayNeverClearedDoesNotHoldWorkingAfterTheOwnerStoppedTheSession() {
    var r = Rig()
    r.inputs.session = .stopped(byOwner: true)
    r.feed(frame(queued: 1, rows: [["thread_id": "alpha", "state": "queued"]]))
    r.advance(10)
    let o = r.tick()
    #expect(o.state == .idle)
    #expect(o.word == "Session stopped by you")
  }

  @Test func aQueuedCountThatNeverChangesStopsCountingAfterFifteenMinutesAndTheDotShowsAgain() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    // He messaged a busy agent: queued 1. The agent then answered with a plain reply, which the relay never turns into a status.
    r.feed(frame(queued: 1, rows: [["thread_id": "alpha", "state": "queued"]]))
    #expect(r.advance(10).state == .working)
    r.feed(frame(queued: 1, unread: 1, rows: [["thread_id": "alpha", "state": "queued"]], reply: ("alpha", 1)))
    r.advance(100)
    #expect(r.tick().state == .working, "a real long turn is not cut short early")
    r.advance(CompanionModel.staleWork)
    let o = r.advance(CompanionModel.leaveWorking + 1)
    #expect(o.state == .idle)
    #expect(o.dot, "and the unread dot is back, because Working no longer hides it")
  }

  @Test func aCountThatKeepsChangingIsNeverStale() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    for k in 0..<4 {
      r.feed(frame(working: 1 + k % 2, rows: [["thread_id": "alpha", "state": "working"]]))
      r.advance(CompanionModel.staleWork - 60)
      #expect(r.tick().state == .working)
    }
  }

  @Test func theBusyFlagIsNotStaleness() {
    var r = Rig()
    r.feed(frame(busy: true))
    r.advance(CompanionModel.staleWork * 2)
    #expect(r.tick().state == .working)
  }
}

@Suite("Companion LIVE review: replies in two threads")
struct CompanionTwoThreadTests {
  @Test func eachWorkingThreadsReplyGetsItsOwnBubbleWhenItFinishes() {
    var r = Rig()
    let both: [[String: Any]] = [["thread_id": "alpha", "state": "working"], ["thread_id": "beta", "state": "working"]]
    r.feed(frame(working: 2, rows: both))
    r.advance(3)
    r.feed(frame(working: 2, rows: both, reply: ("alpha", 10)))
    r.tick(1)
    r.feed(frame(working: 2, rows: both, reply: ("beta", 11)))
    r.tick(1)
    #expect(r.bubbles.isEmpty, "both are still mid-turn")
    r.feed(frame(working: 1, unread: 1, rows: [["thread_id": "beta", "state": "working"]], reply: ("beta", 11)))  // alpha done
    r.advance(1)
    #expect(r.bubbles == ["New reply in Alpha"], "alpha's reply is not erased by beta's")
    r.feed(frame(unread: 2, rows: [["thread_id": "alpha", "state": "ready"], ["thread_id": "beta", "state": "ready"]], reply: ("beta", 11)))
    r.advance(2)
    #expect(r.bubbles == ["New reply in Alpha", "New reply in Beta"])
    #expect(r.anims.filter { $0 == "jumping" }.count == 1, "still one hop a minute")
  }

  @Test func twoThreadsThatFinishInTheSamePassAreBothAnnounced() {
    var r = Rig()
    let both: [[String: Any]] = [["thread_id": "alpha", "state": "working"], ["thread_id": "beta", "state": "working"]]
    r.feed(frame(working: 2, rows: both))
    r.advance(3)
    r.feed(frame(working: 2, rows: both, reply: ("alpha", 10)))
    r.tick(1)
    r.feed(frame(working: 2, rows: both, reply: ("beta", 11)))
    r.tick(1)
    r.feed(frame(unread: 2, rows: [], reply: ("beta", 11)))
    r.advance(8)
    #expect(Set(r.bubbles) == ["New reply in Alpha", "New reply in Beta"])
  }
}

@Suite("Companion LIVE review: a Done that never showed")
struct CompanionLostDoneTests {
  @Test func aDoneThatSomethingOutrankedDoesNotBlockOrHijackTheNextOne() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(needs: 1, unread: 1, rows: [["thread_id": "beta", "state": "needs_you"]], reply: ("alpha", 1)))
    r.advance(6)  // Done's hold ran out while Needs you was showing
    r.feed(frame(unread: 1, reply: ("alpha", 1)))
    r.advance(CompanionModel.doneGap + 10)
    r.feed(frame(unread: 2, reply: ("beta", 2)))
    r.advance(4)
    #expect(r.bubbles.filter { $0.hasPrefix("New reply") } == ["New reply in Beta"], "beta gets its bubble, alpha's stale one is gone")
  }
}

@Suite("Companion LIVE review: dots and reloads")
struct CompanionDotAndReloadTests {
  @Test func aFeedBlipDoesNotEraseTheUnreadOrFailedDots() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(unread: 1, failed: 1, reply: ("alpha", 1)))
    r.advance(CompanionModel.troubleHold + 4)
    #expect(r.tick().dot)
    r.feed(nil)  // a wake, a reload or 90 s of silence
    r.advance(5)
    r.feed(frame(unread: 1, failed: 1, reply: ("alpha", 1)))
    #expect(r.advance(1).dot, "the same unread and failed count again: the dot is back")
    r.feed(frame(unread: 0, failed: 0, reply: ("alpha", 1)))
    #expect(!r.advance(1).dot, "and it still goes when nothing is unread or failed")
  }

  @Test func failuresTheReloadedOutboxFailsAgainAreNotNewTrouble() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 2))
    r.advance(CompanionModel.troubleHold + 4)
    r.feed(nil)  // the page reloads: `failed` is memory only
    r.advance(5)
    r.feed(frame(failed: 0))
    r.tick()
    r.feed(frame(failed: 1))  // the persisted outbox is flushed and the relay refuses the first again
    #expect(r.advance(1).state == .idle)
    r.feed(frame(failed: 2))
    #expect(r.advance(1).state == .idle, "back to the count it had before")
    #expect(!r.bubbles.contains("A message didn't send") || r.bubbles.count == 1, "only the first failure's bubble")
    r.feed(frame(failed: 3))
    #expect(r.advance(1).state == .trouble, "one more than it had is a real failure")
  }

  @Test func theSettleWindowEndsSoALaterFailureAfterAReloadFires() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 2))
    r.advance(CompanionModel.troubleHold + 4)
    r.feed(nil)
    r.advance(5)
    r.feed(frame(failed: 0))
    r.advance(CompanionModel.reloadSettle + 5)
    r.feed(frame(failed: 1))
    #expect(r.advance(1).state == .trouble)
  }
}

@Suite("Companion LIVE review: the status list total")
struct CompanionTotalTests {
  private func inputs(_ f: CompanionFeed) -> CompanionInputs {
    var i = CompanionInputs()
    i.pageStatus = .ready
    i.feed = f
    return i
  }

  @Test func moreAndTheButtonCountComeFromTheFeedsCountsWhenThePageCappedItsRows() {
    let rows = (0..<12).map { ["thread_id": "t\($0)", "state": "working"] }
    let t = CompanionTray.build(inputs: inputs(frame(working: 20, rows: rows)))
    #expect(t.rows.count == 8 && t.more == 12, "20 live threads, 8 shown")
    let exact = CompanionTray.build(inputs: inputs(frame(working: 12, rows: rows)))
    #expect(exact.more == 4)
    let fewer = CompanionTray.build(inputs: inputs(frame(working: 3, rows: Array(rows.prefix(3)))))
    #expect(fewer.more == 0 && fewer.rows.count == 3, "under the cap the rows are the whole list")
  }
}

@Suite("Companion LIVE review: banners")
struct CompanionBannerReviewTests {
  @Test func aReplyMidTurnKeepsItsBannerBecauseHisBubbleIsDeferred() {
    let p = CompanionBannerPolicy.Pet(
      onScreen: true, quiet: false, micRunning: false, feedLive: true, state: .working, replyBanners: false)
    #expect(!CompanionBannerPolicy.drops(body: "New reply in Alpha", pet: p))
  }
}
