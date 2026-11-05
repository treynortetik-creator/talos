import Foundation
import Testing

@testable import TalosDesktopCore

/// The rotating clips (Fidget grown up): a new little thing every 3 to 10 seconds while he is idle and awake, never the same twice
/// running, with his base loop between two, slower when the Mac is left alone, cut by anything that matters. Every test here runs on the Rig's fake clock and
/// fake dice: nothing waits, nothing is random, and the reducer owns no timer.
@Suite("Companion reducer: idle antics")
struct CompanionAnticTests {
  static let names = Set(CompanionModel.shippedAntics.keys)

  /// A rig with the owner at the keyboard (1 s since the last input), so the gap is the base gap.
  func rig(_ pick: @escaping (ClosedRange<Double>) -> Double = { $0.lowerBound }) -> Rig {
    var r = Rig(random: pick)
    r.env.secondsSinceInput = 1
    return r
  }

  func antics(_ r: Rig) -> [String] { r.anims.filter { Self.names.contains($0) } }
  /// Only what the Idle pool plays (the Needs-you clips are not in it)
  func idleClips(_ r: Rig) -> [String] { r.anims.filter { Self.names.contains($0) && CompanionModel.idleAntics[$0] != nil } }

  /// Everything the idle pool plays, `waving` included. Only for a rig that stays idle: a state's own entry also waves.
  func plays(_ r: Rig) -> [String] { r.anims.filter { Self.names.contains($0) || $0 == "waving" } }

  /// Dice that walk a fixed sequence of fractions: the same on every run, and varied enough to pick every antic.
  func dice() -> (ClosedRange<Double>) -> Double {
    var x: UInt64 = 0x9E37_79B9_7F4A_7C15
    return { range in
      x = x &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
      let f = Double(x >> 11) / Double(1 << 53)
      return range.lowerBound + (range.upperBound - range.lowerBound) * f
    }
  }

  @Test func theShippedTableIsAtLeastTheSixAnticsAndTheOldFidget() {
    #expect(Self.names == ["sit", "nap", "stretch", "scratch", "stumble", "tinker", "review", "idle-look", "needs-beckon", "needs-tap"])
  }

  @Test func theIdlePoolIsTheGentleShippedClipsWithNoNapAndNoStumble() {
    #expect(Set(CompanionModel.idleAntics.keys) == ["sit", "stretch", "scratch", "tinker", "review", "waving", "idle-look"])
    #expect(Set(CompanionModel.needsAntics.keys) == ["needs-beckon", "needs-tap"])
    #expect(CompanionEnv().antics == CompanionModel.idleAntics, "a rig that sets nothing plays the idle pool")
  }

  @Test func theViewCutsEveryClipTheIdlePoolPlaysWhenTheOwnerComesBackAndNoOther() {
    for name in Set(CompanionModel.shippedAntics.keys).union(CompanionModel.idleAntics.keys) {
      #expect(CompanionModel.isAntic(name), "\(name) is an antic")
    }
    #expect(CompanionModel.isAntic("waving"), "the idle wave is cut like the rest")
    for other in ["running", "running-left", "running-right", "talking", "jumping", "failed", "landed", "sleep", "wake", "wake-low"] {
      #expect(!CompanionModel.isAntic(other), "\(other) is not an antic")
    }
  }

  @Test func oneComesDueThreeToTenSecondsIn() {
    var low = rig { $0.lowerBound }
    low.tick()
    low.advance(2, step: 1)
    #expect(plays(low).isEmpty, "not before the shortest gap (3 s)")
    low.advance(2, step: 1)
    #expect(plays(low).count == 1)
    var high = rig { $0.upperBound }
    high.advance(9, step: 1)
    #expect(plays(high).isEmpty)
    high.advance(2, step: 1)
    #expect(plays(high).count == 1, "the longest gap is 10 seconds")
  }

  @Test func theDeadlineNamesTheNextAnticSoNoTimerIsNeeded() {
    var r = rig { $0.lowerBound }
    let o = r.tick()
    let due = r.mono + 3
    #expect(o.nextDeadline.map { abs($0 - due) < 0.001 } == true, "asked again exactly when the antic is due: \(String(describing: o.nextDeadline))")
  }

  @Test func theMacLeftAloneMakesTheGapLonger() {
    for (away, factor) in [(60.0, 1.0), (400.0, 1.5), (2000.0, 2.0), (200_000.0, 2.0)] {
      var r = rig { $0.upperBound }
      r.env.secondsSinceInput = away
      r.tick()
      r.advance(10 * factor - 1, step: 1)
      #expect(plays(r).isEmpty, "owner away \(away) s: nothing before \(10 * factor) s")
      r.advance(2, step: 1)
      #expect(plays(r).count == 1, "owner away \(away) s: one at \(10 * factor) s, never slower than twice the base")
    }
  }

  @Test func theMacLeftAloneAfterTheGapWasDrawnStillPushesItLater() {
    var r = rig { $0.lowerBound }
    r.tick()
    r.advance(2, step: 1)
    r.env.secondsSinceInput = 5000  // the owner walked away mid-wait
    r.advance(3, step: 1)
    #expect(antics(r).isEmpty, "a 3 s base becomes 6 s once the Mac is left alone")
    r.advance(2, step: 1)
    #expect(antics(r).count == 1)
  }

  @Test func neverTheSameAnticTwiceInARow() {
    var run = rig(dice())
    var names: [String] = []
    for _ in 0..<120 {
      run.advance(400, step: 4)  // well inside Asleep's 30 minutes
      names = plays(run)
      _ = run.model.activity(mono: run.mono, wall: run.wall)  // the owner pokes around: the antic clock restarts, Asleep never comes
      if names.count >= 60 { break }
    }
    #expect(names.count >= 30, "got \(names.count) antics")
    for (a, b) in zip(names, names.dropFirst()) { #expect(a != b, "\(a) twice in a row") }
    #expect(Set(names) == Set(CompanionModel.idleAntics.keys), "the dice reach the whole pool: \(Set(names))")
  }

  @Test func theSameDiceGiveTheSameAnticsTwice() {
    func run() -> [String] {
      var r = rig(dice())
      r.advance(1500, step: 5)
      return plays(r)
    }
    #expect(run() == run())
    #expect(!run().isEmpty)
  }

  @Test func anIdleStretchOfTwentyEightMinutesIsFullOfAntics() {
    var r = rig(dice())
    r.advance(1700, step: 1)
    // Start to start is the longest of a 10 s gap and the longest clip (7.02 s) plus the 2 s of base loop, a step of 1 s on top.
    #expect(plays(r).count >= 1700 / 11, "got \(plays(r).count)")
  }

  @Test func aPoolOfOneMayRepeatBecauseThereIsNothingElse() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 4]
    r.advance(1000, step: 2)
    let a = antics(r)
    #expect(a.count >= 3, "\(a)")
    #expect(Set(a) == ["sit"])
  }

  @Test func anArtBundleWithNoAnticsGetsNone() {
    var r = rig { $0.lowerBound }
    r.env.antics = [:]
    r.advance(1700, step: 10)
    #expect(antics(r).isEmpty)
  }

  @Test func theNextOneWaitsForTheLastToEndAndThenTwoSecondsOfBaseLoop() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 30]
    r.advance(4, step: 1)  // the first at 3 s
    #expect(antics(r).count == 1)
    r.advance(30, step: 1)  // its 3 s gap is long past at 6 s, but it plays until 33 and the base loop owns 33 to 35: we are at 34
    #expect(antics(r).count == 1, "never two at once, and never back to back")
    r.advance(3, step: 1)
    #expect(antics(r).count == 2)
  }

  // MARK: higher states and clamps always win

  @Test func noAnticStartsDuringAHigherState() {
    func check(_ name: String, _ setup: (inout Rig) -> Void) {
      var r = rig { $0.lowerBound }
      setup(&r)
      r.advance(1700, step: 10)
      #expect(idleClips(r).isEmpty, "an idle clip during \(name): \(idleClips(r))")
    }
    check("Needs you") { $0.inputs.needs = 1 }
    check("Working") { $0.inputs.session = .running(busy: true) }
    check("Down") { $0.inputs.session = .stopped(byOwner: false) }
    check("Down (relay)") { $0.inputs.relayDown = true }
    check("Blocked session") { $0.inputs.session = .blocked }
    check("quiet window") { $0.inputs.quiet = true }
    check("a mic") { $0.env.micRunning = true }
    check("Reduce Motion") { $0.env.reduceMotion = true }
    check("Low Power") { $0.env.lowPower = true }
    check("Mini") { $0.env.mini = true }
    check("moments off") { $0.env.moments = false }
  }

  @Test func noAnticStartsWhileCarriedOrAsleep() {
    var r = rig { $0.lowerBound }
    r.tick()
    _ = r.model.dragBegan(directionRight: true, mono: r.mono, wall: r.wall)
    for _ in 0..<400 {
      r.mono += 1
      r.wall += 1
      let o = r.model.update(r.inputs, env: r.env, mono: r.mono, wall: r.wall)
      r.record(o)
      if o.animation != nil { #expect(!Self.names.contains(o.animation!.clip)) }
    }
    var s = rig { $0.lowerBound }
    s.advance(31 * 60, step: 30)
    s.log.removeAll()
    s.advance(3600, step: 30)
    #expect(antics(s).isEmpty, "Asleep: he is already napping")
  }

  @Test func aHigherStateArrivingMidAnticTakesOverWithItsOwnAnimation() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 30]
    r.advance(13, step: 1)
    #expect(antics(r).count == 1)
    r.inputs.needs = 1
    r.tick(0.1)
    let o = r.tick(0.1)
    #expect(o.state == .needsYou)
    #expect(r.anims.last == "waving", "the state's entry animation replaces the antic")
    r.advance(200, step: 5)
    #expect(idleClips(r).count == 1, "no more idle clips while Needs you holds")
    #expect(antics(r).contains { CompanionModel.needsAntics[$0] != nil }, "it plays its own instead")
  }

  @Test func theOwnerComingBackCutsAnAnticAndRestartsTheWait() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 30]
    r.advance(4, step: 1)
    #expect(antics(r).count == 1)
    let stopBefore = r.last!.anticStop
    r.mono += 2
    r.wall += 2
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    #expect(o.anticStop == stopBefore + 1, "the view is told to cut the antic")
    #expect(o.animation == nil)
    #expect(o.rest == .idle)
    r.record(o)
    r.advance(2, step: 1)
    #expect(antics(r).count == 1, "the gap starts over from the owner's last touch")
    r.advance(2, step: 1)
    #expect(antics(r).count == 2)
  }

  @Test func wakingDuringTheSleepClipGetsUpFromTheSeatToo() {
    var r = rig { $0.upperBound }
    r.env.antics = [:]
    r.advance(1799, step: 1)
    r.advance(2, step: 1)
    #expect(r.anims.contains("sleep"))
    r.mono += 0.1
    r.wall += 0.1
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    #expect(o.animation?.clip == "wake-low")
  }

  @Test func noAnticStartsUnderAnOpenBubbleOrReplyCard() {
    var r = rig { $0.lowerBound }
    r.env.bubbleOpen = true
    r.tick()
    r.advance(130, step: 1)
    #expect(antics(r).isEmpty)
    r.env.bubbleOpen = false
    r.advance(2, step: 1)
    #expect(antics(r).count == 1, "due since the bubble opened, so it starts the moment it closes")
  }

  @Test func anAnticThatWouldRunIntoAsleepDoesNotStart() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 12.88]
    r.tick()  // evaluated once, so the last touch is now and the first antic is already scheduled for 12 s on
    r.mono += 1790  // 10 s before Asleep; the antic needs 12.9 s plus the margin. The antic is long overdue by now.
    r.wall += 1790
    r.tick(0)
    r.advance(9, step: 1)
    #expect(antics(r).isEmpty, "an antic that would end in Asleep never starts: \(antics(r))")
    r.advance(30, step: 1)
    #expect(r.last?.rest == .nap, "and he dozes off instead")
  }

  @Test func anAnticHoldFromTheTrayTheComposeBoxOrAHoverKeepsEveryAnticAway() {
    var r = rig { $0.lowerBound }
    r.env.anticHold = true
    r.tick()
    r.advance(200, step: 1)
    #expect(antics(r).isEmpty)
    r.env.anticHold = false
    r.advance(2, step: 1)
    #expect(antics(r).count == 1, "due since the hold began, so it starts when the hold ends")
  }

  // MARK: Asleep is a nap

  @Test func dozingOffWalksIntoTheNapAndAnyActivityWakesHimCleanly() {
    var r = rig { $0.upperBound }
    r.env.antics = [:]  // keep the antics out of it
    r.advance(1799, step: 1)
    #expect(r.last?.state == .idle)
    #expect(!r.anims.contains("sleep"))
    r.advance(2, step: 1)
    #expect(r.last?.state == .asleep)
    #expect(r.last?.rest == .nap)
    #expect(r.anims.filter { $0 == "sleep" }.count == 1, "he lies down once")
    r.advance(600, step: 30)
    #expect(r.anims.filter { $0 == "sleep" }.count == 1)
    #expect(r.last?.animation == nil || r.last?.animation?.clip == "sleep")
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    #expect(o.state == .idle)
    #expect(o.animation?.clip == "wake", "any activity gets him up")
    #expect(o.rest == .idle)
    r.record(o)
    #expect(r.anims.filter { $0 == "wake" }.count == 1)
  }

  @Test func aWorkStateWakesHimWithItsOwnEntryNotTheWake() {
    var r = rig { $0.upperBound }
    r.env.antics = [:]
    r.advance(1900, step: 5)
    #expect(r.last?.rest == .nap)
    r.inputs.session = .running(busy: true)
    r.advance(3, step: 0.5)
    #expect(r.last?.state == .working)
    #expect(r.anims.suffix(3).contains("running"))
    #expect(!r.anims.contains("wake"), "work wins: he goes straight to work")
  }

  @Test func theQuietWindowKeepsTheStatueAndNeverNaps() {
    var r = rig { $0.upperBound }
    r.inputs.quiet = true
    r.advance(3600, step: 30)
    #expect(r.last?.rest == .statue)
    #expect(!r.anims.contains("sleep"))
    #expect(r.last?.animation == nil)
  }

  @Test func reduceMotionAndLowPowerGiveTheNapAsAStillWithNoAnimation() {
    for set in [{ (r: inout Rig) in r.env.reduceMotion = true }, { (r: inout Rig) in r.env.lowPower = true }] {
      var r = rig { $0.upperBound }
      set(&r)
      r.advance(1900, step: 10)
      #expect(r.last?.rest == .nap)
      #expect(r.log.allSatisfy { $0.animation == nil })
      #expect(r.log.suffix(5).allSatisfy { $0.animation == nil && $0.rest == .nap }, "a nap is one still frame: nothing runs")
    }
  }

  @Test func aMacThatSleptLongEnoughIsAlreadyNappingAndDoesNotAnimateToIt() {
    var r = rig { $0.lowerBound }
    r.advance(120, step: 5)
    r.log.removeAll()
    r.wall += 8 * 3600
    let o = r.model.woke(mono: r.mono, wall: r.wall)
    r.record(o)
    #expect(o.rest == .nap)
    #expect(!r.anims.contains("sleep"))
  }

  // MARK: the owner's rule: never a frozen statue, in Idle and in Needs you

  /// Every clip that starts over `seconds` of the rig's fake clock, with its start time, stepping 0.5 s.
  func starts(_ r: inout Rig, seconds: Double) -> [(t: Double, clip: String)] {
    var out: [(t: Double, clip: String)] = []
    let t0 = r.mono
    var seen = r.log.count
    var left = seconds
    while left > 0 {
      r.tick(0.5)
      left -= 0.5
      for o in r.log[seen...] { if let a = o.animation { out.append((r.mono - t0, a.clip)) } }
      seen = r.log.count
    }
    return out
  }

  @Test func overTenMinutesOfIdleANewClipStartsAtLeastEveryTenSecondsAndNeverRepeatsBackToBack() {
    var r = rig(dice())
    r.tick()
    let s = starts(&r, seconds: 600)
    #expect(s.count >= 600 / 11, "got \(s.count) clips in 10 minutes")
    #expect((s.first?.t ?? 99) <= 10.5, "the first within 10 s of starting")
    for (a, b) in zip(s, s.dropFirst()) {
      #expect(b.t - a.t <= 10.5, "\(b.clip) came \(b.t - a.t) s after \(a.clip)")
      #expect(a.clip != b.clip, "\(a.clip) twice in a row at \(a.t) s")
    }
    #expect(Set(s.map(\.clip)) == Set(CompanionModel.idleAntics.keys), "the whole pool plays, the look around included: \(Set(s.map(\.clip)))")
    #expect(s.allSatisfy { CompanionModel.needsAntics[$0.clip] == nil }, "no Needs-you clip in Idle")
  }

  @Test func overTenMinutesOfNeedsYouANewClipStartsAtLeastEveryTenSecondsAndNeverRepeatsBackToBack() {
    var r = rig(dice())
    r.inputs.needs = 1
    r.tick()
    r.advance(1, step: 0.5)  // the entry beat (his wave) is not one of the rotation
    let s = starts(&r, seconds: 600).filter { $0.clip != "waving" }
    #expect(s.count >= 600 / 11, "got \(s.count) clips in 10 minutes")
    for (a, b) in zip(s, s.dropFirst()) {
      #expect(b.t - a.t <= 10.5, "\(b.clip) came \(b.t - a.t) s after \(a.clip)")
      #expect(a.clip != b.clip, "\(a.clip) twice in a row at \(a.t) s")
    }
    #expect(Set(s.map(\.clip)) == Set(CompanionModel.needsAntics.keys), "both play: \(Set(s.map(\.clip)))")
    #expect(r.last?.rest == .holdStill("waiting"), "and the rest he comes back to is the Needs-you loop's")
  }

  @Test func theBaseLoopAlwaysPlaysBetweenTwoClips() {
    for needs in [false, true] {
      var r = rig(dice())
      if needs { r.inputs.needs = 1 }
      r.tick()
      r.advance(1, step: 0.5)
      let lengths = CompanionModel.shippedAntics.merging(["waving": 1.14]) { a, _ in a }
      let s = starts(&r, seconds: 600).filter { $0.clip != "waving" }
      for (a, b) in zip(s, s.dropFirst()) {
        #expect(b.t - a.t >= (lengths[a.clip] ?? 0) + CompanionModel.restBreath - 0.51, "\(b.clip) cut into the base loop after \(a.clip) (needs: \(needs))")
      }
    }
  }

  @Test func needsYouRotatesOnlyUnderTheSameGatesAsIdle() {
    func check(_ name: String, _ setup: (inout Rig) -> Void) {
      var r = rig { $0.lowerBound }
      r.inputs.needs = 1
      setup(&r)
      r.tick()
      r.advance(1, step: 0.5)
      r.log.removeAll()
      r.advance(600, step: 5)
      let played = r.anims.filter { CompanionModel.needsAntics[$0] != nil }
      #expect(played.isEmpty, "a Needs-you clip during \(name): \(played)")
    }
    check("a mic") { $0.env.micRunning = true }
    check("Reduce Motion") { $0.env.reduceMotion = true }
    check("Low Power") { $0.env.lowPower = true }
    check("Mini") { $0.env.mini = true }
    check("moments off") { $0.env.moments = false }
    check("the quiet window") { $0.inputs.quiet = true }
    check("an open bubble") { $0.env.bubbleOpen = true }
    check("the tray or a resting pointer") { $0.env.anticHold = true }
    check("no needs clips in the art") { $0.env.needsClips = [:] }
  }

  @Test func theOwnerComingBackCutsANeedsClipToo() {
    var r = rig { $0.lowerBound }
    r.inputs.needs = 1
    r.tick()
    r.advance(1, step: 0.5)
    r.env.needsClips = ["needs-beckon": 30]
    r.advance(5, step: 0.5)
    #expect(r.anims.filter { $0 == "needs-beckon" }.count == 1)
    let before = r.last!.anticStop
    r.mono += 1
    r.wall += 1
    let o = r.model.activity(mono: r.mono, wall: r.wall)
    #expect(o.anticStop == before + 1, "the view is told to cut it")
    #expect(o.rest == .holdStill("waiting"))
  }

  // MARK: review fixes: context menu gate, own deadlines, the 3 s floor

  /// Drives the model only at the instants it names itself: no fixed tick, so a missing deadline stalls the clock and shows.
  func startsByDeadline(_ r: inout Rig, seconds: Double, skipWave: Bool = false) -> (starts: [(t: Double, clip: String)], stalls: Int) {
    var out: [(t: Double, clip: String)] = []
    let t0 = r.mono
    var stalls = 0
    var o = r.tick()
    while r.mono - t0 < seconds {
      guard let d = o.nextDeadline else { stalls += 1; break }
      r.tick(max(d - r.mono, 0.001))
      o = r.last!
      if let a = o.animation, skipWave ? a.clip != "waving" : true { out.append((r.mono - t0, a.clip)) }
    }
    return (out, stalls)
  }

  @Test func drivenOnlyByItsOwnDeadlinesIdleStartsAClipAtLeastEveryTenSeconds() {
    var r = rig(dice())
    let (s, stalls) = startsByDeadline(&r, seconds: 600)
    #expect(stalls == 0, "the model must always name a next instant while idle")
    #expect(s.count >= Int(600.0 / 10.5) - 1, "got \(s.count) clips")
    for (a, b) in zip(s, s.dropFirst()) { #expect(b.t - a.t <= 10.5, "\(b.clip) came \(b.t - a.t) s after \(a.clip)") }
  }

  @Test func drivenOnlyByItsOwnDeadlinesNeedsYouStartsAClipAtLeastEveryTenSeconds() {
    var r = rig(dice())
    r.inputs.needs = 1
    r.tick()
    r.advance(1.5, step: 0.5)
    let (s, stalls) = startsByDeadline(&r, seconds: 600, skipWave: true)
    #expect(stalls == 0)
    #expect(s.count >= Int(600.0 / 10.5) - 1, "got \(s.count) clips")
    for (a, b) in zip(s, s.dropFirst()) { #expect(b.t - a.t <= 10.5, "\(b.clip) came \(b.t - a.t) s after \(a.clip)") }
  }

  @Test func aPlayingClipNamesItsOwnEndAsADeadline() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 30]
    r.advance(4, step: 1)
    let o = r.tick()
    // The clip began at about 3 s and ends at 33 s: the deadline must be that end, not nil and not a poll.
    #expect(o.nextDeadline != nil)
    #expect(o.nextDeadline! <= 1000 + 3 + 30 + 0.01, "got \(o.nextDeadline! - 1000)")
  }

  @Test func consecutiveClipStartsAreAtLeastThreeSecondsApartAfterTheFirstToo() {
    for needs in [false, true] {
      var r = rig(dice())
      if needs { r.inputs.needs = 1; r.tick(); r.advance(1.5, step: 0.5) }
      let (s, _) = startsByDeadline(&r, seconds: 600, skipWave: needs)
      #expect(s.count > 20)
      for (a, b) in zip(s, s.dropFirst()) {
        #expect(b.t - a.t >= 3 - 0.001, "\(b.clip) only \(b.t - a.t) s after \(a.clip) (needs: \(needs))")
      }
    }
  }

  @Test func aShortClipStillLeavesThreeSecondsBetweenTwoStarts() {
    var r = rig { $0.lowerBound }
    r.env.antics = ["sit": 0.5]
    let (s, _) = startsByDeadline(&r, seconds: 120)
    for (a, b) in zip(s, s.dropFirst()) { #expect(b.t - a.t >= 3 - 0.001, "gap \(b.t - a.t)") }
  }

  @Test func anOpenContextMenuOrAnyHoldCutsARunningClipAndTellsTheView() {
    for needs in [false, true] {
      var r = rig { $0.lowerBound }
      if needs { r.inputs.needs = 1; r.tick(); r.advance(1, step: 0.5); r.env.needsClips = ["needs-beckon": 30] } else { r.env.antics = ["sit": 30] }
      r.advance(5, step: 0.5)
      #expect(!(needs ? r.anims.filter { $0 == "needs-beckon" } : antics(r)).isEmpty, "a clip is running")
      let before = r.last!.anticStop
      r.env.anticHold = true
      let o = r.tick(0.5)
      #expect(o.anticStop == before + 1, "the hold cuts the running clip (needs: \(needs))")
      let n = r.anims.count
      r.advance(100, step: 1)
      #expect(r.anims.count == n, "and nothing new starts under it")
    }
  }
}
