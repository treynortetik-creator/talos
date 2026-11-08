import Foundation

/// What counts as a worker doing something, for the idle park (docs/OPTION-C.md, "Idle"). tmux's `#{window_activity}` moves on every
/// byte the pane receives, and Claude Code's status line (the owner's `statusLine` setting) repaints under the input box when usage
/// changes, from any session. So the idle clock follows the screen above the input box instead: the conversation, the spinner, the box
/// itself and what is typed in it.
public enum WorkerActivity {
  /// The screen down to and including the lower rule of Claude's input box (`PointerTyper.inputBox`). The footer and the status line
  /// are drawn under that rule and are left out. With no box on the screen (a dialog, a blank pane) it is the whole screen: nothing is
  /// known about where the status line would be, and the clock errs toward activity.
  public static func body(rows: [String]) -> String {
    let end = PointerTyper.inputBox(rows: rows).map { $0.upperBound + 1 } ?? rows.count
    return rows.prefix(end).joined(separator: "\n")
  }
}
