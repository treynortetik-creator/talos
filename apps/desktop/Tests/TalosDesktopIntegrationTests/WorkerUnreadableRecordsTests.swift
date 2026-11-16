import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// A relaunch on a workers.json with an entry this build cannot read, through the real manager: the readable sessions keep their
/// ids, the unreadable one stays on disk, and one notice says which thread. A file that cannot be read at all is never saved over.
@Suite("Option C: workers.json this build cannot read", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerUnreadableRecordsTests {
  static let sidTrip = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"
  static let sidGarden = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
  static let sidTaxes = "11111111-2222-4333-8444-555555555555"

  static func write(_ r: WorkerRig, _ text: String) throws {
    try text.write(toFile: r.talosHome + "/workers.json", atomically: true, encoding: .utf8)
  }

  static func threeThreads(_ r: WorkerRig) -> String {
    """
    {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
     "threads":{
       "trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)","session_id":"\(sidTrip)"},
       "garden":{"state":"parked","tmux":"t-garden","cwd":"\(r.agentDir)","session_id":"\(sidGarden)","previous_ids":["\(sidTaxes)"]},
       "taxes":{"state":"parked","tmux":"t-taxes","cwd":"\(r.agentDir)","session_id":"\(sidTaxes)","pane_pid":"many"}}}
    """
  }

  static func onDisk(_ r: WorkerRig) throws -> [String: Any] {
    let d = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers.json"))
    return try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
  }

  static func unreadableEvents(_ r: WorkerRig) -> [WorkerManager.Event] {
    r.allEvents.filter {
      if case .recordsUnreadable = $0 { return true }
      return $0 == .fileUnreadable
    }
  }

  @Test func aRelaunchKeepsTheGoodSessionsAndTheUnreadableEntry() throws {
    let r = try WorkerRig(threads: ["trip", "garden", "taxes"])
    defer { r.teardown() }
    try Self.write(r, Self.threeThreads(r))
    r.firstTick()
    r.mgr.tickOnce()
    let root = try Self.onDisk(r)
    let threads = try #require(root["threads"] as? [String: [String: Any]])
    #expect(threads["trip"]?["session_id"] as? String == Self.sidTrip)
    #expect(threads["garden"]?["session_id"] as? String == Self.sidGarden)
    #expect(threads["garden"]?["previous_ids"] as? [String] == [Self.sidTaxes])
    let kept = try #require(root[WorkersFileRead.unreadableKey] as? [String: String], "the unreadable entry is gone: \(root)")
    let taxes = try #require(kept["taxes"])
    let value = try #require(try JSONSerialization.jsonObject(with: Data(taxes.utf8)) as? [String: Any])
    #expect(value["session_id"] as? String == Self.sidTaxes)
    #expect(Self.unreadableEvents(r) == [.recordsUnreadable(threads: ["taxes"], others: 0)])
    // a later launch carries it on byte for byte, and says so once again
    let m2 = r.makeManager()
    r.firstTick(m2)
    m2.tickOnce()
    #expect(try #require(Self.onDisk(r)[WorkersFileRead.unreadableKey] as? [String: String])["taxes"] == taxes)
    #expect(try #require(Self.onDisk(r)["threads"] as? [String: Any]).count == 2)
  }

  /// The thread whose entry cannot be read is not started under a new id: its wake waits, unread, for the file to be fixed.
  @Test func aThreadSetAsideIsNotStartedByAWake() throws {
    let r = try WorkerRig(threads: ["trip", "garden", "taxes"])
    defer { r.teardown() }
    try Self.write(r, Self.threeThreads(r))
    r.firstTick()
    try r.wake("taxes")
    for _ in 0..<3 { r.mgr.tickOnce() }
    #expect(r.starts.isEmpty, "a session was started for a thread whose record could not be read")
    #expect(r.entry("taxes") == nil)
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/workers/taxes/wake"), "the wake was taken")
    // control: another thread still starts
    try r.wake("trip")
    #expect(r.wait(8) { r.mgr.tickOnce(); return r.starts.count == 1 }, "\(r.why("trip"))")
  }

  /// An entry whose state a newer build added reads, with its session id, and is not set aside.
  @Test func anUnknownFutureStateKeepsItsSession() throws {
    let r = try WorkerRig(threads: ["trip"])
    defer { r.teardown() }
    try Self.write(
      r,
      """
      {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"dozing","tmux":"t-trip","cwd":"\(r.agentDir)","session_id":"\(Self.sidTrip)"}}}
      """)
    r.firstTick()
    r.mgr.tickOnce()
    #expect(r.entry("trip")?.session_id == Self.sidTrip)
    #expect(try #require(Self.onDisk(r)["threads"] as? [String: [String: Any]])["trip"]?["session_id"] as? String == Self.sidTrip)
    #expect(Self.unreadableEvents(r).isEmpty)
  }

  /// A file that cannot be read at all: never saved over (no heartbeat, no empty file), not even by "Quit and stop", and said
  /// once. Once it is removed, the next tick writes a fresh file.
  @Test(arguments: ["{\"v\":1,\"threads\":", "{\"v\":2,\"supervisor\":{},\"threads\":{}}", "{\"v\":1,\"supervisor\":{}}"])
  func aFileThatCannotBeReadIsNeverSavedOver(text: String) throws {
    let r = try WorkerRig(threads: ["trip"])
    defer { r.teardown() }
    try Self.write(r, text)
    let before = try #require(FileManager.default.contents(atPath: r.talosHome + "/workers.json"))
    r.firstTick()
    try r.wake("trip")
    for _ in 0..<3 { r.mgr.tickOnce() }
    usleep(600_000)  // past the heartbeat
    r.mgr.tickOnce()
    #expect(FileManager.default.contents(atPath: r.talosHome + "/workers.json") == before)
    #expect(r.starts.isEmpty)
    #expect(Self.unreadableEvents(r) == [.fileUnreadable])
    r.mgr.stopAll()
    #expect(FileManager.default.contents(atPath: r.talosHome + "/workers.json") == before, "Quit and stop saved over it")
    // control: removed, a new manager writes the file again
    try FileManager.default.removeItem(atPath: r.talosHome + "/workers.json")
    let m2 = r.makeManager()
    r.firstTick(m2)
    #expect(FileManager.default.fileExists(atPath: r.talosHome + "/workers.json"))
  }

  /// Removed while the same manager runs, as the notice says: the next tick starts fresh and saves again.
  @Test func aRefusedFileRemovedWhileRunningIsSavedAgain() throws {
    let r = try WorkerRig(threads: ["trip"])
    defer { r.teardown() }
    try Self.write(r, "not json")
    r.firstTick()
    try FileManager.default.removeItem(atPath: r.talosHome + "/workers.json")
    r.mgr.tickOnce()
    #expect(r.wait(3) { r.mgr.tickOnce(); return FileManager.default.fileExists(atPath: r.talosHome + "/workers.json") }, "no save after the file was removed")
  }

  /// Fixed by hand while the app runs: the next tick reads it and supervises again.
  @Test func aFileFixedWhileRunningIsReadAgain() throws {
    let r = try WorkerRig(threads: ["trip"])
    defer { r.teardown() }
    try Self.write(r, "not json")
    r.firstTick()
    try Self.write(
      r,
      """
      {"v":1,"supervisor":{"pid":1,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"\(r.agentDir)","session_id":"\(Self.sidTrip)"}}}
      """)
    r.mgr.tickOnce()
    #expect(r.entry("trip")?.session_id == Self.sidTrip)
    #expect(try Self.onDisk(r)["threads"] != nil)
  }
}
