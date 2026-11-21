import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// Update now: what the window says while it waits, the draft it keeps, and the automatic path that still waits on a draft. The same
/// real rig as AutoUpdaterCheckNowTests (a signed file feed, a real clone, the real apply script).
@Suite("Update now: why it waits and the draft", .serialized)
struct ForcedUpdateWaitTests {
  typealias Rig = AutoUpdaterTests.Rig
  typealias Box = AutoUpdaterTests.Box

  static func step(_ r: Rig, _ u: AutoUpdater) { AutoUpdaterCheckNowTests.step(r, u) }

  /// What the hooks were asked to do about the draft.
  final class Drafts: @unchecked Sendable {
    let plan = Box<UpdateStatus.DraftPlan>(.keep)
    let keepAnswer = Box<UpdateStatus.DraftPlan>(.keep)
    let kept = Box(0)
    let keptFor = Box<[String]>([])
  }

  static func ready(_ r: Rig, _ d: Drafts, real: Bool = true) throws -> AutoUpdater {
    try r.publish()
    let u = r.updater(
      realSwap: real,
      hooks: { h in
        h.draftPlan = { d.plan.get() }
        h.keepDraft = { version in
          d.keptFor.edit { $0.append(version) }
          d.kept.edit { $0 += 1 }
          return d.keepAnswer.get()
        }
      })
    u.tick()
    #expect(u.status.pendingVersion == "1.5.0")
    return u
  }

  // MARK: Update now overrides a draft

  @Test func updateNowWithADraftDoesNotWaitOnItSavesItAndGoes() throws {
    let r = try Rig()
    let d = Drafts()
    r.busy.set([AutoUpdate.mainDraftReason])  // unsent text in Main's box, nothing else
    let u = try Self.ready(r, d)
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<6 { Self.step(r, u) }
    #expect(r.spawns.get().count == 1, "the draft did not hold the update: \(u.status)")
    #expect(d.kept.get() == 1, "the draft was saved once, right before the swap")
    #expect(d.keptFor.get() == ["1.5.0"], "bound to the version it is saved for")
    #expect(r.audit().contains("auto_update draft result=keep"))
  }

  @Test func theWindowSaysTheDraftWillBeKeptWhileATurnStillRuns() throws {
    let r = try Rig()
    let d = Drafts()
    r.busy.set([AutoUpdate.mainDraftReason, "main running"])
    let u = try Self.ready(r, d, real: false)
    u.updateNow()
    u.queue.sync {}
    #expect(u.status == .waitingForTurn(version: "1.5.0", why: ["main running"], draft: .keep), "\(u.status)")
    let w = u.status.words
    #expect(w.headline == "Waiting for your agent to finish its turn")
    #expect(w.detail.contains("Talos will keep a copy of your unsent text"))
    #expect(d.kept.get() == 0, "nothing is saved while it waits")
  }

  @Test func aDraftThatCannotBeKeptIsSaidBeforehandAndTheUpdateStillGoesAndTheOwnerIsToldAfterToo() throws {
    let r = try Rig()
    let d = Drafts()
    d.plan.set(.cannotKeep)
    d.keepAnswer.set(.cannotKeep)
    r.busy.set([AutoUpdate.mainDraftReason, "main running"])
    let u = try Self.ready(r, d)
    u.updateNow()
    u.queue.sync {}
    #expect(u.status == .waitingForTurn(version: "1.5.0", why: ["main running"], draft: .cannotKeep))
    #expect(u.status.words.detail.contains("couldn\u{2019}t keep a copy of your unsent text"))
    r.busy.set([AutoUpdate.mainDraftReason])
    for _ in 0..<6 { Self.step(r, u) }
    #expect(r.spawns.get().count == 1, "still updates")
    #expect(r.posts.get().contains(AutoUpdate.draftLostLine), "and says the text is gone")
  }

  @Test func theAutomaticPathStillWaitsOnADraftAndSavesNothing() throws {
    let r = try Rig()
    let d = Drafts()
    r.busy.set([AutoUpdate.mainDraftReason])
    let u = try Self.ready(r, d)  // no Update now
    for _ in 0..<12 { Self.step(r, u) }
    #expect(r.spawns.get().isEmpty && d.kept.get() == 0)
    #expect(!r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "no notice while a draft is there")
    if case .waitingForQuiet = u.status {} else { Issue.record("expected waiting for a quiet moment, got \(u.status)") }
  }

  @Test func aTurnStillBlocksUpdateNowEvenWithADraft() throws {
    let r = try Rig()
    let d = Drafts()
    r.busy.set([AutoUpdate.mainDraftReason, "main running"])
    let u = try Self.ready(r, d)
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<8 { Self.step(r, u) }
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "a running turn is never cut off")
  }

  // MARK: the reasons

  @Test func eachReasonHasItsOwnPlainWords() {
    let cases: [([String], String)] = [
      (["main running"], "Waiting for your agent to finish its turn"),
      (["main busy"], "Waiting for your agent to finish its turn"),
      (["background work under main"], "Waiting for background work"),
      (["main keys"], "Waiting: you are typing"),
      (["the owner wrote"], "Waiting: you are typing"),
      (["main needs the owner"], "Waiting: your agent is waiting for you"),
      (["main has a draft"], "Waiting: you have unsent text in your main chat"),
      ([], "Waiting for your agent to finish its turn"),
    ]
    for (why, headline) in cases {
      #expect(UpdateStatus.waitingForTurn(version: "1.5.0", why: why).words.headline == headline, "\(why)")
    }
  }

  @Test func theMenuNamesTheReasonToo() {
    #expect(UpdateMenu.title(.waitingForTurn(version: "1.5.0", why: ["main running"])) == "Update to 1.5.0: waiting for your agent to finish its turn\u{2026}")
    #expect(UpdateMenu.title(.waitingForTurn(version: "1.5.0", why: ["main has a draft"])) == "Update to 1.5.0: you have unsent text in your main chat\u{2026}")
    #expect(UpdateMenu.showsDot(.waitingForTurn(version: "1.5.0")))
  }

  @Test func eachWaitingReasonIsLoggedOnceAndAgainOnlyWhenItChanges() throws {
    let r = try Rig()
    let d = Drafts()
    r.busy.set(["main running"])
    let u = try Self.ready(r, d, real: false)
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<5 { Self.step(r, u) }
    func count(_ s: String) -> Int { r.audit().components(separatedBy: "update_now_waiting").count - 1 + 0 * s.count }
    #expect(count("") == 1, "five looks, one reason, one line:\n\(r.audit())")
    r.busy.set(["background work under main"])
    for _ in 0..<3 { Self.step(r, u) }
    #expect(count("") == 2)
    #expect(u.status.words.headline == "Waiting for background work")
    r.busy.set(["main keys"])
    Self.step(r, u)
    #expect(count("") == 3 && u.status.words.headline == "Waiting: you are typing")
    #expect(r.audit().contains("why=main running") && r.audit().contains("why=background work under main"))
  }

  // MARK: an update that settles shows or drops the copy (R1-2)

  final class Settled: @unchecked Sendable {
    let calls = Box<[String]>([])
  }

  @Test func theNewAppOffersTheCopyOnlyAfterTheUpdateReallyHappened() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<4 { Self.step(r, u) }
    let s = Settled()
    #expect(s.calls.get().isEmpty, "nothing is offered while the update is only under way")
    let next = r.runNewApp(healthy: true, hooks: { h in h.draftSettled = { v, o in s.calls.edit { $0.append("\(v):\(o)") } } })
    next.tick()
    #expect(s.calls.get() == ["1.5.0:updated"], "\(s.calls.get()) \(next.status)")
  }

  @Test func anUnhealthyUpdateThatRollsBackOffersTheCopyBecauseMainWasRestarted() throws {
    let r = try Rig()
    try r.publish()
    let u = r.updater(realSwap: true)
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<4 { Self.step(r, u) }
    let s = Settled()
    _ = r.runNewApp(healthy: false, hooks: { h in h.draftSettled = { v, o in s.calls.edit { $0.append("\(v):\(o)") } } })
    #expect(s.calls.get() == ["1.5.0:triedAndFailed"], "offered once, after the rollback: \(s.calls.get()) \(r.audit())")
  }

  @Test func aSwapThatCouldNotBeSpawnedDropsTheCopyBecauseNothingQuit() throws {
    let r = try Rig()
    try r.publish()
    let s = Settled()
    let u = r.updater(realSwap: true, hooks: { h in
      h.spawn = { _, _, _ in nil }
      h.draftSettled = { v, o in s.calls.edit { $0.append("\(v):\(o)") } }
    })
    u.tick()
    u.updateNow()
    u.queue.sync {}
    for _ in 0..<6 { Self.step(r, u) }
    #expect(s.calls.get() == ["1.5.0:neverStarted"], "\(s.calls.get()) \(u.status)")
  }

  // MARK: Update now never hangs for want of a timer (R1-6)

  @Test func updateNowSchedulesItsOwnLooksWhenTheUpdatersTimerIsNotRunning() throws {
    let r = try Rig()
    let d = Drafts()
    try r.publish()
    let u = r.updater(realSwap: true, quietPoll: 0.05, hooks: { h in h.draftPlan = { .none } })
    u.tick()  // the one look that found the release; start() is never called: this is Talos before setup
    #expect(u.status.pendingVersion == "1.5.0")
    u.updateNow()
    // nobody ticks again: the update's own looks carry it through the prepare and the swap
    #expect(waitUntil(timeout: 20, poll: 0.1) { !r.spawns.get().isEmpty }, "it hung: \(u.status)")
    _ = d
    u.stop()
  }
}
