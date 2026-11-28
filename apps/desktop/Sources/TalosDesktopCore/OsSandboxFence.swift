import Foundation

/// The clone fence (the twin of cloneFenceProblem and recordedBridgePaths in os-sandbox-folder.ts): a session folder that holds the Talos
/// code folder (the clone) or the pinned bun, or sits inside either, is refused, and the clone, its bridge folder and the bun are always
/// write-protected. Without it a session in such a folder could edit what the guard hook runs, outside the sandbox.
extension OsSandboxFolder {
  /// The env key Talos's `talos-app` entry may carry (only as "0": bun's compiled-code cache off).
  static let bunCacheKey = "BUN_RUNTIME_TRANSPILER_CACHE_PATH"

  static let cloneLine = "This folder contains the Talos code, or is inside it. Pick another folder and start again."
  static let bunLine = "This folder contains the program Talos runs on, or is inside it. Pick another folder and start again."

  /// A name as the Mac's disks compare it: Unicode NFC, then lower case.
  static func foldName(_ p: String) -> String { p.precomposedStringWithCanonicalMapping.lowercased() }

  /// `p` is `dir` or inside it; the root holds everything (`hasPrefix("//")` is false, so it is said here).
  static func fenceUnder(_ p: String, _ dir: String) -> Bool { dir == "/" || p == dir || p.hasPrefix(dir + "/") }

  /// The recorded clone (two folders above the bridge folder), the bridge folder and the buns, each by real path.
  struct RecordedPaths {
    var clone: String
    var bridgeDir: String
    var buns: [String]
    /// The order the write blocks list them in: the clone, the bridge folder, then the buns (once each).
    var denyOrder: [String] {
      var out: [String] = []
      for p in [clone, bridgeDir] + buns where !out.contains(p) { out.append(p) }
      return out
    }
  }
}

extension OsSandboxFolder.Trusted {
  var recordedPaths: OsSandboxFolder.RecordedPaths {
    func real(_ p: String) -> String { (try? OsSandboxPaths.real(p)) ?? OsSandboxFolder.realName(p) }
    let bridge = real(bridgeDir)
    var buns: [String] = []
    for b in [bun] + extraBuns where !buns.contains(real(b)) { buns.append(real(b)) }
    return .init(clone: ((bridge as NSString).deletingLastPathComponent as NSString).deletingLastPathComponent, bridgeDir: bridge, buns: buns)
  }
}

extension OsSandboxFolder {
  /// One plain line when `folder` (a real path) holds the clone or a bun, or is inside one (case and Unicode form ignored), else nil. nil also
  /// when there is no record; the caller never turns an unknown record into trust: the `talos-app` entry check refuses without one.
  static func cloneFenceProblem(_ folder: String, _ trusted: Trusted?) -> String? {
    guard let trusted else { return nil }
    let r = trusted.recordedPaths
    let f = foldName(folder)
    func overlaps(_ p: String) -> Bool { let q = foldName(p); return fenceUnder(f, q) || fenceUnder(q, f) }
    if overlaps(r.clone) { return cloneLine }
    if r.buns.contains(where: overlaps) { return bunLine }
    return nil
  }
}
