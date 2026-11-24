import Foundation
import Testing
import TalosTestSupport
@testable import TalosDesktopCore
@testable import TalosSupervisor

extension WorkerRig {
  /// `pointer_hold` as `workers.json` has it now, decoded.
  fileprivate func hold(_ id: String = "trip") -> WorkersFile.PointerHold? { fileOnDisk?.threads[id]?.pointer_hold }
  fileprivate func holdKeyOnDisk(_ id: String = "trip") -> Bool {
    guard let d = FileManager.default.contents(atPath: talosHome + "/workers.json"),
      let root = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      let e = (root["threads"] as? [String: Any])?[id] as? [String: Any]
    else { return false }
    return e["pointer_hold"] != nil
  }
}

/// `pointer_hold` in `workers.json`: why the pointer a session is owed is held back, for the hub to word. The reason, the time the hold
/// began (fixed while the same reason goes on), and when it is gone.
@Suite("pointer_hold in workers.json", .serialized, .enabled(if: Rig.hasTmux))
struct PointerHoldTests {
  private func draftRig() throws -> (WorkerRig, clear: String) {
    let clear = TestTemp.base + "clr-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(
      scenario: "worker-real.sh",
      extraEnv: ["FAKE_REAL_START": "draft", "FAKE_REAL_SWITCH": clear, "FAKE_REAL_THEN": "empty-input"])
    return (r, clear)
  }

  /// A draft: written the tick the hold starts (not after `draftNoticeAfter`: it stays at 120 s here), with a real time near now, the same
  /// time on later ticks, no Needs you yet, and gone once the box is clear and the pointer has gone in.
  @Test func aDraftIsWrittenAtOnceKeepsItsTimeAndClearsOnDelivery() throws {
    let (r, clear) = try draftRig()
    defer {
      r.teardown()
      unlink(clear)
    }
    r.mgr.startTicking()
    let before = Date().timeIntervalSince1970
    try r.wake("trip")
    #expect(r.wait(10) { r.hold()?.reason == "draft" }, "\(String(describing: r.fileOnDisk?.threads["trip"]))")
    let since = try #require(r.hold().flatMap { ISOTime.parse($0.since) })
    #expect(since >= before - 1 && since <= Date().timeIntervalSince1970 + 1, "since is when the hold began: \(since)")
    #expect(r.mgr.needsYou()["trip"] == nil, "the hold is written before any Needs you: \(r.mgr.needsYou())")
    usleep(2_500_000)
    r.ticksPass()
    #expect(r.hold()?.since == ISOTime.string(since), "the time moved while the reason went on: \(String(describing: r.hold()))")
    FileManager.default.createFile(atPath: clear, contents: nil)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "\(r.typedLines)")
    #expect(r.wait(10) { !r.holdKeyOnDisk() && r.owed().until == nil }, "left on disk after delivery: \(String(describing: r.hold()))")
  }

  /// A hold that still stands after a Talos relaunch goes on from the time the file has: the first look finds the same reason and keeps it.
  @Test func aDraftStillThereAfterARelaunchKeepsItsFileTime() throws {
    let (r, clear) = try draftRig()
    defer {
      r.teardown()
      unlink(clear)
    }
    r.firstCopy("crash").startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.hold()?.reason == "draft" })
    let first = try #require(r.hold()?.since)
    r.appGone("crash")
    usleep(1_200_000)  // a later wall time: a new hold would show it
    _ = r.comeBack()
    #expect(r.wait(10) { r.up("trip") })
    r.ticksPass(4)
    #expect(r.hold()?.reason == "draft" && r.hold()?.since == first, "\(String(describing: r.hold())) was \(first)")
  }

  /// A line typed and never seen: `typed_unseen` once `screenLag` has passed, then gone at the deadline when the pointer is dropped.
  @Test func aNeverSeenLineIsTypedUnseenAndGoneWhenDropped() throws {
    let r = try WorkerRig(scenario: "review-worker.sh")
    defer { r.teardown() }
    r.env["FAKE_RV_ECHO_BOX"] = "1"
    r.env["FAKE_RV_SWALLOW_UNTIL"] = r.root + "/never"
    let c = OwedClock()
    let m = r.manager(readyTimeout: WorkerRig.owedReadyTimeout, now: { c.now })
    m.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") })
    #expect(r.wait(WorkerManager.screenLag + 10) { r.hold()?.reason == "typed_unseen" }, "\(String(describing: r.hold())) \(r.why("trip"))")
    let first = try #require(r.hold()?.since)
    r.ticksPass()
    #expect(r.hold()?.since == first, "the time moved: \(String(describing: r.hold()))")
    c.jump(PointerTyper.claimDeadlineCold + 30)
    #expect(r.wait(10) { r.owed().until == nil }, "not dropped at the deadline: \(r.owed())")
    #expect(r.wait(10) { !r.holdKeyOnDisk() }, "left after the drop: \(String(describing: r.hold()))")
  }

  /// A key the typing guard refuses for the pane's own sake: `refused` from the FIRST refusal, long before the deaf-thread alarm's line
  /// (60 s) or its Needs you (10 minutes); same time on every later tick.
  @Test func aRefusedPointerIsHeldFromTheFirstRefusal() throws {
    let r = try WorkerRig(scenario: "worker-real.sh", extraEnv: ["FAKE_REAL_START": "screen:unknown-menu-under-box"])
    defer { r.teardown() }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()  // deafAfter stays at 60 s / 10 minutes
    try r.wake("trip")
    #expect(r.wait(15) { r.hold()?.reason == "refused" }, "\(String(describing: r.fileOnDisk?.threads["trip"])) \(r.why("trip"))")
    let first = try #require(r.hold()?.since)
    #expect(log.all.isEmpty && r.mgr.needsYou().isEmpty, "the hold came before the alarm's line or Needs you: \(log.all) \(r.mgr.needsYou())")
    r.ticksPass(4)
    #expect(r.hold()?.since == first && r.typedLines.isEmpty, "\(String(describing: r.hold())) \(r.typedLines)")
  }

  /// No pane, no hold: the session going away takes `pointer_hold` out of the file, and a new pane's hold is a new hold.
  @Test func aHoldIsGoneWhenThePaneIsAndNewWhenItComesBack() throws {
    let (r, clear) = try draftRig()
    defer {
      r.teardown()
      unlink(clear)
    }
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.hold()?.reason == "draft" })
    let first = try #require(r.hold()?.since)
    _ = r.tmuxCmd(["kill-session", "-t", "=t-trip:"])
    #expect(r.wait(15) { !r.holdKeyOnDisk() }, "a hold outlived its pane: \(String(describing: r.fileOnDisk?.threads["trip"]))")
    if let again = r.hold() { #expect(again.since != first, "a hold with the old pane's time") }
  }
}

/// When a hold reason may be written at all (`WorkerManager.holdApplies`). No tmux: the rule alone.
@Suite("pointer_hold: when a reason is written")
struct PointerHoldRuleTests {
  @Test func aLeftOverLineGetsNoReasonEvenInsideItsDeadlineWithAPane() {
    #expect(WorkerManager.holdApplies(owed: true, leftover: false, until: 100, now: 50, hasPane: true), "control: the plain case")
    #expect(!WorkerManager.holdApplies(owed: true, leftover: true, until: 100, now: 50, hasPane: true), "a left-over line has its own words")
  }

  @Test func nothingOwedNoPaneOrPastTheDeadlineGetsNoReason() {
    #expect(!WorkerManager.holdApplies(owed: false, leftover: false, until: 100, now: 50, hasPane: true))
    #expect(!WorkerManager.holdApplies(owed: true, leftover: false, until: 100, now: 50, hasPane: false))
    #expect(!WorkerManager.holdApplies(owed: true, leftover: false, until: 100, now: 101, hasPane: true), "past the deadline: the hub has given it to Main")
    #expect(WorkerManager.holdApplies(owed: true, leftover: false, until: 100, now: 100, hasPane: true), "on the deadline is not past it")
    #expect(WorkerManager.holdApplies(owed: true, leftover: false, until: nil, now: 1e12, hasPane: true), "no deadline known: held")
  }
}
