import Foundation

/// The relay origin the window loads (DESKTOP-SPEC D6 and 5.1). A value type so the rules are testable without WebKit.
public struct RelayOrigin: Equatable, Sendable {
  public let scheme: String
  public let host: String
  public let port: Int?

  public init?(_ url: URL) {
    guard let s = url.scheme?.lowercased(), s == "https" || (s == "http" && Self.isLoopback(url.host)),
      var h = url.host?.lowercased(), !h.isEmpty
    else { return nil }
    // IPv6 literals are kept in brackets ("[::1]"): URLComponents refuses the bare form. Comparisons use `bare`.
    if h.contains(":"), !h.hasPrefix("[") { h = "[\(h)]" }
    scheme = s
    host = h
    let defaultPort = s == "https" ? 443 : 80
    port = (url.port == defaultPort) ? nil : url.port
  }

  public init?(_ s: String) {
    guard let u = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    self.init(u)
  }

  static func bare(_ h: String) -> String { h.hasPrefix("[") && h.hasSuffix("]") ? String(h.dropFirst().dropLast()) : h }

  static func isLoopback(_ host: String?) -> Bool {
    guard let h = host?.lowercased() else { return false }
    return h == "localhost" || h == "127.0.0.1" || h == "[::1]" || h == "::1"
  }

  public func matches(scheme s: String?, host h: String?, port p: Int?) -> Bool {
    guard let s = s?.lowercased(), let h = h?.lowercased(), s == scheme, Self.bare(h) == Self.bare(host) else { return false }
    let defaultPort = scheme == "https" ? 443 : 80
    return (p == defaultPort ? nil : p) == port
  }

  public func contains(_ url: URL) -> Bool { matches(scheme: url.scheme, host: url.host, port: url.port) }

  public var url: URL {
    var c = URLComponents()
    c.scheme = scheme
    c.host = host
    c.port = port
    c.path = "/"
    // Never crash on an odd host: fall back to a hand-built string, then to a page that does nothing.
    if let u = c.url { return u }
    return URL(string: "\(scheme)://\(host)\(port.map { ":\($0)" } ?? "")/") ?? URL(string: "about:blank")!
  }
}

public enum NavigationDecision: Equatable, Sendable {
  case allow
  case openExternally(URL)
  case deny
}

public enum WebPolicy {
  /// 5.1: only the relay origin loads in the view; any path under /media/ goes to the default browser (agent pages
  /// run there); every other http(s) or mailto link opens externally; no other scheme loads (about:blank, file, data,
  /// javascript, custom).
  public static func decide(_ url: URL, relay: RelayOrigin) -> NavigationDecision {
    let scheme = url.scheme?.lowercased() ?? ""
    if scheme == "mailto" { return .openExternally(url) }
    guard scheme == "http" || scheme == "https" else { return .deny }
    if relay.contains(url) {
      return isMediaPath(url) ? .openExternally(url) : .allow
    }
    return (url.host ?? "").isEmpty ? .deny : .openExternally(url)
  }

  /// Frames inside the page. An agent's HTML attachment is a sandboxed iframe on /media/..., so the relay origin loads
  /// there (the message gate, not this check, keeps it from the native handler). Anything else is refused.
  public static func decideSubframe(_ url: URL, relay: RelayOrigin) -> NavigationDecision {
    let scheme = url.scheme?.lowercased() ?? ""
    if scheme == "about" { return url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" ? .allow : .deny }
    if scheme == "blob" || scheme == "data" { return .deny }
    // Only agent pages (/media/...) are ever framed. Any other relay path in a frame could speak to the shell as the main
    // frame (WebKit reports `top.webkit...` calls from a same-origin frame that way), so the shell doesn't rest on relay headers.
    return (scheme == "http" || scheme == "https") && relay.contains(url) && isMediaPath(url) ? .allow : .deny
  }

  /// A path is in the media space when its decoded, dot-resolved form starts with /media (any case, any escaping).
  public static func isMediaPath(_ url: URL) -> Bool {
    guard let segs = normalizedSegments(url) else { return true }
    return segs.first.map { $0.lowercased() == "media" } ?? false
  }

  /// The path's segments after decoding (up to four layers) and resolving dots. nil when it will not decode.
  static func normalizedSegments(_ url: URL) -> [Substring]? {
    var path = url.path(percentEncoded: true)
    for _ in 0..<4 {
      guard let next = path.removingPercentEncoding else { return nil }
      if next == path { break }
      path = next
    }
    var stack: [Substring] = []
    for seg in path.replacingOccurrences(of: "\\", with: "/").split(separator: "/", omittingEmptySubsequences: true) {
      if seg == "." { continue }
      if seg == ".." { _ = stack.popLast(); continue }
      stack.append(seg)
    }
    return stack
  }

  /// An attachment: the relay's `GET /media/:id` (an agent page is `/media/:id/page` or `/media/:id/app` and stays in the
  /// browser). The Mac app downloads these itself, with its own sign-in, instead of handing the browser a link that answers
  /// 401 (audit D13).
  public static func isMediaFile(_ url: URL, relay: RelayOrigin) -> Bool {
    guard relay.contains(url), let segs = normalizedSegments(url), segs.count == 2 else { return false }
    return segs[0].lowercased() == "media"
  }

  /// Where a script message came from. The handler drops it unless the sender is the relay's main frame and that page
  /// is not under /media/ (5.3): an agent-written page, an iframe, or an opaque origin (a sandboxed document) can't reach it.
  public struct Sender: Sendable {
    public var isMainFrame: Bool
    public var scheme: String?
    public var host: String?
    public var port: Int?
    public var mainFramePath: String?
    public init(isMainFrame: Bool, scheme: String?, host: String?, port: Int?, mainFramePath: String?) {
      self.isMainFrame = isMainFrame
      self.scheme = scheme
      self.host = host
      self.port = port
      self.mainFramePath = mainFramePath
    }
  }

  public static func accepts(_ s: Sender, relay: RelayOrigin) -> Bool {
    guard s.isMainFrame, let h = s.host, !h.isEmpty, relay.matches(scheme: s.scheme, host: h, port: s.port) else {
      return false
    }
    guard let p = s.mainFramePath, var c = URLComponents(string: "https://x.invalid"), p.hasPrefix("/") else { return false }
    c.percentEncodedPath = p
    guard let u = c.url else { return false }
    return !isMediaPath(u)
  }

  /// What the web view asks to capture.
  public enum MediaKind: Sendable { case microphone, camera, cameraAndMicrophone }

  /// Microphone only, and only for the relay's own page: the main frame on the relay origin, not under /media/ (the same
  /// gate as script messages, 5.3). Dictation, voice notes and live calls need it. Camera, iframes, agent pages and any
  /// other origin stay refused. macOS still asks the owner once for the app's own microphone permission.
  public static func grantsMedia(_ kind: MediaKind, sender: Sender, mainFrameURL: URL?, relay: RelayOrigin) -> Bool {
    guard kind == .microphone, let u = mainFrameURL, relay.contains(u) else { return false }
    return accepts(sender, relay: relay)
  }

  /// What this Mac app can do for the page, listed in the user agent so the page never asks for something an older app drops.
  public static let shellFeatures = ["pick-folder"]

  /// The whole application name for the web view's user agent: the version mark, then `TalosFeatures/<list>`.
  public static func userAgentApplicationName(version: String) -> String {
    "\(userAgentSuffix(version: version)) TalosFeatures/\(shellFeatures.joined(separator: ","))"
  }

  /// ` TalosDesktop/<version>`, appended to the web view's user agent. The page needs it to know it is in the Mac app.
  public static func userAgentSuffix(version: String) -> String {
    let v = version.filter { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
    return "TalosDesktop/\(v.isEmpty ? "0" : v)"
  }
}

/// Where the relay URL comes from (D6): native config only, never the page. `desktop.json` `relay_url` unless it is
/// "auto" or the generic placeholder; then `TALOS_APP_RELAY_URL` in `$TALOS_APP_HOME/bridge.env`.
public enum RelayConfig {
  public static let placeholder = "https://relay.example.com"

  public static func resolve(configured: String, bridgeEnv: String?) -> RelayOrigin? {
    let c = configured.trimmingCharacters(in: .whitespacesAndNewlines)
    if !c.isEmpty, c != "auto", c.trimmingCharacters(in: CharacterSet(charactersIn: "/")) != placeholder {
      return RelayOrigin(c)
    }
    guard let env = bridgeEnv, let v = envValue("TALOS_APP_RELAY_URL", in: env) else { return nil }
    return RelayOrigin(v)
  }

  /// `KEY=value` lines; optional `export`, quotes and a trailing comment are tolerated; the last assignment wins.
  public static func envValue(_ key: String, in text: String) -> String? {
    var found: String?
    for raw in text.split(whereSeparator: \.isNewline) {
      var line = raw.trimmingCharacters(in: .whitespaces)
      if line.hasPrefix("#") || line.isEmpty { continue }
      if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
      guard let eq = line.firstIndex(of: "="), line[..<eq].trimmingCharacters(in: .whitespaces) == key else { continue }
      var v = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
      if let q = v.first, q == "\"" || q == "'", let end = v.dropFirst().firstIndex(of: q) {
        v = String(v[v.index(after: v.startIndex)..<end])
      } else if let hash = v.range(of: " #") {
        v = String(v[..<hash.lowerBound]).trimmingCharacters(in: .whitespaces)
      }
      found = v.isEmpty ? nil : v
    }
    return found
  }
}

/// Saving an attachment inside the app (audit D13). Pure: the response and the name in, a verdict out.
public enum DownloadRules {
  public enum Verdict: Equatable, Sendable {
    case save(filename: String)
    case fail(String)
  }

  public static func verdict(status: Int?, suggestedFilename: String) -> Verdict {
    if let s = status, s >= 400 {
      switch s {
      case 401, 403: return .fail("The relay wouldn't give this file to Talos. Sign in again, then retry.")
      case 404, 410: return .fail("That file is gone from the relay.")
      default: return .fail("The relay couldn't send the file (error \(s)).")
      }
    }
    return .save(filename: safeFilename(suggestedFilename))
  }

  /// A name from a header is text from the agent's side: no folders, no control characters, no leading dot.
  public static func safeFilename(_ s: String) -> String {
    var n = String(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f && $0 != "/" && $0 != ":" && $0 != "\\" })
    while n.hasPrefix(".") { n.removeFirst() }
    n = n.trimmingCharacters(in: .whitespaces)
    if n.count > 120 { n = String(n.prefix(120)) }
    return n.isEmpty ? "download" : n
  }
}
