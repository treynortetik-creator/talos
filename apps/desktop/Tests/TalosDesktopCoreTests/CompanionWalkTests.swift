import CoreGraphics
import Foundation
import Testing

@testable import TalosDesktopCore

/// What the controller decides about a walk, as plain functions and the model's answers to them. The window work itself (the
/// panel moving, the timers) needs a real panel and is covered by the GUI tests.
@Suite("Companion walks: the decisions")
struct CompanionWalkTests {
  typealias Kind = CompanionWalkKind

  @Test func nothingStartsWhileAWalkIsUnderWayAndRoundsWinOverAWander() {
    #expect(Kind.requested(roundsDue: true, wanderDue: true, walking: false) == .rounds, "both due: Rounds")
    #expect(Kind.requested(roundsDue: true, wanderDue: false, walking: false) == .rounds)
    #expect(Kind.requested(roundsDue: false, wanderDue: true, walking: false) == .wander, "only the wander is due")
    #expect(Kind.requested(roundsDue: false, wanderDue: false, walking: false) == nil)
    for (rounds, wander) in [(true, true), (true, false), (false, true)] {
      #expect(Kind.requested(roundsDue: rounds, wanderDue: wander, walking: true) == nil, "already walking: rounds \(rounds), wander \(wander)")
    }
  }

  @Test func aWanderGoesSixtyFourPointsOutAndRoundsOneHundredSeventySix() {
    #expect(Kind.wander.reach == 64 && Kind.rounds.reach == 176)
    let size = CompanionPlacement.standardSize
    let screen = CGRect(x: 0, y: 70, width: 1920, height: 985)
    let start = CGPoint(x: 400, y: 78)
    func farthest(_ k: Kind) -> CGFloat {
      let xs = CompanionPlacement.roundsPath(start: start, size: size, in: screen, reach: k.reach).xs
      return xs.map { abs($0 - start.x) }.max() ?? 0
    }
    #expect(farthest(.wander) == 64, "eight steps of 8 pt")
    #expect(farthest(.rounds) == 176)
  }

  @Test func neitherWalkStartsWhereHeCannotBeSeen() {
    for kind in [Kind.wander, Kind.rounds] {
      #expect(kind.mayStart(visible: true), "\(kind)")
      #expect(!kind.mayStart(visible: false), "\(kind): display asleep, screen locked or panel covered")
    }
  }

  /// A rig with three Rounds slots later today and a wander waiting.
  func rigWithBoth() -> Rig {
    let dice: (ClosedRange<Double>) -> Double = { $0 == CompanionModel.wanderGap ? $0.lowerBound : $0.upperBound }
    var r = Rig(random: dice)
    var plan = CompanionModel.Carry()
    plan.roundsDay = CompanionModel.dayKey(r.wall, window: nil)
    plan.roundsSlots = [10_000, 20_000, 30_000].map { r.wall.addingTimeInterval($0) }
    r.model = CompanionModel(random: dice, carry: plan)
    r.env.secondsSinceInput = 1
    r.env.antics = [:]
    r.advance(61, step: 1)
    return r
  }

  @Test func aDeclinedWalkDropsTheRoundsSlotOrRedrawsTheWanderWaitAccordingToItsKind() {
    var r = rigWithBoth()
    #expect(r.last?.wanderDue == true && r.model.carry.roundsSlots.count == 3, "setup: a wander waits and three slots are planned")
    r.record(r.model.walkDeclined(.wander, mono: r.mono, wall: r.wall))
    #expect(r.last?.wanderDue == false, "the wander wait starts over")
    #expect(r.model.carry.roundsSlots.count == 3, "a declined wander costs no Rounds slot")
    r.advance(61, step: 1)
    #expect(r.last?.wanderDue == true, "setup: due again")
    r.record(r.model.walkDeclined(.rounds, mono: r.mono, wall: r.wall))
    #expect(r.model.carry.roundsSlots.count == 2, "a declined Rounds drops its slot")
    #expect(r.last?.wanderDue == true, "and does not touch the wander wait")
  }

  @Test func aStartedWalkSpendsTheRoundsSlotOrTheWanderWaitAccordingToItsKind() {
    var r = rigWithBoth()
    r.record(r.model.walkStarted(.wander, mono: r.mono, wall: r.wall))
    #expect(r.last?.wanderDue == false, "the wander wait starts over")
    #expect(r.model.carry.roundsSlots.count == 3, "a wander costs no Rounds slot")
    var s = rigWithBoth()
    s.record(s.model.walkStarted(.rounds, mono: s.mono, wall: s.wall))
    #expect(s.model.carry.roundsSlots.count == 2, "Rounds spend their slot")
  }
}
