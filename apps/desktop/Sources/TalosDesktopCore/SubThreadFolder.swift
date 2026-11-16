import Foundation

/// A sub-thread's own folder is a subfolder of its parent thread's folder, made when it is missing. The check is on the resolved paths,
/// so a `..` or a symlink cannot lead out, and it runs at every start: a folder that was inside when it was chosen may have been swapped
/// since. One exception: an absolute path with no `.` or `..` in it that already exists as a folder outside the parent's (and is not the
/// parent's own) is the sub-thread's own folder, kept as it is and never made; it does not get the parent's instructions.
public enum SubThreadFolder {
  public struct Refusal: Error, Equatable, Sendable, CustomStringConvertible {
    public let why: String
    public var description: String { why }
  }

  private static func resolved(_ path: String) -> String? {
    guard path.hasPrefix("/"), let r = realpath(path, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  private static func isFolder(_ path: String) -> Bool {
    var isDir: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
  }

  /// Both paths are resolved already. Strictly inside, compared case-insensitively as APFS is.
  private static func strictlyInside(_ child: String, _ parent: String) -> Bool {
    var root = parent.lowercased()
    while root.hasSuffix("/") { root.removeLast() }
    return child != parent && child.lowercased().hasPrefix(root + "/")
  }

  /// The resolved folder when `cwd` is an own folder outside the parent's: absolute, no `.` or `..` segment, not written as a path under
  /// the parent (so a link inside the parent that leads out stays an escape), existing as a folder, and not the parent itself. Else nil.
  /// The parent must resolve too.
  static func ownFolder(cwd: String, parentCwd: String) -> String? {
    guard cwd.hasPrefix("/"), parentCwd.hasPrefix("/") else { return nil }
    guard !cwd.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return nil }
    guard let parent = resolved(parentCwd), let child = resolved(cwd), isFolder(child) else { return nil }
    func trimmed(_ p: String) -> String {
      var t = p.lowercased()
      while t.count > 1, t.hasSuffix("/") { t.removeLast() }
      return t
    }
    let written = trimmed(cwd)
    for root in [trimmed(parentCwd), trimmed(parent)] where written == root || written.hasPrefix(root == "/" ? "/" : root + "/") { return nil }
    guard !strictlyInside(child, parent), trimmed(child) != trimmed(parent) else { return nil }
    return child
  }

  public static let outside = "the sub-thread's folder must be inside its parent thread's folder"

  /// nil = fine: `cwd` exists, is a folder, and is strictly inside `parentCwd` once both are resolved (or is an own folder, see above).
  /// Otherwise the reason it is refused.
  public static func problem(cwd: String, parentCwd: String) -> String? {
    guard cwd.hasPrefix("/"), parentCwd.hasPrefix("/") else { return "the folders must be absolute paths" }
    guard let parent = resolved(parentCwd) else { return "the parent thread's folder does not exist" }
    guard let child = resolved(cwd) else { return "the sub-thread's folder does not exist" }
    guard isFolder(child) else { return "not a folder" }
    if ownFolder(cwd: cwd, parentCwd: parentCwd) != nil { return nil }
    return strictlyInside(child, parent) ? nil : outside
  }

  /// Where a sub-thread's folder will be, worked out without making anything: the folders that exist are resolved (links and `..`), the
  /// rest must be plain names, and the result must be strictly inside the parent's folder.
  private static func plan(cwd: String, parentCwd: String) -> Result<(parent: String, base: String, rest: [String], target: String), Refusal> {
    guard cwd.hasPrefix("/"), parentCwd.hasPrefix("/") else { return .failure(.init(why: "the folders must be absolute paths")) }
    guard let parent = resolved(parentCwd), isFolder(parent) else {
      return .failure(.init(why: "the parent thread's folder does not exist"))
    }
    let parts = cwd.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    // the longest leading part of the path that exists
    var have = parts.count
    var base: String?
    while have >= 0 {
      if let r = resolved("/" + parts[0..<have].joined(separator: "/")) {
        base = r
        break
      }
      have -= 1
    }
    guard let base, isFolder(base) else { return .failure(.init(why: "the sub-thread's folder is not under a folder that exists")) }
    let rest = parts[have...].filter { $0 != "." }
    guard !rest.contains(where: { $0 == ".." }) else { return .failure(.init(why: outside)) }
    let target = rest.isEmpty ? base : (base == "/" ? "" : base) + "/" + rest.joined(separator: "/")
    guard strictlyInside(target, parent) else { return .failure(.init(why: outside)) }
    return .success((parent, base, rest, target))
  }

  /// The folder fence for a session that is running.
  public enum Fence: Sendable { case inside, outside, unknown }

  /// `.outside` only on a firm verdict: the folder, as it resolves now, is not strictly inside the parent's, or a path is not absolute.
  /// `.unknown` when a folder cannot be resolved for a moment (a rename, a permission, a network mount): never a reason to stop a
  /// session that runs. Makes nothing.
  public static func fence(cwd: String, parentCwd: String) -> Fence {
    if ownFolder(cwd: cwd, parentCwd: parentCwd) != nil { return .inside }  // its own folder, kept: nothing to park
    guard case .failure(let refusal) = plan(cwd: cwd, parentCwd: parentCwd) else { return .inside }
    return refusal.why == outside || refusal.why == "the folders must be absolute paths" ? .outside : .unknown
  }

  /// nil = the folder is (or can be made) strictly inside the parent's. Makes nothing: this is the check to run before anything is decided
  /// about the folder, such as whether another session has it.
  public static func check(cwd: String, parentCwd: String) -> Refusal? {
    if ownFolder(cwd: cwd, parentCwd: parentCwd) != nil { return nil }
    if case .failure(let refusal) = plan(cwd: cwd, parentCwd: parentCwd) { return refusal }
    return nil
  }

  /// The sub-thread's folder, resolved, made if it is missing. It is checked strictly inside the parent's folder BEFORE anything is made,
  /// so a link or `..` cannot make a folder outside it. The made folder is resolved and checked once more.
  public static func prepare(cwd: String, parentCwd: String) -> Result<String, Refusal> {
    if let own = ownFolder(cwd: cwd, parentCwd: parentCwd) { return .success(own) }  // existing, outside: used as it is, nothing made
    let planned: (parent: String, base: String, rest: [String], target: String)
    switch plan(cwd: cwd, parentCwd: parentCwd) {
    case .failure(let refusal): return .failure(refusal)
    case .success(let p): planned = p
    }
    var path = planned.base
    for name in planned.rest {
      path = (path == "/" ? "" : path) + "/" + name
      if mkdir(path, 0o755) != 0 {
        // lost a race with a folder of the same name: fine; a link or a file in the way is not
        var st = stat()
        guard errno == EEXIST, lstat(path, &st) == 0, st.st_mode & S_IFMT == S_IFDIR else {
          return .failure(.init(why: "cannot make the sub-thread's folder"))
        }
      }
    }
    guard let made = resolved(planned.target), isFolder(made), strictlyInside(made, planned.parent) else {
      return .failure(.init(why: outside))
    }
    return .success(made)
  }
}
