import Foundation

/// A folder shaped like the Talos app bundle, with the thread sessions' permission hook where build-app.sh puts it
/// (`Contents/Resources/talos-hooks/`, read-only). For tests of where the hook comes from: no test reads the real `Bundle.main`.
public struct FakeAppBundle: Sendable {
  /// `<base>/Talos.app`, links resolved.
  public let path: String
  public var hooks: String { path + "/Contents/Resources/talos-hooks" }
  public var script: String { hooks + "/permission-relay.py" }
  public var helper: String { hooks + "/_talos_common.py" }

  /// Where one of the thread-state hook's files is (`thread-state.py`, `compaction-guard.py`).
  public func stateFile(_ name: String) -> String { hooks + "/" + name }

  /// `helper` nil: a bundle whose hook has no helper beside it. `state`: the thread-state hook's files by name, as build-app.sh puts them
  /// beside the permission hook (nil: a bundle that has none, as one built before they were added).
  public init(in base: String, script: Data, helper: Data?, state: [String: Data]? = nil) throws {
    let app = base + "/Talos.app"
    try FileManager.default.createDirectory(atPath: app + "/Contents/Resources/talos-hooks", withIntermediateDirectories: true)
    // realpath, not URL.resolvingSymlinksInPath: that one drops /private from /private/var, and the paths here are compared whole
    guard let r = realpath(app, nil) else { throw CocoaError(.fileNoSuchFile) }
    defer { free(r) }
    path = String(cString: r)
    try Self.put(script, at: self.script)
    if let helper { try Self.put(helper, at: self.helper) }
    for (name, bytes) in state ?? [:] { try Self.put(bytes, at: hooks + "/" + name) }
  }

  /// A read-only file (0444), as the build leaves the bundled hook.
  public static func put(_ data: Data, at p: String) throws {
    try data.write(to: URL(fileURLWithPath: p))
    chmod(p, 0o444)
  }

  /// Written over in place (the same inode), the way an editor or a thread session's shell would after `chmod u+w`; read-only again after.
  public static func overwrite(_ p: String, with text: String) throws {
    chmod(p, 0o644)
    let h = try FileHandle(forWritingTo: URL(fileURLWithPath: p))
    try h.truncate(atOffset: 0)
    try h.write(contentsOf: Data(text.utf8))
    try h.close()
    chmod(p, 0o444)
  }
}
