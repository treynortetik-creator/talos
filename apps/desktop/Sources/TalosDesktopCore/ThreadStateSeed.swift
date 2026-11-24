import Foundation

/// A thread's live state file (`<agentDir>/threads/<id>.state.md`), seeded at each start so the session finds the sections it keeps
/// current (the kit's thread-state.py hook puts it back in front of the session at every boundary). Never overwritten, never written
/// through a link; a failure is reported by the caller and never stops the start. The Linux twin is thread-state-seed.ts (same
/// template, same checks; swift-parity.test.ts compares the two).
public enum ThreadStateSeed {
  public enum Outcome: Equatable, Sendable {
    case created
    case exists
    case problem(String)
  }

  /// The state file's path for a thread (the id is a validated thread id: no separator can be in it).
  public static func path(agentDir: String, id: String) -> String { agentDir + "/threads/\(id).state.md" }

  /// The seed text: `name` is the thread's display name (its id when it has none), flattened to one short line.
  public static func template(id: String, name: String?) -> String {
    // a name is config text and lands in a heading: control characters become spaces, runs of space one, at most 80 characters
    let flat = String(String.UnicodeScalarView((name ?? "").unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7f ? " " : $0 }))
    let words = flat.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    let label = String(words.prefix(80))
    let shown = label.isEmpty ? id : label
    return """
      # \(shown) live state (thread \(id))
      READ FIRST after any restart or compaction. Rule: update THIS file the same turn anything here changes (an owner ask, a
      decision, a landing, a hold). Keep it under 8,000 characters; history goes in the thread or a log, not here.

      ## Owner asks open (newest first, dated)
      ## Waiting on the owner
      ## In flight
      ## CI (optional: leave empty if this thread does no builds)
      ## Rules learned

      """
  }

  private static func real(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
  }

  /// Makes the file when it is missing: `threads/` 0700 if absent (refused when it is a link or not a folder), the file opened with
  /// O_CREAT|O_EXCL|O_NOFOLLOW (never overwrites, never follows a link), 0600. `dry` checks the same and writes nothing.
  public static func seed(agentDir: String, id: String, name: String?, dry: Bool = false) -> Outcome {
    let dir = agentDir + "/threads"
    let file = path(agentDir: agentDir, id: id)
    var st = stat()
    let dirThere = lstat(dir, &st) == 0
    if !dirThere, errno != ENOENT { return .problem("\(file) could not be made: \(String(cString: strerror(errno)))") }
    if dirThere, st.st_mode & S_IFMT != S_IFDIR { return .problem("\(dir) is not a plain folder") }
    var fst = stat()
    if lstat(file, &fst) == 0 {
      if fst.st_mode & S_IFMT == S_IFLNK { return .problem("\(file) is a link") }
      // a folder (or anything else) there is not a state file: the session's rules deny what is under it, and it would not be read
      if fst.st_mode & S_IFMT != S_IFREG { return .problem("\(file) is not a regular file") }
      return .exists
    }
    if errno != ENOENT { return .problem("\(file) could not be made: \(String(cString: strerror(errno)))") }
    if dry { return .created }
    if !dirThere, mkdir(dir, 0o700) != 0, errno != EEXIST {
      return .problem("\(file) could not be made: \(String(cString: strerror(errno)))")
    }
    let fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else {
      // EEXIST: another start made it first (or a link appeared): nothing is overwritten
      if errno == EEXIST { return .exists }
      return .problem("\(file) could not be made: \(String(cString: strerror(errno)))")
    }
    defer { close(fd) }
    // threads/ could have been swapped for a link between the check above and the open: the file must really be in the agent
    // folder's own threads/, else what was made is removed
    var made = stat()
    var now = stat()
    var fine = fstat(fd, &made) == 0 && made.st_mode & S_IFMT == S_IFREG
    fine = fine && lstat(dir, &now) == 0 && now.st_mode & S_IFMT == S_IFDIR
    if fine, let a = real(agentDir), let d = real(dir) { fine = d == a + "/threads" } else { fine = false }
    guard fine else {
      unlink(file)
      return .problem("\(dir) is not the agent folder's own threads folder")
    }
    let bytes = Array(template(id: id, name: name).utf8)
    var done = 0
    while done < bytes.count {
      let n = bytes[done...].withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
      if n <= 0 {
        unlink(file)
        return .problem("\(file) could not be made: \(String(cString: strerror(errno)))")
      }
      done += n
    }
    return .created
  }
}
