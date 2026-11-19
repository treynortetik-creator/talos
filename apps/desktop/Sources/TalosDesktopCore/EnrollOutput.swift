import Foundation

/// Reads what `talos-app enroll --label "Mac app"` prints (apps/bridge/src/cli-main.ts cmdEnroll):
///
///     Open this link on the device you want to add (it works once, for 10 minutes):
///     https://<relay>/enroll#<code>
///     Waiting for the device… (Ctrl-C to stop; …)
///
/// then, once the page registers the device, `Pin "Mac app" [four words]? [y/N]` for the owner to answer in the pane.
public struct EnrollOutput: Sendable {
  public enum Result: Equatable, Sendable {
    case none
    case code(String)
    /// More than one enrollment link in the output: sends nothing (a stale or mixed-up pane must not pair the wrong code).
    case ambiguous
  }

  private var buffer = ""
  private var seen = Set<String>()
  public private(set) var result: Result = .none
  public let relay: RelayOrigin?

  public init(relay: RelayOrigin?) { self.relay = relay }

  /// Feed raw pty bytes as text. Escape sequences are stripped; a link split across chunks is joined.
  public mutating func feed(_ chunk: String) {
    buffer += EnrollOutput.stripEscapes(chunk)
    if buffer.count > 20_000 { buffer = String(buffer.suffix(8_000)) }
    scan()
  }

  /// Feed the whole terminal screen (rows already joined where the terminal wrapped a long link). Replaces the buffer,
  /// keeps what was already seen, so reading the same screen again changes nothing.
  public mutating func replace(screen: String) {
    buffer = EnrollOutput.stripEscapes(screen)
    scan()
  }

  private mutating func scan() {
    for raw in buffer.split(whereSeparator: \.isNewline) {
      let line = String(raw).trimmingCharacters(in: .whitespaces)
      guard let r = line.range(of: "/enroll#") else { continue }
      // the link must start the line: scheme://host[:port]/enroll#<code>
      let head = String(line[..<r.lowerBound])
      let tail = String(line[r.upperBound...])
      guard let origin = RelayOrigin(head), let code = EnrollCode.normalize(tail) else { continue }
      if let relay, origin != relay { continue }  // a link for another relay is not ours
      seen.insert(code)
    }
    if seen.count > 1 { result = .ambiguous } else if let c = seen.first, result == .none { result = .code(c) }
  }

  public static func stripEscapes(_ s: String) -> String {
    var out = ""
    var it = s.unicodeScalars.makeIterator()
    while let c = it.next() {
      if c == "\u{1B}" {
        guard let n = it.next() else { break }
        if n == "[" {
          while let x = it.next() { if (0x40...0x7E).contains(x.value) { break } }
        } else if n == "]" {
          while let x = it.next() { if x == "\u{07}" { break } }
        }
        continue
      }
      if c == "\r" { out.unicodeScalars.append("\n"); continue }
      if c.value < 0x20 && c != "\n" && c != "\t" { continue }
      out.unicodeScalars.append(c)
    }
    return out
  }
}

/// `talos-app devices` output: `<id>  pinned  <name>  [words]  <time>` or `<id>  REVOKED  <name> …`.
public enum DevicesList {
  public struct Entry: Equatable, Sendable {
    public var id: String
    public var name: String
    public var pinned: Bool
  }

  public static func parse(_ text: String) -> [Entry] {
    var out: [Entry] = []
    for raw in text.split(whereSeparator: \.isNewline) {
      let cols = raw.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
      guard cols.count == 3, isDeviceId(String(cols[0])) else { continue }
      let state = cols[1]
      guard state == "pinned" || state == "REVOKED" else { continue }
      var rest = String(cols[2]).trimmingCharacters(in: .whitespaces)
      if let b = rest.range(of: "  [") { rest = String(rest[..<b.lowerBound]) }
      out.append(Entry(id: String(cols[0]), name: rest.trimmingCharacters(in: .whitespaces), pinned: state == "pinned"))
    }
    return out
  }

  /// `^d_[a-z2-7]{20}$` (packages/protocol/src/ids.ts DeviceId): the only shape that ever reaches an argv.
  public static func isDeviceId(_ s: String) -> Bool {
    guard s.hasPrefix("d_"), s.count == 22 else { return false }
    return s.dropFirst(2).allSatisfy { ("a"..."z").contains($0) || ("2"..."7").contains($0) }
  }

  /// Ids "Forget this Mac" revokes: the live devices this app named "Mac app". Never anything else.
  public static func macAppIds(_ entries: [Entry], name: String = "Mac app") -> [String] {
    entries.filter { $0.pinned && $0.name == name }.map(\.id)
  }
}

/// The question `talos-app enroll` asks once the device has used the link: `Pin "Mac app" [four words]? [y/N] `
/// (apps/bridge/src/enroll-cli.ts promptPending). Read from the process's own output, nowhere else.
public enum PinPrompt: Equatable, Sendable {
  /// Nothing like the question yet.
  case none
  /// The line has started but is not whole (no four words, or no `[y/N]` yet): never confirmable.
  case partial
  /// The whole question, for our own device name, with exactly four plain words.
  case ready([String])
  /// The program said the question was withdrawn (another device used the code, or it timed out): nothing to answer.
  case withdrawn
  /// The program already took an answer (typed in the details pane, or ours).
  case answered

  /// The newest `Pin "<name>" [...]` line on the screen decides; what follows it can withdraw or close it.
  public static func read(screen: String, name: String = SignInHelp.label) -> PinPrompt {
    let lines = EnrollOutput.stripEscapes(screen).split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    let head = "Pin \"\(name)\" ["
    guard let at = lines.lastIndex(where: { $0.hasPrefix("Pin \"") }) else { return .none }
    let line = lines[at]
    for after in lines[(at + 1)...] {
      if after.contains("was withdrawn") { return .withdrawn }
      if after.hasPrefix("Answered ") { return .answered }
    }
    guard line.hasPrefix(head) else { return line.hasPrefix("Pin \"") && !line.contains("]") ? .partial : .none }
    // the line may carry the answer typed after the question
    guard let close = line.range(of: "]? [y/N]", range: line.index(line.startIndex, offsetBy: head.count)..<line.endIndex) else {
      return .partial
    }
    let inner = line[line.index(line.startIndex, offsetBy: head.count)..<close.lowerBound]
    let words = inner.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
    // only real PGP words, each from its own list by position (enroll-cli.ts plainWords): anything else is no question of ours
    guard PgpWords.isPlain(words) else { return .none }
    if line[close.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty == false { return .answered }
    return .ready(words)
  }
}

/// One pairing run: hands the code to the page exactly once, and never when the output was ambiguous. Then, for the app's own
/// enroll, holds the owner's answer to the four words: confirmable only from a whole question, only once, only after the
/// program's own read delay (an answer sooner than that is a no to it), never after it was withdrawn or timed out.
public struct PairingSession: Sendable {
  public private(set) var output: EnrollOutput
  public private(set) var sent = false
  public private(set) var pin: PinPrompt = .none
  /// When the current four words were first seen whole.
  public private(set) var readySince: Date?
  /// The owner answered (yes or no): once only.
  public private(set) var answered: Bool?

  /// What the bytes to the child are: `y` and Return; `n` and Return.
  public static let yesBytes: [UInt8] = [0x79, 0x0d]
  public static let noBytes: [UInt8] = [0x6e, 0x0d]
  /// The enroll program treats an answer sooner than 0.5 s after the question as a no (enroll-cli.ts READ_MS).
  public static let defaultReadDelay: TimeInterval = 0.7
  /// The program withdraws the question after 60 s (enroll-cli.ts PIN_WAIT_MS); the app stops offering it a little sooner.
  public static let defaultPinWait: TimeInterval = 55

  /// How long the words must have been up before Confirm works, and how long they stay confirmable (tests shorten both).
  public var readDelay = PairingSession.defaultReadDelay
  public var pinWait = PairingSession.defaultPinWait

  public init(relay: RelayOrigin?) { output = EnrollOutput(relay: relay) }

  /// The code to send to the page now, or nil (nothing yet, already sent, or two different links were seen).
  public mutating func update(screen: String, now: Date = Date()) -> String? {
    output.replace(screen: screen)
    var out: String?
    if !sent, case .code(let c) = output.result {
      sent = true
      out = c
    }
    if sent, answered == nil {
      let read = PinPrompt.read(screen: screen)
      if case .ready(let w) = read {
        if case .ready(let old) = pin, old == w {} else { readySince = now }  // new words: the read delay starts again
      } else {
        readySince = nil
      }
      pin = read
    }
    return out
  }

  public var ambiguous: Bool { output.result == .ambiguous }

  /// The four words to show, only while they can be confirmed (whole, not answered, not out of time).
  public func words(now: Date = Date()) -> [String]? {
    guard answered == nil, case .ready(let w) = pin, let since = readySince, now.timeIntervalSince(since) < pinWait else { return nil }
    return w
  }

  /// Whether Confirm does anything now.
  public func confirmable(now: Date = Date()) -> Bool {
    guard words(now: now) != nil, let since = readySince else { return false }
    return now.timeIntervalSince(since) >= readDelay
  }

  /// True exactly once, and only when confirmable: the caller then writes `yesBytes`.
  public mutating func confirm(now: Date = Date()) -> Bool {
    guard confirmable(now: now) else { return false }
    answered = true
    return true
  }

  /// True when a `no` should be written (a whole question is open and nothing was answered yet); marks the run answered either way.
  public mutating func decline() -> Bool {
    defer { if answered == nil { answered = false } }
    guard answered == nil, case .ready = pin else { return false }
    return true
  }
}

public enum ScreenText {
  /// Terminal rows to text; a row the terminal wrapped (`isWrapped`) continues the previous one, so a long link stays whole.
  public static func join(_ rows: [(text: String, wrapped: Bool)]) -> String {
    var out: [String] = []
    for r in rows {
      if r.wrapped, !out.isEmpty { out[out.count - 1] += r.text } else { out.append(r.text) }
    }
    return out.joined(separator: "\n")
  }
}
