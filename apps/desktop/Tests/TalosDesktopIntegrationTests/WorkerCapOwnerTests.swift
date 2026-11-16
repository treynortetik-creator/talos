import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The cap never stops a worker the owner has something open on: a dialog, or text typed into its input box. Quiet is not idle there.
/// Real private tmux (`talos-test-…`, never `-L talos`) and the fake claude's `review-worker.sh`. The loop is driven tick by tick, so
/// the tick that takes the second thread's wake is the one that decides.
@Suite("The cap spares a worker that waits on the owner", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerCapOwnerTests {
  private func rig(_ extra: [String: String] = [:]) throws -> WorkerRig {
    let r = try WorkerRig(threads: ["trip", "garden"], maxLive: 1, scenario: "review-worker.sh", extraEnv: extra)
    r.manager()
    return r
  }

  /// Ticks until `cond` holds.
  private func ticks(_ r: WorkerRig, _ timeout: Double, _ cond: () -> Bool) -> Bool {
    r.wait(timeout) {
      r.mgr.tickOnce()
      return cond()
    }
  }

  /// trip is up, its pointer typed, and quiet again (past the busy window).
  private func quietTrip(_ r: WorkerRig) throws {
    try r.wake("trip")
    #expect(ticks(r, 10) { r.typedLines.count == 1 }, "\(r.why("trip"))")
    #expect(ticks(r, 5) { r.state("trip") == "live" }, "\(r.why("trip"))")
  }

  /// The second thread's message arrives: the one tick that takes its wake decides about the cap.
  private func garden(_ r: WorkerRig) throws {
    try r.wake("garden")
    r.mgr.tickOnce()
  }

  @Test func aDraftInTheInputBoxIsNotTheCapsVictim() throws {
    let r = try rig(["FAKE_RV_ECHO_BOX": "1"])
    defer { r.teardown() }
    try quietTrip(r)
    let pid = try #require(r.entry("trip")?.pane_pid)
    r.ownerTypes("half a thought")
    #expect(r.wait(5) { r.screen().contains("half a thought") })
    #expect(ticks(r, 5) { r.state("trip") == "live" }, "quiet again after the owner's keys: \(r.why("trip"))")
    try garden(r)
    #expect(!r.allEvents.contains(.parked(thread: "trip", reason: "cap")), "the owner's draft was stopped for the cap")
    #expect(ProcessInspect.groupAlive(pid))
    #expect(r.state("garden") != "starting" && r.state("garden") != "live", "no free slot: the start waits")
  }

  @Test func aDialogOnTheScreenIsNotTheCapsVictim() throws {
    let r = try rig()
    defer { r.teardown() }
    let flag = r.root + "/dialog"
    r.env["FAKE_RV_DIALOG"] = flag
    r.manager()
    r.mgr.tune { $0.dialogSettle = 0.3 }
    try quietTrip(r)
    let pid = try #require(r.entry("trip")?.pane_pid)
    FileManager.default.createFile(atPath: flag, contents: nil)
    #expect(ticks(r, 10) { r.mgr.needsYou()["trip"] != nil }, "the dialog was never seen: \(r.why("trip"))")
    #expect(ticks(r, 5) { r.state("trip") == "live" })
    try garden(r)
    #expect(!r.allEvents.contains(.parked(thread: "trip", reason: "cap")), "the dialog the owner was asked was stopped for the cap")
    #expect(ProcessInspect.groupAlive(pid))
  }

  /// Control: a quiet worker with nothing open is still the cap's victim.
  @Test func aQuietWorkerWithNothingOpenIsStillTheVictim() throws {
    let r = try rig(["FAKE_RV_ECHO_BOX": "1"])
    defer { r.teardown() }
    try quietTrip(r)
    try garden(r)
    #expect(r.allEvents.contains(.parked(thread: "trip", reason: "cap")), "\(r.why("trip"))")
    #expect(r.state("garden") == "starting" || r.up("garden"), "\(r.why("garden"))")
  }
}
