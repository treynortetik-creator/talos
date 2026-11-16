import Foundation

/// Where the tests make their temp folders and files. On macOS `NSTemporaryDirectory()` ignores `TMPDIR` and always answers
/// the per-user `/var/folders/.../T/`, so a run that sets `TMPDIR` (CI points it at a folder the antivirus skips) would still
/// write there. This answers `TMPDIR` when it is an existing absolute directory, and `NSTemporaryDirectory()` otherwise.
/// Like `NSTemporaryDirectory()`, it ends in "/".
///
/// Unix socket paths are limited to 103 usable bytes on macOS, and `TMPDIR` can be long. Keep sockets off this base: the
/// tmux sockets live under /tmp (`-L`, with `TMUX_TMPDIR` unset).
public enum TestTemp {
  public static let base: String = resolve(ProcessInfo.processInfo.environment["TMPDIR"])
  public static var url: URL { URL(fileURLWithPath: base, isDirectory: true) }

  /// `p` with every link resolved, as `realpath` gives it: `/private/var/...` for the default TMPDIR. Not
  /// `URL.resolvingSymlinksInPath`, which drops `/private` again, so a path made with it is not the one the code under test (which
  /// asks `realpath`) answers with. For a test root whose paths are compared whole.
  public static func real(_ p: String) throws -> String {
    guard let r = realpath(p, nil) else { throw CocoaError(.fileNoSuchFile) }
    defer { free(r) }
    return String(cString: r)
  }

  public static func resolve(_ tmpdir: String?) -> String {
    var isDir: ObjCBool = false
    guard let t = tmpdir, t.hasPrefix("/"), FileManager.default.fileExists(atPath: t, isDirectory: &isDir), isDir.boolValue
    else { return NSTemporaryDirectory() }
    return t.hasSuffix("/") ? t : t + "/"
  }
}
