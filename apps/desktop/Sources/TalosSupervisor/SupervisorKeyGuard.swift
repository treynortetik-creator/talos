import Foundation
import TalosDesktopCore

/// The one way a key goes to Main's pane (`KeyGuard`): the sender states what it means to press, the screen is read right before the key,
/// and the key goes only when the live screen is exactly that. Every key Main's supervisor sends passes here: the dev-warning auto-accept
/// (SupervisorDevChannels), the dev card and its popup (SupervisorDevCard) and the computer-use Escape (SupervisorComputerUse). A refusal is
/// in the log and comes back as `.refused`, which each caller treats as "no key went" and tells the owner through its own path.
extension Supervisor {
  func sendKey(_ intent: KeyGuard.Intent, _ send: (PtyHost) -> SendOutcome) -> SendOutcome {
    let rows = host.visibleRows()
    if let why = KeyGuard.refusal(rows, intent: intent) {
      // the reason's code only: the row under the box that was not a status row is screen text, which this log never holds
      audit("key_refused", ["session": "main", "intent": intent.name, "why": why.why])
      // a part with no unknown part's shape, or a mode head not seen: its shape once per run (capture it and add it), never the text
      if why.why == "row_under_box" {
        for shape in KeyGuard.refusedStatusShapes(rows ?? []) where refusedShapesSeen.insert(shape).inserted {
          audit("status_part_refused", ["session": "main", "shape": shape])
        }
      }
      return .refused
    }
    // status parts Talos does not know under the box: each new shape once per run, as its shape only, never the text
    for shape in KeyGuard.unknownStatusShapes(rows ?? []) where unknownShapesSeen.insert(shape).inserted {
      audit("status_part_unknown", ["session": "main", "shape": shape])
    }
    return send(host)
  }
}
