import Foundation

/// The check under the Agent folder box. It never creates or changes anything.
public enum AgentFolderCheck {
  public enum Result: Equatable, Sendable {
    case ok
    case okProtected(String)
    case empty
    case missing(String)
    case notAFolder(String)
    case notAccessible(String)

    public var isProblem: Bool {
      switch self {
      case .ok, .okProtected: return false
      default: return true
      }
    }

    public var text: String {
      switch self {
      case .ok: return "Folder found."
      case .okProtected(let f): return "Folder found. It is inside \(f), a folder macOS protects, so macOS asks Talos once."
      case .empty: return "Choose a folder, or leave the default."
      case .missing(let p): return "No folder at \(p). Talos will not create it."
      case .notAFolder(let p): return "\(p) is a file, not a folder."
      case .notAccessible(let p): return "Talos can't open \(p). Check its permissions."
      }
    }
  }

  public static let appliesNote =
    "Applies the next time the agent starts, and that start is a cold start. Nothing restarts on its own."

  /// `exists` returns (exists, isDirectory); `readable` says the folder can be listed. Both are injected for tests.
  public static func check(
    _ path: String, home: String,
    exists: (String) -> (exists: Bool, isDirectory: Bool) = { p in
      var d: ObjCBool = false
      let e = FileManager.default.fileExists(atPath: p, isDirectory: &d)
      return (e, d.boolValue)
    },
    readable: (String) -> Bool = { FileManager.default.isReadableFile(atPath: $0) && FileManager.default.isExecutableFile(atPath: $0) }
  ) -> Result {
    let trimmed = path.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { return .empty }
    let full = PathUtil.expandTilde(trimmed, home: home)
    let e = exists(full)
    if !e.exists { return .missing(full) }
    if !e.isDirectory { return .notAFolder(full) }
    if !readable(full) { return .notAccessible(full) }
    if let f = FirstRun.protectedFolder(trimmed, home: home) { return .okProtected(f) }
    return .ok
  }
}
