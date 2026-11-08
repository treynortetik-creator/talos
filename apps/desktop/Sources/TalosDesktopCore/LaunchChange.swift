import Foundation

/// A change to a running thread session's settings (folder, model, effort, MCP list) and what to do about it (docs/OPTION-C.md "Leads and
/// the fence"). The supervisor's tick compares what the running session was started with (`WorkersFile.Launched`) with the config. A new
/// folder starts a FRESH conversation in it (the old id moves to `previous_ids`); a new model, effort or list resumes the same one. Either
/// goes through `stopping`, so a turn in progress is never cut, and only after the config has stood unchanged for the settle time, so two
/// edits in a row are one restart with the final config.
public enum LaunchChange: Equatable, Sendable {
  case none
  case restart(wanted: Signature, changed: [String])
  case fresh(wanted: Signature)

  /// What a launch is made from. The list is compared as a set; `nil` (no list) and `[]` (a list with nothing on it) differ.
  public struct Signature: Equatable, Sendable {
    public var cwd: String
    public var model: String
    public var effort: String?
    public var mcpAllow: [String]?
    public init(cwd: String, model: String, effort: String?, mcpAllow: [String]?) {
      self.cwd = cwd
      self.model = model
      self.effort = effort
      self.mcpAllow = mcpAllow?.sorted()
    }
  }

  /// A worker with no record of its launch (an entry an older build wrote) is never changed: it records the launch at its next start.
  public static func compare(launched: WorkersFile.Launched?, wanted: Signature) -> LaunchChange {
    guard let l = launched else { return .none }
    if l.cwd != wanted.cwd { return .fresh(wanted: wanted) }
    var changed: [String] = []
    if l.model != wanted.model { changed.append("model") }
    if l.effort != wanted.effort { changed.append("effort") }
    if l.mcp_allow?.sorted() != wanted.mcpAllow { changed.append("mcp_allow") }
    return changed.isEmpty ? .none : .restart(wanted: wanted, changed: changed)
  }

  /// A change is acted on once it has stood, unchanged, for `settle` seconds. A different change starts the wait again; no change forgets it.
  public struct Debounce: Sendable {
    public var settle: Double
    private var pending: LaunchChange?
    private var since: Double = 0
    public init(settle: Double = 30) { self.settle = settle }

    public mutating func observe(_ change: LaunchChange, at t: Double) -> LaunchChange? {
      guard change != .none else {
        pending = nil
        return nil
      }
      if pending != change {
        pending = change
        since = t
        return nil
      }
      guard t - since >= settle else { return nil }
      pending = nil
      return change
    }
  }

  // MARK: the lines the thread gets

  public static func folderLine(_ folder: String) -> String { "Started a new conversation in \(folder)." }

  public static func missingServersLine(_ names: [String]) -> String {
    "These MCP servers on this thread's list were not found, so the session started without them: \(names.joined(separator: ", "))."
  }

  public static func refusedServersLine(_ names: [String]) -> String {
    "These servers can't be on a thread session's list (a claude.ai connector, the browser or screen tools, a messaging plugin) or the Mac can't set them up, so the session started without them: \(names.joined(separator: ", "))."
  }

  public static func ceilingLine(_ d: PrivilegeCeiling.Denial) -> String {
    "This thread's own session did not start: it would have more access than the main session (\(d.detail)). Messages go to the main session until its settings are narrower."
  }
}
