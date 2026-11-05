import Foundation
import Testing

@testable import TalosDesktopCore

/// A fake clock around the reducer. `mono` is the monotonic clock (hysteresis, asleep); `wall` is the wall clock (quiet, Morning,
/// Rounds). They move together unless a test jumps one.
struct Rig {
  var model: CompanionModel
  var inputs = CompanionInputs()
  var env = CompanionEnv()
  var mono: TimeInterval = 1000
  var wall: Date
  var last: CompanionOutput?
  var log: [CompanionOutput] = []

  /// 2026-10-31 09:00 in a fixed UTC-7 zone (no DST) = 16:00 UTC.
  static let fixedUtcMinus7 = TimeZone(identifier: "Etc/GMT+7")!
  static let start = Date(timeIntervalSince1970: 1_793_462_400)  // 2026-10-31 16:00:00 UTC

  init(random: @escaping (ClosedRange<Double>) -> Double = { $0.lowerBound }) {
    model = CompanionModel(random: random)
    wall = Self.start
    inputs.quiet = false
    inputs.session = .running(busy: false)
    inputs.agentName = "Talos"
  }

  @discardableResult mutating func tick(_ dt: TimeInterval = 0) -> CompanionOutput {
    mono += dt
    wall += dt
    let o = model.update(inputs, env: env, mono: mono, wall: wall)
    record(o)
    return o
  }
  mutating func record(_ o: CompanionOutput) {
    last = o
    log.append(o)
  }
  @discardableResult mutating func advance(_ seconds: TimeInterval, step: TimeInterval = 0.5) -> CompanionOutput {
    var left = seconds
    var o = tick(0)
    while left > 0 {
      let d = min(step, left)
      o = tick(d)
      left -= d
    }
    return o
  }
  @discardableResult mutating func click() -> CompanionOutput {
    let o = model.click(mono: mono, wall: wall)
    record(o)
    return o
  }
  var anims: [String] { log.compactMap { $0.animation?.clip } }
  var bubbles: [String] { log.compactMap { $0.bubble?.bubble.text } }
}

@Suite("Companion reducer: states")
struct CompanionStateTests {
  @Test func idleByDefaultAndNotSetUpReadsNotSetUp() {
    var r = Rig()
    r.inputs.session = .notConfigured
    let o = r.tick()
    #expect(o.state == .idle)
    #expect(o.word == "Not set up")
    #expect(o.rest == .idle)
  }

  @Test func stoppedNotByOwnerIsDownWithTheSessionBubble() {
    var r = Rig()
    r.tick()
    r.inputs.session = .stopped(byOwner: false)
    let o = r.tick(1)
    #expect(o.state == .down)
    #expect(o.animation?.clip == "failed")
    #expect(o.rest == .holdLast("failed"))
    #expect(o.bubble?.bubble.text == "Talos's Mac session stopped")
    #expect(o.word == "Session stopped")
  }

  @Test func ownersStopIsIdleNotDown() {
    var r = Rig()
    r.inputs.session = .stopped(byOwner: true)
    let o = r.tick()
    #expect(o.state == .idle)
    #expect(o.word == "Session stopped by you")
    #expect(r.bubbles.isEmpty)
  }

  @Test func relayDownIsDownWithAWordAndNoBubble() {
    var r = Rig()
    r.tick()
    r.inputs.relayDown = true
    let o = r.tick(1)
    #expect(o.state == .down)
    #expect(o.word == "Can't reach the relay")
    #expect(o.bubble == nil, "a Wi-Fi drop is not a stopped session")
  }

  @Test func needsYouWavesThenWaitsAndSaysSo() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 2
    let o = r.tick(1)
    #expect(o.state == .needsYou)
    #expect(o.animation?.clip == "waving")
    #expect(o.rest == .holdStill("waiting"))
    #expect(o.word == "Needs you · 2")
    #expect(o.bubble?.bubble.text == "Talos needs you")
  }

  @Test func sessionNeedsYouAndBlockedBothCountAsNeedsYou() {
    var r = Rig()
    r.inputs.sessionNeedsYou = true
    do { let o_ = r.tick(); #expect(o_.state == .needsYou) }
    var b = Rig()
    b.inputs.session = .blocked
    do { let o_ = b.tick(); #expect(o_.state == .needsYou) }
  }

  @Test func priorityDownBeatsNeedsBeatsWorking() {
    var r = Rig()
    r.inputs.session = .running(busy: true)
    r.inputs.needs = 1
    do { let o_ = r.tick(); #expect(o_.state == .needsYou, "needs you beats working") }
    r.inputs.relayDown = true
    do { let o_ = r.tick(1); #expect(o_.state == .down, "down beats needs you") }
  }

  @Test func needsYouWavesOnceMoreAtTenMinutesThenNeverAgain() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 1
    r.tick(1)
    r.log.removeAll()
    r.advance(590)
    #expect(!r.anims.contains("waving"))
    r.advance(20)
    #expect(r.anims.filter { $0 == "waving" }.count == 1)
    r.log.removeAll()
    r.advance(3000)
    #expect(!r.anims.contains("waving"), "one more wave at 10 min, then nothing")
  }

  @Test func downAndNeedsAreNotDelayedByHysteresis() {
    var r = Rig()
    r.tick()
    r.inputs.session = .stopped(byOwner: false)
    do { let o_ = r.tick(0); #expect(o_.state == .down, "same tick") }
  }
}

@Suite("Companion reducer: hysteresis")
struct CompanionHysteresisTests {
  @Test func workingStartsOnlyAfterOneAndAHalfSeconds() {
    var r = Rig()
    r.tick()
    r.inputs.session = .running(busy: true)
    do { let o_ = r.tick(0); #expect(o_.state == .idle) }
    do { let o_ = r.tick(1.0); #expect(o_.state == .idle) }
    let o = r.tick(0.6)
    #expect(o.state == .working)
    #expect(o.animation?.clip == "running")
    #expect(o.animation?.repeatFor == 20)
    #expect(o.rest == .holdLast("running"))
  }

  @Test func aBlipOfWorkingNeverShowsAndNeverRestartsTheTimer() {
    var r = Rig()
    r.tick()
    r.inputs.session = .running(busy: true)
    r.tick(0)
    r.tick(1.0)
    r.inputs.session = .running(busy: false)
    do { let o_ = r.tick(0.3); #expect(o_.state == .idle) }
    r.inputs.session = .running(busy: true)
    r.tick(0)
    do { let o_ = r.tick(1.0); #expect(o_.state == .idle, "the timer restarted when the blip ended") }
    do { let o_ = r.tick(0.6); #expect(o_.state == .working) }
  }

  @Test func workingLeavesOnlyAfterFourSeconds() {
    var r = Rig()
    r.inputs.session = .running(busy: true)
    r.advance(3)
    #expect(r.last?.state == .working)
    r.inputs.session = .running(busy: false)
    r.tick(0)
    do { let o_ = r.tick(3.0); #expect(o_.state == .working) }
    do { let o_ = r.tick(1.1); #expect(o_.state == .idle) }
  }

  @Test func atMostOneChangeEveryThreeSecondsWhenFalling() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 1
    r.tick(0.1)
    #expect(r.last?.state == .needsYou)
    r.inputs.needs = 0
    r.tick(0)
    do { let o_ = r.tick(1.0); #expect(o_.state == .needsYou, "only 1.1 s since the last change") }
    do { let o_ = r.tick(2.1); #expect(o_.state == .idle) }
  }

  @Test func theNextDeadlineIsTheHysteresisEnd() {
    var r = Rig()
    r.tick()
    r.inputs.session = .running(busy: true)
    let o = r.tick(0)
    #expect(o.nextDeadline.map { abs($0 - (r.mono + 1.5)) < 0.001 } == true)
  }
}

@Suite("Companion reducer: asleep, quiet, mic, motion")
struct CompanionClampTests {
  @Test func idleFallsAsleepAfterThirtyMinutesAndAnyActivityWakesHim() {
    var r = Rig()
    r.advance(1799)
    #expect(r.last?.state == .idle)
    r.advance(2)
    #expect(r.last?.state == .asleep)
    #expect(r.last?.rest == .nap, "Asleep is a nap now: lying down, eyes dim; the statue stays for the quiet window")
    #expect(r.last?.word == "Dozing")
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    #expect(o.state == .idle)
  }

  @Test func thirtyFakeDaysWithNoInputsShowOnlyIdleAsleepAndListedBeatsAndNoBubble() {
    var r = Rig(random: { ($0.lowerBound + $0.upperBound) / 2 })
    var calls = 0
    // One hour steps for 30 days. Quiet window 20:30 to 04:00, in a no-DST zone.
    r.inputs.quietWindow = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: Rig.fixedUtcMinus7)
    for _ in 0..<(30 * 24) {
      r.inputs.quiet = r.inputs.quietWindow?.isQuiet(r.wall)
      let o = r.tick(3600)
      calls += 1
      #expect([.idle, .asleep].contains(o.state))
      if o.roundsDue { _ = r.model.roundsDeclined(mono: r.mono, wall: r.wall) }
    }
    #expect(calls == 720)
    let allowed: Set<String> = Set(CompanionModel.shippedAntics.keys).union(["waving", "sleep", "wake"])
    #expect(Set(r.anims).isSubset(of: allowed), "only Morning, the idle antics and the nap's two transitions may move him: \(Set(r.anims))")
    #expect(r.bubbles.isEmpty)
  }

  @Test func quietShowsAStatueWhateverTheStateWithNoBubbleNoBeatAndADotIfAnythingCollected() {
    var r = Rig()
    r.inputs.quiet = true
    r.inputs.collected = 3
    r.tick()
    r.inputs.needs = 1
    let o = r.tick(1)
    #expect(o.state == .needsYou, "a clamp changes how a state is shown, never the state")
    #expect(o.displayState == .asleep)
    #expect(o.rest == .statue)
    #expect(o.animation == nil)
    #expect(o.bubble == nil)
    #expect(o.dot)
    #expect(o.word == "Needs you · 1", "hover tells the truth")
  }

  @Test func nothingIsDecidedUntilTheFirstBridgeReadHasReturned() {
    var r = Rig()
    r.inputs.quiet = nil
    r.tick()
    r.inputs.session = .stopped(byOwner: false)
    let o = r.tick(1)
    #expect(o.state == .down)
    #expect(o.bubble == nil)
    r.inputs.quiet = false
    do { let o_ = r.tick(1); #expect(o_.bubble != nil, "held, then shown once quiet is known and false") }
  }

  @Test func aMicHoldsTheBubbleAndItShowsAfterwardsOnlyIfStillTrue() {
    var r = Rig()
    r.tick()
    r.env.micRunning = true
    r.inputs.needs = 1
    do { let o_ = r.tick(1); #expect(o_.bubble == nil) }
    r.env.micRunning = false
    do { let o_ = r.tick(1); #expect(o_.bubble?.bubble.text == "Talos needs you") }
    // And a second case: the thing resolved while the mic ran.
    var s = Rig()
    s.tick()
    s.env.micRunning = true
    s.inputs.needs = 1
    s.tick(1)
    s.inputs.needs = 0
    s.advance(5)
    s.env.micRunning = false
    s.advance(1)
    #expect(s.bubbles.isEmpty, "no longer true, never shown")
  }

  @Test func aMicAlsoStopsBeatsWithoutHidingTheState() {
    var r = Rig()
    r.env.micRunning = true
    r.tick()
    let o = r.click()
    #expect(o.animation == nil)
    #expect(o.state == .idle)
  }

  @Test func reduceMotionShowsStillsOnlyButBubblesStay() {
    var r = Rig()
    r.env.reduceMotion = true
    r.tick()
    r.inputs.needs = 1
    let o = r.tick(1)
    #expect(o.animation == nil)
    #expect(o.bubble != nil)
    do { let o_ = r.click(); #expect(o_.animation == nil, "Poke does nothing visible") }
  }

  @Test func lowPowerIsAlsoStillOnly() {
    var r = Rig()
    r.env.lowPower = true
    r.tick()
    r.inputs.session = .stopped(byOwner: false)
    let o = r.tick(1)
    #expect(o.animation == nil)
    #expect(o.bubble != nil)
    #expect(r.env.stillOnly)
  }
}

@Suite("Companion reducer: beats")
struct CompanionBeatTests {
  @Test func helloOnTurnOn() {
    var r = Rig()
    r.tick()
    let o = r.model.turnedOn(mono: r.mono, wall: r.wall)
    #expect(o.animation?.clip == "waving")
  }

  @Test func helloIsGatedLikeEveryBeat() {
    var r = Rig()
    r.inputs.quiet = true
    r.tick()
    do { let o_ = r.model.turnedOn(mono: r.mono, wall: r.wall); #expect(o_.animation == nil) }
  }

  @Test func pokeIsAFourFrameHopLimitedToOnePerSecond() {
    var r = Rig()
    r.tick()
    let a = r.click()
    #expect(a.animation?.clip == "jumping")
    #expect(a.animation?.frameLimit == 4)
    r.tick(0.4)
    do { let o_ = r.click(); #expect(o_.animation == nil, "inside the second") }
    r.tick(0.7)
    do { let o_ = r.click(); #expect(o_.animation?.clip == "jumping") }
  }

  @Test func clickingAnAlertShowsItsBubbleAgainInsteadOfHopping() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 1
    r.tick(1)
    r.log.removeAll()
    r.tick(20)
    let o = r.click()
    #expect(o.animation?.clip != "jumping")
    #expect(o.bubble?.bubble.text == "Talos needs you")
    var d = Rig()
    d.tick()
    d.inputs.session = .stopped(byOwner: false)
    d.tick(1)
    d.tick(20)
    let p = d.click()
    #expect(p.bubble?.bubble.text == "Talos's Mac session stopped")
    #expect(p.animation?.clip != "jumping")
  }

  @Test func fiveClicksInThreeSecondsGrumbleOnceAMinuteEvenWhenHopsAreLimited() {
    var r = Rig()
    r.tick()
    var grumbles = 0
    for _ in 0..<5 {
      r.tick(0.5)
      if r.click().animation?.clip == "running" { grumbles += 1 }
    }
    #expect(grumbles == 1, "the fifth click, counted raw although hops are limited to one a second")
    for _ in 0..<5 {
      r.tick(0.5)
      if r.click().animation?.clip == "running" { grumbles += 1 }
    }
    #expect(grumbles == 1, "once a minute")
    r.advance(60)
    for _ in 0..<5 {
      r.tick(0.5)
      if r.click().animation?.clip == "running" { grumbles += 1 }
    }
    #expect(grumbles == 2)
  }

  @Test func slowClicksNeverGrumble() {
    var r = Rig()
    r.tick()
    for _ in 0..<10 {
      r.tick(1.5)
      do { let o_ = r.click(); #expect(o_.animation?.clip != "running") }
    }
  }

  @Test func carriedFacesTheDirectionAndLandedFollowsTheDrop() {
    var r = Rig()
    r.tick()
    let a = r.model.dragBegan(directionRight: false, mono: r.mono, wall: r.wall)
    #expect(a.animation?.clip == "running-left")
    #expect(a.animation?.untilCleared == true)
    #expect(a.dragging)
    let b = r.model.dragMoved(directionRight: true, mono: r.mono + 0.1, wall: r.wall)
    #expect(b.animation?.clip == "running-right", "both directions are rendered, never mirrored")
    let c = r.model.dragEnded(mono: r.mono + 0.2, wall: r.wall)
    #expect(c.animation?.clip == "landed")
    #expect(!c.dragging)
  }

  @Test func aStateChangeDuringADragNeverPlaysOverTheCarry() {
    var r = Rig()
    r.tick()
    _ = r.model.dragBegan(directionRight: true, mono: r.mono, wall: r.wall)
    r.inputs.session = .stopped(byOwner: false)
    r.mono += 1
    let o = r.model.update(r.inputs, env: r.env, mono: r.mono, wall: r.wall)
    #expect(o.state == .down)
    #expect(o.animation?.clip == "running-right")
    #expect(o.bubble == nil, "the bubble is held until the drop")
    let d = r.model.dragEnded(mono: r.mono + 1, wall: r.wall)
    #expect(d.bubble != nil)
  }

  @Test func momentsOffSilencesTheAnticsAndRoundsButNotPoke() {
    var r = Rig()
    r.env.moments = false
    r.env.secondsSinceInput = 1
    r.advance(1700, step: 20)
    #expect(r.anims.filter { CompanionModel.shippedAntics[$0] != nil }.isEmpty)
    do { let o_ = r.click(); #expect(o_.animation?.clip == "jumping") }
  }

  @Test func miniHasNoBeats() {
    var r = Rig()
    r.env.mini = true
    r.tick()
    do { let o_ = r.click(); #expect(o_.animation == nil) }
  }

  @Test func aBubbleTalksForOnePointTwoSecondsWhenNothingElseIsMoving() {
    var r = Rig()
    r.tick()
    r.inputs.needs = 1
    r.tick(1)
    r.tick(20)
    let o = r.click()
    #expect(o.animation?.clip == "talking")
    #expect(o.animation?.repeatFor == 1.2)
  }
}

@Suite("Companion reducer: Morning, Rounds, wake")
struct CompanionDayTests {
  let quiet = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: Rig.fixedUtcMinus7)

  @Test func morningWavesOnceADayWithTheOvernightCount() {
    var r = Rig()
    r.inputs.quietWindow = quiet
    r.inputs.quiet = true
    r.inputs.collected = 0
    r.tick()
    r.wall += 24 * 3600  // the next morning: turning on was the first day's greeting
    r.inputs.collected = 4
    r.tick(60)
    r.inputs.quiet = false
    let o = r.tick(60)
    #expect(o.animation?.clip == "waving")
    #expect(o.bubble?.bubble.text == "Overnight: 4 items")
    r.log.removeAll()
    r.inputs.quiet = true
    r.tick(60)
    r.inputs.quiet = false
    r.tick(60)
    #expect(!r.anims.contains("waving"), "once a day")
  }

  @Test func morningWithNothingCollectedHasNoBubble() {
    var r = Rig()
    r.inputs.quietWindow = quiet
    r.inputs.quiet = true
    r.tick()
    r.wall += 24 * 3600
    r.inputs.quiet = false
    let o = r.tick(60)
    #expect(o.animation?.clip == "waving")
    #expect(o.bubble == nil)
  }

  @Test func theQuietDotShowsOnlyWhileQuietAndSomethingWasCollected() {
    var r = Rig()
    r.inputs.quiet = true
    do { let o_ = r.tick(); #expect(o_.dot == false) }
    r.inputs.collected = 1
    do { let o_ = r.tick(1); #expect(o_.dot) }
    r.inputs.quiet = false
    do { let o_ = r.tick(1); #expect(o_.dot == false) }
  }

  @Test func roundsSlotsAreThreeOneInEachThirdOfTheAwakeHours() {
    let slots = RoundsPlan.slots(on: Rig.start, quiet: quiet, random: { $0.lowerBound })
    #expect(slots.count == 3)
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Rig.fixedUtcMinus7
    let minutes = slots.map { cal.component(.hour, from: $0) * 60 + cal.component(.minute, from: $0) }
    // Awake: 04:00 to 20:30 = 990 minutes, thirds of 330.
    #expect(minutes == [240, 240 + 330, 240 + 660])
    let top = RoundsPlan.slots(on: Rig.start, quiet: quiet, random: { $0.upperBound })
    let topMin = top.map { cal.component(.hour, from: $0) * 60 + cal.component(.minute, from: $0) }
    #expect(topMin.allSatisfy { $0 >= 240 && $0 < 20 * 60 + 30 }, "never inside the quiet window: \(topMin)")
  }

  @Test func roundsSlotsWithAQuietWindowThatDoesNotWrapAndWithNone() {
    let day = QuietWindow(start: 13 * 60, end: 15 * 60, timeZone: Rig.fixedUtcMinus7)
    for seed in [0.0, 0.5, 1.0] {
      let s = RoundsPlan.slots(on: Rig.start, quiet: day, random: { $0.lowerBound + ($0.upperBound - $0.lowerBound) * seed })
      var cal = Calendar(identifier: .gregorian)
      cal.timeZone = Rig.fixedUtcMinus7
      let m = s.map { cal.component(.hour, from: $0) * 60 + cal.component(.minute, from: $0) }
      #expect(m.count == 3)
      #expect(m.allSatisfy { !(13 * 60..<15 * 60).contains($0) }, "\(m)")
    }
    #expect(RoundsPlan.slots(on: Rig.start, quiet: nil, random: { $0.lowerBound }).count == 3)
  }

  @Test func roundsSlotsInADSTZoneStayInsideTheAwakeHoursOnAChangeDay() {
    let ny = TimeZone(identifier: "America/New_York")!
    let q = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: ny)
    // 2026-11-01 is the fall-back day in New York.
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = ny
    let day = cal.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 12))!
    for seed in [0.0, 0.5, 1.0] {
      let s = RoundsPlan.slots(on: day, quiet: q, random: { $0.lowerBound + ($0.upperBound - $0.lowerBound) * seed })
      #expect(s.count == 3)
      #expect(s.allSatisfy { cal.startOfDay(for: $0) == cal.startOfDay(for: day) })
    }
  }

  @Test func aRoundsSlotComesDueOnceAndOnlyWhenEveryClampAllows() {
    var r = Rig()
    r.inputs.quietWindow = quiet
    r.tick()
    r.env.secondsSinceInput = 5
    // The first slot of the day is at 04:00 by this seed; the rig starts at 09:00, so it is already past its grace. Walk the
    // day and count.
    var due = 0
    var t = r
    for _ in 0..<(15 * 60) {
      let o = t.tick(60)
      if o.roundsDue {
        due += 1
        _ = t.model.roundsStarted(mono: t.mono, wall: t.wall)
      }
    }
    #expect(due == 2, "two slots remain between 09:00 and the end of the awake hours")
    var m = r
    m.env.micRunning = true
    for _ in 0..<(15 * 60) { let o_ = m.tick(60); #expect(o_.roundsDue == false) }
  }

  @Test func aMissedSlotIsDroppedWithNoCatchUp() {
    var r = Rig()
    r.inputs.quietWindow = quiet
    r.env.secondsSinceInput = 5
    r.tick()
    r.inputs.quiet = false
    var due = 0
    for _ in 0..<30 {
      if r.tick(10).roundsDue { due += 1 }
    }
    #expect(due == 0)
  }

  @Test func eightHoursOfSleepGivesNoBurstOfBeats() {
    var r = Rig(random: { $0.lowerBound })
    r.inputs.quietWindow = quiet
    r.env.secondsSinceInput = 5
    r.tick()
    r.advance(120)
    r.log.removeAll()
    // The Mac sleeps 8 hours: the monotonic clock does not move, the wall clock does.
    r.wall += 8 * 3600
    let o = r.model.woke(mono: r.mono, wall: r.wall)
    r.record(o)
    r.advance(30, step: 1)
    let moves = r.anims.filter { $0 != "waving" }
    #expect(moves.isEmpty, "no replayed antic, Rounds or Hello: \(moves)")
    #expect(r.last?.state == .asleep, "he is asleep after a long sleep")
    #expect(r.log.contains { $0.roundsDue } == false)
  }

  @Test func wakingOnANewDayWavesOnce() {
    var r = Rig()
    r.inputs.quietWindow = quiet
    r.tick()
    r.advance(30)
    r.wall += 24 * 3600
    let o = r.model.woke(mono: r.mono, wall: r.wall)
    #expect(o.animation?.clip == "waving")
    #expect(o.state == .idle, "Morning wakes him")
  }

  @Test func theWallClockJumpingBackDoesNotMoveHysteresis() {
    var r = Rig()
    r.tick()
    r.inputs.session = .running(busy: true)
    r.tick(0)
    r.wall -= 3600  // the clock jumps an hour back
    r.mono += 1.6
    do { let o_ = r.model.update(r.inputs, env: r.env, mono: r.mono, wall: r.wall); #expect(o_.state == .working) }
  }
}

@Suite("Click gate")
struct ClickGateTests {
  @Test func aDoubleClickOpensOnlyAfterTheIntervalWithNoThirdClick() {
    var g = ClickGate()
    do { let o_ = g.click(count: 1, mono: 0, interval: 0.5); #expect(o_ == nil) }
    do { let o_ = g.click(count: 2, mono: 0.2, interval: 0.5); #expect(o_ == 0.7) }
    do { let d_ = g.due(mono: 0.6); #expect(!d_) }
    do { let d_ = g.due(mono: 0.7); #expect(d_) }
    do { let d_ = g.due(mono: 0.8); #expect(!d_, "once") }
  }

  @Test func fiveFastClicksNeverOpenTheApp() {
    var g = ClickGate()
    var opened = false
    for (i, n) in [1, 2, 3, 4, 5].enumerated() {
      _ = g.click(count: n, mono: Double(i) * 0.15, interval: 0.5)
      if g.due(mono: Double(i) * 0.15) { opened = true }
    }
    #expect(!opened)
    do { let d_ = g.due(mono: 5); #expect(!d_) }
  }
}


@Suite("Companion clamps gate every path alike")
struct CompanionGateTests {
  enum Cause: CaseIterable { case quiet, mic, notYetKnown }

  func close(_ r: inout Rig, _ c: Cause) {
    switch c {
    case .quiet: r.inputs.quiet = true
    case .mic: r.env.micRunning = true
    case .notYetKnown: r.inputs.quiet = nil
    }
  }

  @Test func noClampLetsABubbleABeatHelloPokeFidgetOrRoundsThrough() {
    for cause in Cause.allCases {
      var r = Rig(random: { $0.lowerBound })
      r.inputs.quietWindow = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: Rig.fixedUtcMinus7)
      r.env.secondsSinceInput = 3
      r.tick()
      close(&r, cause)
      r.tick(1)
      let hello = r.model.turnedOn(mono: r.mono, wall: r.wall)
      #expect(hello.animation == nil, "Hello under \(cause)")
      let poke = r.click()
      #expect(poke.animation == nil, "Poke under \(cause)")
      r.inputs.needs = 1
      r.tick(1)
      #expect(r.bubbles.isEmpty, "bubble under \(cause)")
      r.inputs.needs = 0
      r.env.secondsSinceInput = 1
      r.advance(1700, step: 10)  // past the longest antic gap
      #expect(r.anims.filter { CompanionModel.shippedAntics[$0] != nil }.isEmpty, "an antic under \(cause)")
      #expect(cause != .quiet || !r.anims.contains("waving"), "nothing waves inside the quiet window")
      var due = false
      for _ in 0..<(24 * 60) {
        if r.tick(60).roundsDue { due = true }
      }
      #expect(!due, "Rounds under \(cause)")
    }
  }

  @Test func theGatesOpenAgain() {
    var r = Rig(random: { $0.lowerBound })
    r.tick()
    r.env.micRunning = true
    r.tick(1)
    #expect(r.click().animation == nil)
    r.env.micRunning = false
    r.tick(1)
    r.tick(1.1)
    #expect(r.click().animation?.clip == "jumping")
  }

  @Test func threeRoundsADayAcrossDateChangesEachInItsOwnDay() {
    var r = Rig(random: { $0.lowerBound })
    let q = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: Rig.fixedUtcMinus7)
    r.inputs.quietWindow = q
    r.env.secondsSinceInput = 3
    var perDay: [String: Int] = [:]
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = Rig.fixedUtcMinus7
    for _ in 0..<(48 * 60) {
      r.inputs.quiet = q.isQuiet(r.wall)
      let o = r.tick(60)
      if o.roundsDue {
        _ = r.model.roundsStarted(mono: r.mono, wall: r.wall)
        let c = cal.dateComponents([.month, .day], from: r.wall)
        perDay["\(c.month!)-\(c.day!)", default: 0] += 1
      }
    }
    #expect(perDay.values.reduce(0, +) == 5 || perDay.values.reduce(0, +) == 6, "\(perDay)")
    #expect(perDay.count == 3 || perDay.count == 2, "\(perDay)")
    for (day, n) in perDay { #expect(n <= 3, "\(day) has \(n)") }
  }

  @Test func downToNeedsYouIsStillHeldToOneChangeEveryThreeSeconds() {
    var r = Rig()
    r.tick()
    r.inputs.relayDown = true
    r.tick(0.1)
    #expect(r.last?.state == .down)
    r.inputs.relayDown = false
    r.inputs.needs = 1
    r.tick(0)
    do { let o_ = r.tick(1.0); #expect(o_.state == .down, "falling from Down is held 3 s") }
    do { let o_ = r.tick(2.2); #expect(o_.state == .needsYou) }
  }

  @Test func theOrderInTargetIsTheRealPriorityDownThenNeedsThenWorking() {
    var r = Rig()
    r.inputs.relayDown = true
    r.inputs.needs = 5
    r.inputs.session = .running(busy: true)
    do { let o_ = r.tick(); #expect(o_.state == .down) }
    var s = Rig()
    s.inputs.needs = 5
    s.inputs.session = .running(busy: true)
    do { let o_ = s.tick(); #expect(o_.state == .needsYou) }
  }
}

// MARK: review of PR #106: the reducer findings

@Suite("Companion reducer: review fixes")
struct CompanionReviewFixTests {
  let quiet = QuietWindow(start: 20 * 60 + 30, end: 4 * 60, timeZone: Rig.fixedUtcMinus7)

  /// The closest the reducer asks to be called back, over a stretch of fake time stepped one second at a time.
  private func closestAsk(_ r: inout Rig, seconds: Int) -> TimeInterval {
    var closest = TimeInterval.infinity
    for _ in 0..<seconds {
      let o = r.tick(1)
      if let d = o.nextDeadline { closest = min(closest, d - r.mono) }
    }
    return closest
  }

  @Test func aRoundsSlotHeldBackByAnAwayOwnerDoesNotMakeItAskEvery50ms() {
    var r = Rig(random: { $0.upperBound })  // slots at 09:30, 14:59 and 20:29
    r.inputs.quietWindow = quiet
    r.wall = Rig.start.addingTimeInterval(10.5 * 3600 + 900)  // 19:45
    r.tick()
    r.advance(2500, step: 10)  // 20:26:40, idle for more than 30 minutes: asleep
    #expect(r.last?.state == .asleep)
    r.env.secondsSinceInput = .infinity  // the owner is away
    // 20:29:00 is the slot; the quiet window opens at 20:30. Step through the 90 s grace.
    r.wall = Rig.start.addingTimeInterval(10.5 * 3600 + 3540 + 10)  // 20:29:10
    var due = false
    let closest = closestAsk(&r, seconds: 60)
    for o in r.log.suffix(60) where o.roundsDue { due = true }
    #expect(!due, "the owner is away and he is asleep: the gate holds")
    #expect(closest >= 1, "a held-back slot is re-checked by the periodic recompute, not by a 50 ms timer: closest ask \(closest)")
  }

  /// The review named Needs you after the wave, Down, and Working with the mic on as the same spin as the Rounds slot. Driven
  /// across every state and clamp, eight combinations asked every 50 ms before the fix (the old fallback), none do now.
  @Test func noStateAndNoClampEverAsksToBeCalledBackWithin100ms() {
    for setup: (inout Rig) -> Void in [
      { $0.inputs.needs = 1 }, { $0.inputs.session = .stopped(byOwner: false) },
      { $0.inputs.session = .running(busy: true) }, { $0.inputs.relayDown = true }, { _ in },
    ] {
      for clamp: (inout Rig) -> Void in [
        { $0.env.micRunning = true }, { $0.env.reduceMotion = true }, { $0.env.lowPower = true }, { $0.env.mini = true },
        { $0.env.moments = false }, { $0.inputs.quiet = true }, { _ in },
      ] {
        var r = Rig(random: { $0.lowerBound })
        r.inputs.quietWindow = quiet
        r.tick()
        setup(&r)
        clamp(&r)
        let closest = closestAsk(&r, seconds: 2400)
        #expect(closest >= 0.1, "closest ask \(closest)")
      }
    }
  }

  @Test func theSlotThatIsDueAndAllowedStillFiresAndTheNextOneIsStillScheduled() {
    var r = Rig(random: { $0.lowerBound })
    r.inputs.quietWindow = quiet
    r.env.secondsSinceInput = 5
    r.tick()
    r.wall = Rig.start.addingTimeInterval(-5 * 3600 + 25 * 60)  // 04:25, slot is 04:00 (grace passed)
    var seen = 0
    var asked: [TimeInterval] = []
    for _ in 0..<(12 * 3600 / 30) {
      let o = r.tick(30)
      if o.roundsDue { seen += 1; _ = r.model.roundsStarted(mono: r.mono, wall: r.wall) }
      if let d = o.nextDeadline { asked.append(d - r.mono) }
    }
    #expect(seen == 2, "09:25ish and 14:50ish: \(seen)")
    #expect(asked.contains { $0 > 600 }, "a real slot ahead is still a deadline")
  }

  @Test func aShortLidCloseDoesNotMakeHimAStatueButALongSleepDoes() {
    func woken(after seconds: TimeInterval) -> CompanionOutput {
      var r = Rig()
      r.inputs.quietWindow = quiet
      r.tick()
      r.advance(120)
      r.wall += seconds  // the monotonic clock does not move while the Mac sleeps
      return r.model.woke(mono: r.mono, wall: r.wall)
    }
    let short = woken(after: 120)
    #expect(short.state == .idle, "two minutes asleep is not 30 minutes of nothing")
    #expect(short.rest == .idle)
    #expect(woken(after: 1790).state == .idle)
    #expect(woken(after: 1805).state == .asleep, "a sleep of 30 minutes or more is Asleep")
    #expect(woken(after: -3600).state == .idle, "a clock set back is not a sleep")
  }

  @Test func aRebuiltModelDoesNotReReportOvernightItemsOrReplanRounds() {
    func drive(_ m: CompanionModel) -> (bubbles: [String], model: CompanionModel) {
      var r = Rig()
      r.model = m
      r.inputs.quietWindow = quiet
      r.inputs.quiet = true
      r.inputs.collected = 4
      r.tick()
      r.wall += 24 * 3600
      r.tick(60)
      r.inputs.quiet = false
      r.tick(60)
      return (r.bubbles, r.model)
    }
    var first = Rig()
    first.inputs.quietWindow = quiet
    first.inputs.quiet = true
    first.inputs.collected = 4
    first.tick()
    first.wall += 24 * 3600
    first.tick(60)
    first.inputs.quiet = false
    first.tick(60)
    #expect(first.bubbles == ["Overnight: 4 items"])
    let rebuilt = CompanionModel(carry: first.model.carry)
    // A rebuild (size change, snooze end, off and on) with the same collected count says nothing more.
    var r2 = Rig()
    r2.model = rebuilt
    r2.inputs.quietWindow = quiet
    r2.inputs.collected = 4
    r2.tick()
    r2.inputs.quiet = true
    r2.tick(1)
    r2.wall += 24 * 3600
    r2.tick(60)
    r2.inputs.quiet = false
    r2.tick(60)
    #expect(!r2.bubbles.contains("Overnight: 4 items"), "already reported: \(r2.bubbles)")
    let fresh = drive(CompanionModel())
    #expect(fresh.bubbles == ["Overnight: 4 items"], "control: without the carry it is reported again")
    // Rounds: a consumed slot stays consumed.
    var a = Rig(random: { $0.lowerBound })
    a.inputs.quietWindow = quiet
    a.tick()
    let planned = a.model.carry.roundsSlots.count
    #expect(planned >= 1)
    _ = a.model.roundsStarted(mono: a.mono, wall: a.wall)
    let left = a.model.carry.roundsSlots.count
    #expect(left == planned - 1)
    var b = Rig(random: { $0.lowerBound })
    b.model = CompanionModel(random: { $0.lowerBound }, carry: a.model.carry)
    b.inputs.quietWindow = quiet
    b.tick()
    #expect(b.model.carry.roundsSlots.count == left, "no replan: still \(left), not \(planned)")
  }
}
