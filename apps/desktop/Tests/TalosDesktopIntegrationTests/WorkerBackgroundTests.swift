import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// A thread session is never parked for being idle while background work runs under it, the cap takes one without any first, and
/// every park writes one line in the app's log (docs/OPTION-C.md, "Idle"). The 2026-11-15 loss: a session's `sleep` waker, started
/// from the Bash tool, was killed by the idle park 30 min after its last turn, and nothing woke the session for hours.
///
/// Real private tmux (`talos-test-…`, never `-L talos`), the real process table, and the fake claude run the way Claude Code's native
/// install runs: through a `claude` link to a file named for its version, so the kernel names the process "2.1.325" (measured on a
/// real session). Its Bash tool command is a real `zsh -c` with the CLI's shape; its MCP server stand-in is a plain `sleep`.
@Suite("Background work holds the idle park", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerBackgroundTests {
  /// `<dir>/versions/2.1.325` (bash, re-signed ad hoc: a moved platform binary is refused) and `<dir>/bin/claude` linking to it.
  /// Made once and kept in one shared folder, so runs do not pile up copies: built in a folder of this process's own and renamed
  /// into place, so two test processes at once never use a half-made one (the loser of the rename uses the winner's).
  static let nativeClaude: String? = {
    let fm = FileManager.default
    let shared = TestTemp.base + "/talos-native-claude-v1"
    let link = shared + "/bin/claude"
    if fm.isExecutableFile(atPath: link) { return link }
    let own = TestTemp.base + "/talos-native-claude-\(getpid())-\(UInt32.random(in: 0...UInt32.max))"
    defer { try? fm.removeItem(atPath: own) }
    let version = shared + "/versions/2.1.325"  // the link names where the copy will live once renamed
    guard (try? fm.createDirectory(atPath: own + "/versions", withIntermediateDirectories: true)) != nil,
      (try? fm.createDirectory(atPath: own + "/bin", withIntermediateDirectories: true)) != nil,
      (try? fm.copyItem(atPath: "/bin/bash", toPath: own + "/versions/2.1.325")) != nil,
      ProcessRunner.run(["/usr/bin/codesign", "-s", "-", "--force", own + "/versions/2.1.325"], timeout: 60).ok,
      (try? fm.createSymbolicLink(atPath: own + "/bin/claude", withDestinationPath: version)) != nil
    else { return nil }
    _ = rename(own, shared)  // fails when another process got there first: its copy is the same
    return fm.isExecutableFile(atPath: link) ? link : nil
  }()

  /// A rig whose fake runs as the native install, with the real process table, a log, and the thread lines kept.
  private func rig(threads: [String] = ["trip"], maxLive: Int = 3, idle: Double? = nil) throws -> (WorkerRig, NoticeLog, String) {
    let native = try #require(Self.nativeClaude, "the native-shaped claude could not be made")
    let r = try WorkerRig(threads: threads, maxLive: maxLive)
    let bg = r.root + "/bg"
    try FileManager.default.createDirectory(atPath: bg, withIntermediateDirectories: true)
    r.env["FAKE_CLAUDE_EXEC"] = native
    r.env["FAKE_WORKER_BG"] = bg
    r.makeManager(idle: idle)
    r.mgr.procTable = { ProcTable.live() }  // the real table, not the rig's stub
    let log = r.root + "/supervisor.log"
    r.mgr.tune { $0.auditLogPath = log }
    let notices = NoticeLog()
    r.trackNotices(notices)
    return (r, notices, log)
  }

  private func mark(_ r: WorkerRig, _ id: String, _ what: String) {
    FileManager.default.createFile(atPath: r.root + "/bg/\(id).\(what)", contents: nil)
  }

  private func logLines(_ path: String) -> [String] {
    (try? String(contentsOfFile: path, encoding: .utf8))?.split(separator: "\n").map(String.init) ?? []
  }

  private func parkLines(_ path: String, _ id: String) -> [String] {
    logLines(path).filter { $0.contains("worker_parked thread=\(id) ") }
  }

  /// The detached Bash tool shell under a pane, by pid: the tests stop it themselves (a tmux server going away does not reach it).
  private func task(under pid: Int32) -> Int32? {
    (ProcTable.live() ?? []).first { $0.ppid == pid && $0.name == "zsh" }?.pid
  }

  /// Stops the tasks this test started, by pid, each only while it is still the one started here (its script names this rig's folder):
  /// a pid that ended may have been given to someone else's process.
  private func stop(_ pids: [Int32?], _ r: WorkerRig) {
    for p in pids.compactMap({ $0 }) where p > 1 {
      if ProcessInspect.snapshot(p)?.argv.contains(where: { $0.contains(r.root) }) == true { kill(p, SIGKILL) }
    }
  }

  /// The pane's process as the kernel names it, and its children's names.
  private func tree(_ pid: Int32) -> (root: String?, kids: [String]) {
    let t = ProcTable.live() ?? []
    return (t.first { $0.pid == pid }?.name, t.filter { $0.ppid == pid }.map(\.name))
  }

  @Test func aBackgroundTaskHoldsTheIdleParkAndItsEndLetsItPark() throws {
    let (r, _, log) = try rig(idle: 1.5)
    var started: [Int32?] = []
    defer {
      stop(started, r)
      r.teardown()
    }
    mark(r, "trip", "run")
    mark(r, "trip", "server")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.wait(5) { tree(pid).kids.contains("zsh") && tree(pid).kids.contains("sleep") }, "precondition: \(tree(pid))")
    started.append(task(under: pid))
    #expect(tree(pid).root == "2.1.325", "precondition: the fake runs as the native install does: \(tree(pid))")
    #expect(r.staysUp(for: 5, "parked with a background task running"), "more than three idle times")
    #expect(logLines(log).contains { $0.hasSuffix("worker_idle_held thread=trip bg=1") }, "\(logLines(log))")
    #expect(parkLines(log, "trip").isEmpty)
    mark(r, "trip", "done")
    #expect(r.wait(10) { r.state("trip") == "parked" }, "control: the task ended, it parks: \(r.why("trip"))")
    let line = try #require(parkLines(log, "trip").first)
    #expect(line.contains("why=idle idle_s=") && line.hasSuffix(" bg=0"), "\(line)")
    #expect(parkLines(log, "trip").count == 1, "one line per park: \(parkLines(log, "trip"))")
  }

  /// Control: claude's own children (an MCP server stand-in) are not background work, and the session parks at its idle time.
  @Test func aSessionWithOnlyItsServersParksAtItsIdleTime() throws {
    let (r, notices, log) = try rig(idle: 1.5)
    defer { r.teardown() }
    mark(r, "trip", "server")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { (r.entry("trip")?.pane_pid ?? 0) > 1 }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.wait(5) { tree(pid).kids.contains("sleep") }, "precondition: the server stand-in runs under it: \(tree(pid))")
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    let line = try #require(parkLines(log, "trip").first)
    #expect(line.contains("why=idle") && line.hasSuffix(" bg=0"), "\(line)")
    #expect(!notices.all.contains { $0.text.hasPrefix("Parked while") }, "nothing was cut: \(notices.all)")
  }

  /// The cap's choice is the quiet session with no background work, even when the one with some has been idle longer.
  @Test func theCapSkipsASessionWithBackgroundWork() throws {
    let (r, _, log) = try rig(threads: ["trip", "garden", "third"], maxLive: 2)
    var started: [Int32?] = []
    defer {
      stop(started, r)
      r.teardown()
    }
    mark(r, "trip", "run")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" }, "\(r.why("trip"))")
    let tripPid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.wait(5) { task(under: tripPid) != nil }, "precondition: \(tree(tripPid))")
    started.append(task(under: tripPid))
    usleep(1_000_000)  // trip is the longest idle
    try r.wake("garden")
    #expect(r.wait(10) { r.state("garden") == "live" }, "\(r.why("garden"))")
    usleep(800_000)  // past the busy window
    try r.wake("third")
    #expect(r.wait(20) { r.up("third") }, "\(r.why("third"))")
    #expect(r.wait(5) { r.state("garden") == "parked" }, "\(r.why("garden"))")
    #expect(r.allEvents.contains(.parked(thread: "garden", reason: "cap")), "\(r.allEvents)")
    #expect(!r.allEvents.contains(.parked(thread: "trip", reason: "cap")), "the session with background work was the cap's choice")
    #expect(ProcessInspect.groupAlive(tripPid))
    let line = try #require(parkLines(log, "garden").first)
    #expect(line.contains("why=cap") && line.hasSuffix(" bg=0"), "\(line)")
  }

  /// T7 (audit 2026-11-22): when every quiet session has background work, none is stopped. The new one starts over the limit and its
  /// thread gets one plain line; once that work ends, the count comes back down (the longest idle quiet one is parked then). Before,
  /// the longest idle was parked with its work and its thread told what was cut.
  @Test func whenEveryCandidateHasBackgroundWorkNoneIsStoppedAndTheNewOneStartsOverTheLimit() throws {
    let (r, notices, log) = try rig(threads: ["trip", "garden"], maxLive: 1)
    var started: [Int32?] = []
    defer {
      stop(started, r)
      r.teardown()
    }
    mark(r, "trip", "run")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.state("trip") == "live" }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.wait(5) { tree(pid).kids.contains("zsh") }, "precondition: \(tree(pid))")
    started.append(task(under: pid))
    usleep(800_000)
    try r.wake("garden")
    #expect(r.wait(20) { r.up("garden") }, "\(r.why("garden"))")
    #expect(r.staysUp(for: 3, "trip was stopped to make room"))
    #expect(r.state("trip") == "live", "\(r.why("trip"))")
    #expect(ProcessInspect.groupAlive(pid), "the session with background work was stopped")
    #expect(parkLines(log, "trip").isEmpty, "\(parkLines(log, "trip"))")
    #expect(logLines(log).contains { $0.hasSuffix("worker_start_over_limit thread=garden") }, "\(logLines(log))")
    #expect(r.wait(5) { notices.all.contains { $0.thread == "garden" && $0.text == BackgroundWork.busyLine } }, "\(notices.all)")
    usleep(2_500_000)  // garden is quiet by now, and over the limit: the work that forced that is not charged to it
    #expect(r.state("garden") == "live", "\(r.why("garden"))")
    #expect(parkLines(log, "garden").isEmpty, "garden was parked while the work ran: \(parkLines(log, "garden"))")
    #expect(notices.all.filter { $0.text == BackgroundWork.busyLine }.count == 1, "one line, not one per tick: \(notices.all)")
    #expect(!notices.all.contains { $0.text.hasPrefix("Parked while") }, "nothing was cut: \(notices.all)")
    // the work ends: the count comes back down, the longest idle quiet session goes (trip), with nothing cut
    mark(r, "trip", "done")
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip")) \(logLines(log))")
    let line = try #require(parkLines(log, "trip").first)
    #expect(line.contains("why=cap") && line.hasSuffix(" bg=0"), "\(line)")
    #expect(r.state("garden") == "live")
  }

  /// A session that dies on its own (a crash) is logged as one. Its Bash tool shell is detached, as the CLI's are, so it outlives claude
  /// and nothing proves whose it was any more: the count is `unknown`, and the thread is not told a number nobody could read.
  @Test func aCrashIsLoggedWithItsBackgroundWorkUnknown() throws {
    let (r, notices, log) = try rig()
    var started: [Int32?] = []
    defer {
      stop(started, r)  // detached, it outlives the crash and the tmux server
      r.teardown()
    }
    mark(r, "trip", "run")
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    let pid = try #require(r.entry("trip")?.pane_pid)
    #expect(r.wait(5) { tree(pid).kids.contains("zsh") }, "precondition: \(tree(pid))")
    started.append(task(under: pid))
    kill(pid, SIGKILL)  // claude itself dies
    #expect(r.wait(10) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    let line = try #require(parkLines(log, "trip").first)
    #expect(line.contains("why=crash idle_s=") && line.hasSuffix(" bg=unknown"), "\(line)")
    #expect(parkLines(log, "trip").count == 1, "\(parkLines(log, "trip"))")
    usleep(500_000)
    #expect(!notices.all.contains { $0.text.hasPrefix("Parked while") }, "\(notices.all)")
  }
}
