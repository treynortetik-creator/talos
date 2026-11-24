import Foundation

/// Paths the OS sandbox settings name (OsSandbox.swift). The Swift twin of `real-file.ts`: a path's real location, walked one name at
/// a time as the kernel walks it, and never taken from an open file's name. A file with several names has no one realpath on macOS (the
/// system's own tools are one file with dozens of names), and a Seatbelt rule whose path is not the real spelling is not enforced at all,
/// so the rule paths are made here and nowhere else.
enum OsSandboxPaths {
  struct Failure: Error { let message: String }

  /// Links followed at most: the kernel's own limit (MAXSYMLINKS) on a Mac.
  private static let maxLinks = 32

  /// `p` as the kernel would resolve it, each name spelled as it is on the disk (a file's own name too, when the disk's spelling can be had).
  /// Throws `Failure` where the path does not resolve (missing name, a file used as a folder, a loop, no permission).
  static func real(_ p: String) throws -> String {
    guard !p.isEmpty else { throw Failure(message: "ENOENT: no such file or directory, realpath ''") }
    var rest = Array((p.hasPrefix("/") ? p : FileManager.default.currentDirectoryPath + "/" + p).split(separator: "/", omittingEmptySubsequences: false).map(String.init).reversed())
    var done = "/"
    var isFolder = true
    var links = 0
    while let name = rest.popLast() {
      guard isFolder else { throw Failure(message: "ENOTDIR: not a directory, realpath '\(p)'") }
      if name == "" || name == "." { continue }
      if name == ".." {
        done = (done as NSString).deletingLastPathComponent
        continue
      }
      let next = join(done, name)
      var st = stat()
      guard lstat(next, &st) == 0 else { throw Failure(message: "\(String(cString: strerror(errno))), realpath '\(p)'") }
      if (st.st_mode & S_IFMT) != S_IFLNK {
        done = next
        isFolder = (st.st_mode & S_IFMT) == S_IFDIR
        continue
      }
      links += 1
      guard links <= maxLinks else { throw Failure(message: "ELOOP: too many symbolic links encountered, realpath '\(p)'") }
      var buf = [CChar](repeating: 0, count: Int(PATH_MAX) + 1)
      let n = readlink(next, &buf, Int(PATH_MAX))
      guard n >= 0 else { throw Failure(message: "\(String(cString: strerror(errno))), realpath '\(p)'") }
      let target = String(decoding: buf[0..<n].map { UInt8(bitPattern: $0) }, as: UTF8.self)
      if target.hasPrefix("/") { done = "/" }
      for part in target.split(separator: "/", omittingEmptySubsequences: false).reversed() { rest.append(String(part)) }
    }
    if isFolder { return try realFolder(done) }
    let folder = try realFolder((done as NSString).deletingLastPathComponent)
    let name = (done as NSString).lastPathComponent
    // the disk's spelling of THIS name in THIS folder: realpath's when it is the same name in the same folder, else the folder's one
    // entry spelled like it, else the name as reached (the realpath of a file may come back as one of its other names)
    if let r = libcRealpath(done), (r as NSString).deletingLastPathComponent == folder, fold((r as NSString).lastPathComponent) == fold(name) {
      return r
    }
    if let names = try? FileManager.default.contentsOfDirectory(atPath: folder) {
      if names.contains(name) { return join(folder, name) }
      let like = names.filter { fold($0) == fold(name) }
      if like.count == 1 { return join(folder, like[0]) }
    }
    return join(folder, name)
  }

  /// A folder has one name on a Mac, so its realpath is sound; checked to be a folder still (it may have been swapped for a file since the walk).
  private static func realFolder(_ p: String) throws -> String {
    guard let r = libcRealpath(p) else { throw Failure(message: "\(String(cString: strerror(errno))), realpath '\(p)'") }
    var st = stat()
    guard lstat(r, &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR else { throw Failure(message: "ENOTDIR: not a directory, realpath '\(p)'") }
    return r
  }

  private static func libcRealpath(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  /// A name as a case-folding volume compares it: one Unicode form, one case.
  private static func fold(_ s: String) -> String { s.precomposedStringWithCanonicalMapping.lowercased() }

  /// `a` and `b` joined with one slash (node's `path.join` for the shapes used here: no `..` in `b`).
  static func join(_ a: String, _ b: String) -> String { a == "/" ? "/" + b : a + "/" + b }

  /// `path.resolve(base, w)`: `w` made absolute against `base`, `.` and `..` and doubled slashes taken out.
  static func resolve(_ base: String, _ w: String) -> String {
    var parts: [String] = []
    let all = (w.hasPrefix("/") ? w : base + "/" + w).split(separator: "/", omittingEmptySubsequences: true)
    for s in all {
      if s == "." { continue }
      if s == ".." { _ = parts.popLast(); continue }
      parts.append(String(s))
    }
    return "/" + parts.joined(separator: "/")
  }

  static func lstatOk(_ p: String) -> Bool {
    var st = stat()
    return lstat(p, &st) == 0
  }

  static func isLink(_ p: String) -> Bool {
    var st = stat()
    return lstat(p, &st) == 0 && (st.st_mode & S_IFMT) == S_IFLNK
  }
}
