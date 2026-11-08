import Foundation
import Testing
@testable import TalosDesktopCore

/// `WorkerActivity.body`: what of a worker's screen counts as the session doing something. Real Claude Code screens
/// (Tests/Fixtures/real-2.1.318); the status line under the input box is SYNTHETIC (no capture of the owner's `statusLine` is kept), added
/// as one row after the footer, where Claude draws it.
@Suite("Worker screen activity")
struct WorkerActivityTests {
  private static let status = "  Sonnet 5.5 | 20% | 7d: 38%"
  private static let boxScreens = ["empty-input", "draft-input", "idle-input-auto", "idle-input-manual", "turn-done", "after-esc"]

  @Test(arguments: boxScreens)
  func aStatusLineUnderTheBoxIsNotPartOfTheBodyAndItsRepaintsDoNotChangeIt(name: String) throws {
    let rows = try RealScreens.rows(name)
    #expect(PointerTyper.inputBox(rows: rows) != nil, "control: \(name) has an input box")
    let body = WorkerActivity.body(rows: rows)
    #expect(WorkerActivity.body(rows: rows + [Self.status]) == body, "a status line was read as screen activity")
    #expect(WorkerActivity.body(rows: rows + ["  Sonnet 5.5 | 21% | 7d: 39%"]) == body)
    #expect(WorkerActivity.body(rows: rows + [Self.status, "  second status row"]) == body)
  }

  @Test(arguments: boxScreens)
  func theFooterBelowTheBoxIsNotPartOfTheBody(name: String) throws {
    var rows = try RealScreens.rows(name)
    let box = try #require(PointerTyper.inputBox(rows: rows))
    let body = WorkerActivity.body(rows: rows)
    for i in (box.upperBound + 1)..<rows.count { rows[i] = "  something else \(i)" }
    #expect(WorkerActivity.body(rows: rows) == body)
  }

  @Test func aLineAboveTheBoxIsActivity() throws {
    var rows = try RealScreens.rows("turn-done")
    let before = WorkerActivity.body(rows: rows)
    let spinner = try #require(rows.firstIndex { $0.contains("Crunched for") })
    rows[spinner] = "✻ Crunched for 4s"
    #expect(WorkerActivity.body(rows: rows) != before, "a spinner second or a new output line must count")
  }

  @Test func textTypedInTheBoxIsActivity() throws {
    var rows = try RealScreens.rows("empty-input")
    let before = WorkerActivity.body(rows: rows)
    let box = try #require(PointerTyper.inputBox(rows: rows))
    rows[box.lowerBound] += "h"
    #expect(WorkerActivity.body(rows: rows) != before)
  }

  /// With no input box (a dialog, a blank pane) nothing says where a status line would be: the whole screen counts.
  @Test func aScreenWithNoBoxCountsWhole() throws {
    let rows = try RealScreens.rows("trust-dialog")
    #expect(PointerTyper.inputBox(rows: rows) == nil, "control: the trust dialog has no input box")
    #expect(WorkerActivity.body(rows: rows) == rows.joined(separator: "\n"))
    #expect(WorkerActivity.body(rows: rows + [Self.status]) != WorkerActivity.body(rows: rows))
    #expect(WorkerActivity.body(rows: []) == "")
  }
}
