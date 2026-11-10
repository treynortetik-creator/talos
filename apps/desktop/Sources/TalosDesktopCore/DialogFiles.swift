import Foundation
import Security

/// The files of the needs-you prompts: `dialog` in `workers.json`, the bridge's answer, the Mac's result and the bridge's card file
/// (docs/OPTION-C.md "Needs-you prompts"; the contract is packages/protocol/src/dialog-files.ts, part A2). Small, fixed shapes; everything
/// the bridge writes is read with the hardening of `agent-request.json`, and none of it is believed: an answer proves itself (DialogProof.swift).

/// A known dialog on a worker's pane that a tap can answer: the entry's `dialog` in `workers.json`, present while it is on screen. A new `id`
/// per sighting; the card the bridge makes from it lives until `expires_at`.
public struct DialogOffer: Codable, Equatable, Sendable {
  public var id: String
  public var kind: DialogReader.Kind
  public var subject: String?
  public var options: [String]
  public var cursor: Int?
  /// With a `devChannels` offer: which pieces of Main's start command differ from the one the owner last confirmed (`folder`, `program`,
  /// `flags`, `env`; names only, never a value). Empty = changed (or never confirmed) but the Mac cannot say what. nil = not a launch change.
  public var launch_changed: [String]?
  public var seen_at: String
  public var expires_at: String

  public static let launchPieces: Set<String> = ["folder", "program", "flags", "env"]

  public init(
    id: String, kind: DialogReader.Kind, subject: String?, options: [String], cursor: Int?, launch_changed: [String]? = nil, seen_at: String,
    expires_at: String
  ) {
    self.id = id
    self.kind = kind
    self.subject = subject
    self.options = options
    self.cursor = cursor
    self.launch_changed = launch_changed
    self.seen_at = seen_at
    self.expires_at = expires_at
  }

  /// Explicit nulls for the two that may be absent, as the schema writes them.
  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(kind, forKey: .kind)
    try c.encode(subject, forKey: .subject)
    try c.encode(options, forKey: .options)
    try c.encode(cursor, forKey: .cursor)
    try c.encodeIfPresent(launch_changed, forKey: .launch_changed)
    try c.encode(seen_at, forKey: .seen_at)
    try c.encode(expires_at, forKey: .expires_at)
  }

  public var dialog: DialogReader.Dialog { .init(kind: kind, subject: subject, options: options, cursor: cursor) }

  /// Whether a record read back from disk fits the contract: the id's form, the option count and lengths, a cursor that is a row, and times
  /// that parse. workers.json can be edited while the app is down; what does not fit is no dialog.
  public var isValid: Bool {
    let u = id.utf8
    guard (22...64).contains(u.count), u.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d }),
      options.count <= 6, kind == .login ? options.isEmpty : !options.isEmpty,
      options.allSatisfy({ (1...120).contains($0.count) }), subject.map({ (1...500).contains($0.count) }) ?? true,
      cursor.map({ options.indices.contains($0) }) ?? true, ISOTime.parse(seen_at) != nil, ISOTime.parse(expires_at) != nil,
      launch_changed.map({ $0.count <= 4 && $0.allSatisfy(Self.launchPieces.contains) }) ?? true
    else { return false }
    return true
  }

  /// 16 random bytes from the system's generator, base64url: 128 bits, not guessable and not a time.
  public static func newId() -> String {
    var bytes = [UInt8](repeating: 0, count: 16)
    if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
      for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }  // the same system generator
    }
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}

/// A small regular file the other side writes, read the way `AgentRequestFile` reads its file: one `open` that refuses a link, then `fstat`,
/// so a missing file costs one failed call and a link, a pipe, a folder or a big file is never read.
enum SmallFile {
  case absent
  case invalid
  case data(Data)

  static func read(path: String, maxBytes: Int) -> SmallFile {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    if fd < 0 { return errno == ENOENT ? .absent : .invalid }
    defer { Darwin.close(fd) }
    var st = stat()
    guard fstat(fd, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, st.st_size <= maxBytes else { return .invalid }
    var buf = [UInt8](repeating: 0, count: maxBytes + 1)
    let n = Darwin.read(fd, &buf, buf.count)
    guard n >= 0, n <= maxBytes else { return .invalid }
    return .data(Data(buf[0..<n]))
  }
}

public enum SafePath {
  /// A folder that is a folder itself: not a link to one (`lstat`). A thread's `workers/<id>` folder that is a link is somewhere else.
  public static func isRealFolder(_ path: String) -> Bool {
    var st = stat()
    return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
  }
}

/// The owner's own tap, carried by the answer: the exact text the owner's device signed (`signed`, the canonical `card.resolve` frame
/// without its signature), the signature, the device, and the card's binding the frame's `payload_hash` commits to.
public struct DialogProof: Equatable, Sendable {
  public var signed: String
  public var osig: String
  public var deviceId: String
  public var binding: String
}

/// `workers/<id>/dialog-answer.json` (v 2): a tap on a card, with its proof. `choice`/`action`, `label` and `by` are for display and the log;
/// the Mac presses from what the proof says. Strict: exactly the contract's fields and no others; nil for anything else, never a guess.
public struct DialogAnswerRequest: Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    case choose(Int)
    case open
  }

  public static let fileName = "dialog-answer.json"
  public static let maxBytes = 16 * 1024
  /// As an agent request: older than five minutes by its own time is not acted on, and neither is one dated this far ahead.
  public static let maxAgeMs: Double = 300_000
  public static let maxFutureMs: Double = 60_000

  public var dialogId: String
  public var action: Action
  public var label: String
  public var by: String
  /// Unix milliseconds, from the ISO time in the file.
  public var at: Double
  public var controlId: String
  public var proof: DialogProof

  private static let top: Set<String> = ["v", "dialog_id", "choice", "action", "label", "by", "at", "control_id", "proof"]
  private static let proofKeys: Set<String> = ["signed", "osig", "device_id", "binding"]

  public static func parse(_ data: Data) -> DialogAnswerRequest? {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], Set(o.keys).isSubset(of: top), JSONValue.int(o["v"]) == 2,
      let dialogId = o["dialog_id"] as? String, matches(dialogId, id: 22...64), let controlId = o["control_id"] as? String, matches(controlId, id: 1...64),
      let label = o["label"] as? String, text(label, 1...120), let by = o["by"] as? String, text(by, 1...60),
      let atText = o["at"] as? String, let at = ISOTime.parse(atText), let p = o["proof"] as? [String: Any], Set(p.keys) == proofKeys,
      let signed = p["signed"] as? String, text(signed, 1...4096), let osig = p["osig"] as? String, osig.count == 86, matches(osig, id: 86...86),
      let device = p["device_id"] as? String, isDeviceId(device), let binding = p["binding"] as? String, text(binding, 1...12288)
    else { return nil }
    let action: Action
    switch (o["choice"], o["action"]) {
    case (let c?, nil):
      guard let i = JSONValue.int(c), (0...5).contains(i) else { return nil }
      action = .choose(i)
    case (nil, let a?):
      guard a as? String == "open" else { return nil }
      action = .open
    default:
      return nil
    }
    return DialogAnswerRequest(
      dialogId: dialogId, action: action, label: label, by: by, at: at * 1000, controlId: controlId,
      proof: DialogProof(signed: signed, osig: osig, deviceId: device, binding: binding))
  }

  /// `^[A-Za-z0-9_-]{n}$`.
  private static func matches(_ s: String, id range: ClosedRange<Int>) -> Bool {
    let u = s.utf8
    return range.contains(u.count) && u.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5a) || ($0 >= 0x61 && $0 <= 0x7a) || $0 == 0x5f || $0 == 0x2d }
  }

  /// `^d_[a-z2-7]{20}$`.
  static func isDeviceId(_ s: String) -> Bool {
    let u = Array(s.utf8)
    return u.count == 22 && u[0] == 0x64 && u[1] == 0x5f && u[2...].allSatisfy { ($0 >= 0x61 && $0 <= 0x7a) || ($0 >= 0x32 && $0 <= 0x37) }
  }

  private static func text(_ s: String, _ range: ClosedRange<Int>) -> Bool { range.contains(s.count) && !s.unicodeScalars.contains { $0.value < 0x20 && $0 != "\n" && $0 != "\t" } }

  public func isStale(nowMs: Double) -> Bool { nowMs - at > Self.maxAgeMs || at - nowMs > Self.maxFutureMs }
}

public enum DialogAnswerFile: Equatable, Sendable {
  case absent
  /// A file is there but is not an answer.
  case invalid
  case answer(DialogAnswerRequest)

  public static func read(path: String) -> DialogAnswerFile {
    switch SmallFile.read(path: path, maxBytes: DialogAnswerRequest.maxBytes) {
    case .absent: return .absent
    case .invalid: return .invalid
    case .data(let d): return DialogAnswerRequest.parse(d).map { .answer($0) } ?? .invalid
    }
  }
}

/// `workers/<id>/dialog-result.json`: what the Mac did with an answer. The bridge says "pressed" or "nothing pressed" to the card from it.
public enum DialogResult {
  public static let fileName = "dialog-result.json"

  public enum Outcome: String, Sendable { case pressed, nothingPressed = "nothing_pressed", opened }
  /// Why nothing was pressed: the proof did not check out, the screen was not the dialog offered, or the dialog was answered already.
  public enum Reason: String, Sendable { case screenChanged = "screen_changed", alreadyAnswered = "already_answered", unverified }

  public static func encode(
    dialogId: String, controlId: String, outcome: Outcome, choice: Int? = nil, label: String? = nil, reason: Reason? = nil, at: Double
  ) -> Data {
    var o: [String: Any] = ["v": 1, "dialog_id": dialogId, "control_id": controlId, "source": "card", "outcome": outcome.rawValue, "at": ISOTime.string(at)]
    if let choice { o["choice"] = choice }
    if let label { o["label"] = label }
    if let reason { o["reason"] = reason.rawValue }
    return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
  }

  /// What the Mac writes for a popup press: `source: mac`, no control id. Only a press or an open: the schema has no mac `nothing_pressed`, so
  /// that gives no data at all and nothing is written.
  public static func encodeMac(dialogId: String, outcome: Outcome, choice: Int? = nil, label: String? = nil, at: Double) -> Data {
    guard outcome != .nothingPressed else { return Data() }
    var o: [String: Any] = ["v": 1, "dialog_id": dialogId, "source": "mac", "outcome": outcome.rawValue, "at": ISOTime.string(at)]
    if let choice { o["choice"] = choice }
    if let label { o["label"] = label }
    return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
  }

  /// The control id the last result was written for (nil when none can be read).
  public static func controlId(path: String) -> String? {
    guard case .data(let d) = SmallFile.read(path: path, maxBytes: 4096), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    return o["control_id"] as? String
  }
}

/// `workers/<id>/dialog-card.json`: the bridge has a card for this dialog (any status). While the file names a dialog, the Mac posts no line for it.
public enum DialogCardAck {
  public static let fileName = "dialog-card.json"
  private static let statuses: Set<String> = ["waiting", "answered", "closed", "expired"]

  /// Who answered the card for `dialogId`, when the card file says it was answered (display only: "Answered on <device>" in the popup). nil for
  /// any other status, another dialog, or a file that does not fit.
  public static func answered(path: String, dialogId: String) -> String? {
    guard case .data(let d) = SmallFile.read(path: path, maxBytes: 4096), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      JSONValue.int(o["v"]) == 1, ExactText.equal(o["dialog_id"] as? String, dialogId), o["status"] as? String == "answered",
      let by = o["by"] as? String, !by.isEmpty, by.count <= 60
    else { return nil }
    return by
  }

  public static func dialogId(path: String) -> String? {
    guard case .data(let d) = SmallFile.read(path: path, maxBytes: 4096), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
      JSONValue.int(o["v"]) == 1, let id = o["dialog_id"] as? String, (22...64).contains(id.utf8.count),
      let card = o["card_id"] as? String, !card.isEmpty, card.count <= 64
    else { return nil }
    if let s = o["status"], !(s is NSNull), !statuses.contains(s as? String ?? "") { return nil }
    return id
  }
}
