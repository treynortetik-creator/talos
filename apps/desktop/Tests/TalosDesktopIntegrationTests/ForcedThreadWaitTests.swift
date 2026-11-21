import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// Update now and the thread agents: Main's turn is waited for as long as it runs, a busy thread agent for at most 5 minutes from the
/// press (an option), and "Update now anyway" skips only the thread part. The same real rig as ForcedUpdateWaitTests.
@Suite("Update now: thread agents get 5 minutes", .serialized)
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

  @Test func aBusyThreadHoldsTheUpdateFiveMinutesFromThePressAndThenItGoes() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 9)  // 270 s
    #expect(r.spawns.get().isEmpty && r.head() == r.a, "still inside the 5 minutes: nothing moved: \(u.status)")
    guard case .waitingForTurn(_, _, _, let t?) = u.status else {
      Issue.record("expected a thread wait, got \(u.status)")
      return
    }
    #expect(t.names == ["Ari Skill"] && t.minutes == 5)
    #expect(u.status.words.headline == "Waiting for Ari Skill to finish (up to 5 minutes)")
    #expect(u.status.words.detail.contains("Anything they were still working on may be cut off. You can send it again from the thread."))
    #expect(!u.status.words.detail.contains("sent to them again"), "nothing is promised that is not done")
    #expect(u.status.offersSkipThreadWait)
    Self.steps(r, u, 8)
    #expect(r.spawns.get().count == 1, "5 minutes passed, the update went: \(u.status)\n\(r.audit())")
    // the thread that was cut is named for the bridge, which re-sends its turn once
    func mode(_ p: String) -> Int { ((try? FileManager.default.attributesOfItem(atPath: p)[.posixPermissions]) as? Int) ?? -1 }
    #expect(mode(markerPath(r)) == 0o600, "the file is the app's alone")
    #expect(mode(r.home + "/auto-update") == 0o700, "and so is its folder")
    let raw = try String(contentsOfFile: markerPath(r), encoding: .utf8)
    let o = try #require(try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
    #expect(o["threads"] as? [String] == ["ari_s_cc_skill"] && o["v"] as? Int == 1 && o["at"] is String)
    let commit = try #require(o["commit"] as? String)
    #expect(commit.count == 40 && commit.allSatisfy { $0.isHexDigit }, "bound to the release's commit, not its version name: \(commit)")
    #expect(o["version"] as? String == "1.5.0")
    #expect(r.audit().contains("update_now_waiting"))
    // one line for the thread reason however many looks it lasted, and one more when it changed (the 5 minutes ran out)
    #expect(r.audit().components(separatedBy: "update_now_waiting").count - 1 == 2, "\(r.audit())")
    #expect(r.audit().contains("why=thread ari_s_cc_skill busy"))
  }

  @Test func theFiveMinutesIsAnOption() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r, options: { $0.threadWait = 60 })
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 1)  // 30 s
    #expect(r.spawns.get().isEmpty)
    #expect(u.status.words.headline == "Waiting for Ari Skill to finish (up to 1 minute)")
    Self.steps(r, u, 8)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  @Test func severalThreadsAreNamedAsYourThreadAgents() {
    let two = UpdateStatus.ThreadWait(names: ["Trip", "Budget"])
    #expect(two.line == "Waiting for your thread agents to finish (up to 5 minutes)")
    #expect(UpdateStatus.ThreadWait(names: []).line == "Waiting for your thread agents to finish (up to 5 minutes)")
    #expect(UpdateStatus.ThreadWait(names: ["Trip", "Trip"]).line == "Waiting for Trip to finish (up to 5 minutes)")
    let s = UpdateStatus.waitingForTurn(version: "1.5.0", threads: two)
    #expect(UpdateMenu.title(s) == "Update to 1.5.0: waiting for your thread agents to finish (up to 5 minutes)\u{2026}")
    #expect(!UpdateStatus.waitingForTurn(version: "1.5.0", why: ["main running"]).offersSkipThreadWait)
    #expect(UpdateStatus.skipThreadWaitButton == "Update now anyway")
  }

  @Test func backgroundWorkInAThreadAlsoGetsOnlyFiveMinutes() throws {
    let r = try Rig()
    r.busy.set(["thread background work: zsh (pid 4242)"])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 3)
    #expect(u.status.words.headline == "Waiting for your thread agents to finish (up to 5 minutes)")
    Self.steps(r, u, 16)
    #expect(r.spawns.get().count == 1, "\(u.status)")
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
    #expect(r.spawns.get().count == 1, "no 5 minutes: \(u.status)")
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
    // Main's turn ends; the thread was skipped, so it goes without any further thread wait
    r.busy.set([Self.busyThread])
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  @Test func afterTheFiveMinutesMainsTurnStillHoldsTheUpdate() throws {
    let r = try Rig()
    r.busy.set(["main running", Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 30)
    #expect(r.spawns.get().isEmpty)
    r.busy.set([Self.busyThread])  // Main done; the thread's 5 minutes ran out long ago
    Self.steps(r, u, 5)
    #expect(r.spawns.get().count == 1, "\(u.status)")
  }

  @Test func aSecondPressOfUpdateNowDoesNotRestartTheFiveMinutes() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)
    u.updateNow()
    u.queue.sync {}
    Self.steps(r, u, 8)  // 240 s
    u.updateNow()  // the window's Install pressed again
    u.queue.sync {}
    Self.steps(r, u, 8)
    #expect(r.spawns.get().count == 1, "the clock still counts from the first press: \(u.status)")
  }

  // MARK: the automatic path keeps its rules

  @Test func theAutomaticPathStillWaitsForBusyThreadsAndMakesNoMarker() throws {
    let r = try Rig()
    r.busy.set([Self.busyThread])
    let u = try Self.ready(r)  // no Update now
    Self.steps(r, u, 20)  // 10 minutes: far past the forced path's 5
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
