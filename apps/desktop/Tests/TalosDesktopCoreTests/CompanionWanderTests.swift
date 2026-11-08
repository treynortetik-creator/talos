import Foundation
import Testing

@testable import TalosDesktopCore

/// The short wander: every 1 to 3 minutes while he is idle and awake, the model says one is due and the controller does the
/// walking (and checks the pointer and the open panels, which the model cannot see). Every test runs on the Rig's fake clock and
/// fake dice: nothing waits, nothing is random, and the reducer owns no timer.
private func frame(
  working: Int = 0, unread: Int = 0, rows: [[String: Any]] = [], reply: (String, Int)? = nil
) -> CompanionFeed {
  let o: [String: Any] = [
    "type": "companion_state", "link": "online", "mac_online": true, "busy": false, "needs": 0, "working": working, "queued": 0,
    "on_call": 0, "unread": unread, "failed": 0, "rows": rows,
    "last_reply": reply.map { ["thread_id": $0.0, "seq": $0.1] as [String: Any] } ?? NSNull(),
  ]
  guard case .companionState(let f)? = WebToNative.decode(o) else { fatalError("the test frame must decode") }
  return f
}

private extension Rig {
  mutating func feed(_ f: CompanionFeed?) {
    inputs.feed = f
    inputs.pageStatus = f == nil ? .down : .ready
    inputs.threads = [CompanionThreadRef(id: "alpha", name: "Alpha"), CompanionThreadRef(id: "beta", name: "Beta")]
  }
}

@Suite("Companion reducer: short wanders")
struct CompanionWanderTests {
  /// A rig with the owner at the keyboard and no antics, so the only thing in the way is the wander clock itself.
  func rig(_ pick: @escaping (ClosedRange<Double>) -> Double = { $0.lowerBound }) -> Rig {
    var r = Rig(random: pick)
    r.env.secondsSinceInput = 1
    r.env.antics = [:]
    return r
  }

  func due(_ r: Rig) -> Bool { r.log.contains { $0.wanderDue } }

  @Test func oneComesDueOneToThreeMinutesIn() {
    var low = rig { $0.lowerBound }
    low.tick()
    low.advance(59, step: 1)
    #expect(!due(low), "not before the shortest gap (60 s)")
    low.advance(2, step: 1)
    #expect(due(low))
    var high = rig { $0.upperBound }
    high.advance(179, step: 1)
    #expect(!due(high))
    high.advance(2, step: 1)
    #expect(due(high), "the longest gap is 3 minutes")
  }

  @Test func theDeadlineNamesTheNextWanderSoNoTimerIsNeeded() {
    var r = rig { $0.lowerBound }
    let o = r.tick()
    #expect(o.nextDeadline.map { abs($0 - (r.mono + 60)) < 0.001 } == true, "\(String(describing: o.nextDeadline))")
  }

  @Test func theMacLeftAloneSlowsItButNeverBeyondTwiceTheGap() {
    for (away, factor) in [(60.0, 1.0), (400.0, 1.5), (2000.0, 2.0), (200_000.0, 2.0)] {
      var r = rig { $0.upperBound }
      r.env.secondsSinceInput = away
      r.tick()
      r.advance(180 * factor - 1, step: 1)
      #expect(!due(r), "owner away \(away) s: nothing before \(180 * factor) s")
      r.advance(2, step: 1)
      #expect(due(r), "owner away \(away) s: due at \(180 * factor) s")
    }
  }

  @Test func itStaysDueUntilTheControllerStartsItAndThenTheWaitStartsOver() {
    var r = rig { $0.lowerBound }
    r.advance(61, step: 1)
    #expect(r.last?.wanderDue == true)
    r.advance(10, step: 1)
    #expect(r.last?.wanderDue == true, "held until the controller answers")
    let o = r.model.wanderStarted(mono: r.mono, wall: r.wall)
    r.record(o)
    #expect(!o.wanderDue)
    #expect(o.nextDeadline.map { abs($0 - (r.mono + 60)) < 0.001 } == true, "the next one is a full gap away: \(String(describing: o.nextDeadline))")
    r.advance(59, step: 1)
    #expect(r.last?.wanderDue == false)
    r.advance(2, step: 1)
    #expect(r.last?.wanderDue == true)
  }

  @Test func aDeclinedWanderDrawsANewWaitInsteadOfAskingAgainAtOnce() {
    var r = rig { $0.lowerBound }
    r.advance(61, step: 1)
    #expect(r.last?.wanderDue == true)
    let o = r.model.wanderDeclined(mono: r.mono, wall: r.wall)
    r.record(o)
    #expect(!o.wanderDue)
    r.advance(30, step: 1)
    #expect(r.last?.wanderDue == false)
  }

  @Test func theOwnerComingBackRestartsTheWait() {
    var r = rig { $0.lowerBound }
    r.advance(50, step: 1)
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    r.record(o)
    r.advance(50, step: 1)
    #expect(r.last?.wanderDue == false, "60 s from the last touch, not from the start")
    r.advance(11, step: 1)
    #expect(r.last?.wanderDue == true)
  }

  @Test func aStartedWanderLeavesNoClipUntilTheWalkAndTheBaseLoopBreathAreOver() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 2]
    let start = r.mono
    r.advance(59, step: 1)
    #expect(r.last?.wanderDue == false)
    while r.last?.wanderDue != true && r.mono < start + 90 { r.advance(1, step: 1) }  // due at 60 s, or when the clip playing then ends
    #expect(r.last?.wanderDue == true && r.mono >= start + 60, "setup: the wander is due")
    #expect(r.anims.count >= 5, "setup: clips were rotating all along: \(r.anims)")
    r.record(r.model.wanderStarted(mono: r.mono, wall: r.wall))
    let before = r.anims.count
    r.advance(9, step: 1)
    #expect(r.anims.count == before, "no clip while he is out walking (8 s) and the base loop breathes (2 s): \(r.anims.suffix(2))")
    r.advance(3, step: 1)
    #expect(r.anims.count == before + 1, "and the rotation goes on after")
  }

  @Test func wakingTheMacStartsTheWanderWaitOverAsItDoesForTheAntics() {
    var r = rig { $0.lowerBound }
    r.advance(70, step: 1)
    #expect(r.last?.wanderDue == true, "setup: a wander is waiting")
    r.mono += 10  // a short lid close: the uptime clock does not count it, so no Asleep
    r.wall += 10
    let o = r.model.woke(mono: r.mono, wall: r.wall)
    r.record(o)
    #expect(!o.wanderDue, "nothing that came due while the Mac slept is replayed")
    #expect(o.nextDeadline.map { abs($0 - (r.mono + 60)) < 0.001 } == true, "a full gap from the wake: \(String(describing: o.nextDeadline))")
    r.advance(59, step: 1)
    #expect(r.last?.wanderDue == false)
    r.advance(2, step: 1)
    #expect(r.last?.wanderDue == true)
  }

  @Test func noWanderOnTheTickAClipStartsEvenWhenItsWaitIsAlreadyOver() {
    // A gap of zero makes the wander due the moment the clamps open. They open on the tick the decisions become known, which is
    // also the tick Hello waves: the wave is the clip, so the wander waits for the next tick.
    var r = Rig(random: { $0 == CompanionModel.wanderGap ? 0 : $0.lowerBound })
    r.env.secondsSinceInput = 1
    r.env.antics = [:]
    r.inputs.quiet = nil
    r.record(r.model.turnedOn(mono: r.mono, wall: r.wall))
    r.tick(1)
    #expect(r.last?.wanderDue == false && r.anims.isEmpty, "setup: nothing is known yet, so nothing plays and no wander is due")
    r.inputs.quiet = false
    let hello = r.tick(1)
    #expect(hello.animation?.clip == "waving", "setup: Hello waves on the tick the decisions are known")
    #expect(!hello.wanderDue, "not on the tick a clip starts")
    #expect(r.tick(1).wanderDue, "and it is due on the next")
  }

  // MARK: clamps

  @Test func noWanderDuringAHigherStateOrAClampOrWithMomentsOff() {
    func check(_ name: String, _ setup: (inout Rig) -> Void) {
      var r = rig { $0.lowerBound }
      setup(&r)
      r.advance(900, step: 5)
      #expect(!due(r), "a wander during \(name)")
    }
    check("Needs you") { $0.inputs.needs = 1 }
    check("Working") { $0.inputs.session = .running(busy: true) }
    check("Down") { $0.inputs.session = .stopped(byOwner: false) }
    check("Down (relay)") { $0.inputs.relayDown = true }
    check("Blocked session") { $0.inputs.session = .blocked }
    check("a call (a mic)") { $0.env.micRunning = true }
    check("Reduce Motion") { $0.env.reduceMotion = true }
    check("Low Power") { $0.env.lowPower = true }
    check("Mini") { $0.env.mini = true }
    check("moments off") { $0.env.moments = false }
  }

  @Test func noWanderWhileCarriedOrAsleep() {
    var r = rig { $0.lowerBound }
    r.tick()
    _ = r.model.dragBegan(directionRight: true, mono: r.mono, wall: r.wall)
    for _ in 0..<400 {
      r.mono += 1
      r.wall += 1
      let o = r.model.update(r.inputs, env: r.env, mono: r.mono, wall: r.wall)
      r.record(o)
    }
    #expect(!due(r), "while he is carried")
    var s = rig { $0.lowerBound }
    s.advance(31 * 60, step: 30)
    s.log.removeAll()
    s.advance(3600, step: 30)
    #expect(!due(s), "Asleep: he is napping")
  }

  @Test func noWanderUnderAnOpenBubbleOrAHoldAndItComesTheMomentItLifts() {
    for hold in [{ (r: inout Rig) in r.env.bubbleOpen = true }, { (r: inout Rig) in r.env.anticHold = true }] {
      var r = rig { $0.lowerBound }
      hold(&r)
      r.tick()
      r.advance(200, step: 1)
      #expect(!due(r))
      r.env.bubbleOpen = false
      r.env.anticHold = false
      r.advance(2, step: 1)
      #expect(due(r), "due since the hold began, so it is due when the hold ends")
    }
  }

  @Test func noWanderWhileAnAnticPlays() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 100]
    r.advance(100, step: 1)
    #expect(!due(r), "the sit is on screen for 100 s and the wander waits for it")
    r.advance(20, step: 1)
    #expect(due(r), "and it comes when the sit is over")
  }

  @Test func noWanderOnTheTickABubbleSpeaksNorWhileHeIsTalking() {
    // Dice that make a wander due at once, so only what the model holds back can stop it.
    var r = Rig(random: { $0 == CompanionModel.wanderGap ? 0 : $0.lowerBound })
    r.env.secondsSinceInput = 1
    r.env.antics = [:]
    r.feed(frame())
    r.tick()  // baseline
    r.feed(frame(unread: 1, reply: ("alpha", 10)))  // a reply: Done hops once
    r.advance(10)
    #expect(r.last?.state == .idle && r.last?.wanderDue == true, "setup: idle again and a wander is waiting")
    r.log.removeAll()
    r.feed(frame(unread: 2, reply: ("beta", 11)))  // another reply inside the hop's minute: the bubble alone
    r.advance(4)
    let talking = r.log.firstIndex { $0.animation?.clip == "talking" }
    #expect(talking != nil, "setup: a bubble speaks while he is idle: \(r.anims)")
    guard let i = talking else { return }
    #expect(!r.log[i].wanderDue, "not on the tick he starts talking")
    #expect(!r.log[i + 1].wanderDue, "nor while he is talking (the next tick is 0.5 s on)")
    #expect(r.log.dropFirst(i + 4).contains { $0.wanderDue }, "and it comes once he has finished")
  }

  @Test func theWanderNeverTouchesTheOwnerActivityClockSoHeStillDozesOffOnTime() {
    var r = rig { $0.lowerBound }
    var wanders = 0
    for _ in 0..<(1799 / 5) {
      r.advance(5, step: 5)
      if r.last?.wanderDue == true {
        wanders += 1
        r.record(r.model.wanderStarted(mono: r.mono, wall: r.wall))
      }
    }
    #expect(wanders >= 10, "a wander about every minute for half an hour: \(wanders)")
    #expect(r.last?.state == .idle)
    r.advance(10, step: 1)
    #expect(r.last?.state == .asleep, "30 minutes with no touch: he still dozes off")
  }
}

@Suite("Companion wander: quiet hours are not a clamp")
struct CompanionWanderQuietTests {
  @Test func aWanderIsDueInTheQuietWindowAsItIsByDay() {
    func firstDue(quiet: Bool) -> Bool {
      var r = Rig(random: { $0.lowerBound })
      r.inputs.quiet = quiet
      r.env.secondsSinceInput = 1
      r.tick()
      var due = false
      for _ in 0..<(900 / 5) where r.tick(5).wanderDue { due = true }
      return due
    }
    #expect(firstDue(quiet: false), "setup: by day a wander comes")
    #expect(firstDue(quiet: true), "and in quiet hours too")
  }
}
