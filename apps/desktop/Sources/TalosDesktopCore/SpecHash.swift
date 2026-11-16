import CryptoKit
import Foundation

/// The Mac's twin of packages/protocol/src/spec-hash.ts and canonical.ts (restart on update): a thread session's launch spec as JSON,
/// written in RFC 8785 form (JCS) and hashed. Both supervisors use the same procedure and the same vectors
/// (packages/protocol/fixtures/spec-hash/vectors.json); a hash is only ever compared with one made on the same machine.
///
/// Strings are kept as UTF-16 code units, as JavaScript holds them, so the vectors' lone surrogates can be read and refused, and keys
/// sort by code unit as RFC 8785 says. Anything RFC 8785 cannot write (a lone surrogate, NaN, an infinity) throws: it is never hashed as
/// something else.
public indirect enum SpecJSON: Equatable, Sendable {
  case null
  case bool(Bool)
  case number(Double)
  case string([UInt16])
  case array([SpecJSON])
  case object([Member])

  public struct Member: Equatable, Sendable {
    public var key: [UInt16]
    public var value: SpecJSON
    public init(_ key: String, _ value: SpecJSON) {
      self.key = Array(key.utf16)
      self.value = value
    }
    public init(units: [UInt16], _ value: SpecJSON) {
      self.key = units
      self.value = value
    }
  }

  public static func str(_ s: String) -> SpecJSON { .string(Array(s.utf16)) }
  /// An object from a dictionary of strings (env, files).
  public static func strings(_ d: [String: String]) -> SpecJSON { .object(d.map { Member($0.key, .str($0.value)) }) }

  public enum Failure: Error, Equatable, Sendable {
    case loneSurrogate
    case notFinite
    case parse(String)
  }
}

/// RFC 8785 JSON Canonicalization Scheme over `SpecJSON`.
public enum JCS {
  public static func text(_ v: SpecJSON) throws -> String {
    var out: [UInt16] = []
    try write(v, into: &out)
    return String(decoding: out, as: UTF16.self)  // no lone surrogate is left: `write` refused them
  }

  static func write(_ v: SpecJSON, into out: inout [UInt16]) throws {
    switch v {
    case .null: out += "null".utf16
    case .bool(let b): out += (b ? "true" : "false").utf16
    case .number(let d): out += try number(d).utf16
    case .string(let s): try string(s, into: &out)
    case .array(let items):
      out.append(0x5B)
      for (i, item) in items.enumerated() {
        if i > 0 { out.append(0x2C) }
        try write(item, into: &out)
      }
      out.append(0x5D)
    case .object(let members):
      out.append(0x7B)
      // by UTF-16 code unit; the last of a repeated key wins, as JSON.parse keeps it
      var byKey: [[UInt16]: SpecJSON] = [:]
      for m in members { byKey[m.key] = m.value }
      for (i, key) in byKey.keys.sorted(by: { $0.lexicographicallyPrecedes($1) }).enumerated() {
        if i > 0 { out.append(0x2C) }
        try string(key, into: &out)
        out.append(0x3A)
        try write(byKey[key] ?? .null, into: &out)
      }
      out.append(0x7D)
    }
  }

  /// A JSON string as JSON.stringify writes it: the two-character escapes, `\u00xx` (lower case) for the other controls, and
  /// everything else as it is. A surrogate not in a pair throws.
  static func string(_ s: [UInt16], into out: inout [UInt16]) throws {
    out.append(0x22)
    var i = 0
    while i < s.count {
      let u = s[i]
      switch u {
      case 0x22: out += "\\\"".utf16
      case 0x5C: out += "\\\\".utf16
      case 0x08: out += "\\b".utf16
      case 0x0C: out += "\\f".utf16
      case 0x0A: out += "\\n".utf16
      case 0x0D: out += "\\r".utf16
      case 0x09: out += "\\t".utf16
      case 0..<0x20: out += String(format: "\\u%04x", u).utf16
      case 0xD800...0xDBFF:
        guard i + 1 < s.count, (0xDC00...0xDFFF).contains(s[i + 1]) else { throw SpecJSON.Failure.loneSurrogate }
        out.append(u)
        out.append(s[i + 1])
        i += 1
      case 0xDC00...0xDFFF: throw SpecJSON.Failure.loneSurrogate
      default: out.append(u)
      }
      i += 1
    }
    out.append(0x22)
  }

  /// A number as ECMAScript's Number::toString writes it (RFC 8785 3.2.2.3), from Swift's shortest round-trip digits.
  public static func number(_ d: Double) throws -> String {
    guard d.isFinite else { throw SpecJSON.Failure.notFinite }
    if d == 0 { return "0" }  // -0 too
    let sign = d < 0 ? "-" : ""
    let text = abs(d).description  // "1e-07", "9.007199254740992e+15", "100.0", "0.002"
    let parts = text.split(separator: "e", maxSplits: 1)
    let exp = parts.count == 2 ? Int(parts[1]) ?? 0 : 0
    let mantissa = parts[0].split(separator: ".", maxSplits: 1)
    var digits = Array(mantissa[0]) + (mantissa.count == 2 ? Array(mantissa[1]) : [])
    var point = mantissa[0].count
    while digits.first == "0" {
      digits.removeFirst()
      point -= 1
    }
    while digits.last == "0" { digits.removeLast() }
    let k = digits.count
    let n = point + exp  // the value is 0.<digits> × 10^n
    let s = String(digits)
    if k <= n, n <= 21 { return sign + s + String(repeating: "0", count: n - k) }
    if 0 < n, n <= 21 { return sign + String(digits[0..<n]) + "." + String(digits[n...]) }
    if -6 < n, n <= 0 { return sign + "0." + String(repeating: "0", count: -n) + s }
    let e = n - 1
    let es = (e < 0 ? "-" : "+") + String(abs(e))
    return sign + (k == 1 ? s : String(digits[0]) + "." + String(digits[1...])) + "e" + es
  }
}

extension SpecJSON {
  /// Parses JSON text, keeping strings as UTF-16 code units (a `\ud800` escape stays the lone unit it names). Depth is bounded.
  public static func parse(_ data: Data) throws -> SpecJSON {
    var p = Parser(bytes: Array(data))
    p.space()
    let v = try p.value(depth: 0)
    p.space()
    guard p.i == p.bytes.count else { throw Failure.parse("trailing text at \(p.i)") }
    return v
  }

  struct Parser {
    let bytes: [UInt8]
    var i = 0
    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func space() {
      while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
    }

    func no(_ why: String) -> Failure { .parse("\(why) at \(i)") }

    mutating func literal(_ word: String, _ v: SpecJSON) throws -> SpecJSON {
      let w = Array(word.utf8)
      guard i + w.count <= bytes.count, Array(bytes[i..<(i + w.count)]) == w else { throw no("bad literal") }
      i += w.count
      return v
    }

    mutating func value(depth: Int) throws -> SpecJSON {
      guard depth < 64 else { throw no("too deep") }
      guard i < bytes.count else { throw no("end of text") }
      switch bytes[i] {
      case UInt8(ascii: "n"): return try literal("null", .null)
      case UInt8(ascii: "t"): return try literal("true", .bool(true))
      case UInt8(ascii: "f"): return try literal("false", .bool(false))
      case UInt8(ascii: "\""): return .string(try string())
      case UInt8(ascii: "["):
        i += 1
        var items: [SpecJSON] = []
        space()
        if i < bytes.count, bytes[i] == UInt8(ascii: "]") {
          i += 1
          return .array(items)
        }
        while true {
          space()
          items.append(try value(depth: depth + 1))
          space()
          guard i < bytes.count else { throw no("end of text") }
          if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
          guard bytes[i] == UInt8(ascii: "]") else { throw no("expected , or ]") }
          i += 1
          return .array(items)
        }
      case UInt8(ascii: "{"):
        i += 1
        var members: [Member] = []
        space()
        if i < bytes.count, bytes[i] == UInt8(ascii: "}") {
          i += 1
          return .object(members)
        }
        while true {
          space()
          guard i < bytes.count, bytes[i] == UInt8(ascii: "\"") else { throw no("expected a key") }
          let k = try string()
          space()
          guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { throw no("expected :") }
          i += 1
          space()
          members.append(Member(units: k, try value(depth: depth + 1)))
          space()
          guard i < bytes.count else { throw no("end of text") }
          if bytes[i] == UInt8(ascii: ",") { i += 1; continue }
          guard bytes[i] == UInt8(ascii: "}") else { throw no("expected , or }") }
          i += 1
          return .object(members)
        }
      default:
        return try number()
      }
    }

    mutating func number() throws -> SpecJSON {
      let start = i
      while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
      guard i > start, let d = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else { throw no("bad number") }
      return .number(d)
    }

    mutating func string() throws -> [UInt16] {
      i += 1  // the opening quote
      var raw: [UInt8] = []
      var out: [UInt16] = []
      func flush() { out += String(decoding: raw, as: UTF8.self).utf16; raw = [] }
      while i < bytes.count {
        let b = bytes[i]
        if b == UInt8(ascii: "\"") {
          i += 1
          flush()
          return out
        }
        guard b >= 0x20 else { throw no("control character in a string") }
        guard b == UInt8(ascii: "\\") else {
          raw.append(b)
          i += 1
          continue
        }
        flush()
        guard i + 1 < bytes.count else { throw no("end of text") }
        let e = bytes[i + 1]
        i += 2
        switch e {
        case UInt8(ascii: "\""): out.append(0x22)
        case UInt8(ascii: "\\"): out.append(0x5C)
        case UInt8(ascii: "/"): out.append(0x2F)
        case UInt8(ascii: "b"): out.append(0x08)
        case UInt8(ascii: "f"): out.append(0x0C)
        case UInt8(ascii: "n"): out.append(0x0A)
        case UInt8(ascii: "r"): out.append(0x0D)
        case UInt8(ascii: "t"): out.append(0x09)
        case UInt8(ascii: "u"):
          guard i + 4 <= bytes.count, let u = UInt16(String(decoding: bytes[i..<(i + 4)], as: UTF8.self), radix: 16) else {
            throw no("bad \\u escape")
          }
          out.append(u)
          i += 4
        default: throw no("bad escape")
        }
      }
      throw no("unterminated string")
    }
  }
}

/// `spec_hash`: "sha256:" + hex(sha256(JCS(spec))), over the UTF-8 bytes of the JCS text.
public enum SpecHash {
  /// What a launch record keeps (protocol `SPEC_HASH_PATTERN`).
  public static func isValid(_ s: String) -> Bool {
    let b = Array(s.utf8)
    guard b.count == 71, s.hasPrefix("sha256:") else { return false }
    return b[7...].allSatisfy { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) }
  }

  public static func hash(_ spec: SpecJSON) throws -> String {
    "sha256:" + hex(Data(try JCS.text(spec).utf8))
  }

  public static func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
