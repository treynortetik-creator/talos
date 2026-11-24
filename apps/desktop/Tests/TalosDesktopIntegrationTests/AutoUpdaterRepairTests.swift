import Foundation
import Testing
import TalosDesktopCore
import TalosTestSupport

@testable import TalosSupervisor

/// A failed update is forgotten only after the app and the code are seen to be back together; otherwise the record stays, the owner gets
/// one line, a restart keeps it, nothing retries by itself, and Try again looks once more. The same real rig and real git as
/// AutoUpdaterTests; the way back is made to fail with a "previous branch" that does not exist (the script refuses it).
@Suite("A failed update that could not be put back keeps its record", .serialized)
struct AutoUpdaterRepairTests {
  typealias Rig = AutoUpdaterTests.Rig
  typealias Box = AutoUpdaterTests.Box

  var pendingFile: (Rig) -> String { { $0.home + "/auto-update/pending.json" } }

  /// The checkout is on the release (B), its record says it came from `ref` (A), and the swap is gone without a result.
  func stoppedSwap(_ r: Rig, oldRef: String) throws {
    r.git(["fetch", "-q", "--tags", "origin"], in: r.checkout)
    r.git(["checkout", "-q", "--detach", r.b], in: r.checkout)
    try FileManager.default.createDirectory(atPath: r.home + "/auto-update", withIntermediateDirectories: true)
    var p = AutoUpdate.Pending(
      version: "1.5.0", old_version: "1.4.0", checkout: r.checkout, old_ref: oldRef, old_head: r.a, helper_pid: 999_999,
      started_at: ISOTime.string(Date().timeIntervalSince1970))
    p.commit = r.b
    try JSONEncoder().encode(p).write(to: URL(fileURLWithPath: pendingFile(r)))
  }

  func record(_ r: Rig) -> AutoUpdate.Pending? {
    FileManager.default.contents(atPath: pendingFile(r)).flatMap { try? JSONDecoder().decode(AutoUpdate.Pending.self, from: $0) }
  }

  /// The log writes each line's keys in sorted order: `restore exit=<n> ok=<0|1>`.
  func restores(_ r: Rig) -> Int { r.audit().components(separatedBy: "auto_update restore exit=").count - 1 }

  let line = AutoUpdate.repairLine("1.5.0", old: "1.4.0")

  /// Old code: the put-back result was only logged and the record removed right after, in every case.
  @Test func aWayBackThatFailsKeepsTheRecordAndSaysOneLine() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.head() == r.b, "the way back could not run: the code is still on the release")
    let kept = try #require(record(r), "the record of the failed update is still there")
    #expect(kept.repair == true && kept.version == "1.5.0")
    #expect(u.status == .failed(line: line, logPath: u.logPathForOwner), "\(u.status)")
    #expect(r.posts.get() == [line], "one line only, not the failure line first: \(r.posts.get())")
    #expect(restores(r) == 1, "\(r.audit())")
    #expect(r.audit().contains("repair_needed"))
  }

  /// Nothing looks again on its own: ticks, hours and a new check never run the way back a second time.
  @Test func nothingRetriesByItself() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    let u = r.updater(version: "1.4.0")
    u.tick()
    let before = restores(r)
    #expect(before == 1)
    for _ in 0..<20 {
      r.clock.edit { $0 += 3600 }
      u.tick()
    }
    u.checkNow()
    u.queue.sync {}
    #expect(restores(r) == before, "the way back ran again by itself:\n\(r.audit())")
    #expect(record(r)?.repair == true)
    #expect(r.posts.get().filter { $0 == line }.count == 1, "said once")
    #expect(u.status == .failed(line: line, logPath: u.logPathForOwner))
  }

  /// A restart keeps the record: the new process says the line again and still tries nothing; Try again then works once the cause is gone.
  @Test func aRestartKeepsItAndTryAgainRepairsOnceItCan() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    r.updater(version: "1.4.0").tick()
    let before = restores(r)
    #expect(before == 1, "\(r.audit())")
    let again = r.updater(version: "1.4.0")  // a new process
    again.tick()
    #expect(restores(r) == 1, "a launch tries nothing")
    #expect(again.status == .failed(line: line, logPath: again.logPathForOwner))
    // Try again while the cause stands: still kept, still one line
    let first = Box<Bool?>(nil)
    again.retryRepair { first.set($0) }
    again.queue.sync {}
    #expect(first.get() == false, "it did not pass")
    #expect(record(r)?.repair == true)
    #expect(again.status == .failed(line: line, logPath: again.logPathForOwner))
    // the cause goes (the branch the record names exists again): Try again puts things back, checks, and the record goes
    r.git(["branch", "gone", r.a], in: r.checkout)
    let second = Box<Bool?>(nil)
    again.retryRepair { second.set($0) }
    again.queue.sync {}
    #expect(second.get() == true, "\(again.status)\n\(r.audit())")
    #expect(r.head() == r.a, "the code is back")
    #expect(record(r) == nil, "the record goes only now")
    #expect(r.audit().contains("repair_done"))
    // and a later Try again with nothing to repair just goes on to the window's own check
    let third = Box<Bool?>(nil)
    again.retryRepair { third.set($0) }
    again.queue.sync {}
    #expect(third.get() == true)
  }

  /// Old code: the code folder was put back and the record removed without looking at the app on disk. Here the code goes back fine,
  /// but the app in Applications is the new version while the old one runs, so they still disagree.
  @Test func anAppThatIsStillTheNewVersionOnDiskKeepsTheRecordEvenWhenTheCodeWentBack() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "main")
    try FileManager.default.createDirectory(atPath: r.dest + "/Talos.app/Contents", withIntermediateDirectories: true)
    let plist = try PropertyListSerialization.data(
      fromPropertyList: ["CFBundleShortVersionString": "1.5.0"], format: .xml, options: 0)
    try plist.write(to: URL(fileURLWithPath: r.dest + "/Talos.app/Contents/Info.plist"))
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.head() == r.a, "the code did go back")
    #expect(record(r)?.repair == true, "but the app is not the old one, so the record stays")
    #expect(u.status == .failed(line: line, logPath: u.logPathForOwner))
  }

  /// Control: when the way back works and the app is the old one, the record goes and no repair line is said (the existing behaviour).
  @Test func aWayBackThatWorksStillClosesTheRecordWithoutARepairLine() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "main")
    let u = r.updater(version: "1.4.0")
    u.tick()
    #expect(r.head() == r.a && r.branch() == "main")
    #expect(record(r) == nil)
    #expect(!r.posts.get().contains(line))
    #expect(r.posts.get() == ["Talos couldn't update to 1.5.0: the update stopped before it finished. It's still on 1.4.0."])
  }

  /// Old code: a preflight that could not answer was read as an untrusted folder, so the record went with the failed restore.
  @Test func noAnswerFromTheScriptIsNotAnUntrustedFolder() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "main")
    let u = r.updater(version: "1.4.0", options: { $0.applyScript = "/nonexistent/auto-update-apply.sh" })
    u.tick()
    #expect(record(r)?.repair == true, "nothing could be checked, so the record stays: \(r.audit())")
    #expect(u.status == .failed(line: line, logPath: u.logPathForOwner), "\(u.status)")
  }

  /// A disk that cannot be written must not make every look run the way back again and say it again.
  @Test func aRecordThatCannotBeMarkedIsHeldInMemory() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    let dir = r.home + "/auto-update"
    chmod(dir, 0o500)
    defer { chmod(dir, 0o700) }
    let u = r.updater(version: "1.4.0")
    u.tick()
    for _ in 0..<10 {
      r.clock.edit { $0 += 30 }
      u.tick()
    }
    #expect(restores(r) == 1, "the way back ran once, not on every look:\n\(r.audit())")
    #expect(r.posts.get().filter { $0 == line }.count == 1)
    #expect(r.audit().contains("repair_record_not_written"))
    #expect(u.needsRepair())
    // Try again clears the hold once the cause is gone
    chmod(dir, 0o700)
    r.git(["branch", "gone", r.a], in: r.checkout)
    let ok = Box<Bool?>(nil)
    u.retryRepair { ok.set($0) }
    u.queue.sync {}
    #expect(ok.get() == true, "\(u.status)\n\(r.audit())")
    #expect(!u.needsRepair() && record(r) == nil)
  }

  /// The owner put another app in place: the record goes with nothing moved, and the normal check can run.
  @Test func aRepairClearsItselfWhenTheAppWasReplaced() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    r.updater(version: "1.4.0").tick()
    #expect(record(r)?.repair == true)
    let n = restores(r)
    let newer = r.updater(version: "1.6.0")
    newer.tick()
    #expect(record(r) == nil, "dropped")
    #expect(restores(r) == n && r.head() == r.b, "no code was moved")
    #expect(r.audit().contains("repair_dropped") && r.audit().contains("why=app_replaced"))
    #expect(!newer.needsRepair())
  }

  /// Someone moved the clean folder to a commit that is neither the release's nor the old one: not ours to put back.
  @Test func aRepairClearsItselfWhenTheFolderWasMovedByHand() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    r.updater(version: "1.4.0").tick()
    #expect(record(r)?.repair == true)
    let n = restores(r)
    r.git(["commit", "-q", "--allow-empty", "-m", "mine"], in: r.checkout)
    let moved = r.head()
    #expect(moved != r.a && moved != r.b)
    let again = r.updater(version: "1.4.0")
    again.tick()
    #expect(record(r) == nil, "dropped: \(r.audit())")
    #expect(restores(r) == n && r.head() == moved, "nothing was moved")
    #expect(r.audit().contains("why=code_moved"))
  }

  /// Control: the folder still on the release (what a failed restore leaves) is NOT a reason to drop the record.
  @Test func aFolderStillOnTheReleaseIsNotDropped() throws {
    let r = try Rig()
    try stoppedSwap(r, oldRef: "gone")
    r.updater(version: "1.4.0").tick()
    r.updater(version: "1.4.0").tick()
    #expect(record(r)?.repair == true && r.head() == r.b)
  }

  @Test func theRepairWordsArePlainAndBothOldAndNewAreNamed() {
    let l = AutoUpdate.repairLine("1.5.0", old: "1.4.0")
    #expect(l.contains("1.5.0") && l.contains("1.4.0") && l.hasSuffix("press Try again."))
    #expect(l.contains("Check for Updates"), "the line says where the button is: \(l)")
    #expect(AboutCopy.checkButtonTitle(.failed(line: l, logPath: "~/x")) == "Try again", "the failed window offers Try again")
    #expect(!l.contains("pending") && !l.contains("record") && !l.contains("checkout"), "no jargon: \(l)")
  }
}
