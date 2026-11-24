import Foundation
import Testing
@testable import TalosDesktopCore

/// `pointer_hold` on a workers.json entry: absent is fine, a reason this build does not know is kept, and what cannot be read is none for
/// that entry alone. Its order: typed_unseen > draft > scrolled > refused.
@Suite("workers.json pointer_hold")
struct PointerHoldCoreTests {
  private func file(_ extra: String, second: String = "") -> Data {
    Data(
      """
      {"v":1,"supervisor":{"pid":7,"heartbeat_at":"2026-10-30T00:00:00.000Z","workers_supported":true,"main_pane_pid":0},
       "threads":{"trip":{"state":"live","tmux":"t-trip","cwd":"/home/alex/x"\(extra)}\(second)}}
      """.utf8)
  }
  private let good = #","pointer_hold":{"reason":"draft","since":"2026-10-30T00:00:05.000Z"}"#

  @Test func absentIsNoneAndIsNotWritten() throws {
    let f = try #require(WorkersFile.decode(file("")))
    #expect(f.threads["trip"]?.pointer_hold == nil)
    let root = try #require(try JSONSerialization.jsonObject(with: f.encoded()) as? [String: Any])
    let e = try #require((root["threads"] as? [String: Any])?["trip"] as? [String: Any])
    #expect(e["pointer_hold"] == nil)
  }

  @Test(arguments: ["typed_unseen", "draft", "scrolled", "refused"])
  func eachReasonSurvivesALoadAndAWrite(reason: String) throws {
    let f = try #require(WorkersFile.decode(file(#","pointer_hold":{"reason":"\#(reason)","since":"2026-10-30T00:00:05.000Z"}"#)))
    #expect(f.threads["trip"]?.pointer_hold == .init(reason: reason, since: "2026-10-30T00:00:05.000Z"))
    #expect(try #require(WorkersFile.decode(f.encoded())) == f)
  }

  /// A reason a newer peer writes is kept as it is, with the entry whole.
  @Test func anUnknownReasonIsKept() throws {
    let f = try #require(WorkersFile.decode(file(#","pointer_hold":{"reason":"something_new","since":"2026-10-30T00:00:05.000Z"}"#)))
    #expect(f.threads["trip"]?.pointer_hold?.reason == "something_new")
    #expect(f.threads["trip"]?.state == "live")
  }

  /// Not a hold: none for that entry only. The entry and its sibling still load.
  @Test(arguments: [
    #","pointer_hold":"draft""#, #","pointer_hold":{"reason":"draft"}"#, #","pointer_hold":{"reason":"draft","since":"not a time"}"#,
    #","pointer_hold":{"reason":7,"since":"2026-10-30T00:00:05.000Z"}"#, #","pointer_hold":{"reason":"","since":"2026-10-30T00:00:05.000Z"}"#,
    #","pointer_hold":null"#, #","pointer_hold":[1,2]"#,
  ])
  func malformedIsNoneForThatEntryOnly(bad: String) throws {
    let sibling = #","other":{"state":"live","tmux":"t-other","cwd":"/home/alex/y"\#(good)}"#
    let f = try #require(WorkersFile.decode(file(bad, second: sibling)))
    #expect(f.threads["trip"] != nil && f.threads["trip"]?.pointer_hold == nil, "\(bad)")
    #expect(f.threads["other"]?.pointer_hold?.reason == "draft", "the sibling lost its hold")
  }

  @Test func theOrderIsTypedUnseenThenDraftThenScrolledThenRefused() {
    typealias H = WorkersFile.PointerHold
    #expect(H.pick(unseen: true, draft: true, scrolled: true, refused: true) == "typed_unseen")
    #expect(H.pick(unseen: false, draft: true, scrolled: true, refused: true) == "draft")
    #expect(H.pick(unseen: false, draft: false, scrolled: true, refused: true) == "scrolled")
    #expect(H.pick(unseen: false, draft: false, scrolled: false, refused: true) == "refused")
    #expect(H.pick(unseen: false, draft: false, scrolled: false, refused: false) == nil)
    #expect(H.reasons == ["typed_unseen", "draft", "scrolled", "refused"])
  }
}
