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

/// One pairing run: hands the code to the page exactly once, and never when the output was ambiguous.
public struct PairingSession: Sendable {
  public private(set) var output: EnrollOutput
  public private(set) var sent = false

  public init(relay: RelayOrigin?) { output = EnrollOutput(relay: relay) }

  /// The code to send to the page now, or nil (nothing yet, already sent, or two different links were seen).
  public mutating func update(screen: String) -> String? {
    output.replace(screen: screen)
    guard !sent, case .code(let c) = output.result else { return nil }
    sent = true
    return c
  }

  public var ambiguous: Bool { output.result == .ambiguous }
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
