import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// `needs_you.resets_at` as the thread sessions' writer puts it in workers.json (`Runtime.persisted`): carried only under the usage-limit
/// kind, absent when it could not be worked out. The end-to-end checks are in WorkerUsageLimitTests and MainUsageLimitTests.
@Suite("workers.json: needs_you.resets_at")
struct UsageLimitResetsAtWriterTests {
  func runtime(prompt: String?, resetsAt: String?) -> WorkerManager.Runtime {
    var r = WorkerManager.Runtime(entry: .init(threadId: "trip", cwd: "/home/alex/proj"))
    r.entry.state = "live"
    r.needsYouPrompt = prompt
    r.needsYouAt = "2026-11-13T00:00:00.000Z"
    r.needsYouResetsAt = resetsAt
    return r
  }

  @Test func onlyTheUsageLimitCarriesIt() {
    let at = "2026-11-13T15:00:00.000Z"
    #expect(runtime(prompt: UsageLimitScreen.kind, resetsAt: at).persisted.needs_you?.resets_at == at)
    #expect(runtime(prompt: UsageLimitScreen.kind, resetsAt: nil).persisted.needs_you?.resets_at == nil, "unparsed: omitted")
    #expect(runtime(prompt: UsageLimitScreen.kind, resetsAt: nil).persisted.needs_you?.kind == "usage limit", "the needs-you itself stays")
    // a value left over from an earlier usage-limit screen never rides on another kind
    for kind in ["folder trust", "computer-use permissions", "a prompt"] {
      let e = runtime(prompt: kind, resetsAt: at).persisted
      #expect(e.needs_you?.kind == kind && e.needs_you?.resets_at == nil, "\(kind)")
    }
    // no pane, no needs-you, so no reset either
    var parked = runtime(prompt: UsageLimitScreen.kind, resetsAt: at)
    parked.entry.state = "parked"
    #expect(parked.persisted.needs_you == nil)
  }
}

/// A `resets_at` as the synthetic screen's "4pm (Europe/Paris)" makes it: 16:00:00 in Paris, the next one after the screen was read
/// (after `readAfter`, at most a day past `readBy`). A wrong zone, a wrong day or a missing value fails.
func expectParisFourPm(_ iso: String?, readAfter: Date, readBy: Date, sourceLocation: SourceLocation = #_sourceLocation) {
  guard let iso, let t = ISOTime.parse(iso) else {
    Issue.record("no resets_at: \(String(describing: iso))", sourceLocation: sourceLocation)
    return
  }
  var cal = Calendar(identifier: .gregorian)
  cal.timeZone = TimeZone(identifier: "Europe/Paris")!
  let c = cal.dateComponents([.hour, .minute, .second], from: Date(timeIntervalSince1970: t))
  #expect(c.hour == 16 && c.minute == 0 && c.second == 0, "\(iso) is not 4pm in Paris", sourceLocation: sourceLocation)
  #expect(t > readAfter.timeIntervalSince1970 && t <= readBy.timeIntervalSince1970 + 86_400, "\(iso) is not the next 4pm", sourceLocation: sourceLocation)
}
