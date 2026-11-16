import Foundation
import TalosDesktopCore

/// The one way a key goes to a thread session's pane (`KeyGuard`): the sender states what it means to press, the pane is read right before
/// the key (with its colours: the box intents need them), and the key goes only when the live screen is exactly that. Every key the worker
/// side sends passes here: the tap answerer (WorkerDialogAnswer), the owed-pointer typer and its Enter and Backspaces (WorkerOwedPointer)
/// and the computer-use Escape (WorkerComputerUse). A refusal is in the log; each caller treats it as "no key went", and a refused pointer is
/// said to the thread, never silent (`noteHeldPointer(.refused)`).
extension WorkerManager {
  /// Why a key meant as `intent` may not go to this thread's pane now, or nil: it may. Logged when refused.
  func keyRefusal(_ id: String, _ intent: KeyGuard.Intent) -> KeyGuard.Refusal? { guardRead(id, intent).refusal }

  /// The guard's read of the pane (its rows with colours; nil: it could not be read) and its answer for `intent`.
  func guardRead(_ id: String, _ intent: KeyGuard.Intent) -> (refusal: KeyGuard.Refusal?, rows: [String]?) {
    let rows = paneRows(id)
    guard let why = KeyGuard.refusal(rows, intent: intent) else {
      noteUnknownStatusParts(rows, thread: id)
      return (nil, rows)
    }
    // the reason's code only: the row under the box that was not a status row is screen text, which the log never holds
    audit("key_refused thread=\(id) intent=\(intent.name) why=\(why.why)")
    if why.why == "row_under_box" { noteRefusedStatusParts(rows, thread: id) }
    return (why, rows)
  }

  /// A key went with status parts Talos does not know under the box: each new shape once per run of the supervisor, as its shape only
  /// (`BoxFrame.unknownShape`), never the text.
  func noteUnknownStatusParts(_ rows: [String]?, thread id: String) {
    guard let rows else { return }
    for shape in KeyGuard.unknownStatusShapes(rows) where unknownShapesSeen.insert(shape).inserted {
      audit("status_part_unknown thread=\(id) shape=\(shape)")
    }
  }

  /// A key refused for a row under the box whose part has no unknown part's shape, or whose mode head Talos has not seen: each new shape
  /// once per run (`BoxFrame.refusedShape`: length and character classes), never the text. One in the audit means: capture it and add it.
  func noteRefusedStatusParts(_ rows: [String]?, thread id: String) {
    guard let rows else { return }
    for shape in KeyGuard.refusedStatusShapes(rows) where refusedShapesSeen.insert(shape).inserted {
      audit("status_part_refused thread=\(id) shape=\(shape)")
    }
  }

  /// The pane as it is now, with its colours; nil when it could not be read.
  func paneRows(_ id: String) -> [String]? {
    let cap = run(tmux(id).capturePaneEscaped())
    return cap.ok ? TmuxCommands.parseCapture(cap.out) : nil
  }

  /// One key (or keys) for this pane, `argv` a tmux send, only when the guard allows `intent`. nil: refused, nothing was run.
  func sendKey(_ id: String, _ argv: [String], _ intent: KeyGuard.Intent) -> RunResult? { sendKeyReading(id, argv, intent).result }

  /// `sendKey`, with the rows the guard read right before the key: the read and the send follow each other with nothing awaited between.
  func sendKeyReading(_ id: String, _ argv: [String], _ intent: KeyGuard.Intent) -> (result: RunResult?, seen: [String]?) {
    let read = guardRead(id, intent)
    guard read.refusal == nil else { return (nil, read.rows) }
    return (run(argv), read.rows)
  }
}
