import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// A worker found `stopping` after a relaunch. The copy that asked for the stop is gone, and with it whose stop it was and any limit it
/// had, so the copy that adopts it waited for the turn to end with no limit at all: a hung turn held the thread until somebody tapped.
/// Now the wait is `adoptedStopLimit` (10 min) from when the stop was asked for (`stopping_since` in workers.json; a time in the future
/// is no later than now, a file without one counts from the relaunch, and never less than `adoptedStopFloor`, 2 min, from the relaunch
/// whatever the file says). At the limit the turn is ended like an owner's stop (SIGTERM, then
/// SIGKILL after the grace) and the thread gets one line saying its turn was cut. A turn that ends in time is parked as before, silently.
///
/// Real private tmux; never `-L talos`. The awake clock is the test's, for the time the adopting copy has waited; the time the app was
/// away is written into the file as an earlier `stopping_since` (the wall clock itself stays real: tmux's own activity times, which say
/// whether a turn is running, are real time). Nothing waits for 10 real minutes.
private let scenario = "review-worker.sh"

private final class StopClocks: @unchecked Sendable {
  private let l = NSLock()
  private var wall = Date().timeIntervalSince1970
  private var up: Double = 0
  private let born = Date()
  var now: Double { l.withLock { wall + Date().timeIntervalSince(born) } }
  var awake: Double { l.withLock { up + Date().timeIntervalSince(born) } }
  func jumpAwake(_ s: Double) { l.withLock { up += s } }
}

@Suite("A stop adopted after a relaunch has a limit", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerAdoptedStopTests {
  static let cutLine = "This thread's session was stopped in the middle of a turn: Talos restarted while it was stopping, and the turn was still running 10 min after the stop was asked for. The conversation is kept."

  private func signals(_ r: WorkerRig) -> [String] { r.lines(r.root + "/signals") }

  /// A worker in the middle of a turn that never ends, asked to stop by the governor (the stop that has no limit of its own), and the
  /// app gone with `stopping` and its time in the file.
  private func stoppingThenGone(_ c: StopClocks) throws -> WorkerRig {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    r.env["FAKE_RV_SIGLOG"] = r.root + "/signals"
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    _ = r.manager(busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(5) { r.fileOnDisk?.threads["trip"]?.state == "stopping" }, "\(r.why("trip"))")
    let since = try #require(r.fileOnDisk?.threads["trip"]?.stopping_since.flatMap(ISOTime.parse), "the stop's time is not in the file")
    #expect(abs(since - c.now) < 30, "\(since) vs \(c.now)")
    r.mgr.detach()
    #expect(signals(r).isEmpty, "control: the turn is still running")
    return r
  }

  /// The copy that comes back, with a notice log. Returns once its first tick has adopted the worker.
  private func comeBack(_ r: WorkerRig, _ c: StopClocks, _ log: NoticeLog) -> WorkerManager {
    let m = r.manager(busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.trackNotices(log, on: m)
    r.firstTick(m)
    m.startTicking()
    return m
  }

  private func editEntry(_ r: WorkerRig, _ edit: (inout [String: Any]) -> Void) throws {
    let url = URL(fileURLWithPath: r.talosHome + "/workers.json")
    var root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var threads = try #require(root["threads"] as? [String: Any])
    var e = try #require(threads["trip"] as? [String: Any])
    edit(&e)
    threads["trip"] = e
    root["threads"] = threads
    try JSONSerialization.data(withJSONObject: root).write(to: url)
  }

  @Test func anAdoptedStopCutsAHungTurnAtItsLimitAndTellsTheThread() throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    let log = NoticeLog()
    let m = comeBack(r, c, log)
    #expect(r.state("trip") == "stopping", "\(r.why("trip"))")
    c.jumpAwake(540)
    m.tickOnce()  // a tick that sees 540 s
    #expect(r.state("trip") == "stopping" && signals(r).isEmpty, "cut before the limit: \(signals(r))")
    #expect(log.all.isEmpty, "\(log.all)")
    c.jumpAwake(70)
    #expect(r.wait(10) { m.tickOnce(); return !signals(r).isEmpty }, "the adopted stop still waits with no limit")
    #expect(r.wait(8) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 }, "the thread was not told its turn was cut: \(log.all)")
    #expect(log.all.first?.thread == "trip" && log.all.first?.text == Self.cutLine, "\(log.all)")
    #expect(r.allEvents.contains(.parked(thread: "trip", reason: "stop_limit")), "\(r.allEvents)")
    #expect(r.entry("trip")?.session_id != nil, "the conversation is kept for the next message")
    #expect(r.fileOnDisk?.threads["trip"]?.stopping_since == nil, "a parked worker still says when it was stopping")
    for _ in 0..<5 { m.tickOnce() }
    #expect(log.all.count == 1, "told more than once: \(log.all)")
  }

  /// The limit counts from when the stop was asked for, not from the relaunch: the time the app was away is part of it.
  @Test func theLimitCountsFromTheStopNotFromTheRelaunch() throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    try editEntry(r) { $0["stopping_since"] = ISOTime.string(c.now - 300) }  // the stop was asked for five minutes before the relaunch
    let log = NoticeLog()
    let m = comeBack(r, c, log)
    c.jumpAwake(270)
    m.tickOnce()
    #expect(r.state("trip") == "stopping" && signals(r).isEmpty, "cut before the limit: \(r.why("trip")) \(signals(r))")
    c.jumpAwake(40)  // 310 s after the relaunch, 610 s after the stop
    #expect(r.wait(10) { m.tickOnce(); return !signals(r).isEmpty }, "the limit ran from the relaunch")
    #expect(r.wait(5) { log.all.count == 1 && log.all.first?.text == Self.cutLine }, "\(log.all)")
  }

  /// However old the file says the stop is, no turn is cut on the file's word at the first look: the file can be edited while the app
  /// is down (a year-old time on another thread's running turn), the time away is wall clock (a closed lid counts), and a turn that
  /// ended just before the relaunch still reads as running for a moment. The turn gets `adoptedStopFloor` (120 s) from the relaunch.
  @Test func aStopOlderThanTheLimitStillGetsTheFloor() throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    try editEntry(r) { $0["stopping_since"] = ISOTime.string(c.now - 31_536_000) }
    let log = NoticeLog()
    let m = comeBack(r, c, log)
    for _ in 0..<3 { m.tickOnce() }
    c.jumpAwake(90)
    m.tickOnce()
    #expect(r.state("trip") == "stopping" && signals(r).isEmpty && log.all.isEmpty, "cut on the file's word: \(signals(r)) \(log.all)")
    c.jumpAwake(40)
    #expect(r.wait(10) { m.tickOnce(); return !signals(r).isEmpty }, "\(r.why("trip"))")
    #expect(r.wait(5) { log.all.count == 1 && log.all.first?.text == Self.cutLine }, "\(log.all)")
  }

  /// What the file says about the stop's time is not trusted to stretch the wait: a time in the future is no later than now, and a file
  /// with no time, or one that is not a time (an older build's, a hand edit), counts from the relaunch. Each gets the whole limit, no more.
  @Test(arguments: ["future", "absent", "junk"])
  func aStopTimeThatCannotBeUsedCountsFromTheRelaunch(how: String) throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    try editEntry(r) { e in
      switch how {
      case "future": e["stopping_since"] = ISOTime.string(c.now + 1_000_000)
      case "absent": e["stopping_since"] = nil
      default: e["stopping_since"] = "yesterday"
      }
    }
    let log = NoticeLog()
    let m = comeBack(r, c, log)
    c.jumpAwake(540)
    m.tickOnce()
    #expect(r.state("trip") == "stopping" && signals(r).isEmpty, "\(how): cut before the limit")
    c.jumpAwake(70)
    #expect(r.wait(10) { m.tickOnce(); return !signals(r).isEmpty }, "\(how): never cut")
    #expect(r.wait(5) { log.all.count == 1 }, "\(how): \(log.all)")
  }

  /// A turn that ends inside the limit is parked the ordinary way, and nothing is said.
  @Test func aTurnThatEndsInTimeIsParkedAndNothingIsSaid() throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    let log = NoticeLog()
    let m = comeBack(r, c, log)
    c.jumpAwake(300)
    m.tickOnce()
    #expect(r.state("trip") == "stopping")
    FileManager.default.createFile(atPath: r.root + "/quiet", contents: nil)  // the turn ends
    #expect(r.wait(15) { r.state("trip") == "parked" }, "\(r.why("trip"))")
    c.jumpAwake(1000)
    for _ in 0..<5 { m.tickOnce() }
    #expect(log.all.isEmpty, "\(log.all)")
    #expect(!r.allEvents.contains(.parked(thread: "trip", reason: "stop_limit")), "\(r.allEvents)")
  }

  /// The line is a notice like the others: a post that clearly failed is tried again, and it still goes once.
  @Test func aCutLineThatFailedToPostIsTriedAgain() throws {
    let c = StopClocks()
    let r = try stoppingThenGone(c)
    defer { r.teardown() }
    try editEntry(r) { $0["stopping_since"] = ISOTime.string(c.now - 100_000) }
    let log = NoticeLog()
    log.outcome = .failed
    let m = comeBack(r, c, log)
    m.tickOnce()
    c.jumpAwake(130)  // past the floor
    #expect(r.wait(10) { m.tickOnce(); return log.all.count >= 1 }, "\(r.why("trip"))")
    log.outcome = .sent
    c.jumpAwake(1)  // past the retry wait (0.1 s here)
    #expect(r.wait(10) { m.tickOnce(); return log.all.count >= 2 }, "never tried again: \(log.all)")
    #expect(log.all.allSatisfy { $0.text == Self.cutLine }, "\(log.all)")
    let n = log.all.count
    for _ in 0..<5 { m.tickOnce() }
    #expect(log.all.count == n, "sent again after it went: \(log.all)")
  }

  /// In the copy that asked for it, the governor's stop still never ends a turn (the limit is only for a stop nobody can account for).
  @Test func theGovernorsOwnStopStillHasNoLimit() throws {
    let c = StopClocks()
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_NOISE": "trip"])
    defer { r.teardown() }
    r.env["FAKE_RV_SIGLOG"] = r.root + "/signals"
    r.env["FAKE_RV_QUIET"] = r.root + "/quiet"
    _ = r.manager(busyWindow: 2.5, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.state("trip") == "busy" }, "\(r.why("trip"))")
    try r.wakeFile("trip", action: "park", reason: "governor")
    #expect(r.wait(5) { r.state("trip") == "stopping" })
    c.jumpAwake(100_000)
    for _ in 0..<4 { r.mgr.tickOnce() }
    #expect(r.state("trip") == "stopping" && signals(r).isEmpty, "\(signals(r))")
  }
}
