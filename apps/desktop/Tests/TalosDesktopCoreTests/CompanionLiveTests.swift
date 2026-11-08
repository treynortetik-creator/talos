import Foundation
import Testing

@testable import TalosDesktopCore

/// C-LIVE (DESKTOP-COMPANION-SPEC 11.4): the feed reaches him. Frames go through the real `WebToNative.decode`, so a field the
/// Swift decoder would refuse can't hide behind a hand-built `CompanionFeed`.
private func frame(
  link: String = "online", busy: Bool = false, needs: Int = 0, working: Int = 0, queued: Int = 0, unread: Int = 0, failed: Int = 0,
  rows: [[String: Any]] = [], reply: (String, Int)? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": link, "mac_online": true, "busy": busy, "needs": needs, "working": working, "queued": queued,
    "on_call": 0, "unread": unread, "failed": failed, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

private let threads = [
  CompanionThreadRef(id: "general", name: "Daily plan"), CompanionThreadRef(id: "ops", name: "Ops"),
  CompanionThreadRef(id: "a1", name: "A thread"), CompanionThreadRef(id: "a2", name: "A thread"),
]

private extension Rig {
  mutating func feed(_ f: CompanionFeed?) {
    inputs.feed = f
    inputs.pageStatus = f == nil ? .down : .ready
    inputs.threads = threads
  }
}

@Suite("Companion LIVE: Trouble")
struct CompanionTroubleTests {
  @Test func aRisingFailedCountRaisesTroubleWithItsBubbleAndHolds() {
    var r = Rig()
    r.feed(frame())
    r.tick()  // baseline
    r.feed(frame(failed: 1))
    let o = r.tick(1)
    #expect(o.state == .trouble)
    #expect(o.animation?.clip == "failed")
    #expect(o.rest == .holdLast("failed"))
    #expect(o.bubble?.bubble.text == "A message didn't send")
    #expect(o.word == "A message didn't send")
    #expect(r.advance(9).state == .trouble, "holds 10 s")
    let after = r.advance(2)
    #expect(after.state == .idle)
    #expect(after.dot, "then Idle with a dot while failed > 0")
    r.feed(frame(failed: 0))
    #expect(!r.tick(1).dot, "the dot goes when nothing is failed")
  }

  @Test func theFirstFrameAfterAnyPageLoadIsTheBaselineSoAReloadNeverFiresTrouble() {
    var r = Rig()
    r.feed(frame(failed: 3))
    #expect(r.tick().state == .idle)
    #expect(!r.tick(5).dot)
    r.feed(nil)  // the page went away
    r.tick(1)
    r.feed(frame(failed: 4))  // a fresh page, already holding 4
    #expect(r.tick(1).state == .idle)
    #expect(r.bubbles.isEmpty)
  }

  @Test func aSecondFailureWhileInTroubleExtendsItWithoutAnotherBubble() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 1))
    r.tick(1)
    r.feed(frame(failed: 2))
    r.advance(8)
    #expect(r.tick(0).state == .trouble, "9 s after the first, extended by the second")
    #expect(r.bubbles.count == 1)
  }

  @Test func troubleClickShowsTheBubbleAgainAndNeverHops() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 1))
    r.tick(1)
    r.advance(8)  // the bubble was shown at entry; the click shows it again
    r.log.removeAll()
    let o = r.click()
    #expect(o.bubble?.bubble.text == "A message didn't send")
    #expect(o.animation?.clip != "jumping")
  }

  @Test func theFeedGoingAwayMidTroubleDropsHimBackToNativeInputs() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 1))
    #expect(r.tick(1).state == .trouble)
    r.feed(nil)  // sign-out, page gone, stale: the reducer must not hold the old frame's alarm
    #expect(r.tick(4).state == .idle)
  }
}

@Suite("Companion LIVE: Done")
struct CompanionDoneTests {
  @Test func aNewReplyHopsOnceWithTheThreadNameAndHoldsThreeSeconds() {
    var r = Rig()
    r.feed(frame(reply: ("general", 10)))
    r.tick()  // baseline holds seq 10: no Done for a reply that was already there
    #expect(r.bubbles.isEmpty)
    r.feed(frame(unread: 1, reply: ("general", 11)))
    let o = r.tick(1)
    #expect(o.state == .done)
    #expect(o.animation?.clip == "jumping")
    #expect(o.bubble?.bubble.text == "New reply in Daily plan")
    #expect(o.bubble?.bubble.threadId == "general")
    #expect(o.word == "Reply waiting")
    #expect(r.advance(2).state == .done)
    let after = r.advance(2)
    #expect(after.state == .idle)
    #expect(after.dot, "a dot while unread > 0")
    r.feed(frame(unread: 0, reply: ("general", 11)))
    #expect(!r.tick(1).dot)
  }

  @Test func theFirstReplyAfterANullBaselineStillCounts() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(reply: ("ops", 1)))
    #expect(r.tick(1).state == .done)
  }

  @Test func aReplyInAThreadThatIsStillWorkingWaitsUntilItLeavesWorking() {
    var r = Rig()
    r.feed(frame(busy: true, working: 1, rows: [["thread_id": "ops", "state": "working"]]))
    r.advance(3)
    r.feed(frame(busy: true, working: 1, rows: [["thread_id": "ops", "state": "working"]], reply: ("ops", 5)))
    #expect(r.tick(1).state != .done, "the turn isn't over")
    r.advance(10)
    #expect(!r.anims.contains("jumping"))
    r.feed(frame(unread: 1, rows: [["thread_id": "ops", "state": "ready"]], reply: ("ops", 5)))
    let o = r.tick(1)
    #expect(o.animation?.clip == "jumping" || o.state == .done, "one hop when the thread leaves working")
    #expect(r.bubbles.contains("New reply in Ops"))
  }

  @Test func aChattyAgentHopsOncePerMinuteAndBubblesOncePerThreadPerMinute() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    var seq = 1
    func reply(_ id: String) {
      seq += 1
      r.feed(frame(unread: seq, reply: (id, seq)))
    }
    reply("general")
    r.tick(1)
    r.advance(4)
    reply("general")  // 5 s later, same thread: no hop, no bubble
    r.tick(1)
    reply("ops")  // another thread inside the minute: its own bubble, but no second hop
    r.tick(1)
    r.advance(4)
    #expect(r.anims.filter { $0 == "jumping" }.count == 1)
    #expect(r.bubbles == ["New reply in Daily plan", "New reply in Ops"])
    r.advance(60)
    reply("general")
    r.tick(1)
    #expect(r.anims.filter { $0 == "jumping" }.count == 2, "a minute on: a new hop")
  }

  @Test func aReplyWhileTheTalosWindowIsKeyIsNotNews() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.inputs.windowIsKey = true
    r.feed(frame(unread: 1, reply: ("general", 3)))
    #expect(r.tick(1).state == .idle)
    #expect(r.bubbles.isEmpty)
  }

  @Test func windowBecomingKeyWhileADoneIsWaitingCancelsIt() {
    var r = Rig()
    let w = [["thread_id": "ops", "state": "working"]]
    r.feed(frame(busy: true, working: 1, rows: w))
    r.advance(3)
    r.feed(frame(busy: true, working: 1, rows: w, reply: ("ops", 9)))
    r.tick(1)
    r.inputs.windowIsKey = true
    r.tick(1)
    r.feed(frame(rows: [["thread_id": "ops", "state": "ready"]], reply: ("ops", 9)))
    r.inputs.windowIsKey = false
    r.tick(1)
    #expect(!r.anims.contains("jumping"))
  }

  @Test func aReplyOutsideTheListNamesAThread() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(reply: ("ghost", 2)))
    #expect(r.tick(1).bubble?.bubble.text == "New reply in A thread")
  }

  @Test func theMicHoldsTheBubbleAndAMissedOneIsNotReplayedAfterTheState() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.env.micRunning = true
    r.feed(frame(reply: ("general", 2)))
    let o = r.tick(1)
    #expect(o.bubble == nil)
    r.advance(5)  // the mic outlasts Done's three seconds
    r.env.micRunning = false
    r.advance(10)
    #expect(r.bubbles.isEmpty, "Done lasted three seconds: it is no longer true")
  }
}

@Suite("Companion LIVE: Needs you and Working from the feed")
struct CompanionFeedStateTests {
  @Test func needsComesFromTheFeedWithTheThreadNameInTheBubble() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 0
    r.feed(frame(needs: 2, rows: [["thread_id": "general", "state": "needs_you"]]))
    let o = r.tick(1)
    #expect(o.state == .needsYou)
    #expect(o.word == "Needs you · 2")
    #expect(o.bubble?.bubble.text == "Needs you in Daily plan")
    #expect(o.bubble?.bubble.threadId == "general")
  }

  @Test func theFeedCountWinsOverTheStaleBadgeAndTheBadgeStillWorksWithoutAFeed() {
    var r = Rig()
    r.inputs.needs = 3
    r.feed(frame(needs: 0))
    #expect(r.tick(1).state == .idle, "the feed says nothing needs him")
    r.feed(nil)
    #expect(r.tick(1).state == .needsYou, "no feed: the page badge")
  }

  @Test func aSessionThatNeedsTheOwnerNamesTheAgentNotAThread() {
    var r = Rig()
    r.inputs.agentName = "Ada"
    r.inputs.sessionNeedsYou = true
    r.feed(frame(needs: 1, rows: [["thread_id": "general", "state": "needs_you"]]))
    #expect(r.tick(1).bubble?.bubble.text == "Ada needs you")
  }

  @Test func workingComesFromBusyOrTheCountsWithTheCountOnTheWord() {
    var r = Rig()
    r.feed(frame(busy: false, working: 2, queued: 1))
    r.tick()
    let o = r.advance(2)
    #expect(o.state == .working)
    #expect(o.word == "Working · 3")
    var q = Rig()
    q.feed(frame(busy: true))
    q.tick()
    #expect(q.advance(2).state == .working)
  }

  @Test func theFeedReplacesNativeBusyWhenItIsLive() {
    var r = Rig()
    r.inputs.session = .running(busy: true)
    r.feed(frame(busy: false))
    r.tick()
    #expect(r.advance(6).state == .idle)
    r.feed(nil)
    r.tick()
    #expect(r.advance(2).state == .working, "no feed: agentActivity")
  }

  @Test func aRisingCountPlaysOneStrikeAtMostEveryThirtySeconds() {
    var r = Rig()
    r.feed(frame(busy: true, working: 1))
    r.tick()
    r.advance(3)
    r.log.removeAll()
    r.feed(frame(busy: true, working: 2))
    r.tick(1)
    r.feed(frame(busy: true, working: 3))
    r.tick(1)
    #expect(r.anims.filter { $0 == "running" }.count == 1, "the second rise is inside 30 s")
    r.advance(31)
    r.log.removeAll()
    r.feed(frame(busy: true, working: 4))
    r.tick(1)
    #expect(r.anims.filter { $0 == "running" }.count == 1)
  }
}

@Suite("Companion LIVE: priority, clamps and the quiet window")
struct CompanionLivePriorityTests {
  @Test func downBeatsNeedsBeatsTroubleBeatsDoneBeatsWorking() {
    #expect(CompanionState.down.priority > CompanionState.needsYou.priority)
    #expect(CompanionState.needsYou.priority > CompanionState.trouble.priority)
    #expect(CompanionState.trouble.priority > CompanionState.done.priority)
    #expect(CompanionState.done.priority > CompanionState.working.priority)
    #expect(CompanionState.working.priority > CompanionState.idle.priority)
  }

  @Test func needsOutranksATroubleThatArrivesWhileHeWaves() {
    var r = Rig()
    r.feed(frame(needs: 1, rows: [["thread_id": "ops", "state": "needs_you"]]))
    r.tick()
    r.advance(4)
    r.feed(frame(needs: 1, failed: 1, rows: [["thread_id": "ops", "state": "needs_you"]]))
    #expect(r.tick(1).state == .needsYou)
  }

  @Test func troubleCutsADoneThatIsAlreadyShowing() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    r.feed(frame(reply: ("ops", 1)))
    #expect(r.tick(1).state == .done)
    r.feed(frame(failed: 1, reply: ("ops", 1)))
    #expect(r.tick(0.1).state == .trouble)
  }

  @Test func theQuietWindowKeepsHimAnimatedButSilentAndMorningCountsTheRepliesAndFailures() {
    var r = Rig()
    r.inputs.quiet = true
    r.feed(frame())
    r.tick()
    r.feed(frame(unread: 1, reply: ("ops", 1)))
    let o = r.tick(1)
    #expect(o.state == .done && o.rest == .holdLast("jumping"), "the Done look, not a statue")
    #expect(o.animation?.clip == "jumping", "Done plays its clip in quiet hours as it does by day")
    #expect(o.bubble == nil, "but no bubble")
    #expect(o.dot, "a still dot: something was collected")
    r.feed(frame(unread: 1, failed: 1, reply: ("ops", 1)))
    r.tick(1)
    r.wall += 24 * 3600  // the next morning: turning on was the first day's greeting
    r.advance(30)
    r.inputs.quiet = false
    r.log.removeAll()
    r.advance(1)
    #expect(r.bubbles.contains("Overnight: 2 items"))
    #expect(r.anims.contains("waving"))
  }

  @Test func reduceMotionInTheQuietWindowIsStillAStillNotAnAnimation() {
    var r = Rig()
    r.inputs.quiet = true
    r.env.reduceMotion = true
    r.feed(frame())
    r.tick()
    r.feed(frame(unread: 1, reply: ("ops", 1)))
    let o = r.tick(1)
    #expect(o.animation == nil && o.bubble == nil)
    #expect(o.rest == .holdLast("jumping"))
  }

  @Test func thirtyFakeDaysWithAQuietFeedGiveNoBubbleAndNoAlarm() {
    var r = Rig()
    r.feed(frame())
    r.tick()
    for _ in 0..<(30 * 24) { r.advance(3600, step: 600) }
    #expect(r.bubbles.isEmpty)
    #expect(r.log.allSatisfy { $0.state == .idle || $0.state == .asleep })
  }

  @Test func reduceMotionAndLowPowerKeepTheStateButDropTheClip() {
    var r = Rig()
    r.env.reduceMotion = true
    r.feed(frame())
    r.tick()
    r.feed(frame(failed: 1))
    let o = r.tick(1)
    #expect(o.state == .trouble)
    #expect(o.animation == nil)
    #expect(o.bubble?.bubble.text == "A message didn't send", "bubbles stay: they carry the information")
  }

  @Test func theMiniPoseCoversTheNewStates() {
    #expect(CompanionAtlas.miniPose(.trouble) == .worried)
    #expect(CompanionAtlas.miniPose(.done) == .pleased)
  }
}

@Suite("Companion LIVE: phrases are closed and hostile names stay one clean line")
struct CompanionLivePhraseTests {
  @Test func theNewBubblesPassThePushBuildersTemplates() {
    #expect(NotificationPolicy.isPushPhrase(CompanionBubble.newReply(thread: "Daily plan", id: "x").text))
    #expect(NotificationPolicy.isPushPhrase(CompanionBubble.needsYouIn(thread: "Daily plan", id: "x").text))
  }

  @Test func aHostileThreadNameIsOneCleanLineEverywhere() {
    let hostile = "\u{202E}evil\nline **bold** [x](y)\u{200B}" + String(repeating: "z", count: 500)
    let b = CompanionBubble.newReply(thread: hostile, id: "x").text
    #expect(!b.contains("\n") && !b.contains("\u{202E}") && !b.contains("\u{200B}"))
    #expect(b.count <= "New reply in ".count + 40)
    var i = CompanionInputs()
    i.pageStatus = .ready
    i.threads = [CompanionThreadRef(id: "h", name: hostile)]
    i.feed = frame(rows: [["thread_id": "h", "state": "working"]])
    let t = CompanionTray.build(inputs: i)
    #expect(t.rows.count == 1)
    #expect(!t.rows[0].title.contains("\n") && t.rows[0].title.count <= 40)
    #expect(CompanionPhrase.accessibility(agent: hostile, word: "Working").count <= 40 + ", working".count)
  }

  @Test func replyTextKeepsNewlinesAndDropsControlAndBidiMarks() {
    let t = CompanionPhrase.replyText("one\u{202E}\u{0007}\ntwo\u{200B}\tthree")
    #expect(t == "one\ntwo three")
    #expect(CompanionPhrase.replyText(String(repeating: "a", count: 900)).count == 500)
  }
}

@Suite("Companion LIVE: the status list")
struct CompanionTrayTests {
  private func inputs(_ f: CompanionFeed?, page: CompanionPageStatus = .ready, session: CompanionSession = .running(busy: false)) -> CompanionInputs {
    var i = CompanionInputs()
    i.pageStatus = page
    i.feed = f
    i.threads = threads
    i.session = session
    return i
  }

  @Test func rowsFollowTheFeedOrderWithTheStateWords() {
    let f = frame(rows: [
      ["thread_id": "general", "state": "needs_you"], ["thread_id": "ops", "state": "ready"], ["thread_id": "a1", "state": "working"],
      ["thread_id": "a2", "state": "queued"],
    ])
    let t = CompanionTray.build(inputs: inputs(f))
    #expect(t.rows.map(\.word) == ["Needs you", "Reply waiting", "Working", "Waiting its turn"])
    #expect(t.rows.map(\.title) == ["Daily plan", "Ops", "A thread", "A thread 2"])
    #expect(t.rows[3].action == .thread("a2"), "equal names stay apart and the action carries the id")
    #expect(t.headline == nil && !t.dimmed)
  }

  @Test func anIdMissingFromTheThreadListReadsAThread() {
    let t = CompanionTray.build(inputs: inputs(frame(rows: [["thread_id": "ghost", "state": "ready"]])))
    #expect(t.rows.first?.title == "A thread")
    #expect(t.rows.first?.action == .thread("ghost"))
  }

  @Test func loadingEmptyDownAndOldPageEachSayWhatTheyAre() {
    #expect(CompanionTray.build(inputs: inputs(nil)).headline == "Checking…")
    let empty = CompanionTray.build(inputs: inputs(frame()))
    #expect(empty.headline == "All quiet." && empty.rows.isEmpty && empty.showsStill)
    let down = CompanionTray.build(inputs: inputs(nil, page: .down))
    #expect(down.headline == "Can't reach Talos" && down.offersOpenTalos)
    let old = CompanionTray.build(inputs: inputs(nil, page: .noFeed, session: .stopped(byOwner: false)))
    #expect(old.footer == "Reload Talos for the full list")
    #expect(old.rows.map(\.word) == ["Session stopped"], "native rows still show")
    #expect(old.rows.first?.action == .terminal)
  }

  @Test func aLinkThatIsNotOnlineDimsTheRowsUnderNotConnected() {
    let t = CompanionTray.build(inputs: inputs(frame(link: "offline", rows: [["thread_id": "ops", "state": "working"]])))
    #expect(t.dimmed && t.headline == "Not connected" && t.rows.count == 1)
  }

  @Test func atMostEightRowsThenPlusNMore() {
    let rows = (0..<11).map { ["thread_id": "t\($0)", "state": "working"] }
    let t = CompanionTray.build(inputs: inputs(frame(rows: rows)))
    #expect(t.rows.count == 8 && t.more == 3)
    #expect(t.rows.last?.action == .thread("t7"))
  }

  @Test func theSessionTroubleRowComesFirstAndAnOwnersStopIsNotTrouble() {
    let f = frame(rows: [["thread_id": "ops", "state": "working"]])
    let t = CompanionTray.build(inputs: inputs(f, session: .stopped(byOwner: false)))
    #expect(t.rows.first?.action == .terminal && t.rows.count == 2)
    let own = CompanionTray.build(inputs: inputs(f, session: .stopped(byOwner: true)))
    #expect(own.rows.count == 1)
  }
}

@Suite("Companion LIVE: reply banners")
struct CompanionBannerTests {
  private func pet(
    onScreen: Bool = true, quiet: Bool? = false, mic: Bool = false, feed: Bool = true, state: CompanionState = .idle, both: Bool = false
  ) -> CompanionBannerPolicy.Pet {
    .init(onScreen: onScreen, quiet: quiet, micRunning: mic, feedLive: feed, state: state, replyBanners: both)
  }

  @Test func whileHeCanShowTheReplyTheBannerIsDropped() {
    #expect(CompanionBannerPolicy.drops(body: "New reply in Daily plan", pet: pet()))
    #expect(CompanionBannerPolicy.drops(body: "Answer ready in Ops", pet: pet(state: .done)))
  }

  @Test func anyOtherConditionKeepsTodaysBanner() {
    let cases: [(String, (inout CompanionBannerPolicy.Pet) -> Void)] = [
      ("off", { $0.onScreen = false }),
      ("quiet", { $0.quiet = true }),
      ("quiet unknown", { $0.quiet = nil }),
      ("mic", { $0.micRunning = true }),
      ("no feed", { $0.feedLive = false }),
      ("down", { $0.state = .down }),
      ("needs you", { $0.state = .needsYou }),
      ("trouble", { $0.state = .trouble }),
      ("owner wants both", { $0.replyBanners = true }),
    ]
    for (name, change) in cases {
      var p = pet()
      change(&p)
      #expect(!CompanionBannerPolicy.drops(body: "New reply in Daily plan", pet: p), "\(name)")
    }
  }

  @Test func everyOtherBannerIsUntouched() {
    #expect(!CompanionBannerPolicy.drops(body: "Needs you in Daily plan", pet: pet()))
    #expect(!CompanionBannerPolicy.drops(body: "Talos's Mac session stopped", pet: pet()))
    #expect(!CompanionBannerPolicy.drops(body: "New reply in \n" + String(repeating: "x", count: 90), pet: pet()), "not a push phrase")
    #expect(!CompanionBannerPolicy.drops(body: "New activity", pet: pet()))
  }
}

@Suite("Companion LIVE: placement")
struct CompanionCardPlacementTests {
  let v = CGRect(x: 0, y: 0, width: 1280, height: 800)
  let sprite = CGRect(x: 1160, y: 8, width: 96, height: 104)

  @Test func theCardStaysOnScreenAndClearOfHimInAllFourCorners() {
    for o in [CGPoint(x: 8, y: 8), CGPoint(x: 1176, y: 8), CGPoint(x: 8, y: 688), CGPoint(x: 1176, y: 688)] {
      let s = CGRect(origin: o, size: CompanionPlacement.standardSize)
      for size in [CGSize(width: 280, height: 300), CGSize(width: 320, height: 180)] {
        let f = CompanionPlacement.cardFrame(sprite: s, size: size, in: v)
        #expect(v.contains(f))
        #expect(!f.intersects(s))
      }
    }
  }

  @Test func theControlsAreWideEnoughForThreeTargets() {
    #expect(CompanionPlacement.controlsSize.width >= 3 * 44 + 2 * 8)
  }
}
