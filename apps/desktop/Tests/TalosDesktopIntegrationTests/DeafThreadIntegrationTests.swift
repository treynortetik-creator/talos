import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// The deaf-thread alarm through the manager on real panes (a private tmux server): a restart or park in the middle of a told run, and a
/// thread that flaps. The live case (a repainting pane) is in KeyGuardIntegrationTests.
@Suite("The deaf-thread alarm across restarts and flaps", .serialized, .enabled(if: Rig.hasTmux))
struct DeafThreadIntegrationTests {

  /// A thread told it cannot be typed into is parked (a restart or a park, here a switch back to shared) and comes back on a clear pane:
  /// the run's end is not dropped, and the "can message again" line goes once the new pane reads fine (never while there is no pane).
  @Test func aParkInTheMiddleOfAToldRunStillSaysTypingIsBack() throws {
    let switchFile = TestTemp.base + "talos-deaf-park-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: [
      "FAKE_REAL_START": "screen:unknown-menu-under-box", "FAKE_REAL_SWITCH": switchFile, "FAKE_REAL_THEN": "empty-input",
    ])
    defer {
      r.teardown()
      unlink(switchFile)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    let audit = r.root + "/audit.log"
    r.mgr.tune {
      $0.deafAfter = (1.5, 600, 1.5)
      $0.auditLogPath = audit
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let words = WorkerNotice.deafLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip")
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    #expect(log.all.first?.text == words)
    // the owner's park, and the screen is fine from the next session on: the pointer still owed starts a new one at once
    r.mgr.queue.sync { r.mgr.requestPark("trip", reason: "control", byOwner: true) }
    FileManager.default.createFile(atPath: switchFile, contents: nil)
    #expect(r.wait(20) { r.starts.count == 2 }, "the park ended the session and a new one started: starts \(r.starts.count)")
    let back = WorkerNotice.deafBackLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip", handled: .init())
    #expect(r.wait(20) { log.all.count == 2 }, "the recovery of the run the park ended: \(log.all) state=\(r.state("trip")) \(r.why("trip")) \(completeLines(audit).suffix(14))")
    #expect(log.all.last?.text == back, "\(log.all)")
    usleep(1_500_000)
    #expect(log.all.count == 2, "once: \(log.all)")
    #expect(r.mgr.needsYou()["trip"] != WorkerNotice.refusedKind)
  }

  /// A thread that flaps (deaf, fine, deaf again within the debounce): one line pair per 10 minutes, but Needs you comes back at once.
  @Test func aThreadThatFlapsIsToldOncePerDebounceAndStaysFlagged() throws {
    let s1 = TestTemp.base + "talos-deaf-flap1-\(UUID().uuidString.prefix(6))"
    let s2 = TestTemp.base + "talos-deaf-flap2-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: [
      "FAKE_REAL_START": "screen:unknown-menu-under-box", "FAKE_REAL_SWITCH": s1, "FAKE_REAL_THEN": "empty-input",
      "FAKE_REAL_SWITCH2": s2, "FAKE_REAL_THEN2": "unknown-menu-under-box",
    ])
    defer {
      r.teardown()
      unlink(s1)
      unlink(s2)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune { $0.deafAfter = (1.5, 4, 1.5) }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind })
    FileManager.default.createFile(atPath: s1, contents: nil)  // fine again
    #expect(r.wait(15) { log.all.count == 2 }, "the first run's recovery: \(log.all)")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty })
    FileManager.default.createFile(atPath: s2, contents: nil)  // deaf again, inside the debounce
    #expect(r.wait(15) { r.mgr.needsYou()["trip"] == WorkerNotice.refusedKind }, "Needs you is live at once: \(r.mgr.needsYou())")
    usleep(2_500_000)
    #expect(log.all.count == 2, "no second notice inside the debounce: \(log.all)")
  }

  /// A run whose notice the debounce held back (it flapped) is not silent for its whole length: once the window has passed, the thread
  /// is told, and what it says on clearing is the usual line.
  @Test func aRunHeldBackByTheDebounceIsToldOnceTheWindowHasPassed() throws {
    let s1 = TestTemp.base + "talos-deaf-deb1-\(UUID().uuidString.prefix(6))"
    let s2 = TestTemp.base + "talos-deaf-deb2-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: [
      "FAKE_REAL_START": "screen:unknown-menu-under-box", "FAKE_REAL_SWITCH": s1, "FAKE_REAL_THEN": "empty-input",
      "FAKE_REAL_SWITCH2": s2, "FAKE_REAL_THEN2": "unknown-menu-under-box",
    ])
    defer {
      r.teardown()
      unlink(s1)
      unlink(s2)
    }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.tune {
      $0.deafAfter = (1.5, 600, 1.5)
      $0.noticeDebounce = 25
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(10) { log.all.count == 1 }, "\(log.all)")
    FileManager.default.createFile(atPath: s1, contents: nil)
    #expect(r.wait(15) { log.all.count == 2 }, "recovery: \(log.all)")
    FileManager.default.createFile(atPath: s2, contents: nil)  // deaf again, inside the window
    usleep(6_000_000)
    #expect(log.all.count == 2, "held back inside the window: \(log.all)")
    let words = WorkerNotice.deafLine(name: r.mgr.displayName(ofThread: "trip"), id: "trip")
    #expect(r.wait(40) { log.all.count == 3 }, "told once the window has passed, still deaf: \(log.all)")
    #expect(log.all.last?.text == words)
    usleep(2_000_000)
    #expect(log.all.count == 3, "once: \(log.all)")
  }

  /// A runner that is killed never reaches `teardown`: the private tmux server it started must still go, because the fixture that keeps
  /// its pane alive ends by itself (`FAKE_MAX_LIFETIME`), even while it repaints every second. Only ever this test's own unique socket.
  @Test func aKilledRunnerLeavesNoTestServerBehind() throws {
    let tmux = try #require(Rig.tmuxPath)
    let socket = "talos-test-leak-\(UUID().uuidString.prefix(8).lowercased())"
    let root = TestTemp.base + socket
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    defer {
      for pid in Rig.serverPids(socket: socket) { kill(pid, SIGKILL) }  // only if the test failed: our own socket's server
      unlink(Rig.tmuxSocketPath(socket))
      try? FileManager.default.removeItem(atPath: root)
    }
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/fake-claude/worker-real.sh").path
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/bin/sh")
    child.arguments = ["-c", "\"$TMUXBIN\" -L \"$SOCK\" -f /dev/null new-session -d -s leak -x 100 -y 40 \"$PANECMD\"; sleep 300"]
    child.environment = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TMUXBIN": tmux, "SOCK": socket,
      "PANECMD": "env FAKE_MAX_LIFETIME=4 FAKE_REAL_TICK=1 FAKE_REAL_START=screen:unknown-menu-under-box TALOS_APP_HOME='\(root)' TALOS_APP_WORKER_THREAD=leak bash '\(fixture)'",
    ]
    try child.run()
    #expect(waitUntil(timeout: 10) { Rig.serverPids(socket: socket).count == 1 }, "control: the server is up: \(Rig.serverPids(socket: socket))")
    kill(child.processIdentifier, SIGKILL)  // the runner dies without any teardown
    child.waitUntilExit()
    #expect(waitUntil(timeout: 25) { Rig.serverPids(socket: socket).isEmpty }, "no server of ours is left behind: \(Rig.serverPids(socket: socket))")
  }

  /// The same for the background task a fake session leaves running (`worker.sh`'s detached `zsh -c ... eval 'until ...'`, its own session): a
  /// runner killed before teardown must not leave it polling for ever. It ends when its lifetime is up (or its folder is gone).
  @Test func aKilledRunnerLeavesNoBackgroundTaskPolling() throws {
    let root = TestTemp.base + "talos-bg-leak-\(UUID().uuidString.prefix(8).lowercased())"
    let bg = root + "/bg"
    try FileManager.default.createDirectory(atPath: bg, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: bg + "/leak.run", contents: nil)
    let ours = { () -> [Int32] in
      (ProcTable.live() ?? []).map(\.pid).filter { ProcessInspect.snapshot($0)?.argv.contains(where: { $0.contains(root) }) == true }
    }
    defer {
      for pid in ours() { kill(pid, SIGKILL) }  // only if the test failed: processes whose argv names this test's own folder
      try? FileManager.default.removeItem(atPath: root)
    }
    let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Fixtures/fake-claude/worker.sh").path
    let child = Process()
    child.executableURL = URL(fileURLWithPath: "/bin/bash")
    child.arguments = [fixture]
    child.environment = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "TALOS_APP_HOME": root, "TALOS_APP_WORKER_THREAD": "leak", "FAKE_WORKER_BG": bg,
      "FAKE_MAX_LIFETIME": "4",
    ]
    child.standardInput = FileHandle.nullDevice
    child.standardOutput = FileHandle.nullDevice
    child.standardError = FileHandle.nullDevice
    try child.run()
    #expect(waitUntil(timeout: 10) { !ours().isEmpty }, "control: the task is running")
    kill(child.processIdentifier, SIGKILL)  // no trap, no teardown
    child.waitUntilExit()
    #expect(waitUntil(timeout: 20) { ours().isEmpty }, "the task ended by itself: \(ours())")
  }
}
