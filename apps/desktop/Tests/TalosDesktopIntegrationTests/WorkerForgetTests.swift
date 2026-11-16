import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A thread that no longer has its own session (back to shared, archived, deleted) leaves the session lists once its worker has gone
/// and it has stayed that way for ten minutes, so no Resume is offered for a session that can never start. The master switch turned off forgets nothing: turning it back on resumes
/// every thread where it was. Real private tmux (`talos-test-…`, never `-L talos`) and the fake claude.
@Suite("A thread that is no longer dedicated", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerForgetTests {
  private func ticks(_ r: WorkerRig, _ timeout: Double, _ cond: () -> Bool) -> Bool {
    r.wait(timeout) {
      r.mgr.tickOnce()
      return cond()
    }
  }

  private func parkedTrip(_ r: WorkerRig, _ clock: JumpClock = JumpClock()) throws {
    r.manager(now: { clock.wallMs() / 1000 }, awake: { clock.awake() })
    try r.wake("trip")
    #expect(ticks(r, 10) { r.up("trip") }, "\(r.why("trip"))")
    try r.wakeFile("trip", action: "park", reason: "control")
    // the awake clock only moves when the test moves it: a second a look, so the pane reads quiet and the park goes ahead
    #expect(ticks(r, 10) { clock.advance(1); return r.state("trip") == "parked" }, "\(r.why("trip"))")
  }

  @Test(arguments: ["shared", "archived", "deleted"])
  func itsParkedEntryLeavesTheList(how: String) throws {
    let r = try WorkerRig(threads: ["trip", "garden"], scenario: "review-worker.sh")
    defer { r.teardown() }
    let clock = JumpClock()
    try parkedTrip(r, clock)
    let trip: String
    switch how {
    case "shared": trip = ",{\"id\":\"trip\",\"kind\":\"fixed\"}"
    case "archived": trip = ",{\"id\":\"trip\",\"kind\":\"fixed\",\"session\":\"dedicated\",\"archived\":true}"
    default: trip = ""
    }
    try """
    {"default_thread":"general","dedicated":{"enabled":true,"max_live":3},"threads":[{"id":"general","kind":"fixed"},\
    {"id":"garden","kind":"fixed","session":"dedicated"}\(trip)]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    // a config read wrongly for a moment forgets nothing: only one that stays that way does
    for _ in 0..<3 { r.mgr.tickOnce() }
    #expect(r.entry("trip")?.session_id != nil, "forgotten on the first read: \(r.why("trip"))")
    clock.advance(601)
    #expect(ticks(r, 5) { r.entry("trip") == nil }, "still listed with a Resume that does nothing: \(r.why("trip"))")
    #expect(r.wait(3) { r.fileOnDisk.map { $0.threads["trip"] == nil } ?? false }, "still in workers.json")
  }

  /// Control: the master switch off keeps every entry, with its session id.
  @Test func theMasterSwitchOffForgetsNothing() throws {
    let r = try WorkerRig(scenario: "review-worker.sh")
    defer { r.teardown() }
    try parkedTrip(r)
    let sid = try #require(r.entry("trip")?.session_id)
    try """
    {"default_thread":"general","dedicated":{"enabled":false,"max_live":3},"threads":[{"id":"general","kind":"fixed"},\
    {"id":"trip","kind":"fixed","session":"dedicated"}]}
    """.write(toFile: r.talosHome + "/config.json", atomically: true, encoding: .utf8)
    for _ in 0..<3 { r.mgr.tickOnce() }
    #expect(r.entry("trip")?.session_id == sid, "\(r.why("trip"))")
  }
}
