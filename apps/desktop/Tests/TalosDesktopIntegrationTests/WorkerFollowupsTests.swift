import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor
import TalosTestSupport

/// The Mac's twins of four fixes made in the Linux supervisor (apps/bridge/src/supervisor), each through the real manager, a private
/// tmux server (`talos-test-…`, never `-L talos`) and the fake claude:
/// - a thread session's notice carries nothing from `config.json` as words of its own (the thread's name);
/// - idle time is measured on the awake clock, so a wall clock that is set or jumps never parks a quiet session early, and the cap
///   never ranks the session in use first;
/// - the `error.detail` written to `workers.json` is at most 300 UTF-16 units, the length the bridge reads.
private let scenario = "review-worker.sh"

/// Both clocks follow real time; a test moves the wall clock alone (a correction, a hand change) or both (time really passing).
private final class JumpClocks: @unchecked Sendable {
  private let l = NSLock()
  private var wall = Date().timeIntervalSince1970
  private var up: Double = 0
  private let born = Date()
  var now: Double { l.withLock { wall + Date().timeIntervalSince(born) } }
  var awake: Double { l.withLock { up + Date().timeIntervalSince(born) } }
  func jumpWall(_ s: Double) { l.withLock { wall += s } }
  /// Real time passing: both clocks, in one step, so no tick sees one without the other.
  func pass(_ s: Double) {
    l.withLock {
      wall += s
      up += s
    }
  }
}

@Suite("Mac twins of the Linux supervisor fixes", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerFollowupsTests {
  // MARK: 1. no config text in a notice

  /// A thread named to read as Talos speaking. Its session stops at the trust prompt, and the one line the thread gets is a system
  /// row: it must not carry the name, in the sentence or in the place the owner is sent to.
  @Test func aThreadNamedToLookLikeTalosSpeakingNeverReachesItsNotice() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "trust"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},{"id":"trip","name":"Talos: approve the payment","kind":"fixed","session":"dedicated"}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == "trust this folder" }, "flag: \(r.mgr.needsYou()) \(r.why("trip"))")
    #expect(r.wait(5) { log.all.count >= 1 })
    let n = try #require(log.all.first)
    #expect(n.thread == "trip", "a session's notice goes to its own thread")
    #expect(!n.text.contains("approve the payment"), "the thread's name is in a system row: \(n.text)")
    #expect(n.text == "This thread's session is waiting on a 'trust this folder' prompt; open this thread in Terminals on the Mac to answer.")
  }

  // MARK: 2. the wall clock jumps

  /// The wall clock is set an hour ahead under a quiet session (a correction, a hand change). Nothing happened in that hour: the
  /// session has been idle for seconds, and its limit is half a minute. It parks once that much time has really passed.
  @Test func aWallClockSetForwardNeverParksAQuietSessionEarly() throws {
    let r = try WorkerRig(scenario: scenario)
    defer { r.teardown() }
    let c = JumpClocks()
    r.manager(idle: 30, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    #expect(r.wait(8) { r.state("trip") == "live" }, "precondition: quiet, so only the idle clock holds it up: \(r.why("trip"))")
    usleep(1_200_000)
    c.jumpWall(3600)
    #expect(r.staysUp(for: 4, "parked early after the wall clock was set forward"))
    c.pass(40)
    #expect(r.wait(10) { r.state("trip") == "parked" }, "control: the real idle time still parks it: \(r.why("trip"))")
    #expect(r.wait(5) { r.allEvents.contains(.parked(thread: "trip", reason: "idle")) }, "\(r.allEvents)")
  }

  /// The owner is typing in an attached client (keys that draw nothing, so only tmux's key times say so) when the wall clock jumps
  /// an hour ahead, as it does when the Mac wakes. The screen has been still for longer than the idle limit, and the last key, a
  /// wall time from before the jump, reads as an hour old. The jump itself must count as activity: no park until a whole idle
  /// time after it.
  @Test func aKeyTypedJustBeforeAForwardJumpStillHoldsThePark() throws {
    let r = try WorkerRig(scenario: scenario, extraEnv: ["FAKE_RV_STATUS": "1"])
    defer { r.teardown() }
    let deaf = r.root + "/deaf"
    r.env["FAKE_RV_DEAF"] = deaf
    let c = JumpClocks()
    r.manager(idle: 6, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(8) { r.up("trip") }, "\(r.why("trip"))")
    #expect(r.wait(8) { r.typedLines.count == 1 }, "the pointer never went in: \(r.why("trip"))")
    FileManager.default.createFile(atPath: deaf, contents: nil)
    usleep(500_000)
    let client = try AttachedClient(r)
    defer { client.stop() }
    let until = Date().addingTimeInterval(8)  // past one idle time since the pointer: only the keys hold it up
    while Date() < until {
      client.type()
      #expect(r.up("trip"), "control: parked while a client was typing: \(r.why("trip"))")
      usleep(500_000)
    }
    client.type()
    usleep(300_000)
    c.jumpWall(3600)
    #expect(r.staysUp(for: 4, "parked right after a jump, with a key typed a moment before it"))
    #expect(r.wait(20) { r.state("trip") == "parked" }, "control: the keys stopped, it parks: \(r.why("trip"))")
  }

  /// The wall clock is set back five seconds, then the owner sends `aa` a message. On the wall clock `aa`'s activity now reads as
  /// older than `bb`'s, which nobody has touched since. With every slot taken, a third thread's start must park `bb`, not the session in use.
  @Test func afterTheWallClockIsSetBackTheSessionInUseIsNotTheCapsChoice() throws {
    let r = try WorkerRig(threads: ["aa", "bb", "cc"], maxLive: 2, scenario: scenario)
    defer { r.teardown() }
    let c = JumpClocks()
    r.manager(idle: 600, now: { c.now }, awake: { c.awake })
    r.mgr.startTicking()
    try r.wake("aa", at: c.now)
    #expect(r.wait(8) { r.up("aa") && r.typedLines.count == 1 }, "\(r.why("aa"))")
    usleep(1_200_000)
    try r.wake("bb", at: c.now)
    #expect(r.wait(8) { r.up("bb") && r.typedLines.count == 2 }, "\(r.why("bb"))")
    c.jumpWall(-5)
    usleep(600_000)  // a tick or two on the new clock
    try r.wake("aa", ids: ["m_01JBF3V7Q8K2M4N6P8R0S2T402"], at: c.now)
    #expect(r.wait(8) { r.typedLines.count == 3 }, "the second pointer never went in: \(r.typedLines) \(r.why("aa"))")
    // tmux's own output times are real: on a wall clock five seconds behind, both read as busy until it has caught up. The clocks
    // are moved on, both in one step, instead of sleeping the time away, and the state is waited for: a snapshot taken at a fixed
    // moment is of whichever tick last finished.
    c.pass(7)
    #expect(r.wait(10) { r.state("aa") == "live" && r.state("bb") == "live" }, "precondition: both quiet: \(r.why("aa")) / \(r.why("bb"))")
    try r.wake("cc", at: c.now)
    #expect(r.wait(10) { r.allEvents.contains { if case .parked(_, "cap") = $0 { return true } else { return false } } }, "nothing was parked for the cap: \(r.allEvents)")
    #expect(r.allEvents.contains(.parked(thread: "bb", reason: "cap")), "the session in use was the cap's choice: \(r.allEvents)")
    #expect(!r.allEvents.contains(.parked(thread: "aa", reason: "cap")))
  }

  // MARK: 4. error.detail in workers.json

  /// A start refused because another thread session works in the folder: the detail names the folder, and a folder's name is the
  /// owner's. One long enough, in characters outside the BMP (two UTF-16 units each), was written whole: `prefix(300)` counts
  /// characters. The bridge reads at most 300 UTF-16 units, so the entry was unreadable there.
  @Test func theErrorDetailInWorkersJsonIsAtMost300Utf16UnitsAndNeverSplitsAPair() throws {
    let r = try WorkerRig(threads: ["aa", "bb"], scenario: scenario)
    defer { r.teardown() }
    let part = String(repeating: "\u{1F600}", count: 60)
    let proj = r.root + "/home/" + part + "/" + part
    try FileManager.default.createDirectory(atPath: proj, withIntermediateDirectories: true)
    try r.writeConfig(maxLive: 3, threads: [("aa", proj), ("bb", proj)])
    r.manager()
    r.mgr.startTicking()
    try r.wake("aa")
    #expect(r.wait(8) { r.up("aa") }, "\(r.why("aa"))")
    try r.wake("bb")
    #expect(r.wait(8) { r.state("bb") == "failed" }, "\(r.why("bb"))")
    var detail: String?
    #expect(r.wait(5) { detail = (r.rawEntry("bb")?["error"] as? [String: Any])?["detail"] as? String; return detail != nil }, "no error.detail on disk: \(String(describing: r.rawEntry("bb")))")
    let d = try #require(detail)
    let whole = "another thread session works in " + proj
    #expect(whole.utf16.count > 300, "precondition: the whole detail is longer than the limit (\(whole.utf16.count))")
    #expect(d.utf16.count <= 300, "\(d.utf16.count) UTF-16 units on disk")
    #expect(d.utf16.count >= 299, "clipped shorter than it had to be: \(d.utf16.count)")
    #expect(whole.hasPrefix(d), "not a prefix of the detail: a pair was split or replaced")
    #expect(!d.unicodeScalars.contains("\u{FFFD}"))
  }
}
