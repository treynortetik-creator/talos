import Foundation

/// The bun and tmux that ship inside a prebuilt Talos.app (`Contents/Helpers`, put there by `bundle-tools.sh` and signed with the
/// app). A Mac's own copies are always preferred: the bundled folder goes at the END of the PATH Main and the workers get, so it
/// only answers when nothing else does.
public enum BundledTools {
  /// The app's helper folder, when this process runs from an app that has one (not a test runner, not a debug build).
  public static let dir: String? = resolve(bundlePath: Bundle.main.bundlePath)

  public static func resolve(bundlePath: String, isExecutable: (String) -> Bool = FileManager.default.isExecutableFile) -> String? {
    let d = bundlePath + "/Contents/Helpers"
    return ["bun", "tmux"].contains(where: { isExecutable(d + "/" + $0) }) ? d : nil
  }

  /// `path` with `dir` added last (not twice). A missing or empty PATH becomes the system folders plus `dir`.
  public static func appending(toPath path: String?, dir: String?) -> String? {
    guard let dir, !dir.isEmpty else { return path }
    let parts = (path ?? "").split(separator: ":", omittingEmptySubsequences: true).map(String.init)
    if parts.contains(dir) { return path }
    return (parts.isEmpty ? ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] : parts).appending(dir).joined(separator: ":")
  }

  /// Whether the install should use bun for the packages: the Mac has no pnpm on the PATH. The clone's installer reads the variable.
  public static func jsRuntimeEnv(_ env: [String: String], isExecutable: (String) -> Bool = FileManager.default.isExecutableFile) -> [String: String] {
    var e = env
    let hasPnpm = LoginShellEnv.which("pnpm", path: env["PATH"], isExecutable: isExecutable) != nil
    if !hasPnpm { e["TALOS_JS_RUNTIME"] = "bun" } else { e["TALOS_JS_RUNTIME"] = nil }
    return e
  }
}

extension Array {
  fileprivate func appending(_ x: Element) -> [Element] { self + [x] }
}
