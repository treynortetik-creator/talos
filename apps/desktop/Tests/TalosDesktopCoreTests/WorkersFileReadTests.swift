import Foundation
import Testing
@testable import TalosDesktopCore

/// workers.json is read entry by entry: one entry this build cannot read never costs the others, is kept as its JSON text under
/// `unreadable_threads`, and a save never writes back fewer entries than were read. A file that cannot be read at all is refused.
@Suite("workers.json read entry by entry")
struct WorkersFileReadTests {
  static let sidTrip = "6f1c2a9e-4b3d-4c8e-9a71-2d5e8f0b3c41"
  static let sidGarden = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
  static let sidTaxes = "11111111-2222-4333-8444-555555555555"
  static let supervisor = #"{"pid":7,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0}"#

  /// Three threads; `taxes` has a wrong-typed field (`pane_pid` a string), so this build cannot read it.
  static func threeThreads(taxes: String? = nil) -> Data {
    let junk = taxes ?? #"{"state":"parked","tmux":"t-taxes","cwd":"/home/alex/agent","session_id":"\#(sidTaxes)","pane_pid":"many"}"#
    return Data(
      """
      {"v":1,"supervisor":\(supervisor),"threads":{
        "trip":{"state":"parked","tmux":"t-trip","cwd":"/home/alex/agent","session_id":"\(sidTrip)"},
        "garden":{"state":"off","tmux":"t-garden","cwd":"/home/alex/agent","session_id":"\(sidGarden)","previous_ids":["\(sidTaxes)"]},
        "taxes":\(junk)}}
      """.utf8)
  }

  static func read(_ d: Data) throws -> WorkersFileRead {
    guard case .read(let r) = WorkersFileRead.read(d) else {
      Issue.record("the file did not read: \(WorkersFileRead.read(d))")
      throw CancellationError()
    }
    return r
  }

  static func root(_ d: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
  }

  @Test func oneUnreadableEntryKeepsTheOthersAndIsSetAside() throws {
    let r = try Self.read(Self.threeThreads())
    #expect(r.file.threads.keys.sorted() == ["garden", "trip"])
    #expect(r.file.threads["trip"]?.session_id == Self.sidTrip)
    #expect(r.file.threads["garden"]?.previous_ids == [Self.sidTaxes])
    #expect(r.unreadable.keys.sorted() == ["taxes"])
    #expect(r.unreadableThreadIds == ["taxes"])
  }

  /// Load and save: the good sessions intact, the unreadable one kept, and kept byte for byte on every later save.
  @Test func aSaveKeepsTheUnreadableEntryByteForByte() throws {
    let first = try Self.read(Self.threeThreads())
    let saved = try WorkersFileRead.encoded(first.file, keeping: first.unreadable)
    let back = try Self.read(saved)
    #expect(back.file.threads["trip"]?.session_id == Self.sidTrip)
    #expect(back.file.threads["garden"]?.session_id == Self.sidGarden)
    #expect(back.file.threads["garden"]?.previous_ids == [Self.sidTaxes])
    #expect(back.unreadable == first.unreadable)
    let kept = try #require(try Self.root(saved)[WorkersFileRead.unreadableKey] as? [String: String])
    let text = try #require(kept["taxes"])
    let value = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    #expect(value["session_id"] as? String == Self.sidTaxes, "the session id of the unreadable entry must be on disk")
    #expect(value["pane_pid"] as? String == "many")
    // `threads` no longer holds it, so a reader of `threads` alone reads the file
    #expect(try Self.root(saved)["threads"].flatMap { $0 as? [String: Any] }?["taxes"] == nil)
    // a second save carries the string on as it is
    let again = try WorkersFileRead.encoded(back.file, keeping: back.unreadable)
    #expect(try Self.read(again).unreadable["taxes"] == text)
  }

  /// No entry is lost: what was read, readable or not, is all in what is written.
  @Test func aSaveNeverWritesFewerEntriesThanWereRead() throws {
    let r = try Self.read(Self.threeThreads())
    let saved = try Self.root(try WorkersFileRead.encoded(r.file, keeping: r.unreadable))
    let threads = (saved["threads"] as? [String: Any])?.count ?? 0
    let kept = (saved[WorkersFileRead.unreadableKey] as? [String: Any])?.count ?? 0
    #expect(threads + kept == 3)
  }

  /// A state from a newer build is not unreadable: the entry reads, may be running, and keeps its session.
  @Test func anUnknownFutureStateStillReads() throws {
    let r = try Self.read(
      Self.threeThreads(taxes: #"{"state":"dozing","tmux":"t-taxes","cwd":"/home/alex/agent","session_id":"\#(Self.sidTaxes)"}"#))
    #expect(r.unreadable.isEmpty)
    #expect(r.file.threads["taxes"]?.state == "dozing")
    #expect(r.file.threads["taxes"]?.session_id == Self.sidTaxes)
    #expect(r.file.anyMayBeRunning)
  }

  @Test(arguments: [
    #"{"state":"parked","tmux":"t-taxes","cwd":"/home/alex/agent","session_id":42}"#,
    #"{"state":"parked","tmux":"t-taxes","cwd":"/home/alex/agent","previous_ids":"x"}"#,
    #"{"state":7,"tmux":"t-taxes","cwd":"/home/alex/agent"}"#,
    #"{"tmux":"t-taxes","cwd":"/home/alex/agent"}"#,
    #"["not","an","entry"]"#,
    #""just text""#,
    "null",
  ])
  func aWrongTypedEntryIsSetAsideAlone(junk: String) throws {
    let r = try Self.read(Self.threeThreads(taxes: junk))
    #expect(r.file.threads.keys.sorted() == ["garden", "trip"])
    #expect(r.unreadable.keys.sorted() == ["taxes"])
  }

  /// A key that is not a thread id is kept as well, and counted, never named.
  @Test func aKeyThatIsNotAThreadIdIsKeptAndNotNamed() throws {
    let d = Data(
      """
      {"v":1,"supervisor":\(Self.supervisor),"threads":{
        "trip":{"state":"parked","tmux":"t-trip","cwd":"/home/alex/agent"},
        "Not A Thread!":{"state":"parked","tmux":"t-x","cwd":"/home/alex/agent"}}}
      """.utf8)
    let r = try Self.read(d)
    #expect(r.file.threads.keys.sorted() == ["trip"])
    #expect(r.unreadable.keys.sorted() == ["Not A Thread!"])
    #expect(r.unreadableThreadIds.isEmpty)
    #expect(r.unnamedCount == 1)
    let line = try #require(r.entriesNotice)
    #expect(!line.contains("Not A Thread!"))
    #expect(line.contains("1 other"))
  }

  /// The one notice names the thread ids, never a value from the entry.
  @Test func theNoticeNamesTheThreadsOnly() throws {
    let r = try Self.read(Self.threeThreads())
    let line = try #require(r.entriesNotice)
    #expect(line.contains("taxes"))
    #expect(!line.contains(Self.sidTaxes) && !line.contains("many"))
    #expect(line == WorkersFileRead.entriesNoticeText.replacingOccurrences(of: "{threads}", with: "taxes"))
    #expect(try Self.read(Self.threeThreads(taxes: #"{"state":"off","tmux":"t-taxes","cwd":"/home/alex/agent"}"#)).entriesNotice == nil)
  }

  /// An entry set aside earlier that reads now (fixed by hand, or a build that knows its shape) goes back into `threads`; one
  /// that still cannot be read stays as it was, and one whose key `threads` already has is kept under a key that is no thread id.
  @Test func anEntrySetAsideThatReadsNowComesBack() throws {
    let fixed = #"{\"state\":\"parked\",\"tmux\":\"t-taxes\",\"cwd\":\"/home/alex/agent\",\"session_id\":\"\#(Self.sidTaxes)\"}"#
    let still = #"{\"state\":\"parked\",\"tmux\":\"t-walk\",\"cwd\":7}"#
    let twin = #"{\"state\":\"parked\",\"tmux\":\"t-trip\",\"cwd\":\"/home/alex/other\"}"#
    let d = Data(
      """
      {"v":1,"supervisor":\(Self.supervisor),"threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"/home/alex/agent"}},
       "\(WorkersFileRead.unreadableKey)":{"taxes":"\(fixed)","walk":"\(still)","trip":"\(twin)"}}
      """.utf8)
    let r = try Self.read(d)
    #expect(r.file.threads["taxes"]?.session_id == Self.sidTaxes)
    #expect(r.file.threads["trip"]?.cwd == "/home/alex/agent")
    #expect(r.unreadable.keys.sorted() == ["trip#", "walk"])
    #expect(r.unreadableThreadIds == ["walk"], "a thread that reads must not be held back by an old copy")
    #expect(r.unreadable["walk"] == still.replacingOccurrences(of: "\\\"", with: "\""))
  }

  /// The same key unreadable in `threads` and already set aside: both are kept, none lost.
  @Test func aKeyUnreadableTwiceKeepsBoth() throws {
    let d = Data(
      """
      {"v":1,"supervisor":\(Self.supervisor),"threads":{"walk":{"cwd":8}},"\(WorkersFileRead.unreadableKey)":{"walk":"{\\"cwd\\":7}"}}
      """.utf8)
    let r = try Self.read(d)
    #expect(Set(r.unreadable.values) == [#"{"cwd":8}"#, #"{"cwd":7}"#])
    #expect(r.unreadableThreadIds == ["walk"])
  }

  /// A value under the key that is not a string (a hand edit) is kept as its JSON text.
  @Test func aSetAsideValueThatIsNotAStringIsKeptAsText() throws {
    let d = Data(
      """
      {"v":1,"supervisor":\(Self.supervisor),"threads":{},"\(WorkersFileRead.unreadableKey)":{"walk":{"cwd":7}}}
      """.utf8)
    let r = try Self.read(d)
    #expect(r.unreadable["walk"] == #"{"cwd":7}"#)
  }

  /// The whole file cannot be read: nothing to save over it. No file, or an empty one, is a fresh start.
  @Test(arguments: [
    "not json at all", "[1,2]", "{\"v\":2,\"supervisor\":{},\"threads\":{}}", "{\"v\":1,\"supervisor\":{}}",
    "{\"v\":1,\"threads\":[]}", "{\"v\":1,\"threads\":{},\"unreadable_threads\":[]}", "{\"v\":\"1\",\"threads\":{}}",
  ])
  func aFileThatCannotBeReadIsRefused(text: String) {
    #expect(WorkersFileRead.read(Data(text.utf8)) == .refused, "\(text)")
  }

  @Test func noFileOrAnEmptyOneIsAFreshStart() {
    #expect(WorkersFileRead.read(nil) == WorkersFileRead.Outcome.none)
    #expect(WorkersFileRead.read(Data()) == WorkersFileRead.Outcome.none)
  }

  /// A torn copy of the protocol's own fixture is refused, and the whole fixture still reads with nothing set aside.
  @Test func theProtocolFixtureReadsWhole() throws {
    let data = try #require(FileManager.default.contents(atPath: protocolFixtures + "/workers.json"))
    let r = try Self.read(data)
    #expect(r.unreadable.isEmpty)
    #expect(r.file == WorkersFile.decode(data))
    #expect(WorkersFileRead.read(data.prefix(data.count / 2)) == .refused)
    // a file with nothing set aside is written exactly as before
    #expect(try WorkersFileRead.encoded(r.file, keeping: [:]) == r.file.encoded())
  }

  /// A supervisor block this build cannot read costs no thread: adopt never reads it, and the next save writes a new one.
  @Test func anUnreadableSupervisorBlockKeepsTheThreads() throws {
    let d = Data(
      """
      {"v":1,"supervisor":{"pid":"x"},"threads":{"trip":{"state":"parked","tmux":"t-trip","cwd":"/home/alex/agent","session_id":"\(Self.sidTrip)"}}}
      """.utf8)
    #expect(try Self.read(d).file.threads["trip"]?.session_id == Self.sidTrip)
  }

  /// The key, the notice ids and their words are the protocol's (`packages/protocol/src/workers-unreadable.ts`), read from that
  /// file so the Mac and the bridge cannot drift apart.
  @Test func theContractIsTheProtocols() throws {
    let here = URL(fileURLWithPath: #filePath)
    let repo = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
    let text = try String(contentsOf: repo.appendingPathComponent("packages/protocol/src/workers-unreadable.ts"), encoding: .utf8)
    let key = try #require(text.firstMatch(of: /WORKERS_UNREADABLE_KEY = '([a-z_]+)'/), "the contract no longer has the key")
    #expect(String(key.1) == WorkersFileRead.unreadableKey)
    let entries = try #require(text.firstMatch(of: /entries: \{\s*id: '([a-z_]+)',\s*text: '([^']+)'/), "no entries notice")
    #expect(String(entries.1) == WorkersFileRead.entriesNoticeId)
    #expect(String(entries.2) == WorkersFileRead.entriesNoticeText)
    let file = try #require(text.firstMatch(of: /file: \{\s*id: '([a-z_]+)',\s*text: '([^']+)'/), "no file notice")
    #expect(String(file.1) == WorkersFileRead.fileNoticeId)
    #expect(String(file.2) == WorkersFileRead.fileNoticeText)
  }
}
