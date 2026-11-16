import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor

/// A second and third message to a thread whose session is in a turn: each pointer is typed and entered, and Claude Code queues it
/// (real-2.1.325-queued). The fake draws exactly what those captures show: the dim "Press up to edit queued messages" placeholder in the
/// empty box once a line is queued, and "⏸ manual mode on · 1 shell · esc to interrupt · ↓ to manage" under it. Real private tmux;
/// never `-L talos`.
@Suite("Pointers into a busy turn are queued", .serialized, .enabled(if: Rig.hasTmux))
struct QueuedPointerTests {
  @Test func threePointersIntoOneBusyTurnAreAllTypedAndEntered() throws {
    let r = try WorkerRig(scenario: "worker-queued.sh")
    defer { r.teardown() }
    let audit = r.root + "/audit.log"
    r.mgr.tune { $0.auditLogPath = audit }
    r.mgr.startTicking()
    let ids = ["m_01JBF3V7Q8K2M4N6P8R0S2T401", "m_01JBF3V7Q8K2M4N6P8R0S2T402", "m_01JBF3V7Q8K2M4N6P8R0S2T403"]
    for (n, m) in ids.enumerated() {
      try r.wake("trip", ids: [m])
      #expect(r.wait(20) { r.typedLines.count == n + 1 }, "pointer \(n + 1): \(r.typedLines) \(r.why("trip"))\n\(r.screen())")
    }
    usleep(1_500_000)
    #expect(r.typedLines == Array(repeating: "trip \(PointerTyper.text)", count: 3), "\(r.typedLines)")
    #expect(r.owed().until == nil, "\(r.owed())")
    let refused = r.lines(audit).filter { $0.contains("key_refused") || $0.contains(EnterDetection.auditEvent) }
    #expect(refused.isEmpty, "\(refused)")
    #expect(r.mgr.needsYou()["trip"] == nil, "\(r.mgr.needsYou())")
  }

  /// A key that went with status parts Talos does not know under the box: the audit gets each new shape once per run of the supervisor,
  /// as its shape only (letters a, digits N), never the text.
  @Test func unknownStatusPartsAreAuditedOncePerShapeAsShapesOnly() throws {
    let r = try WorkerRig(scenario: "worker-queued.sh")
    defer { r.teardown() }
    let audit = r.root + "/audit.log"
    r.mgr.tune { $0.auditLogPath = audit }
    let rule = String(repeating: "─", count: 60)
    let pane = ["⏺ Done.", rule, "❯ ", rule, "  ⏸ manual mode on · ctrl+r to search · v2 tip"]
    let other = ["⏺ Done.", rule, "❯ ", rule, "  ⏸ plan mode on · ctrl+r to search"]
    r.mgr.queue.sync {
      r.mgr.noteUnknownStatusParts(pane, thread: "trip")
      r.mgr.noteUnknownStatusParts(pane, thread: "trip")
      r.mgr.noteUnknownStatusParts(other, thread: "trip")
    }
    let lines = r.lines(audit).filter { $0.contains("status_part_unknown") }
    #expect(lines.count == 2, "\(lines.count)")
    #expect(lines.contains { $0.hasSuffix("thread=trip shape=aaaa+a aa aaaaaa") } && lines.contains { $0.hasSuffix("thread=trip shape=aN aaa") })
    #expect(!lines.contains { $0.contains("ctrl") || $0.contains("search") || $0.contains("tip") }, "never the text")
    // and a part refused for its shape: its length and classes once per run, never the text
    let refusedPane = ["⏺ Done.", rule, "❯ ", rule, "  ⏸ manual mode on · Proceed?"]
    r.mgr.queue.sync {
      r.mgr.noteRefusedStatusParts(refusedPane, thread: "trip")
      r.mgr.noteRefusedStatusParts(refusedPane, thread: "trip")
    }
    let refused = r.lines(audit).filter { $0.contains("status_part_refused") }
    #expect(refused.count == 1 && refused[0].hasSuffix("thread=trip shape=8:aAp"), "\(refused)")
    #expect(!refused.contains { $0.contains("Proceed") })
  }
}
