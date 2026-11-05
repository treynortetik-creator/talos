import Foundation
import TalosDesktopCore

/// One plain sentence per way the session stops (audit D41). The menu used to print the Swift value, `stopped
/// (startFailed("…"))`.
extension Supervisor.StopReason {
  public var plainSentence: String {
    switch self {
    case .user: return "Stopped."
    case .crashLoop: return "The agent kept crashing, so Talos stopped restarting it."
    case .resumeMissing: return "The last conversation can't be resumed."
    case .noNotice: return "The restart wasn't confirmed in time."
    case .crashedNoAutoRestart: return "The agent crashed and auto-restart is off."
    case .startFailed:
      let d = startDetail
      return d.isEmpty ? "The agent couldn't start." : "The agent couldn't start: \(d)."
    }
  }

  /// Just the why of a failed start ("claude was not found (claude_path auto)"), for a line that already says it couldn't start.
  public var startDetail: String {
    guard case .startFailed(let why) = self else { return "" }
    var d = why.trimmingCharacters(in: .whitespacesAndNewlines)
    if d.hasPrefix("start failed: ") { d.removeFirst("start failed: ".count) }
    d = String(d.split(whereSeparator: \.isNewline).first ?? "").trimmingCharacters(in: .whitespaces)
    if d.count > 140 { d = String(d.prefix(140)) + "…" }
    return d
  }

  /// Starting again with the same conversation id fails the same way, so only a new conversation helps.
  public var retryCannotWork: Bool { if case .resumeMissing = self { return true } else { return false } }

  /// A stop the owner did not ask for: the menu offers Try again.
  public var isFailure: Bool { if case .user = self { return false } else { return true } }
}
