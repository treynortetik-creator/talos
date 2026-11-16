import Foundation
import Testing
@testable import TalosDesktopCore

/// `workers.json` carries the worker's last real activity (`last_active_at`) so a relaunched app can carry the idle clock on. It is
/// optional and written only while set: a file without it is the file of every earlier build, a value that is not a time reads as no
/// value, and a file with it still loads in an earlier build (the hub's schema drops the key it does not know).
@Suite("workers.json last activity")
struct WorkersFileLastActiveTests {
  private func file(_ extra: String) -> Data {
    Data(
      """
      {"v":1,"supervisor":{"pid":7,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"live","tmux":"t-trip","cwd":"/tmp/x"\(extra)},
                  "walk":{"state":"parked","tmux":"t-walk","cwd":"/tmp/y"}}}
      """.utf8)
  }

  private func entry(_ f: WorkersFile, _ id: String = "trip") throws -> [String: Any] {
    let root = try #require(try JSONSerialization.jsonObject(with: f.encoded()) as? [String: Any])
    return try #require((root["threads"] as? [String: Any])?[id] as? [String: Any])
  }

  @Test func aFileWithoutItLoadsAndIsWrittenWithoutIt() throws {
    let f = try #require(WorkersFile.decode(file("")))
    #expect(try entry(f)["last_active_at"] == nil)
    #expect(try entry(f)["error"] != nil, "the keys written before are still written, nulls included")
  }

  @Test func theSavedTimeSurvivesALoadAndAWrite() throws {
    let f = try #require(WorkersFile.decode(file(",\"last_active_at\":\"2026-10-30T00:01:02.500Z\"")))
    #expect(try entry(f)["last_active_at"] as? String == "2026-10-30T00:01:02.500Z")
    #expect(try entry(f, "walk")["last_active_at"] == nil, "the other thread's entry is untouched")
    #expect(WorkersFile.decode(try f.encoded()) == f)
  }

  @Test(arguments: [",\"last_active_at\":17", ",\"last_active_at\":\"yesterday\"", ",\"last_active_at\":null", ",\"last_active_at\":{\"a\":1}"])
  func aValueThatIsNotATimeIsNoValueAndNeverAnUnreadableFile(extra: String) throws {
    let f = try #require(WorkersFile.decode(file(extra)), "the file must still load")
    #expect(try entry(f)["last_active_at"] == nil)
    #expect(f.threads["walk"] != nil)
  }
}

/// `stopping_since`: when a worker was asked to stop after its turn, so a relaunched app can count the turn's time from the stop and
/// not from its own start. Optional, like `last_active_at`: a file without it is every earlier build's, a value that is not a time is
/// no value (never an unreadable file), and it round-trips.
@Suite("workers.json stop time")
struct WorkersFileStoppingSinceTests {
  private func file(_ extra: String) -> Data {
    Data(
      """
      {"v":1,"supervisor":{"pid":7,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"stopping","tmux":"t-trip","cwd":"/tmp/x"\(extra)}}}
      """.utf8)
  }

  private func entry(_ f: WorkersFile) throws -> [String: Any] {
    let root = try #require(try JSONSerialization.jsonObject(with: f.encoded()) as? [String: Any])
    return try #require((root["threads"] as? [String: Any])?["trip"] as? [String: Any])
  }

  @Test func aFileWithoutItLoadsAndIsWrittenWithoutIt() throws {
    let f = try #require(WorkersFile.decode(file("")))
    #expect(f.threads["trip"]?.stopping_since == nil)
    #expect(try entry(f)["stopping_since"] == nil)
  }

  @Test func theStopTimeSurvivesALoadAndAWrite() throws {
    let f = try #require(WorkersFile.decode(file(",\"stopping_since\":\"2026-10-30T00:01:02.500Z\"")))
    #expect(f.threads["trip"]?.stopping_since == "2026-10-30T00:01:02.500Z")
    #expect(try entry(f)["stopping_since"] as? String == "2026-10-30T00:01:02.500Z")
    #expect(WorkersFile.decode(try f.encoded()) == f)
  }

  @Test(arguments: [",\"stopping_since\":17", ",\"stopping_since\":\"yesterday\"", ",\"stopping_since\":null", ",\"stopping_since\":{\"a\":1}"])
  func aValueThatIsNotATimeIsNoValueAndNeverAnUnreadableFile(extra: String) throws {
    let f = try #require(WorkersFile.decode(file(extra)), "the file must still load")
    #expect(f.threads["trip"]?.stopping_since == nil)
    #expect(f.threads["trip"]?.state == "stopping")
  }
}
