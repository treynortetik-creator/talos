import Foundation

/// `$TALOS_APP_HOME/agent-request.json`: the bridge writes it when the owner taps "Restart agent" on the phone, or a session calls
/// `restart_main` (mode 0600, written atomically). Restart is the only action: restore stays in the Mac menu and Terminal. Anything that
/// does not match the format exactly is not a request. Any program running as the owner can write this file, so only a `proof` that
/// `RestartProofCheck` verifies makes a request the owner's.
public struct AgentRequest: Equatable, Sendable {
  public static let fileName = "agent-request.json"
  /// A real request is under 500 bytes with its proof; a bigger file is not one, and is never read whole.
  public static let maxBytes = 4096
  public static let maxIdLength = 64
  /// A request older than this (five minutes, by its own `ts`) is ignored: the owner tapped it long ago.
  public static let maxAgeMs: Double = 300_000
  /// So is one dated this far ahead: a forged `ts` must not keep a request alive for good.
  public static let maxFutureMs: Double = 60_000

  public var controlId: String
  /// Unix milliseconds, when the bridge wrote it.
  public var ts: Double
  /// `proof`: the owner's own signature on the phone's `agent.recover`, as the bridge copied it. What it says is checked by
  /// `RestartProofCheck`; nothing else in the file says who asked (an old file's `asked_by` is not read).
  public var proof: Proof = .none
  /// `by_thread`: the thread whose lead asked (a thread id, `WorkerSpec.isThreadId`), nil for Main's own session or one not read.
  public var byThread: String? = nil
  /// `why`: the asker's reason, made plain here (`plainText`), whatever the bridge already did. Text a session chose: never posted as the
  /// Mac's own row.
  public var why: String? = nil

  public enum Proof: Equatable, Sendable {
    /// No `proof` field: `restart_main`, or the phone's button through a bridge older than the field.
    case none
    /// A `proof` field that is not exactly the shape (`device_id`, `osig`, `signed_b64url`, each in its form): it claims to be the
    /// owner's and cannot be.
    case malformed
    case present(RestartProof)
  }

  /// `signed_b64url`'s cap in characters (`AGENT_REQUEST_SIGNED_MAX`): a real one is about 230.
  public static let signedMax = 1024
  private static let proofKeys: Set<String> = ["device_id", "osig", "signed_b64url"]

  /// `proof` as read: exactly the three fields, a device id, an 86-character base64url signature, and base64url signed bytes.
  static func proof(_ v: Any?) -> Proof {
    guard let v else { return .none }
    guard let p = v as? [String: Any], Set(p.keys) == proofKeys, let device = p["device_id"] as? String, DialogAnswerRequest.isDeviceId(device),
      let osig = p["osig"] as? String, osig.utf8.count == 86, DeviceKeys.base64url(osig)?.count == 64,
      let b64 = p["signed_b64url"] as? String, (1...signedMax).contains(b64.utf8.count), let signed = DeviceKeys.base64url(b64), !signed.isEmpty
    else { return .malformed }
    return .present(RestartProof(deviceId: device, osig: osig, signed: signed))
  }

  /// Strict about the four fields (the action must be `restart`), tolerant of extra ones. Nil for anything else; never throws and never guesses.
  public static func parse(_ data: Data) -> AgentRequest? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], JSONValue.int(o["v"]) == 1,
      o["action"] as? String == "restart", let id = o["control_id"] as? String, isValidId(id),
      let ts = o["ts"] as? NSNumber, CFGetTypeID(ts) != CFBooleanGetTypeID(), ts.doubleValue.isFinite
    else { return nil }
    let by = (o["by_thread"] as? String).flatMap { WorkerSpec.isThreadId($0) ? $0 : nil }
    let why = (o["why"] as? String).map { plainText($0) }.flatMap { $0.isEmpty ? nil : $0 }
    return AgentRequest(controlId: id, ts: ts.doubleValue, proof: proof(o["proof"]), byThread: by, why: why)
  }

  /// `why`, `last.detail` and the like are text from a file a session may have written: letters, digits, spaces and plain punctuation
  /// only (anything else becomes a space: no markup, no tags, no control or invisible characters), one line, at most `max` characters.
  /// The cap counts unicode scalars, not characters (letters that join into one long grapheme cluster would pass a character count
  /// with hundreds of scalars), and the UTF-8 bytes are capped too (`plainTextMaxBytes`).
  public static func plainText(_ s: String, max: Int = 80) -> String {
    let keep = CharacterSet.letters.subtracting(.nonBaseCharacters).union(.decimalDigits).union(CharacterSet(charactersIn: " .,:;!?'()-/"))
    var out: [Unicode.Scalar] = []
    var bytes = 0
    for u in s.unicodeScalars {
      let c: Unicode.Scalar
      if keep.contains(u), u != " " {
        c = u
      } else if let last = out.last, last != " " {
        c = " "
      } else {
        continue
      }
      let n = String(c).utf8.count
      guard out.count < max, bytes + n <= plainTextMaxBytes else { break }
      out.append(c)
      bytes += n
    }
    while out.last == " " { out.removeLast() }
    var v = String.UnicodeScalarView()
    v.append(contentsOf: out)
    return String(v)
  }

  /// `plainText`'s cap in UTF-8 bytes (four per scalar at most, for the 80-scalar cap).
  public static let plainTextMaxBytes = 320

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

  /// The request, when it is one.
  public var request: AgentRequest? {
    if case .request(let r) = self { return r }
    return nil
  }

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
