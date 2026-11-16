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

  /// What a launch is made from. The list is compared as a set; `nil` (no list) and `[]` (a list with nothing on it) differ. A `cwd` of
  /// nil is a folder that cannot be known now (its setting cannot be read): never compared.
  public struct Signature: Equatable, Sendable {
    public var cwd: String?
    public var model: String
    public var effort: String?
    public var mcpAllow: [String]?
    public init(cwd: String?, model: String, effort: String?, mcpAllow: [String]?) {
      self.cwd = cwd
      self.model = model
      self.effort = effort
      self.mcpAllow = mcpAllow?.sorted()
    }
  }

  /// A worker with no record of its launch (an entry an older build wrote) has only its folder compared, against `entryCwd` (the entry's
  /// own `cwd`: every start set it to the folder it launched in, resolved), so a folder change is not missed; its model, effort and list
  /// are not known, and it records them at its next start. A launch field whose setting cannot be read (`unread`, see
  /// `ThreadSessionSettings.optsUnread`) is its default, not the owner's setting, and restarts nothing; the MCP list is always compared
  /// (one that cannot be read is the empty list: a narrowing is never put off).
  public static func compare(
    launched: WorkersFile.Launched?, wanted: Signature, unread: [String] = [], entryCwd: String? = nil
  ) -> LaunchChange {
    func isUnread(_ f: String) -> Bool { unread.contains("session_opts") || unread.contains(f) }
    guard let l = launched else {
      if let was = entryCwd, let w = wanted.cwd, !isUnread("cwd"), was != w { return .fresh(wanted: wanted) }
      return .none
    }
    if let w = wanted.cwd, !isUnread("cwd"), l.cwd != w { return .fresh(wanted: wanted) }
    var changed: [String] = []
    if !isUnread("model"), l.model != wanted.model { changed.append("model") }
    if !isUnread("effort"), l.effort != wanted.effort { changed.append("effort") }
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

  /// The folder is not named: it is the owner's setting, and the line is a system row (`WorkerNotice`).
  public static func folderLine() -> String { "Started a new conversation in this thread's new folder." }

  /// The servers are named, since the owner needs them to act, in quotes (`WorkerNotice.quoted`).
  public static func missingServersLine(_ names: [String]) -> String {
    "These MCP servers on this thread's list were not found, so the session started without them: \(WorkerNotice.quoted(names))."
  }

  public static func refusedServersLine(_ names: [String]) -> String {
    "These servers can't be on a thread session's list (a claude.ai connector, the browser or screen tools, a messaging plugin) or the Mac can't set them up, so the session started without them: \(WorkerNotice.quoted(names))."
  }

  public static func ceilingLine(_ d: PrivilegeCeiling.Denial) -> String {
    "This thread's own session did not start: it would have more access than the main session (\(d.detail)). Messages go to the main session until its settings are narrower."
  }
}
