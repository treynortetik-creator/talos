import Foundation

/// The only keys a tap on a dialog ever sends, by tmux key NAME (tmux turns the name into the bytes the pane's own cursor-key mode wants).
/// Never a digit: the real Select does nothing with one (real 2.1.319 captures), and never raw bytes.
public enum DialogKey: String, CaseIterable, Sendable { case up = "Up", down = "Down", enter = "Enter" }

/// Needs-you prompts: the key plan for an answer. Pure. It is asked again after every arrow, against a fresh read, so the moves always come
/// from the CURRENT cursor row; the real Select also wraps at its ends (Down on the last row goes to the first), so the plan never walks
/// off an end, and an arrow that moved the row any other way than one step is a failure (`moved`).
public enum DialogAnswer {
  public enum Refusal: String, Equatable, Sendable {
    case unreadable, kindChanged, optionsChanged, subjectChanged, badChoice, noCursor, noKeys
  }

  public enum Plan: Equatable, Sendable {
    case keys([DialogKey])
    case refuse(Refusal)
  }

  /// Why `fresh` is not the dialog that was offered, nil when it is: the same kind, the same option labels in the same order, and the same
  /// subject when the offer had one.
  public static func differs(offered: DialogReader.Dialog, fresh: DialogReader.Dialog) -> Refusal? {
    if fresh.kind != offered.kind { return .kindChanged }
    if !ExactText.equal(fresh.options, offered.options) { return .optionsChanged }
    if offered.subject != nil, !ExactText.equal(fresh.subject, offered.subject) { return .subjectChanged }
    return nil
  }

  /// Up or Down presses then Enter, to get the cursor to `choice`; just Enter when it is there. Nothing when `fresh` is not the dialog
  /// that was offered.
  public static func plan(offered: DialogReader.Dialog, fresh: DialogReader.Dialog?, choice: Int) -> Plan {
    guard let fresh else { return .refuse(.unreadable) }
    if let why = differs(offered: offered, fresh: fresh) { return .refuse(why) }
    guard offered.kind != .login else { return .refuse(.noKeys) }
    guard offered.options.indices.contains(choice) else { return .refuse(.badChoice) }
    guard let cursor = fresh.cursor, fresh.options.indices.contains(cursor) else { return .refuse(.noCursor) }
    let d = choice - cursor
    return .keys(Array(repeating: d > 0 ? DialogKey.down : DialogKey.up, count: abs(d)) + [.enter])
  }

  /// Whether an arrow did what it was sent for: the row is exactly one step from `from` in its direction.
  public static func moved(_ key: DialogKey, from: Int, to: Int?) -> Bool {
    guard let to else { return false }
    switch key {
    case .up: return to == from - 1
    case .down: return to == from + 1
    case .enter: return false
    }
  }
}
