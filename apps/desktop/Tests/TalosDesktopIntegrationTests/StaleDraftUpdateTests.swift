import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// The automatic update and a forgotten draft: it waits on unsent text in Main's box, but once the text has been the same for 2 hours it
/// goes, after saving the signed copy that Update now saves. Any other blocker still holds it. Same real rig as ForcedUpdateWaitTests.
@Suite("Automatic update: a draft unchanged for 2 hours", .serialized)
struct StaleDraftUpdateTests {
  typealias Rig = AutoUpdaterTests.Rig
  typealias Box = AutoUpdaterTests.Box

  final class Draft: @unchecked Sendable {
    let fingerprint = Box<String?>("a")
    let kept = Box(0)
    let partial = Box(false)
    let keepAnswer = Box<UpdateStatus.DraftPlan>(.keep)
  }

  static func ready(_ r: Rig, _ d: Draft, real: Bool = true) throws -> AutoUpdater {
    try r.publish()
    let u = r.updater(
      realSwap: real,  // DEFAULT caps: the draft's 2 hours must fit inside the release's own 2-hour wait
      hooks: { h in
        h.draftFingerprint = { d.fingerprint.get() }
        h.draftPartial = { d.partial.get() }
        h.keepDraft = { _ in
          d.kept.edit { $0 += 1 }
          return d.keepAnswer.get()
        }
      })
    u.tick()
    #expect(u.status.pendingVersion == "1.5.0")
    u.tick()  // the first look at the draft: its clock starts here
    return u
  }

  static func advance(_ r: Rig, _ u: AutoUpdater, _ seconds: Double) {
    r.clock.edit { $0 += seconds }
    u.tick()
  }

  static func settle(_ r: Rig, _ u: AutoUpdater, _ n: Int = 10) {
    for _ in 0..<n { advance(r, u, 30) }
  }

  @Test func oneHourFiftyNineStillWaitsAndTwoHoursGoesAfterSavingACopy() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)  // the first look of the draft starts its clock
    Self.advance(r, u, 7140)  // 1 h 59 min
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0 && !r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "\(u.status)")
    Self.advance(r, u, 60)  // 2 h exactly
    Self.settle(r, u)
    #expect(r.spawns.get().count == 1, "went at 2 hours: \(u.status)\n\(r.audit())")
    #expect(!r.audit().contains("gave_up_waiting"), "the release's own wait did not end first:\n\(r.audit())")
    #expect(d.kept.get() == 1, "the signed copy was saved right before the swap")
    #expect(r.audit().contains("draft_unchanged"))
    #expect(r.audit().components(separatedBy: "draft_unchanged").count - 1 == 1, "the reason is logged once")
    #expect(r.audit().contains("draft unchanged for 2 hours; keeping a copy"))
    #expect(r.audit().contains("auto_update draft result=keep"))
  }

  @Test func aDraftThatChangesStartsTheTwoHoursAgain() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)
    Self.advance(r, u, 7000)  // nearly there
    d.fingerprint.set("b")  // the owner typed something
    Self.advance(r, u, 60)  // would have been past 2 hours
    Self.settle(r, u)
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0, "the clock restarted at the change: \(u.status)")
    Self.advance(r, u, 6800)  // 1 h 53 since the change
    Self.settle(r, u, 8)  // 1 h 57
    #expect(r.spawns.get().isEmpty, "\(u.status)")
    Self.advance(r, u, 150)  // past 2 hours since the change
    Self.settle(r, u)
    #expect(r.spawns.get().count == 1 && d.kept.get() == 1, "\(u.status)\n\(r.audit())")
  }

  @Test func aBoxThatCannotBeReadNeverCountsAsUnchanged() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason])
    d.fingerprint.set(nil)
    let u = try Self.ready(r, d)
    Self.advance(r, u, 20_000)
    Self.settle(r, u)
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0)
  }

  @Test func anotherBlockerStillHoldsItEvenWhenTheDraftIsOldEnough() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason, "main running"])
    let u = try Self.ready(r, d)
    Self.advance(r, u, 3600)
    Self.settle(r, u, 4)
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0, "a turn still holds it: \(u.status)")
    r.busy.set([AutoUpdate.mainDraftReason, "the owner wrote"])
    Self.advance(r, u, 3000)  // the owner's activity holds it as well
    Self.settle(r, u, 4)
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0, "\(u.status)")
    r.busy.set([AutoUpdate.mainDraftReason])  // only the draft is left, and it turns 2 hours old
    Self.settle(r, u, 30)
    #expect(r.spawns.get().count == 1, "\(u.status)\n\(r.audit())")
  }

  @Test func theOptionShortensTheTwoHours() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason])
    try r.publish()
    let u = r.updater(
      realSwap: true, options: { $0.draftStaleAfter = 600 },
      hooks: { h in
        h.draftFingerprint = { d.fingerprint.get() }
        h.keepDraft = { _ in .keep }
      })
    u.tick()
    u.tick()
    Self.advance(r, u, 590)
    #expect(r.spawns.get().isEmpty)
    Self.advance(r, u, 20)
    Self.settle(r, u)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  @Test func theNoticeShowsOnlyAfterAnUpdateTheAppRecorded() throws {
    final class Settled: @unchecked Sendable { let calls = Box<[String]>([]) }
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)
    Self.advance(r, u, 7200)
    Self.settle(r, u)
    #expect(r.spawns.get().count == 1)
    let s = Settled()
    #expect(s.calls.get().isEmpty, "nothing is offered while the update is only under way")
    _ = u
    let next = r.runNewApp(healthy: true, hooks: { h in h.draftSettled = { v, o in s.calls.edit { $0.append("\(v):\(o)") } } })
    next.tick()
    #expect(s.calls.get() == ["1.5.0:updated"], "\(s.calls.get()) \(next.status)")
  }

  @Test func aSwapThatNeverStartedDropsTheCopyInsteadOfShowingIt() throws {
    final class Settled: @unchecked Sendable { let calls = Box<[String]>([]) }
    let r = try Rig()
    let d = Draft()
    let s = Settled()
    r.busy.set([AutoUpdate.mainDraftReason])
    try r.publish()
    let u = r.updater(
      realSwap: true,
      hooks: { h in
        h.draftFingerprint = { d.fingerprint.get() }
        h.keepDraft = { _ in .keep }
        h.spawn = { _, _, _ in nil }
        h.draftSettled = { v, o in s.calls.edit { $0.append("\(v):\(o)") } }
      })
    u.tick()
    u.tick()
    Self.advance(r, u, 7200)
    Self.settle(r, u, 14)
    #expect(s.calls.get() == ["1.5.0:neverStarted"], "\(s.calls.get()) \(u.status)")
  }

  // MARK: the copy must be whole, or the automatic update does not go

  @Test func aCopyThatCannotBeKeptStopsTheAutomaticSwapAndSaysWhy() throws {
    let r = try Rig()
    let d = Draft()
    d.keepAnswer.set(.cannotKeep)
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)
    Self.advance(r, u, 7200)
    Self.settle(r, u, 14)
    #expect(r.spawns.get().isEmpty, "no swap without a copy: \(u.status)")
    #expect(r.head() == r.a, "the code folder was put back")
    #expect(r.audit().contains("draft_not_kept") && r.audit().contains("why=cannot_keep"), "\(r.audit())")
    #expect(!r.posts.get().contains(AutoUpdate.draftLostLine), "nothing was lost: the update did not go")
    d.keepAnswer.set(.keep)  // the box can be copied again
    Self.advance(r, u, 1800)  // the next window
    Self.settle(r, u, 16)
    #expect(r.spawns.get().count == 1, "\(u.status)\n\(r.audit())")
  }

  @Test func aPartialCopyStopsTheAutomaticSwapAndNothingIsSaved() throws {
    let r = try Rig()
    let d = Draft()
    d.partial.set(true)
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)
    Self.advance(r, u, 7200)
    Self.settle(r, u, 14)
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0, "\(u.status)")
    #expect(r.audit().contains("why=partial_or_unreadable"), "\(r.audit())")
    // never announced and never installed then undone: no false "will update in 2 minutes", no prepare, no loop
    #expect(!r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "\(r.posts.get())")
    #expect(!r.audit().contains("auto_update notice") && !r.audit().contains("prepared"), "\(r.audit())")
    Self.advance(r, u, 3600)
    Self.settle(r, u, 20)
    #expect(!r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")) && r.spawns.get().isEmpty, "still waiting, not looping")
  }

  @Test func givingUpStartsTheDraftCountAgain() throws {
    let r = try Rig()
    let d = Draft()
    r.busy.set([AutoUpdate.mainDraftReason, "main running"])  // a turn: the plain cap applies
    let u = try Self.ready(r, d)
    #expect(u.draftWatch.track != nil)
    Self.advance(r, u, 7300)
    #expect(r.audit().contains("gave_up_waiting"), "\(r.audit())")
    #expect(u.draftWatch.track == nil, "the count is not carried into the next release")
  }
}
