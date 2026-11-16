import Foundation

/// A settings file as Claude Code reads it. Claude Code parses with JavaScript's `JSON.parse`, where the LAST of two keys with the same
/// name wins; Foundation keeps the first. A file that names `permissions` twice would then give this app one mode and deny list and
/// Claude Code another, and the privilege ceiling would be read from the one main does not run under. This reads the same document
/// with the last key winning, at every depth. Text Foundation does not take as JSON is not read at all, and everything it does take
/// is read: this never turns a file Claude Code reads into one that says nothing.
public enum SettingsJSON {
  public static func object(_ data: Data) -> [String: Any]? {
    guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else { return nil }
    var p = Parser(bytes: [UInt8](data))
    if p.bytes.starts(with: [0xEF, 0xBB, 0xBF]) { p.i = 3 }
    guard let v = p.value(depth: 0) else { return nil }
    p.space()
    guard p.i == p.bytes.count else { return nil }
    return v as? [String: Any]
  }

  struct Parser {
    var bytes: [UInt8]
    var i = 0
    /// Past Foundation's own limit (512), which has already let the document through: never the reason a file is not read.
    static let maxDepth = 1024

    mutating func space() {
      while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
    }

    mutating func value(depth: Int) -> Any? {
      space()
      guard i < bytes.count, depth <= Self.maxDepth else { return nil }
      switch bytes[i] {
      case UInt8(ascii: "{"): return object(depth: depth)
      case UInt8(ascii: "["): return array(depth: depth)
      case UInt8(ascii: "\""): return string()
      case UInt8(ascii: "t"): return word("true", true)
      case UInt8(ascii: "f"): return word("false", false)
      case UInt8(ascii: "n"): return word("null", NSNull())
      default: return number()
      }
    }

    mutating func word(_ w: String, _ v: Any) -> Any? {
      let u = [UInt8](w.utf8)
      guard i + u.count <= bytes.count, Array(bytes[i..<i + u.count]) == u else { return nil }
      i += u.count
      return v
    }

    mutating func number() -> Any? {
      let start = i
      while i < bytes.count, "+-0123456789.eE".utf8.contains(bytes[i]) { i += 1 }
      guard i > start, let d = Double(String(decoding: bytes[start..<i], as: UTF8.self)) else { return nil }
      return NSNumber(value: d)
    }

    /// The text between the quotes, with its escapes read by Foundation (one fragment at a time).
    mutating func string() -> String? {
      let start = i
      i += 1
      while i < bytes.count, bytes[i] != UInt8(ascii: "\"") {
        i += bytes[i] == UInt8(ascii: "\\") ? 2 : 1
      }
      guard i < bytes.count else { return nil }
      i += 1
      let raw = bytes[start..<i]
      // text Foundation cannot give back on its own (half of a surrogate pair) is kept as written: it is still a string
      return ((try? JSONSerialization.jsonObject(with: Data(raw), options: [.fragmentsAllowed])) as? String)
        ?? String(decoding: raw.dropFirst().dropLast(), as: UTF8.self)
    }

    mutating func array(depth: Int) -> Any? {
      i += 1
      var out: [Any] = []
      space()
      if i < bytes.count, bytes[i] == UInt8(ascii: "]") {
        i += 1
        return out
      }
      while true {
        guard let v = value(depth: depth + 1) else { return nil }
        out.append(v)
        space()
        guard i < bytes.count else { return nil }
        if bytes[i] == UInt8(ascii: "]") {
          i += 1
          return out
        }
        guard bytes[i] == UInt8(ascii: ",") else { return nil }
        i += 1
      }
    }

    mutating func object(depth: Int) -> Any? {
      i += 1
      var out: [String: Any] = [:]
      space()
      if i < bytes.count, bytes[i] == UInt8(ascii: "}") {
        i += 1
        return out
      }
      while true {
        space()
        guard i < bytes.count, bytes[i] == UInt8(ascii: "\""), let k = string() else { return nil }
        space()
        guard i < bytes.count, bytes[i] == UInt8(ascii: ":") else { return nil }
        i += 1
        guard let v = value(depth: depth + 1) else { return nil }
        out[k] = v  // the last one wins, as in JSON.parse
        space()
        guard i < bytes.count else { return nil }
        if bytes[i] == UInt8(ascii: "}") {
          i += 1
          return out
        }
        guard bytes[i] == UInt8(ascii: ",") else { return nil }
        i += 1
      }
    }
  }
}
