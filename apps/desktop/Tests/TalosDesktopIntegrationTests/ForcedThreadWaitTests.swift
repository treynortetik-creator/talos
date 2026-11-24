import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// Update now and the thread agents: Main's turn and a busy thread agent are both waited for as long as they run (until the 2 hours every wait has), and
/// "Update now anyway" is the only way past a thread. The same real rig as ForcedUpdateWaitTests.
@Suite("Update now: thread agents are waited for like Main", .serialized)
struct ForcedThreadWaitTests {
  typealias Rig = AutoUpdaterTests.Rig

  static let busyThread = "thread ari_s_cc_skill busy"

  static func ready(_ r: Rig, real: Bool = true, options: (@Sendable (inout AutoUpdater.Options) -> Void)? = nil) throws -> AutoUpdater {
    try r.publish()
    let u = r.updater(
      realSwap: real, options: options,
      hooks: { h in
        h.draftPlan = { .none }
        h.threadName = { $0 == "ari_s_cc_skill" ? "Ari Skill" : $0 }
      })
    u.tick()
    #expect(u.status.pendingVersion == "1.5.0")
    return u
  }

  static func steps(_ r: Rig, _ u: AutoUpdater, _ n: Int) {
    for _ in 0..<n { ForcedUpdateWaitTests.step(r, u) }
  }

  /// Inside the updater's own folder, which only this app can open.
  var markerPath: (Rig) -> String { { $0.home + "/auto-update/update-interrupted.json" } }

  /// Old code: at 300 s from the press the thread reason was dropped and the update went (spawns == 1), cutting the turn off.
  @Test func aBusyThreadHoldsTheUpdateForAsLongAsItRunsAndThenItGoesWithoutACutOff() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 80)  // 40 minutes: far past the old 5
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "nothing moved while the thread works: \(u.status)")
    guard case .waitingForTurn(_, _, _, let t?) = u.status else {
      Issue.record("expected a thread wait, got \(u.status)")
      return
    }
    #expect(t.names == ["Ari Skill"])
    #expect(u.status.words.headline == "Waiting for Ari Skill to finish")
    #expect(u.status.words.detail.contains("press Update now anyway"), "\(u.status.words.detail)")
    #expect(!u.status.words.detail.contains("minute"), "no short time limit is promised: \(u.status.words.detail)")
    #expect(u.status.offersSkipThreadWait, "the way to go ahead is offered where it waits on a thread")
    r.busy.set([])  // the turn ended on its own
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "it goes once the thread is quiet: \(u.status)\n\(r.audit())")
    #expect(!FileManager.default.fileExists(atPath: markerPath(r)), "nothing was cut off, so no list of threads")
    #expect(!r.audit().contains("update_interrupted"))
  }

  /// "Update now anyway" names the busy thread for the bridge (the Send again card), as before.
  @Test func updateNowAnywayWritesTheListOfCutOffThreadsPrivately() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 4)
    u.skipThreadWait()
    u.queue.sync {}
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)\n\(r.audit())")
    func mode(_ p: String) -> Int { ((try? FileManager.default.attributesOfItem(atPath: p)[.posixPermissions]) as? Int) ?? -1 }
    #expect(mode(markerPath(r)) == 0o600, "the file is the app's alone")
    #expect(mode(r.home + "/auto-update") == 0o700, "and so is its folder")
    let raw = try String(contentsOfFile: markerPath(r), encoding: .utf8)
    let o = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    #expect(o["threads"] as? [String] == ["ari_s_cc_skill"] && o["v"] as? Int == 1 && o["at"] is String)
    let commit = try #require(o["commit"] as? String)
    #expect(commit.count == 40 && commit.allSatisfy { $0.isHexDigit }, "bound to the release's commit, not its version name: \(commit)")
    #expect(o["version"] as? String == "1.5.0")
    #expect(r.audit().contains("why=thread ari_s_cc_skill busy"))
  }

  /// Old code: the failed write was logged and the update went on, cutting the thread off with no list to send it again from.
  @Test func updateNowAnywayStopsBeforeUpdatingWhenTheListCannotBeSaved() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    // a folder where the list goes (with something in it): the list cannot be written there
    try FileManager.default.createDirectory(atPath: markerPath(r), withIntermediateDirectories: true)
    try "x".write(toFile: markerPath(r) + "/keep", atomically: true, encoding: .utf8)
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 2)
    u.skipThreadWait()
    u.queue.sync {}
    Self.steps(r, u, 10)
    #expect(r.spawns.get().isEmpty, "nothing was swapped: \(u.status)\n\(r.audit())")
    #expect(r.head() == r.a && r.branch() == "main", "the code folder is back where it was")
    guard case .failed(let line, _) = u.status else {
      Issue.record("expected a plain failure line, got \(u.status)")
      return
    }
    #expect(line == AutoUpdate.interruptedListLine("1.5.0", old: "1.4.0"), "\(line)")
    #expect(r.audit().contains("update_interrupted result=not_written"))
    // once the list can be written, an Update now goes through
    try FileManager.default.removeItem(atPath: markerPath(r))
    r.busy.set([])
    r.clock.edit { $0 += AutoUpdate.postponeFor }
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 8)
    #expect(r.spawns.get().count == 1, "\(u.status)\n\(r.audit())")
  }

  @Test func severalThreadsAreNamedAsYourThreadAgents() {
    let two = UpdateStatus.ThreadWait(names: ["Trip", "Budget"])
    #expect(two.line == "Waiting for your thread agents to finish")
    #expect(UpdateStatus.ThreadWait(names: [], background: true).line == "Waiting for background work in your threads to finish")
    #expect(UpdateStatus.ThreadWait(names: []).line == "Waiting for your thread agents to finish", "none named and not background work")
    #expect(UpdateStatus.ThreadWait(names: ["Trip", "Trip"]).line == "Waiting for Trip to finish")
    let s = UpdateStatus.waitingForTurn(version: "1.5.0", threads: two)
    #expect(UpdateMenu.title(s) == "Update to 1.5.0: waiting for your thread agents to finish\u{2026}")
    #expect(!UpdateStatus.waitingForTurn(version: "1.5.0", why: ["main running"]).offersSkipThreadWait)
    #expect(UpdateStatus.skipThreadWaitButton == "Update now anyway")
  }

  /// A background server that never ends (a dev server a shell started) holds an Update now for ever: the button is the way out.
  @Test func backgroundWorkInAThreadHoldsUntilItEndsOrTheOwnerGoesAnyway() throws {
    let r = try Rig()
    r.busy.set(["thread background work: zsh (pid 4242)"])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 40)
    #expect(r.spawns.get().isEmpty, "\(u.status)")
    #expect(u.status.words.headline == "Waiting for background work in your threads to finish")
    #expect(u.status.offersSkipThreadWait)
    u.skipThreadWait()
    u.queue.sync {}
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)")
    #expect(!FileManager.default.fileExists(atPath: markerPath(r)), "no thread was named, so there is no list")
  }

  // MARK: Update now anyway

  @Test func updateNowAnywaySkipsTheThreadWaitAtOnce() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 2)
    #expect(r.spawns.get().isEmpty)
    u.skipThreadWait()
    u.queue.sync {}
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "no wait at all: \(u.status)")
    #expect(r.audit().contains("update_now_anyway"))
  }

  @Test func updateNowAnywayNeverSkipsMainsRunningTurn() throws {
    let r = try Rig()
    r.busy.set(["main running", Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    // Main is mid-turn: the button is not offered at all (a decision: hidden, not disabled)
    #expect(!u.status.offersSkipThreadWait, "\(u.status)")
    #expect(u.status.words.headline == "Waiting for your agent to finish its turn")
    u.skipThreadWait()  // a press that arrives anyway (a stale window)
    u.queue.sync {}
    Self.steps(r, u, 40)  // 20 minutes
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "Main's turn is never cut off: \(u.status)")
    // Main's turn ends; the thread was skipped by the owner's own press, so it goes without any further thread wait
    r.busy.set([Self.busyThread])
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  /// Old code: the thread's 5 minutes ran out while Main worked, so the thread no longer held the update once Main was done.
  @Test func whenMainsTurnEndsABusyThreadStillHoldsTheUpdate() throws {
    let r = try Rig()
    r.busy.set(["main running", Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 30)
    #expect(r.spawns.get().isEmpty)
    r.busy.set([Self.busyThread])  // Main done; the thread is not
    Self.steps(r, u, 20)
    #expect(r.spawns.get().isEmpty, "\(u.status)")
    #expect(u.status.offersSkipThreadWait, "now it waits on a thread, so the button is there")
    r.busy.set([])
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  /// A thread reason with no id that is not background work (a restart under way) is "your thread agents", never "background work".
  @Test func aThreadRestartUnderWayIsNotCalledBackgroundWork() throws {
    let r = try Rig()
    r.busy.set(["a thread restart is under way"])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 2)
    #expect(u.status.words.headline == "Waiting for your thread agents to finish", "\(u.status)")
  }

  /// The wait has the same 2 hours as Main's: a thread that never ends does not hold it for ever, and the owner is told plainly.
  @Test func aThreadThatNeverEndsEndsTheWaitAfterTwoHoursWithAPlainLine() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 250)  // a little over 2 hours
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "nothing was cut off: \(u.status)")
    #expect(u.status == .failed(line: AutoUpdate.busyLine("1.5.0", old: "1.4.0"), logPath: u.logPathForOwner), "\(u.status)")
    #expect(r.audit().contains("gave_up_waiting"))
  }

  @Test func aSecondPressOfUpdateNowDoesNotSkipTheThreadWait() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 8)
    u.updateNow()  // the window's Install pressed again
    u.queue.sync {}
    Self.steps(r, u, 30)
    #expect(r.spawns.get().isEmpty, "a second press is not the owner's Update now anyway: \(u.status)")
  }

  // MARK: the automatic path keeps its rules

  @Test func theAutomaticPathStillWaitsForBusyThreadsAndMakesNoMarker() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)  // no Update now
    Self.steps(r, u, 20)  // 10 minutes
    #expect(r.spawns.get().isEmpty && !r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")), "\(u.status)")
    if case .waitingForQuiet = u.status {} else { Issue.record("expected waiting for a quiet moment, got \(u.status)") }
    #expect(!FileManager.default.fileExists(atPath: markerPath(r)))
    r.busy.set([])  // quiet at last: the notice, as before
    Self.steps(r, u, 4)
    #expect(r.posts.get().contains(AutoUpdate.noticeLine("1.5.0")))
  }

  @Test func aCleanSwapRemovesAnOldMarker() throws {
    let r = try Rig()
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    try "{\"v\":1}".write(toFile: markerPath(r), atomically: true, encoding: .utf8)
    let u = try Self.ready(r)  // nothing busy
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 6)
    #expect(r.spawns.get().count == 1)
    #expect(!FileManager.default.fileExists(atPath: markerPath(r)), "no stale list of threads is left for the next start")
  }

  @Test func theReasonWordsSplitMainFromTheThreads() {
    #expect(AutoUpdate.isThreadReason("thread trip busy") && AutoUpdate.isThreadReason("a thread restart is under way"))
    #expect(!AutoUpdate.isThreadReason("main running") && !AutoUpdate.isThreadReason("background work under main"))
    #expect(AutoUpdate.threadId(in: "thread trip busy") == "trip")
    #expect(AutoUpdate.threadId(in: "thread background work: zsh (pid 1)") == nil)
    #expect(AutoUpdate.threadId(in: "main busy") == nil)
  }

  @Test func aLaterPressWhileTheUpdateIsInItsFinalLooksKeepsTheSkipAndTheClock() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 2)
    u.skipThreadWait()
    u.queue.sync {}
    // run to the point where the folder has moved and the final looks begin
    var inFinal = false
    for _ in 0..<12 where !inFinal {
      ForcedUpdateWaitTests.step(r, u)
      u.queue.sync { if case .final = u.phase { inFinal = true } }
      if !r.spawns.get().isEmpty { break }
    }
    guard inFinal else {
      #expect(r.spawns.get().count == 1, "it went through the final looks at once: \(u.status)")
      return
    }
    u.updateNow()  // a second press in the final looks must not reset what the owner already chose
    u.queue.sync {}
    #expect(u.forcedThreads.skip && u.forcedThreads.pressedAt != nil, "the skip stands")
    Self.steps(r, u, 4)
    #expect(r.spawns.get().count == 1, "the busy thread did not hold it again: \(u.status)")
  }
}
