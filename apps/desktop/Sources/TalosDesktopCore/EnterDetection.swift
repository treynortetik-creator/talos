import Foundation

/// After a pointer's Enter: did it land on Talos's own line, or may it have answered a prompt that opened in the moment between the key
/// guard's look and the key? The guard reads the pane right before the Enter (`KeyGuard`), and nothing is awaited between that read and
/// the send, but a select can still open in that window (docs/SECURITY.md, "The message pointer's Enter in a thread session"). So the
/// pane is read again right after the Enter, `laterDelay` on and, when that still shows Talos's line, `slowDelay` on; each read is one
/// class, and `judge` decides. An unreadable read is neither. The Linux supervisor's twin is apps/bridge/src/supervisor/enter-check.ts;
/// both are held to Tests/Fixtures/enter-detection-vectors.json.
public enum EnterDetection {
  /// One read of the pane, as one word: never its text.
  public enum Class: String, Sendable, CaseIterable {
    case boxEmpty = "box_empty"
    case boxOurs = "box_ours"
    case boxOther = "box_other"
    case prompt
    case dialog
    case usageLimit = "usage_limit"
    case none
    case unreadable
  }

  /// Why an Enter was flagged, the first that holds in this order.
  public enum Why: String, Sendable {
    case lineStillInBox = "line_still_in_box"
    case promptAppeared = "prompt_appeared"
  }

  /// How long after the Enter the second read is taken.
  public static let laterDelay: Double = 0.3
  /// When the second read still shows our line: one more read this long after the Enter (a slow redraw), the Linux ENTER_CHECK_SLOW_MS.
  public static let slowDelay: Double = 1.0

  /// The audit event's name.
  public static let auditEvent = "enter_may_have_answered"

  /// The class of one read (`escaped`: its rows, with their colours when the capture had them; nil: it could not be read). In this order:
  /// the usage-limit menu and a dialog (`DialogMatcher.liveDialog`; the sign-in hint under a live box is no dialog), a prompt
  /// (`PromptDetector`), then Claude's input box (empty, holding exactly Talos's line, or anything else), else none. The Linux
  /// supervisor's `enterClass`, the same order.
  public static func classify(_ escaped: [String]?) -> Class {
    guard let escaped else { return .unreadable }
    var all = escaped
    while let l = all.last, InputBoxAttributes.stripEscapes(l).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { all.removeLast() }
    let rows = all.map(InputBoxAttributes.stripEscapes)
    switch DialogMatcher.liveDialog(rows) {
    case .usageLimit: return .usageLimit
    case .none, .loginExpired: break
    default: return .dialog
    }
    if PromptDetector.detect(rows) != nil { return .prompt }
    guard let box = PointerTyper.inputBox(rows: rows) else { return .none }
    if InputBoxAttributes.draftPresent(escapedRows: all) == false { return .boxEmpty }
    return BoxFrame.exactBoxText(rows, box: box) == PointerTyper.text ? .boxOurs : .boxOther
  }

  /// A select or dialog of any kind: what an Enter may have answered.
  static func selects(_ c: Class) -> Bool { c == .prompt || c == .dialog || c == .usageLimit }

  /// Flagged, and why, from the classes of the read before the Enter, right after it, `laterDelay` on and (`latest`, only when `later`
  /// still showed our line) `slowDelay` on. nil: not flagged. The last read decides the line: still our line there, it did not submit.
  /// A select counts only when the read before the Enter showed none, and one that shows only later counts only when the read right
  /// after the Enter did not show the box empty (the Enter went into the box; a select after that is the turn's own). As enter-check.ts.
  public static func judge(pre: Class, after: Class, later: Class, latest: Class? = nil) -> Why? {
    if (latest ?? later) == .boxOurs { return .lineStillInBox }
    let laterSelect = selects(later) || (latest.map(selects) ?? false)
    if !selects(pre), selects(after) || (laterSelect && after != .boxEmpty) { return .promptAppeared }
    return nil
  }
}
