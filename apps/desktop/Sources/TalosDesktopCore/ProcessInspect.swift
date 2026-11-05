import Darwin
import Foundation

/// A read-only look at one process (DESKTOP-SPEC 4.2, 4.7). Live reads use `sysctl` (`KERN_PROC_PID` for pgid, ppid and
/// start time, `KERN_PROCARGS2` for argv and environment) and `proc_pidinfo` for the working directory. Nothing here
/// signals anything.
public struct ProcessSnapshot: Equatable, Sendable {
  public var pid: Int32
  public var ppid: Int32
  public var pgid: Int32
  /// Start time, seconds since 1970 (microsecond precision).
  public var startTime: Double
  public var argv: [String]
  public var env: [String: String]
  public var cwd: String?

  public init(
    pid: Int32, ppid: Int32, pgid: Int32, startTime: Double, argv: [String], env: [String: String] = [:],
    cwd: String? = nil
  ) {
    self.pid = pid
    self.ppid = ppid
    self.pgid = pgid
    self.startTime = startTime
    self.argv = argv
    self.env = env
    self.cwd = cwd
  }

  public var commandLine: String { argv.joined(separator: " ") }
}

/// `ps -p <pid> -o lstart=,command=` under `LC_ALL=C`, split the way the bridge does (lifecycle.ts `psInfo`).
public struct PsInfo: Equatable, Sendable {
  public var lstart: String
  public var command: String
  public init(lstart: String, command: String) {
    self.lstart = lstart
    self.command = command
  }

  public static func parse(_ line: String) -> PsInfo? {
    let l = line.hasSuffix("\n") ? String(line.dropLast()) : line
    guard !l.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    let chars = Array(l)
    let head = String(chars.prefix(24)).trimmingCharacters(in: .whitespaces)
    let tail = chars.count > 24 ? String(chars[24...]).trimmingCharacters(in: .whitespaces) : ""
    return PsInfo(lstart: head, command: tail)
  }
}

public enum ProcessInspect {
  /// Parses a `KERN_PROCARGS2` buffer: `argc` (Int32), the exec path, NUL padding, `argc` argv strings, then the
  /// environment strings until an empty string or the end.
  public static func parseProcArgs2(_ buf: [UInt8]) -> (argv: [String], env: [String: String])? {
    guard buf.count >= 4 else { return nil }
    let argc = Int(buf[0]) | Int(buf[1]) << 8 | Int(buf[2]) << 16 | Int(buf[3]) << 24
    guard argc >= 0, argc < 100_000 else { return nil }
    var i = 4
    while i < buf.count, buf[i] != 0 { i += 1 }  // exec path
    while i < buf.count, buf[i] == 0 { i += 1 }  // padding
    func next() -> String? {
      guard i < buf.count else { return nil }
      let start = i
      while i < buf.count, buf[i] != 0 { i += 1 }
      let s = String(decoding: buf[start..<i], as: UTF8.self)
      i += 1
      return s
    }
    var argv: [String] = []
    for _ in 0..<argc {
      guard let s = next() else { return nil }
      argv.append(s)
    }
    // Some layouts (a script exec'd through its #! line) leave NUL padding between argv and the environment.
    while i < buf.count, buf[i] == 0 { i += 1 }
    var env: [String: String] = [:]
    while let s = next() {
      if s.isEmpty { break }
      if let eq = s.firstIndex(of: "="), eq != s.startIndex {
        env[String(s[..<eq])] = String(s[s.index(after: eq)...])
      }
    }
    return (argv, env)
  }

  /// pid, ppid, pgid and start time. nil when the process is gone.
  public static func basic(_ pid: Int32) -> ProcessSnapshot? {
    guard pid > 0 else { return nil }
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else { return nil }
    let tv = info.kp_proc.p_un.__p_starttime
    let start = Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000
    return ProcessSnapshot(
      pid: pid, ppid: info.kp_eproc.e_ppid, pgid: info.kp_eproc.e_pgid, startTime: start, argv: [])
  }

  /// Adds argv, environment (same-user processes only) and cwd. Fields that can't be read stay empty.
  public static func snapshot(_ pid: Int32) -> ProcessSnapshot? {
    guard var s = basic(pid) else { return nil }
    if let (argv, env) = procArgs(pid) {
      s.argv = argv
      s.env = env
    }
    s.cwd = cwd(pid)
    return s
  }

  static func procArgs(_ pid: Int32) -> (argv: [String], env: [String: String])? {
    var mib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    var argmax: Int32 = 0
    var size = MemoryLayout<Int32>.size
    guard sysctl(&mib, 2, &argmax, &size, nil, 0) == 0, argmax > 0 else { return nil }
    var buf = [UInt8](repeating: 0, count: Int(argmax))
    var len = Int(argmax)
    var mib2: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    guard sysctl(&mib2, 3, &buf, &len, nil, 0) == 0 else { return nil }
    return parseProcArgs2(Array(buf.prefix(len)))
  }

  static func cwd(_ pid: Int32) -> String? {
    var info = proc_vnodepathinfo()
    let size = Int32(MemoryLayout<proc_vnodepathinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &info, size) == size else { return nil }
    return withUnsafePointer(to: &info.pvi_cdir.vip_path) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXPATHLEN)) { String(cString: $0) }
    }
  }

  /// `kill(pid, 0)`: alive (or alive but not ours, EPERM).
  public static func alive(_ pid: Int32) -> Bool {
    guard pid > 0 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
  }

  /// `killpg(pgid, 0)`: some member of the group is alive.
  public static func groupAlive(_ pgid: Int32) -> Bool {
    guard pgid > 1 else { return false }
    return killpg(pgid, 0) == 0 || errno == EPERM
  }
}
