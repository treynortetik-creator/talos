import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// The release's 2 hours count from when it was ready. It must never give up at the very moment the machine is quiet, nor in the middle of
/// a postponement (a real log: notice at 23:42, "the owner wrote" at 23:43, 30 minutes of postponement, then "gave_up_waiting why=" with no
/// reason at 00:13). DEFAULT caps throughout. Same real rig as StaleDraftUpdateTests.
@Suite("Automatic update: the 2-hour cap and quiet looks", .serialized)
struct QuietCapEdgeTests {
  typealias Rig = AutoUpdaterTests.Rig

  static func ready(_ r: Rig) throws -> AutoUpdater {
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    #expect(u.status.pendingVersion == "1.5.0")
    return u
  }

  static func advance(_ r: Rig, _ u: AutoUpdater, _ seconds: Double) {
    r.clock.edit { $0 += seconds }
    u.tick()
  }

  static func settle(_ r: Rig, _ u: AutoUpdater, _ n: Int) {
    for _ in 0..<n { advance(r, u, 30) }
  }

  @Test func aPostponementThatOutlastsTheCapDoesNotGiveUpWhenTheMachineGoesQuiet() throws {
    let r = try Rig()
    r.busy.set(["main running"])
    let u = try Self.ready(r)
    Self.advance(r, u, 7000)  // a turn for almost the whole 2 hours
    r.busy.set([])
    Self.settle(r, u, 3)  // two quiet looks, then the notice
    #expect(r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "the notice went out: \(u.status)")
    r.owner.set("2026-11-14T23:43:00Z")  // the owner wrote during the notice
    Self.settle(r, u, 2)
    #expect(r.audit().contains("postponed"), "\(r.audit())")
    Self.advance(r, u, 1800)  // the postponement ends, past the release's 2 hours
    Self.settle(r, u, 12)
    #expect(!r.audit().contains("gave_up_waiting"), "it did not give up when quiet:\n\(r.audit())")
    #expect(r.spawns.get().count == 1, "it went: \(u.status)\n\(r.audit())")
  }

  @Test func aQuietLookPastTheCapGetsItsTryAndNeverGivesUpWithNoReason() throws {
    let r = try Rig()
    r.busy.set(["main running"])
    let u = try Self.ready(r)
    Self.advance(r, u, 7190)  // still a turn, just inside the cap
    r.busy.set([])
    Self.advance(r, u, 60)  // the first quiet look, past the 2 hours
    Self.settle(r, u, 14)
    #expect(!r.audit().contains("gave_up_waiting"), "\(r.audit())")
    #expect(r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "the quiet looks finished: \(u.status)")
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  @Test func stillGivesUpWhenItIsNeverQuietAndSaysWhy() throws {
    let r = try Rig()
    r.busy.set(["main running"])
    let u = try Self.ready(r)
    Self.advance(r, u, 7300)
    #expect(r.audit().contains("gave_up_waiting"), "a turn that lasts past the cap still ends the wait")
    #expect(r.audit().contains("why=main running"), "\(r.audit())")
    #expect(!r.audit().contains("why= ") && !r.audit().contains("why=\n"), "never an empty reason:\n\(r.audit())")
  }
}
