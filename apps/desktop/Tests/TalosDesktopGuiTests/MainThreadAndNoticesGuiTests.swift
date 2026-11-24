import AppKit
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop
@testable import TalosSupervisor

/// "Forget this Mac" by name: a revoke that worked stays done whatever the next one did. Pure: no controller, no CLI.
@Suite("Forget this Mac by name: what is said and what is deleted")
struct ForgetByNameOutcomeTests {
  @Test func everyRevokeWorkedSoTheSignInGoes() {
    let o = WebController.byNameOutcome(found: 2, failed: 0)
    #expect(o.ok && o.wipe && o.note == "Revoked 2 device(s).")
  }

  @Test func noRevokeWorkedSoNothingIsDeleted() {
    let o = WebController.byNameOutcome(found: 2, failed: 2)
    #expect(!o.ok && !o.wipe)
    #expect(o.note.contains("nothing was revoked and nothing was deleted"))
  }

  @Test func someWorkedSoTheCountIsSaidAndTheSignInGoes() {
    let o = WebController.byNameOutcome(found: 3, failed: 1)
    #expect(!o.ok, "it is not reported as a clean forget")
    #expect(o.wipe, "this window's device may be one of the two that were revoked: its key must not stay looking signed in")
    #expect(o.note.contains("Revoked 2 of 3") && o.note.contains("1 revoke(s) failed"))
    #expect(!o.note.contains("nothing was"), "it must not say nothing happened")
  }
}

// The real controller: what holds the main thread, where a thread session's line shows, and what happens when desktop.json names
// another Talos home. Runs only with TALOS_GUI_TESTS=1, on the scratch HOME `TmuxWorld.root` sets; no session is ever started.
@MainActor
@Suite("Mac: main thread and thread-session notices", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct MainThreadAndNoticesGuiTests {
  @MainActor private final class World {
    let model: SupervisorController
    let store = MemoryStore()

    init() throws {
      cannotTakeTheKeyboard()
      _ = TmuxWorld.root
      TmuxWorld.hookBundle()
      try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
      model = SupervisorController(store: store)
      model.beginSession = { _ in false }  // no test here starts a session
    }

    func close() {
      model.workers?.detach()
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    }

    /// Lets the main actor run what was queued for it, until `done` or about `seconds` have passed.
    func settle(_ seconds: Double = 5, until done: () -> Bool) async {
      let end = Date().addingTimeInterval(seconds)
      while !done(), Date() < end { try? await Task.sleep(nanoseconds: 20_000_000) }
    }
  }

  /// Holds the supervisor's queue the way a tick in a slow tmux call does. It lets go by itself after `limit`, so code that waits
  /// on the queue from the main thread fails its timing instead of hanging the run.
  private final class HeldQueue: @unchecked Sendable {
    private let gate = DispatchSemaphore(value: 0)
    init(_ sup: Supervisor, limit: Double = 2) {
      let gate = self.gate
      sup.q.async { _ = gate.wait(timeout: .now() + limit) }
    }
    func release() { gate.signal() }
  }

  private func seconds(_ body: () -> Void) -> Double {
    let t = Date()
    body()
    return Date().timeIntervalSince(t)
  }

  // MARK: Find a running session

  @Test func findingARunningSessionDoesNotHoldTheMainThread() async throws {
    let w = try World()
    defer { w.close() }
    let gate = DispatchSemaphore(value: 0)
    let calls = Counter()
    // the three reads, as slow as a login shell and `claude` can be; they let go after 2 s whatever happens
    w.model.adoptLookup = { _, _, _ in
      calls.bump()
      #expect(!Thread.isMainThread, "the reads never run on the main thread")
      _ = gate.wait(timeout: .now() + 2)
      return AdoptLookup(plan: nil, note: "No other session holds Telegram or the bridge.")
    }
    let took = seconds { w.model.findSessionToAdopt() }
    #expect(took < 0.5, "the click came back in \(took) s")
    #expect(w.model.adoptLooking && w.model.adoptNote == AdoptLookup.looking, "and the window says it is looking")
    w.model.findSessionToAdopt()  // a second click while it looks
    gate.signal()
    await w.settle { !w.model.adoptLooking }
    #expect(!w.model.adoptLooking)
    #expect(w.model.adopt == nil && w.model.adoptNote == "No other session holds Telegram or the bridge.")
    #expect(calls.value == 1, "one search, not two")
  }

  // MARK: settings changes

  @Test func aSettingsChangeDoesNotWaitForTheSupervisorsQueue() async throws {
    let w = try World()
    defer { w.close() }
    #expect(w.model.importCommand("claude --one") == nil)
    let was = w.model.supervisor.currentConfig()
    let held = HeldQueue(w.model.supervisor)

    let took = seconds {
      w.model.saveSetting { $0.keepAwakeOnAC = !was.keepAwakeOnAC }
      w.model.saveSetting { $0.autoRestart.toggle() }
      w.model.saveSetting { $0.autoRestart.toggle() }  // an edit that is not the same twice: laid on once each
      #expect(w.model.editLaunchLine("claude --one --two") == .updated(claudePath: "auto", args: MainChannelFlag.ensured(["--one", "--two"])))
      #expect(w.model.useAgentFolder("/home/alex/elsewhere", launchArgs: []) == nil)
      #expect(w.model.terminalCommand.contains("--one --two"))
    }
    #expect(took < 0.5, "five settings changes and a copy took \(took) s with the supervisor busy")
    #expect(w.model.supervisor.currentConfig() == was, "control: the supervisor has applied nothing yet")
    // what the windows read meanwhile
    let now = w.model.configNow
    #expect(now.keepAwakeOnAC == !was.keepAwakeOnAC && now.autoRestart == was.autoRestart)
    #expect(now.args == MainChannelFlag.ensured(["--one", "--two"]) && now.agentDir == "/home/alex/elsewhere")
    #expect(w.model.editLaunchLine("claude --one --two") == .unchanged, "the box is judged against the change just made")

    let revision = w.model.configRevision
    held.release()
    w.model.supervisor.drain()
    await w.settle { w.model.configRevision >= revision + 2 }
    let after = w.model.supervisor.currentConfig()
    #expect(after.keepAwakeOnAC == !was.keepAwakeOnAC && after.autoRestart == was.autoRestart)
    #expect(after.args == MainChannelFlag.ensured(["--one", "--two"]) && after.agentDir == "/home/alex/elsewhere")
    #expect(w.model.configNow == after, "nothing is left laid over the supervisor's config")
    #expect(w.model.configRevision == revision + 2, "the launch line and the folder each told the windows to reload, once applied")
    let disk = try #require(try ConfigFile.load(SupervisorController.configPath))
    #expect(disk.args == MainChannelFlag.ensured(["--one", "--two"]) && disk.keepAwakeOnAC == !was.keepAwakeOnAC, "and it reached desktop.json")
  }

  @Test func aSettingChangedBeforeSetupIsHeldAtOnceAndReachesTheImport() async throws {
    let w = try World()
    defer { w.close() }
    let held = HeldQueue(w.model.supervisor)
    let took = seconds { w.model.saveSetting { $0.keepAwakeOnAC = true; $0.notifyThread = "daily" } }
    #expect(took < 0.5)
    #expect(PreSetup.load(w.store)?.keepAwakeOnAC == true, "held for the next launch without waiting for the supervisor")
    #expect(!FileManager.default.fileExists(atPath: SupervisorController.configPath), "a toggle never makes the file")
    held.release()
    #expect(w.model.importCommand("claude --one") == nil)
    let c = w.model.supervisor.currentConfig()
    #expect(c.keepAwakeOnAC && c.notifyThread == "daily" && c.args == MainChannelFlag.ensured(["--one"]))
  }

  @Test func aHotkeyRebindDoesNotWriteOverASettingStillOnItsWay() async throws {
    let w = try World()
    defer { w.close() }
    #expect(w.model.importCommand("claude --one") == nil)
    let was = w.model.supervisor.currentConfig()
    let held = HeldQueue(w.model.supervisor)
    // a toggle and a folder change that the supervisor has not applied yet, then the rebind
    w.model.saveSetting { $0.keepAwakeOnAC = !was.keepAwakeOnAC }
    #expect(w.model.useAgentFolder("/home/alex/elsewhere", launchArgs: []) == nil)
    w.model.saveComposeHotkey("cmd+shift+k")
    held.release()
    w.model.supervisor.drain()
    let after = w.model.supervisor.currentConfig()
    #expect(after.hotkeys.compose == "cmd+shift+k")
    #expect(after.keepAwakeOnAC == !was.keepAwakeOnAC && after.agentDir == "/home/alex/elsewhere", "the rebind replaced the whole config")
    let disk = try #require(try ConfigFile.load(SupervisorController.configPath))
    #expect(disk.keepAwakeOnAC == !was.keepAwakeOnAC && disk.agentDir == "/home/alex/elsewhere" && disk.hotkeys.compose == "cmd+shift+k")
    // and no window writes a whole config it read earlier
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    for name in try FileManager.default.contentsOfDirectory(atPath: dir.path) where name != "SupervisorController.swift" {
      let src = try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
      #expect(!src.contains(".updateConfig("), "\(name) replaces the whole config")
    }
  }

  @Test func anImportBuildsOnWhatATickInFlightPublished() async throws {
    let w = try World()
    defer { w.close() }
    #expect(w.model.importCommand("claude --one") == nil)
    // a tick in flight that ends by publishing a new conversation id, as a start does
    let id = "11111111-2222-4333-8444-555555555555"
    let gate = DispatchSemaphore(value: 0)
    let sup = w.model.supervisor
    sup.q.async {
      _ = gate.wait(timeout: .now() + 2)
      sup.config.session.id = id
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { gate.signal() }
    #expect(w.model.importCommand("claude --two") == nil)
    let after = w.model.supervisor.currentConfig()
    #expect(after.args == MainChannelFlag.ensured(["--two"]))
    #expect(after.session.id == id, "the import wrote a copy read before the tick ended over the tick's id")
  }

  // MARK: thread-session notices

  @Test func aThreadSessionsLineShowsWhileMainIsFineAndGoesWhenItIsAnswered() async throws {
    let w = try World()
    defer { w.close() }
    let facts = Facts()
    w.model.threadFacts = { _ in (facts.waiting, facts.failed) }
    w.model.readThreadNames = { _ in ["t_sales": "Sales"] }
    var needsYouBanners = 0
    var failedBanners: [String] = []
    w.model.onThreadNeedsYou = { needsYouBanners += 1 }
    w.model.onThreadFailed = { thread, name, code in failedBanners.append("\(thread)|\(name)|\(code)") }

    // Main runs and waits on nothing; the Sales session shows a prompt
    facts.waiting = ["t_sales": "sign in"]
    w.model.handleWorker(.needsYou(thread: "t_sales", prompt: "sign in"))
    w.model.status.phase = .running
    w.model.status.needsYou = nil
    #expect(w.model.threadNotice == ThreadNotices.waitingLine(name: "Sales", prompt: "sign in"), "\(w.model.threadNotice)")
    #expect(w.model.notice.isEmpty && w.model.liveNotice.isEmpty, "Main's own line is not used for it")
    #expect(needsYouBanners == 1)

    // answered: the once-a-second look drops the line
    facts.waiting = [:]
    w.model.refreshNow()
    #expect(w.model.threadNotice.isEmpty, "\(w.model.threadNotice)")

    // a failure is said, by name, with a banner
    facts.failed = ["t_sales"]
    w.model.handleWorker(.failed(thread: "t_sales", code: "crash_loop"))
    #expect(w.model.threadNotice == ThreadNotices.failedLine(name: "Sales", code: "crash_loop"))
    #expect(failedBanners == ["t_sales|Sales|crash_loop"])
    // Main's own events do not touch it, and it does not touch Main's
    w.model.handle(.needsYou(.dialog("folder trust")))
    #expect(w.model.notice.contains("folder trust") && w.model.threadNotice.contains("kept stopping"))

    // the session starts again
    w.model.handleWorker(.started(thread: "t_sales", resume: true))
    #expect(w.model.threadNotice.isEmpty)
  }

  @Test func theMenuShowsTheThreadLineAndTheBannersAreWired() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    let app = try String(contentsOf: dir.appendingPathComponent("StatusMenu.swift"), encoding: .utf8)
    #expect(app.contains("if !model.threadNotice.isEmpty { Text(model.threadNotice) }"))
    let status = try String(contentsOf: dir.appendingPathComponent("StatusCoordinator.swift"), encoding: .utf8)
    #expect(status.contains("model.onThreadNeedsYou = ") && status.contains("model.onThreadFailed = "))
  }

  // MARK: the Talos home

  @Test func anImportedTalosHomeMovesTheThreadSessionsThere() async throws {
    let w = try World()
    defer { w.close() }
    let first = try #require(w.model.workers, "this Mac has no usable tmux, so there are no thread sessions to move")
    let before = w.model.workersHome
    let home = TmuxWorld.root + "/th-" + UUID().uuidString.prefix(8)
    try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    #expect(w.model.importCommand("TALOS_APP_HOME=\(home) claude --one") == nil)
    #expect(w.model.supervisor.currentConfig().env["TALOS_APP_HOME"] == home)
    #expect(w.model.workersHome == before, "control: nothing has looked yet")

    w.model.refreshNow()  // the once-a-second look
    await w.settle { w.model.workersHome == home }
    #expect(w.model.workersHome == home)
    let now = try #require(w.model.workers)
    #expect(now !== first && now.options.talosHome == home, "a manager for the new home")
    // it is the one that runs: its heartbeat lands in the new home, and the old one holds no lock
    await w.settle(10) { FileManager.default.fileExists(atPath: home + "/workers.json") }
    #expect(FileManager.default.fileExists(atPath: home + "/workers.json"), "the new home gets the supervisor's heartbeat")
    #expect(!first.isActive, "the old manager let go of its lock")
    #expect(!w.model.notice.hasPrefix(TalosHomeChange.restartPrefix))
  }

  @Test func aNewTalosHomeWithAThreadSessionRunningSaysARestartIsNeeded() async throws {
    let w = try World()
    defer { w.close() }
    let first = try #require(w.model.workers)
    let before = w.model.workersHome
    let home = TmuxWorld.root + "/th-" + UUID().uuidString.prefix(8)
    try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    w.model.workersMayRun = { _ in true }
    #expect(w.model.importCommand("TALOS_APP_HOME=\(home) claude --one") == nil)
    // Main's own line is in the menu: the restart line waits for it, look after look
    w.model.handle(.needsYou(.dialog("folder trust")))
    w.model.refreshNow()
    w.model.refreshNow()
    #expect(w.model.notice.contains("folder trust"), "the restart line replaced Main's needs-you line: \(w.model.notice)")
    w.model.notice = ""
    w.model.refreshNow()
    await w.settle(15) { w.model.notice == TalosHomeChange.restartNotice(to: home) }
    #expect(w.model.notice == TalosHomeChange.restartNotice(to: home), "\(w.model.notice)")
    #expect(w.model.workers === first && w.model.workersHome == before, "a running session is never orphaned by a move")

    // the last one parks: the next look moves, and the line goes
    w.model.workersMayRun = { _ in false }
    w.model.refreshNow()
    await w.settle { w.model.workersHome == home }
    #expect(w.model.workersHome == home && w.model.notice.isEmpty, "\(w.model.notice)")
  }
}

extension MainThreadAndNoticesGuiTests {
  @Test func aSetupDuringAHomeMoveDoesNotReviveTheManagerBeingLetGo() async throws {
    let w = try World()
    defer { w.close() }
    let first = try #require(w.model.workers)
    try FileManager.default.createDirectory(atPath: w.model.workersHome, withIntermediateDirectories: true)
    #expect(w.model.importCommand("claude --one") == nil)
    await w.settle { first.isActive }
    try #require(first.isActive, "control: the first manager runs from the old home")
    let home = TmuxWorld.root + "/th-" + UUID().uuidString.prefix(8)
    try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    #expect(w.model.importCommand("TALOS_APP_HOME=\(home) claude --one") == nil)

    // the old manager is inside a slow tick when the move begins, so its `detach` has to wait
    let gate = DispatchSemaphore(value: 0)
    first.queue.async { _ = gate.wait(timeout: .now() + 3) }
    w.model.refreshNow()
    // timing-ok: no event shows a detach blocked on a queue; the held gate keeps the move from finishing whatever the wait
    try await Task.sleep(nanoseconds: 300_000_000)  // the move's detach is now waiting on that queue
    #expect(w.model.workers === first, "control: the move has not finished")
    #expect(w.model.importCommand("TALOS_APP_HOME=\(home) claude --two") == nil)  // a second setup, mid-move
    gate.signal()
    await w.settle { w.model.workersHome == home }
    #expect(w.model.workersHome == home)
    let now = try #require(w.model.workers)
    defer { first.detach() }
    // timing-ok: a negative window; the manager must not tick again within it
    try await Task.sleep(nanoseconds: 2_500_000_000)  // two of its ticks, had it been started again
    #expect(!first.isActive, "the manager that was let go took its lock again and runs with nobody holding it")
    #expect(now !== first && now.options.talosHome == home)
  }
}

extension MainThreadAndNoticesGuiTests {
  /// The app's own quit hooks on a real controller, with the reply and the clock taken over so nothing quits the test process.
  private func quitWorld(_ w: World, replies: Replies, clock: Clock) {
    QuitCoordinator.shared.resetForTests()
    w.model.installQuitHooks()
    var h = QuitCoordinator.shared.hooks!
    h.reply = { replies.all.append($0) }
    h.uptime = { clock.now }
    QuitCoordinator.shared.hooks = h
  }

  @Test func quitAndStopComesBackAtOnceWithASlowWorkerStopAndTheLimitStillFires() async throws {
    let w = try World()
    defer { w.close() }
    let mgr = try #require(w.model.workers)
    let replies = Replies()
    let clock = Clock()
    quitWorld(w, replies: replies, clock: clock)
    defer { QuitCoordinator.shared.resetForTests() }
    // the workers' queue is inside a tick that will not end for a long while (its tmux calls)
    let gate = DispatchSemaphore(value: 0)
    mgr.queue.async { _ = gate.wait(timeout: .now() + 20) }
    defer { gate.signal() }

    var answer: NSApplication.TerminateReply?
    let took = seconds {
      QuitCoordinator.shared.quitAndStop(terminate: { answer = QuitCoordinator.shared.shouldTerminate() })
    }
    #expect(took < 0.5, "Quit and stop held the main thread for \(took) s")
    #expect(answer == .terminateLater, "the quit is held: the thread sessions are not stopped yet")
    #expect(!mgr.isAllStopped)
    clock.now += 14
    await pump(0.5)
    #expect(replies.all.isEmpty, "inside the limit, still stopping")
    clock.now += 2  // past the 15 s limit, with the worker stop still stuck
    await pump(0.5)
    #expect(replies.all == [true], "the limit fires and the quit goes ahead: \(replies.all)")
  }

  @Test func quitAndStopWaitsForTheThreadSessionsAndGoesWhenTheyAreStopped() async throws {
    let w = try World()
    defer { w.close() }
    let mgr = try #require(w.model.workers)
    let replies = Replies()
    let clock = Clock()
    quitWorld(w, replies: replies, clock: clock)
    defer { QuitCoordinator.shared.resetForTests() }
    let gate = DispatchSemaphore(value: 0)
    mgr.queue.async { _ = gate.wait(timeout: .now() + 20) }
    var answer: NSApplication.TerminateReply?
    QuitCoordinator.shared.quitAndStop(terminate: { answer = QuitCoordinator.shared.shouldTerminate() })
    #expect(answer == .terminateLater)
    await pump(0.5)
    #expect(replies.all.isEmpty, "Main was never running, so only the thread sessions hold the quit")
    gate.signal()  // the tick ends; the stop runs
    await w.settle { !replies.all.isEmpty }
    #expect(mgr.isAllStopped && replies.all == [true])
  }
}

@MainActor private final class Replies { var all: [Bool] = [] }
@MainActor private final class Clock { var now: Double = 1000 }

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func bump() { lock.withLock { n += 1 } }
  var value: Int { lock.withLock { n } }
}

@MainActor private final class Facts {
  var waiting: [String: String] = [:]
  var failed: Set<String> = []
}
