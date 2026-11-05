import Foundation

/// The owner's launch command as structured fields (DESKTOP-SPEC 4.1 "Import a pasted command", 4.7 "Copy Terminal
/// command"). `parse` accepts `[cd <dir> &&] [VAR=value …] claude <args…>` with quotes and `~`. It never runs a shell,
/// and refuses anything a shell would do more with: `;`, `|`, `&` (other than the one `&&`), redirects, `$…`, backticks,
/// globs, parentheses and newlines.
public struct LaunchSpec: Equatable, Sendable {
  public var agentDir: String?
  public var env: [String: String]
  public var program: String
  public var args: [String]
  public var resumeId: String?

  public init(agentDir: String?, env: [String: String], program: String, args: [String], resumeId: String?) {
    self.agentDir = agentDir
    self.env = env
    self.program = program
    self.args = args
    self.resumeId = resumeId
  }

  public enum ParseError: Error, Equatable, Sendable, CustomStringConvertible {
    case empty
    case forbidden(String)
    case unterminatedQuote
    case notClaude(String)
    case badCd
    case resumeNeedsUUID(String)
    case headlessFlag(String)

    public var description: String {
      switch self {
      case .empty: return "The command is empty."
      case .forbidden(let what): return "Talos runs claude without a shell, so \(what) isn't supported."
      case .unterminatedQuote: return "A quote is not closed."
      case .notClaude(let p): return "The command must run claude, not \(p)."
      case .badCd: return "Use exactly `cd <folder> && …` before the claude command."
      case .resumeNeedsUUID(let v): return "--resume needs a session id (a UUID), not \(v)."
      case .headlessFlag(let f): return "\(f) runs claude headless; the live session must be interactive."
      }
    }
  }

  enum Token: Equatable {
    case word(String)
    case and
  }

  // MARK: tokenizer

  static func tokenize(_ text: String, home: String) throws -> [Token] {
    var tokens: [Token] = []
    var cur = ""
    var inWord = false
    var sawEquals = false  // first unquoted `=` seen in this word (tilde after `=` expands, as in a shell assignment)
    let chars = Array(text)
    var i = 0

    func flush() {
      if inWord { tokens.append(.word(cur)) }
      cur = ""
      inWord = false
      sawEquals = false
    }
    func tildeAllowedHere(_ idx: Int) -> Bool {
      // `~` expands at the start of a word, or right after the first `=` of an assignment, when followed by `/` or end.
      let atStart = !inWord || (sawEquals && cur.hasSuffix("=") && cur.filter { $0 == "=" }.count == 1)
      guard atStart else { return false }
      let next = idx + 1 < chars.count ? chars[idx + 1] : " "
      return next == "/" || next == " " || next == "\t"
    }

    while i < chars.count {
      let c = chars[i]
      switch c {
      case " ", "\t":
        flush()
        i += 1
      case "\n", "\r":
        throw ParseError.forbidden("a newline")
      case ";": throw ParseError.forbidden("`;`")
      case "|": throw ParseError.forbidden("`|`")
      case "<", ">": throw ParseError.forbidden("a redirect")
      case "`": throw ParseError.forbidden("a backtick")
      case "$": throw ParseError.forbidden("`$` (variables and $(…))")
      case "(", ")": throw ParseError.forbidden("parentheses")
      case "*", "?": throw ParseError.forbidden("a glob")
      case "#" where !inWord: throw ParseError.forbidden("a comment")
      case "&":
        if i + 1 < chars.count, chars[i + 1] == "&" {
          flush()
          tokens.append(.and)
          i += 2
        } else {
          throw ParseError.forbidden("`&`")
        }
      case "\\":
        guard i + 1 < chars.count else { throw ParseError.forbidden("a trailing backslash") }
        let n = chars[i + 1]
        if n == "\n" || n == "\r" { throw ParseError.forbidden("a newline") }
        cur.append(n)
        inWord = true
        i += 2
      case "'":
        inWord = true
        i += 1
        var closed = false
        while i < chars.count {
          let q = chars[i]
          if q == "'" { closed = true; i += 1; break }
          if q == "\n" || q == "\r" { throw ParseError.forbidden("a newline") }
          cur.append(q)
          i += 1
        }
        if !closed { throw ParseError.unterminatedQuote }
      case "\"":
        inWord = true
        i += 1
        var closed = false
        while i < chars.count {
          let q = chars[i]
          if q == "\"" { closed = true; i += 1; break }
          if q == "\n" || q == "\r" { throw ParseError.forbidden("a newline") }
          if q == "$" { throw ParseError.forbidden("`$` (variables and $(…))") }
          if q == "`" { throw ParseError.forbidden("a backtick") }
          if q == "\\", i + 1 < chars.count, ["\"", "\\", "$", "`"].contains(chars[i + 1]) {
            cur.append(chars[i + 1])
            i += 2
            continue
          }
          cur.append(q)
          i += 1
        }
        if !closed { throw ParseError.unterminatedQuote }
      case "~" where tildeAllowedHere(i):
        cur += home
        inWord = true
        i += 1
      default:
        if c == "=" && inWord && !sawEquals { sawEquals = true }
        cur.append(c)
        inWord = true
        i += 1
      }
    }
    flush()
    return tokens
  }

  static func isAssignment(_ w: String) -> (String, String)? {
    guard let eq = w.firstIndex(of: "=") else { return nil }
    let name = String(w[..<eq])
    guard let first = name.first, first == "_" || first.isLetter, first.isASCII,
      name.allSatisfy({ ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "_" })
    else { return nil }
    return (name, String(w[w.index(after: eq)...]))
  }

  // MARK: parse

  public static func parse(_ text: String, home: String) throws -> LaunchSpec {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { throw ParseError.empty }
    let tokens = try tokenize(trimmed, home: home)
    var words: [String] = []
    var dir: String?
    let ands = tokens.filter { $0 == .and }.count
    if ands > 1 { throw ParseError.badCd }
    if ands == 1 {
      guard let idx = tokens.firstIndex(of: .and), idx == 2,
        case .word("cd") = tokens[0], case .word(let d) = tokens[1], !d.isEmpty
      else { throw ParseError.badCd }
      dir = d
      for t in tokens[(idx + 1)...] { if case .word(let w) = t { words.append(w) } }
    } else {
      for t in tokens { if case .word(let w) = t { words.append(w) } }
    }
    if words.first == "cd" { throw ParseError.badCd }

    var env: [String: String] = [:]
    var k = 0
    // `env -u NAME …` is what Copy Terminal command prefixes; unsetting is not a field of the spec.
    if words.first == "env" {
      k = 1
      while k + 1 < words.count, words[k] == "-u" { k += 2 }
    }
    while k < words.count, let (name, value) = isAssignment(words[k]) {
      env[name] = value
      k += 1
    }
    guard k < words.count else { throw ParseError.empty }
    let program = words[k]
    guard (program as NSString).lastPathComponent == "claude" else { throw ParseError.notClaude(program) }
    let rest = Array(words[(k + 1)...])

    for f in rest where f == "-p" || f == "--print" || f.hasPrefix("--print=") || f == "--bg" {
      throw ParseError.headlessFlag(f)
    }
    // `--resume <uuid>` (or `-r`, `--resume=`, `--session-id`) becomes session.id.
    var resume: String?
    var j = 0
    while j < rest.count {
      let a = rest[j]
      if a == "--resume" || a == "-r" || a == "--session-id" {
        guard j + 1 < rest.count, !rest[j + 1].hasPrefix("-") else { throw ParseError.resumeNeedsUUID("nothing") }
        resume = rest[j + 1]
        j += 2
        continue
      }
      if a.hasPrefix("--resume=") { resume = String(a.dropFirst("--resume=".count)) }
      if a.hasPrefix("--session-id=") { resume = String(a.dropFirst("--session-id=".count)) }
      j += 1
    }
    if let r = resume, !ResumeRewrite.isUUID(r) { throw ParseError.resumeNeedsUUID(r) }
    return LaunchSpec(
      agentDir: dir, env: env, program: program, args: ResumeRewrite.strip(rest), resumeId: resume?.lowercased())
  }

  // MARK: render (Copy Terminal command)

  /// `cd <dir> && env -u NAME … VAR=val … <program> <args…> --resume <id>`, every field shell-quoted. Pasting it into Terminal runs
  /// exactly these fields (the rollback path, 4.7).
  public func render() -> String {
    var parts: [String] = []
    if let d = agentDir { parts += ["cd", Self.shellQuote(d), "&&"] }
    // A shell a Claude session spawned holds its session markers; claude would inherit them and save no transcript.
    let shown = env.filter { !ClaudeEnvScrub.isSessionMarker($0.key) }
    let unset = ClaudeEnvScrub.unsetInPastedCommand.filter { shown[$0] == nil }
    if !unset.isEmpty { parts += ["env"] + unset.flatMap { ["-u", $0] } }
    for k in shown.keys.sorted() { parts.append("\(k)=\(Self.shellQuote(shown[k] ?? ""))") }
    parts.append(Self.shellQuote(program))
    parts += args.map(Self.shellQuote)
    if let r = resumeId { parts += ["--resume", Self.shellQuote(r)] }
    return parts.joined(separator: " ")
  }

  public static func shellQuote(_ s: String) -> String {
    if s.isEmpty { return "''" }
    let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_@%+=:,./-")
    if s.unicodeScalars.allSatisfy({ safe.contains($0) }) { return s }
    return "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }
}
