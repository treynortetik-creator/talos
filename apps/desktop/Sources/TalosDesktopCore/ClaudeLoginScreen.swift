import Foundation

/// What `claude auth login` shows on its screen: the sign-in link, and whether it waits for a pasted code ("Paste code here if
/// prompted"). The link is only offered when it is https on an official host written plainly (no percent-escapes in the host). Its query carries one-time values, so the
/// description (what a log line or a test failure would print) holds the host only, never the query, and the pasted code is
/// never part of this type at all.
public struct ClaudeLoginScreen: Equatable, Sendable, CustomStringConvertible {
  public var url: String?
  public var wantsCode: Bool
  public init(url: String? = nil, wantsCode: Bool = false) {
    self.url = url
    self.wantsCode = wantsCode
  }

  public static let allowedHosts = ["claude.ai", "claude.com", "anthropic.com"]

  /// Rows are the terminal's, wide enough that a long link is one row.
  public static func parse(rows: [String]) -> ClaudeLoginScreen {
    var found: String?
    var wants = false
    for row in rows {
      if row.lowercased().contains("paste code here") { wants = true }
      guard found == nil else { continue }
      var rest = Substring(row)
      while let r = rest.range(of: "https://") ?? rest.range(of: "http://") {
        var end = r.lowerBound
        while end < rest.endIndex, !rest[end].isWhitespace, !"<>\"'".contains(rest[end]) { end = rest.index(after: end) }
        var cand = String(rest[r.lowerBound..<end])
        while let last = cand.last, ".,;:!?)]}".contains(last) { cand.removeLast() }
        if allowed(cand) { found = cand; break }
        rest = rest[end...]
      }
    }
    return ClaudeLoginScreen(url: found, wantsCode: wants)
  }

  static func allowed(_ s: String) -> Bool {
    guard let c = URLComponents(string: s), c.scheme == "https", c.user == nil, c.password == nil, c.port == nil,
      let host = c.host?.lowercased(), c.percentEncodedHost == c.host,
      host.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") })
    else { return false }
    return allowedHosts.contains { host == $0 || host.hasSuffix("." + $0) }
  }

  public var description: String {
    "ClaudeLoginScreen(host: \(url.flatMap { URLComponents(string: $0)?.host } ?? "none"), wantsCode: \(wantsCode))"
  }
}
