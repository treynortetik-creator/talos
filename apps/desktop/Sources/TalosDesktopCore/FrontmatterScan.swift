import Foundation

/// The top-level keys of a Markdown file's YAML frontmatter, read the way a YAML parser would, or `unclear` when this reader cannot
/// be certain (R1-3). A subagent, skill or command file whose frontmatter carries hooks, its own MCP servers or its own permission
/// mode refuses a thread session's start (WorkerFolderTree.swift), so a key this reader misses is a hole: it does not guess.
///
/// Claude Code 2.1.322 takes the frontmatter as the text between a first `---` line and the next `---` anywhere after it, and parses
/// it as YAML. This reader takes the text up to the next line that is `---` alone, which holds Claude Code's text and possibly more.
/// What it understands:
///  - a block mapping at any uniform indentation (the first line with content sets it), keys plain, `'single'` or `"double"` quoted
///    (a key with a `\` escape is unclear: `"hoo\x6bs"` is `hooks`);
///  - values: plain, quoted (across lines too), flow collections `[...]` / `{...}` (across lines too), block scalars `|` / `>`;
///  - nested lines (more indented than the top) are read only to follow quotes, flow collections and block scalars through them;
///  - a whole document that is one flow mapping (`{hooks: x, name: y}`).
/// Unclear, so refused: a tab in an indentation, a line less indented than the top, a top line that is not a key, an anchor or alias
/// or tag (`&`, `*`, `!`, so no merge key can add one), a quote or flow collection still open when a top-level line comes, a frontmatter
/// with no end, a `...` line, U+0085, U+2028, U+2029 and other control characters, and an opening line that is not plain `---`.
/// The kit's permission hook (permission-relay.py, `frontmatter_keys`) is the same reader; both suites hold the same cases.
public enum FrontmatterScan {
  public enum Outcome: Equatable, Sendable {
    /// The top-level keys, in order (none when the file has no frontmatter).
    case keys([String])
    case unclear(String)
  }

  typealias S = [Unicode.Scalar]

  public static func scan(_ text: String) -> Outcome {
    var src = S(text.unicodeScalars)
    if src.first == "\u{FEFF}" { src.removeFirst() }
    // one kind of line end: "\r\n" and a lone "\r" are both one
    var s = S()
    s.reserveCapacity(src.count)
    var i = 0
    while i < src.count {
      if src[i] == "\r" {
        s.append("\n")
        if i + 1 < src.count, src[i + 1] == "\n" { i += 1 }
      } else {
        s.append(src[i])
      }
      i += 1
    }
    let lines = s.split(separator: "\n", omittingEmptySubsequences: false).map(S.init)
    guard let first = lines.first, first.starts(with: "---".unicodeScalars) else { return .keys([]) }
    guard trimmed(first) == S("---".unicodeScalars) else { return .unclear("its first line starts a frontmatter block that is not plain ---") }
    var end: Int?
    for k in 1..<max(1, lines.count) {
      let t = trimmed(lines[k])
      if t == S("---".unicodeScalars) {
        end = k
        break
      }
      if t == S("...".unicodeScalars) { return .unclear("its frontmatter has a ... line") }
    }
    guard let e = end else { return .unclear("its frontmatter has no closing ---") }
    let body = Array(lines[1..<e].joined(separator: ["\n"]))
    if let bad = body.first(where: { ($0.value < 0x20 && $0 != "\t" && $0 != "\n") || $0.value == 0x7F || [0x85, 0x2028, 0x2029, 0xFEFF].contains($0.value) }) {
      return .unclear(String(format: "its frontmatter has the character U+%04X", bad.value))
    }
    var p = Reader(t: body)
    return p.run()
  }

  static func trimmed(_ l: S) -> S {
    var a = l[...]
    while let f = a.first, f == " " || f == "\t" { a = a.dropFirst() }
    while let f = a.last, f == " " || f == "\t" { a = a.dropLast() }
    return S(a)
  }

  struct Unclear: Error { var why: String }

  struct Reader {
    let t: S
    var n: Int { t.count }

    func lineEnd(_ from: Int) -> Int {
      var j = from
      while j < n, t[j] != "\n" { j += 1 }
      return j
    }
    func isSpace(_ c: Unicode.Scalar) -> Bool { c == " " || c == "\t" }
    func blank(_ a: Int, _ b: Int) -> Bool { t[a..<b].allSatisfy(isSpace) }
    /// Blank, or a comment, from `a` to the line end `b`.
    func restIsNothing(_ a: Int, _ b: Int) -> Bool {
      var j = a
      while j < b, isSpace(t[j]) { j += 1 }
      return j == b || t[j] == "#"
    }

    mutating func run() -> Outcome {
      do { return .keys(try block()) } catch let u as Unclear { return .unclear(u.why) } catch { return .unclear("it cannot be read") }
    }

    mutating func block() throws -> [String] {
      var keys: [String] = []
      var top: Int?
      var blockIndent: Int?
      var pos = 0
      while pos <= n {
        let le = lineEnd(pos)
        var k = pos
        while k < le, t[k] == " " { k += 1 }
        let indent = k - pos
        if blank(pos, le) {
          pos = le + 1
          continue
        }
        if t[k] == "\t" { throw Unclear(why: "its frontmatter has a tab in an indentation") }
        if let b = blockIndent {
          if indent > b {
            pos = le + 1
            continue
          }
          blockIndent = nil
        }
        if t[k] == "#" {
          pos = le + 1
          continue
        }
        if top == nil {
          top = indent
          if t[k] == "{" || t[k] == "[" { return try flowDocument(k) }
        }
        guard let topIndent = top, indent >= topIndent else { throw Unclear(why: "its frontmatter has a line less indented than its first") }
        var v: Int
        if indent == topIndent {
          guard let (key, after) = try keyAt(k, le, strict: true) else { throw Unclear(why: "its frontmatter has a top-level line that is not a key") }
          keys.append(key)
          v = after
        } else {
          var q = k
          while q < le, t[q] == "-", q + 1 == le || isSpace(t[q + 1]) {
            q += 1
            while q < le, isSpace(t[q]) { q += 1 }
          }
          v = try keyAt(q, le, strict: false)?.1 ?? q
        }
        switch try value(v, le, top: topIndent) {
        case .line: pos = le + 1
        case .block:
          blockIndent = indent
          pos = le + 1
        case .until(let lastLineEnd): pos = lastLineEnd + 1
        }
      }
      return keys
    }

    /// A key at `k` and the index just past its `:`, or nil when the line holds no key there. `strict`: a top-level line, where a
    /// key that cannot be read for certain is unclear rather than "not a key".
    func keyAt(_ k: Int, _ le: Int, strict: Bool) throws -> (String, Int)? {
      guard k < le else { return nil }
      let c = t[k]
      if c == "\"" || c == "'" {
        var j = k + 1
        var key = S()
        while true {
          guard j < le else { return nil }  // a quoted key never spans lines
          if c == "\"", t[j] == "\\" {
            if strict { throw Unclear(why: "its frontmatter has a key with an escape") }
            return nil
          }
          if t[j] == c {
            if c == "'", j + 1 < le, t[j + 1] == "'" {
              key.append("'")
              j += 2
              continue
            }
            break
          }
          key.append(t[j])
          j += 1
        }
        j += 1
        while j < le, isSpace(t[j]) { j += 1 }
        guard j < le, t[j] == ":" else { return nil }
        return (String(String.UnicodeScalarView(key)), j + 1)
      }
      let next: Unicode.Scalar? = k + 1 < le ? t[k + 1] : nil
      if "-?:".unicodeScalars.contains(c), next == nil || isSpace(next!) { return nil }
      if ",[]{}#&*!|>%@`".unicodeScalars.contains(c) { return nil }
      var j = k
      while j < le {
        if t[j] == ":", j + 1 == le || isSpace(t[j + 1]) {
          var a = k, b = j
          while b > a, isSpace(t[b - 1]) { b -= 1 }
          while a < b, isSpace(t[a]) { a += 1 }
          return (String(String.UnicodeScalarView(t[a..<b])), j + 1)
        }
        if t[j] == "#", j > k, isSpace(t[j - 1]) { return nil }
        j += 1
      }
      return nil
    }

    enum After { case line, block, until(Int) }

    /// What the value at `v` (on the line ending at `le`) takes: the rest of the line, a block scalar below it, or lines up to the one
    /// ending at the index returned. A construct that runs on to a later line may not meet a line at or left of the top indent.
    func value(_ v0: Int, _ le: Int, top: Int) throws -> After {
      var v = v0
      while v < le, isSpace(t[v]) { v += 1 }
      if v == le || t[v] == "#" { return .line }
      let c = t[v]
      var close: Int
      switch c {
      case "\"", "'": close = try quoted(v)
      case "[", "{":
        var j = v
        var ignored: [String] = []
        try flowNode(&j, keys: &ignored, collect: false)
        close = j - 1
      case "|", ">":
        var j = v + 1
        while j < le, "0123456789+-".unicodeScalars.contains(t[j]) { j += 1 }
        guard j == le || (isSpace(t[j]) && restIsNothing(j, le)) else { throw Unclear(why: "its frontmatter has a block scalar header it cannot read") }
        return .block
      case "&", "*", "!", "%", "@", "`": throw Unclear(why: "its frontmatter has an anchor, alias, tag or reserved character")
      default: return .line
      }
      if close < le { return .line }
      try spanStaysRight(from: le, to: close, top: top)
      let last = lineEnd(close)
      guard restIsNothing(close + 1, last) else { throw Unclear(why: "its frontmatter has text after a value that spans lines") }
      return .until(last)
    }

    /// Every line that starts after `from` and holds text up to `to` is more indented than the top.
    func spanStaysRight(from: Int, to: Int, top: Int) throws {
      var j = from
      while j < to {
        if t[j] == "\n" {
          var k = j + 1
          while k < n, t[k] == " " { k += 1 }
          let le = lineEnd(j + 1)
          if !blank(j + 1, le), k - (j + 1) <= top { throw Unclear(why: "its frontmatter has a quote or a flow collection open at a top-level line") }
        }
        j += 1
      }
    }

    /// The index of the closing quote of the quoted scalar opening at `q`.
    func quoted(_ q: Int) throws -> Int {
      let c = t[q]
      var j = q + 1
      while j < n {
        if c == "\"", t[j] == "\\" {
          j += 2
          continue
        }
        if t[j] == c {
          if c == "'", j + 1 < n, t[j + 1] == "'" {
            j += 2
            continue
          }
          return j
        }
        j += 1
      }
      throw Unclear(why: "its frontmatter has a quote that never closes")
    }

    // MARK: flow collections

    mutating func flowDocument(_ k: Int) throws -> [String] {
      guard t[k] == "{" else { throw Unclear(why: "its frontmatter is a flow sequence, not a mapping") }
      var keys: [String] = []
      var j = k
      try flowNode(&j, keys: &keys, collect: true)
      skipFlowSpace(&j)
      guard j >= n else { throw Unclear(why: "its frontmatter has text after its flow mapping") }
      return keys
    }

    func skipFlowSpace(_ j: inout Int) {
      while j < n {
        if isSpace(t[j]) || t[j] == "\n" {
          j += 1
        } else if t[j] == "#", j == 0 || isSpace(t[j - 1]) || t[j - 1] == "\n" {
          while j < n, t[j] != "\n" { j += 1 }
        } else {
          return
        }
      }
    }

    /// One flow node at `j` (quoted, a collection, or plain), leaving `j` just past it. `collect`: this is the document's own
    /// mapping, whose keys are wanted.
    func flowNode(_ j: inout Int, keys: inout [String], collect: Bool) throws {
      skipFlowSpace(&j)
      guard j < n else { throw Unclear(why: "its frontmatter has a flow collection that never closes") }
      let c = t[j]
      if c == "\"" || c == "'" {
        j = try quoted(j) + 1
        return
      }
      if c == "[" || c == "{" {
        let closer: Unicode.Scalar = c == "[" ? "]" : "}"
        j += 1
        while true {
          skipFlowSpace(&j)
          guard j < n else { throw Unclear(why: "its frontmatter has a flow collection that never closes") }
          if t[j] == closer {
            j += 1
            return
          }
          // an entry: a node, then maybe `: node`
          let keyStart = j
          if t[j] == "?", j + 1 < n, isSpace(t[j + 1]) || t[j + 1] == "\n" { throw Unclear(why: "its frontmatter has an explicit key") }
          var inner: [String] = []
          try flowNode(&j, keys: &inner, collect: false)
          if collect {
            guard let key = flowKeyText(keyStart, j) else { throw Unclear(why: "its frontmatter has a flow key it cannot read") }
            keys.append(key)
          }
          skipFlowSpace(&j)
          if j < n, t[j] == ":" {
            j += 1
            skipFlowSpace(&j)
            if j < n, t[j] != ",", t[j] != closer { try flowNode(&j, keys: &inner, collect: false) }
            skipFlowSpace(&j)
          }
          guard j < n else { throw Unclear(why: "its frontmatter has a flow collection that never closes") }
          if t[j] == "," {
            j += 1
          } else if t[j] != closer {
            throw Unclear(why: "its frontmatter has a flow collection it cannot read")
          }
        }
      }
      if "&*!|>%@`],}".unicodeScalars.contains(c) { throw Unclear(why: "its frontmatter has an anchor, alias, tag or reserved character") }
      // plain: up to a flow indicator, a `:` that ends it, or a comment
      while j < n {
        let d = t[j]
        if ",[]{}".unicodeScalars.contains(d) { return }
        if d == ":", j + 1 >= n || isSpace(t[j + 1]) || t[j + 1] == "\n" || ",[]{}".unicodeScalars.contains(t[j + 1]) { return }
        if d == "#", j > 0, isSpace(t[j - 1]) || t[j - 1] == "\n" { return }
        j += 1
      }
    }

    /// A flow key's text: a quoted key with no escape, or a plain key trimmed.
    func flowKeyText(_ a: Int, _ b: Int) -> String? {
      let c = t[a]
      if c == "\"" || c == "'" {
        var inner = S(t[(a + 1)..<(b - 1)])
        if c == "\"" { if inner.contains("\\") || inner.contains("\n") { return nil } } else {
          if inner.contains("\n") { return nil }
          inner = S(String(String.UnicodeScalarView(inner)).replacingOccurrences(of: "''", with: "'").unicodeScalars)
        }
        return String(String.UnicodeScalarView(inner))
      }
      if c == "[" || c == "{" { return nil }
      var x = a, y = b
      while y > x, isSpace(t[y - 1]) || t[y - 1] == "\n" { y -= 1 }
      while x < y, isSpace(t[x]) { x += 1 }
      if t[x..<y].contains("\n") { return nil }
      return String(String.UnicodeScalarView(t[x..<y]))
    }
  }
}
