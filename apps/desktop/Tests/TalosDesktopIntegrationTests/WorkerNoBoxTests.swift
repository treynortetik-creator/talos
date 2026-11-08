import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The pointer is typed only when Claude's input box is on the pane. `worker-blank.sh` writes the hub's ready file FIRST and keeps the
/// pane blank (a new thread folder's MCP server can connect under the trust dialog, before the UI is up); the box is drawn when the
/// test says so. Real private tmux server; the owner's tmux, Claude config and bridge are never touched.
@Suite("Pointer waits for the input box", .serialized, .enabled(if: Rig.hasTmux))
struct WorkerNoBoxTests {
  private func rig() throws -> (WorkerRig, String) {
    let box = NSTemporaryDirectory() + "box-\(UUID().uuidString.prefix(6))"
    let r = try WorkerRig(scenario: "worker-blank.sh", extraEnv: ["FAKE_BLANK_BOX": box, "FAKE_BLANK_REPEAT": "1"])
    return (r, box)
  }

  private func drawBox(_ box: String, _ n: Int = 1) { FileManager.default.createFile(atPath: box + ".\(n)", contents: nil) }

  private func cleanUp(_ r: WorkerRig, _ box: String) {
    r.teardown()
    for n in 1...3 { unlink(box + ".\(n)") }
  }

  /// A worker that is live (ready written) over a blank pane gets nothing typed; the line goes in once, after the box is drawn.
  @Test func nothingIsTypedOverABlankPaneAndOneLineGoesInOnceTheBoxIsDrawn() throws {
    let (r, box) = try rig()
    defer { cleanUp(r, box) }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    usleep(2_500_000)  // a dozen ticks over the blank pane
    #expect(r.typedLines.isEmpty, "typed into a pane with no input box: \(r.typedLines)")
    #expect(r.mgr.needsYou().isEmpty, "the wait is not yet long enough to bother the owner")
    drawBox(box)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the box is up: \(r.why("trip"))")
    #expect(r.typedLines.first == "trip \(PointerTyper.text)")
    usleep(1_500_000)
    #expect(r.typedLines.count == 1, "exactly one line: \(r.typedLines)")
    #expect(log.all.isEmpty, "\(log.all)")
  }

  /// No box for longer than the ready timeout: the thread is told once, the worker shows Needs you, nothing is typed and the worker
  /// is not stopped. When the box appears the line is typed once, the hold clears, and a later hold tells the thread again.
  @Test func aPaneWithNoBoxTellsTheThreadOnceHoldsAndThenReleases() throws {
    let (r, box) = try rig()
    defer { cleanUp(r, box) }
    let log = NoticeLog()
    r.trackNotices(log)
    r.mgr.startTicking()
    try r.wake("trip")
    #expect(r.wait(10) { r.up("trip") }, "\(r.why("trip"))")
    r.mgr.tune { $0.readyTimeout = 1.5 }  // the notice debounce stays at its default (600 s): a later hold is a new hold
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.noBoxKind }, "\(r.mgr.needsYou())")
    #expect(r.wait(5) { log.all.count == 1 }, "\(log.all)")
    usleep(3_500_000)  // well past two more timeouts: still one
    #expect(log.all.count == 1, "once per hold, not every timeout: \(log.all)")
    #expect(log.all.first?.thread == "trip")
    #expect(log.all.first?.text == "trip's session isn't showing its input box yet. Open Terminals \u{2192} trip to see what it's waiting on.")
    #expect(r.typedLines.isEmpty, "\(r.typedLines)")
    #expect(r.up("trip"), "the worker is kept, never stopped for this: \(r.why("trip"))")
    #expect(r.starts.count == 1)
    #expect(r.mgr.needsYou()["trip"] == WorkerNotice.noBoxKind)

    drawBox(box)
    #expect(r.wait(10) { r.typedLines.count == 1 }, "the pointer goes in once the box is up: \(r.why("trip"))")
    #expect(r.typedLines.first == "trip \(PointerTyper.text)")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty }, "\(r.mgr.needsYou())")
    #expect(log.all.count == 1)

    // a later hold is a new episode: the pane went blank again and a new message is due
    try r.wake("trip")
    #expect(r.wait(10) { r.mgr.needsYou()["trip"] == WorkerNotice.noBoxKind }, "\(r.mgr.needsYou())")
    #expect(r.wait(5) { log.all.count == 2 }, "the second hold tells the thread again: \(log.all)")
    #expect(r.typedLines.count == 1)
    drawBox(box, 2)
    #expect(r.wait(10) { r.typedLines.count == 2 }, "\(r.typedLines)")
    #expect(r.wait(5) { r.mgr.needsYou().isEmpty })
  }
}
