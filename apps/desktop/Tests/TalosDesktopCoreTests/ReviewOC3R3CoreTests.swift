import Foundation
import Testing
@testable import TalosDesktopCore

/// PR #68, third review. Run: bash apps/desktop/scripts/test.sh --filter ReviewOC3R3
@Suite("Review OC3 R3 core")
struct ReviewOC3R3Core {
  /// R17's rule, one key further on: "present but not what we wrote: unreadable, not off". A `threads` that isn't a list
  /// reads as no dedicated threads, so `tickLocked` sends every running worker `switched_off`.
  @Test(arguments: [#""threads":{}"#, #""threads":"x""#, #""threads":3"#])
  func FINDING_aThreadsValueThatIsNotAListIsUnreadable(_ threads: String) {
    let json = #"{"dedicated":{"enabled":true},"# + threads + "}"
    #expect(DedicatedSettings.readable(Data(json.utf8)) == nil)
  }

  /// Control: a missing list really is "no dedicated threads".
  @Test func aConfigWithNoThreadsKeyIsReadable() {
    #expect(DedicatedSettings.readable(Data(#"{"dedicated":{"enabled":true}}"#.utf8))?.threads.isEmpty == true)
  }
}
