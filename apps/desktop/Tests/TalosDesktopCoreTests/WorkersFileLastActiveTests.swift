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
