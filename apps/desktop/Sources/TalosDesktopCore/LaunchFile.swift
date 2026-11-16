import Foundation

/// How every agent pane is launched, Main's and each worker's. tmux is handed only `/usr/bin/env -i /bin/sh <file>`, and the
/// file holds the rest:
/// - its first line removes the file, so it is gone as soon as the shell has read it;
/// - then one `export NAME='value'` per variable. `export` is a shell builtin, so no value is ever in an argv, where `ps`
///   shows it to any local process (tmux's `-e NAME=value` and `env NAME=value` both put it there);
/// - then `exec` of the agent's argv, every element single-quoted, so a path with spaces, `$`, quotes or a backtick runs as
///   named (tmux runs a one-element command through `sh -c`).
/// With `env -i` the pane has what the file exports (and the `PWD` and `SHLVL` the shell adds), so nothing is ever set on
/// the shared tmux server or its sessions: one launch's variables can't reach another pane, and a variable the server
/// holds can't reach this one. Main no longer gets the `TMUX` and `TMUX_PANE` tmux sets; workers never did.
/// The file is 0600, created new (O_EXCL, never through a symlink) in a 0700 folder under the Talos home.
public enum LaunchFile {
  public enum Failure: Error, Equatable, CustomStringConvertible {
    /// A variable name the shell can't `export`.
    case badName(String)
    case io(String)

    public var description: String {
      switch self {
      case .badName(let n): return "refused environment variable name \(n.debugDescription)"
      case .io(let why): return "launch file: \(why)"
      }
    }
  }

  /// Main's launch files. A worker's is `launch.sh` in its own folder.
  public static func dir(talosHome: String) -> String { talosHome + "/launch" }

  /// `^[A-Za-z_][A-Za-z0-9_]*$`
  public static func isValidName(_ name: String) -> Bool {
    guard let first = name.unicodeScalars.first, first == "_" || isASCIILetter(first) else { return false }
    return name.unicodeScalars.allSatisfy { $0 == "_" || isASCIILetter($0) || ("0"..."9").contains($0) }
  }

  private static func isASCIILetter(_ c: Unicode.Scalar) -> Bool { ("a"..."z").contains(c) || ("A"..."Z").contains(c) }

  /// Always single-quoted; a `'` inside is `'\''`.
  static func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

  /// Variables macOS `/bin/sh` (bash) owns: `export` of one stops the script before the agent runs. The shell sets them
  /// itself, so they are left out, not refused.
  static let shellOwned: Set<String> = [
    "BASH_ARGC", "BASH_ARGV", "BASH_LINENO", "BASH_SOURCE", "BASH_VERSINFO", "EUID", "FUNCNAME", "GROUPS", "PPID", "SHELLOPTS",
    "UID",
  ]

  /// The file's text. TERM is what tmux.conf's `default-terminal` gives a pane when the environment has none: `env -i`
  /// drops the one tmux sets.
  public static func script(argv: [String], env: [String: String]) throws -> String {
    guard let program = argv.first, !program.isEmpty else { throw Failure.io("nothing to run") }
    // `exec -x` is an option to exec in some shells, and `exec --` is not portable: a program name never starts with `-`
    guard !program.hasPrefix("-") else { throw Failure.io("a program name cannot start with -") }
    guard !argv.contains(where: { $0.contains("\0") }), !env.values.contains(where: { $0.contains("\0") }) else {
      throw Failure.io("an argument or variable holds a NUL byte")
    }
    var e = env.filter { !shellOwned.contains($0.key) }
    if e["TERM"] == nil { e["TERM"] = "xterm-256color" }
    if let bad = e.keys.sorted().first(where: { !isValidName($0) }) { throw Failure.badName(bad) }
    var lines = ["rm -f -- \"$0\""]
    lines += e.keys.sorted().map { "export \($0)=\(quote(e[$0] ?? ""))" }
    lines.append("exec " + argv.map(quote).joined(separator: " "))
    return lines.joined(separator: "\n") + "\n"
  }

  /// A new file name for one start of `session`: `launch-<session>-<16 hex>.sh`.
  public static func newPath(in dir: String, session: String) -> String {
    dir + "/launch-\(session)-" + (0..<8).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() + ".sh"
  }

  /// Removes the files of earlier starts of `session` a pane never got to read (it died first, or the app did). One start
  /// per session at a time; the exact name pattern, so `t-a` never removes `t-a-b`'s.
  public static func removeStale(in dir: String, session: String, except keep: String) {
    let prefix = "launch-\(session)-"
    for f in (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    where f.hasPrefix(prefix) && f.hasSuffix(".sh") && dir + "/" + f != keep {
      let hex = f.dropFirst(prefix.count).dropLast(3)
      if hex.count == 16, hex.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) { unlink(dir + "/" + f) }
    }
  }

  /// What a tmux client (and so a server it starts) runs with: the plain basics, never a token or a setting of one launch.
  public static func serverBasics(_ env: [String: String]) -> [String: String] {
    let keep: Set<String> = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "XDG_RUNTIME_DIR"]
    return env.filter { keep.contains($0.key) || $0.key.hasPrefix("LC_") }
  }

  /// What tmux runs. Nothing in it but the file's path.
  public static func tmuxArgv(_ path: String) -> [String] { ["/usr/bin/env", "-i", "/bin/sh", path] }

  /// Writes `script` to a new file at `path` (0600). Its folder is made 0700, or narrowed to 0700 when it is ours; one that
  /// is a symlink or someone else's is refused. Nothing is left at `path` when this throws.
  public static func create(at path: String, script: String) throws {
    let dir = (path as NSString).deletingLastPathComponent
    do {
      try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
      throw Failure.io("can't make \(dir): \(error)")
    }
    var st = stat()
    guard lstat(dir, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid() else {
      throw Failure.io("\(dir) is not a folder of ours")
    }
    if st.st_mode & 0o777 != 0o700, chmod(dir, 0o700) != 0 { throw Failure.io("can't make \(dir) private") }
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw Failure.io("can't create \(path): \(String(cString: strerror(errno)))") }
    let bytes = Array(script.utf8)
    var off = 0
    while off < bytes.count {
      let n = bytes.withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress! + off, bytes.count - off) }
      if n <= 0 { break }
      off += n
    }
    let ok = off == bytes.count && fchmod(fd, 0o600) == 0
    close(fd)
    guard ok else {
      unlink(path)
      throw Failure.io("can't write \(path)")
    }
  }
}
