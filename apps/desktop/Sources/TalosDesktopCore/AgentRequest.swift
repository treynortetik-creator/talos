import Foundation

/// `$TALOS_APP_HOME/agent-request.json`: the bridge writes it when the owner taps "Restart agent" on the phone (mode 0600,
/// written atomically). Restart is the only action: restore stays in the Mac menu and Terminal. Anything that does not
/// match the format exactly is not a request.
public struct AgentRequest: Equatable, Sendable {
  public static let fileName = "agent-request.json"
  /// A real request is about a hundred bytes; a bigger file is not one, and is never read whole.
  public static let maxBytes = 4096
  public static let maxIdLength = 64
  /// A request older than this (five minutes, by its own `ts`) is ignored: the owner tapped it long ago.
  public static let maxAgeMs: Double = 300_000
  /// So is one dated this far ahead: a forged `ts` must not keep a request alive for good.
  public static let maxFutureMs: Double = 60_000

  public var controlId: String
  /// Unix milliseconds, when the bridge wrote it.
  public var ts: Double

  /// Strict about the four fields (the action must be `restart`), tolerant of extra ones. Nil for anything else; never throws and never guesses.
  public static func parse(_ data: Data) -> AgentRequest? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      o["action"] as? String == "restart", let id = o["control_id"] as? String, isValidId(id),
      let ts = o["ts"] as? NSNumber, CFGetTypeID(ts) != CFBooleanGetTypeID(), ts.doubleValue.isFinite
    else { return nil }
    return AgentRequest(controlId: id, ts: ts.doubleValue)
  }

  /// `^[A-Za-z0-9_-]{1,64}$`. The id is only compared with the one last acted on, but the file is one the agent can write, so
  /// nothing that could mean something to a shell or a path gets through.
  static func isValidId(_ s: String) -> Bool {
    let u = s.utf8
    return (1...maxIdLength).contains(u.count)
      && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d }
  }

  public func isStale(nowMs: Double) -> Bool { nowMs - ts > Self.maxAgeMs || ts - nowMs > Self.maxFutureMs }
}

/// What is at the request path right now.
public enum AgentRequestFile: Equatable, Sendable {
  case absent
  /// A file is there but is not a request: bad JSON, wrong fields, a link, not a regular file, too big, unreadable.
  case invalid
  case request(AgentRequest)

  /// One `open` that refuses a link, then `fstat`: a missing file costs a failed `open`, and a link, a pipe or a huge file is
  /// never read.
  public static func read(path: String) -> AgentRequestFile {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if fd < 0 { return errno == ENOENT ? .absent : .invalid }
    defer { Darwin.close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= AgentRequest.maxBytes else { return .invalid }
    var buf = [UInt8](repeating: 0, count: AgentRequest.maxBytes + 1)
    let n = Darwin.read(fd, &buf, buf.count)
    guard n >= 0, n <= AgentRequest.maxBytes, let r = AgentRequest.parse(Data(buf[0..<n])) else { return .invalid }
    return .request(r)
  }

  /// The same file as `seen`: both unusable, or both requests with one control_id. A newer request written since is not.
  static func isSame(_ a: AgentRequestFile, _ b: AgentRequestFile) -> Bool {
    switch (a, b) {
    case (.invalid, .invalid): return true
    case (.request(let x), .request(let y)): return x.controlId == y.controlId
    default: return false
    }
  }

  /// Deletes the file only if it is still the one `seen`, so a request written after we read is not lost. True when deleted.
  @discardableResult
  public static func clear(path: String, ifStill seen: AgentRequestFile) -> Bool {
    guard seen != .absent, isSame(read(path: path), seen) else { return false }
    return unlink(path) == 0
  }
}
