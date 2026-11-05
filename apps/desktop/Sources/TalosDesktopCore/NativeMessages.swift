import Foundation

/// Swift mirror of `packages/protocol/src/native.ts` (shell API v1, DESKTOP-SPEC 5.3). The TypeScript schemas are strict:
/// an unknown type or an unknown field is refused, never ignored. These decoders do the same, and the AppPath and URL
/// rules are at least as strict as the TypeScript ones, because the page is the less trusted side.
/// `Tests/.../NativeFixtureTests` decodes every sample in `packages/protocol/fixtures/native/messages.json`.
public enum WebToNative: Equatable, Sendable {
  public struct Thread: Equatable, Sendable {
    public var id: String
    public var name: String
  }
  public enum PairState: String, Sendable { case waitingPin = "waiting_pin", pinned, failed }

  case ready(signedIn: Bool, features: [String])
  case notify(title: String, body: String, navigate: String, tag: String?)
  case badge(Int)
  case openExternal(URL)
  case haptic(String)
  case threads([Thread])
  case pairStatus(PairState)
  /// The desktop companion's feed (feature `companion/1`, DESKTOP-COMPANION-SPEC 7).
  case companionState(CompanionFeed)
  /// A `companion_state` that failed decoding. The receiver clears the feed: an old frame must not keep standing.
  case companionInvalid
  case companionReply(CompanionReply)
  /// Where the page left room for the agent terminal, or nil when the terminal screen is not showing (`terminal_view`).
  case terminalView(TerminalViewRect?)

  /// Decodes what `WKScriptMessage.body` carries (a JSON object). nil = refuse.
  public static func decode(_ body: Any) -> WebToNative? {
    guard let o = body as? [String: Any], let type = o["type"] as? String else { return nil }
    func only(_ keys: Set<String>) -> Bool { Set(o.keys) == keys.union(["type"]) }
    func allowed(required: Set<String>, optional: Set<String> = []) -> Bool {
      let k = Set(o.keys).subtracting(["type"])
      return required.isSubset(of: k) && k.isSubset(of: required.union(optional))
    }
    switch type {
    case "ready":
      guard only(["shell_api", "features", "signed_in"]), JSONValue.int(o["shell_api"]) == 1,
        let features = o["features"] as? [Any], features.count <= 32,
        let signedIn = JSONValue.bool(o["signed_in"])
      else { return nil }
      var out: [String] = []
      for f in features {
        guard let s = f as? String, (1...64).contains(s.utf16.count) else { return nil }
        out.append(s)
      }
      return .ready(signedIn: signedIn, features: out)
    case "notify":
      guard allowed(required: ["title", "body", "navigate"], optional: ["tag"]),
        let title = o["title"] as? String, title.utf16.count <= 200,
        let body = o["body"] as? String, body.utf16.count <= 2000,
        let nav = o["navigate"] as? String, AppPath.isValid(nav)
      else { return nil }
      var tag: String?
      if let t = o["tag"] {
        guard let s = t as? String, (1...100).contains(s.utf16.count) else { return nil }
        tag = s
      }
      return .notify(title: title, body: body, navigate: nav, tag: tag)
    case "badge":
      guard only(["count"]), let n = JSONValue.int(o["count"]), (0...99_999).contains(n) else { return nil }
      return .badge(n)
    case "open_external":
      guard only(["url"]), let s = o["url"] as? String, let u = ExternalURL.parse(s) else { return nil }
      return .openExternal(u)
    case "haptic":
      guard only(["kind"]), let k = o["kind"] as? String,
        ["light", "medium", "heavy", "selection", "success", "warning", "error"].contains(k)
      else { return nil }
      return .haptic(k)
    case "threads":
      guard only(["items"]), let items = o["items"] as? [Any], items.count <= 100 else { return nil }
      var out: [Thread] = []
      for i in items {
        guard let d = i as? [String: Any], Set(d.keys) == ["id", "name"], let id = d["id"] as? String,
          ThreadIdRule.isValid(id), let name = d["name"] as? String, (1...80).contains(name.utf16.count)
        else { return nil }
        out.append(Thread(id: id, name: name))
      }
      return .threads(out)
    case "pair_status":
      guard only(["state"]), let s = o["state"] as? String, let st = PairState(rawValue: s) else { return nil }
      return .pairStatus(st)
    case "companion_state":
      // Never nil: a bad frame is not "an unknown message" (the bridge would count it dropped and keep the old feed).
      guard let feed = CompanionFeed.decode(o) else { return .companionInvalid }
      return .companionState(feed)
    case "companion_reply":
      return CompanionReply.decode(o).map(WebToNative.companionReply)
    case "terminal_view":
      guard only(["rect"]) else { return nil }
      if o["rect"] is NSNull { return .terminalView(nil) }
      guard let r = o["rect"] as? [String: Any], Set(r.keys) == ["x", "y", "width", "height"],
        let x = JSONValue.int(r["x"]), let y = JSONValue.int(r["y"]), let w = JSONValue.int(r["width"]),
        let h = JSONValue.int(r["height"]), [x, y, w, h].allSatisfy({ (0...TerminalViewRect.max).contains($0) })
      else { return nil }
      return .terminalView(TerminalViewRect(x: x, y: y, width: w, height: h))
    default:
      return nil
    }
  }

  /// Decodes message text (what a test or a log holds).
  public static func decode(json: Data) -> WebToNative? {
    guard let v = try? JSONSerialization.jsonObject(with: json) else { return nil }
    return decode(v)
  }
}

/// What the shell sends to the page. `javascript` is the one line the web view evaluates; the payload is a JSON string
/// literal, so no value can break out of it.
public enum NativeToWeb: Equatable, Sendable {
  case compose(threadId: String, text: String)
  case navigate(path: String)
  case enrollCode(String)
  /// Asks the page for the newest agent reply in one thread, as plain text (after a click only).
  case companionReplyRequest(req: String, threadId: String)
  /// What macOS says about this app's notification permission (Settings > Notifications shows it).
  case notifyPermission(NotifyPermission)

  public var object: [String: Any] {
    switch self {
    case .compose(let t, let x): return ["type": "compose", "thread_id": t, "text": x]
    case .navigate(let p): return ["type": "navigate", "path": p]
    case .enrollCode(let c): return ["type": "enroll_code", "code": c]
    case .companionReplyRequest(let r, let t): return ["type": "companion_reply_request", "req": r, "thread_id": t]
    case .notifyPermission(let p): return ["type": "notify_permission", "state": p.rawValue]
    }
  }

  /// Builds the message only when it passes the page's own rules (thread id, 1..32000 chars, AppPath, a setup code).
  public static func validated(_ m: NativeToWeb) -> NativeToWeb? {
    switch m {
    case .compose(let t, let x):
      return ThreadIdRule.isValid(t) && (1...32_000).contains(x.utf16.count) ? m : nil
    case .navigate(let p): return AppPath.isValid(p) ? m : nil
    case .enrollCode(let c): return EnrollCode.normalize(c) != nil ? m : nil
    case .companionReplyRequest(let r, let t): return CompanionReq.isValid(r) && ThreadIdRule.isValid(t) ? m : nil
    case .notifyPermission: return m
    }
  }

  public func jsonString() -> String? {
    guard let d = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
    return String(data: d, encoding: .utf8)
  }

  /// `window.talosNative && window.talosNative.receive(<json string literal>)`
  public func javascript() -> String? {
    guard let lit = stringLiteral() else { return nil }
    return "window.talosNative && window.talosNative.receive(\(lit))"
  }

  /// The body of a script that asks the page and gives back its answer, for a caller that waits for it. A newer page has
  /// `receiveAck`, which answers with a promise that settles when the work is done; an older page has only `receive`, a plain
  /// boolean. The body ends in `return`, so it runs as an async function body (`callAsyncJavaScript`), which waits for a promise.
  public func acknowledgedJavascript() -> String? {
    guard let lit = stringLiteral() else { return nil }
    return "var raw = \(lit); var t = window.talosNative; return t ? (t.receiveAck ? t.receiveAck(raw) : t.receive(raw)) : undefined"
  }

  /// The validated message as one JavaScript string literal.
  private func stringLiteral() -> String? {
    guard let m = NativeToWeb.validated(self), let json = m.jsonString(),
      let lit = try? JSONSerialization.data(withJSONObject: [json], options: [.fragmentsAllowed]),
      var s = String(data: lit, encoding: .utf8)
    else { return nil }
    s.removeFirst()  // [
    s.removeLast()  // ]
    return s
  }
}

/// The notification permission as the page words it (`notify_permission`, packages/protocol/src/native.ts).
public enum NotifyPermission: String, Equatable, Sendable {
  case granted
  case denied
  case notAsked = "not_asked"

  /// From `UNAuthorizationStatus.rawValue`: 0 notDetermined, 1 denied, 2 authorized, 3 provisional, 4 ephemeral. These are
  /// exactly the statuses `Notifier.show` posts for (2, 3, 4). A status this build does not know posts nothing, so it
  /// reads as denied.
  public init(authorizationStatusRaw raw: Int) {
    switch raw {
    case 0: self = .notAsked
    case 2, 3, 4: self = .granted
    default: self = .denied
    }
  }
}

/// Where the bridge writes its log: `$TALOS_APP_HOME/bridge.log`, with the same home the rest of the app resolves (the
/// desktop.json `env`, then the process environment, then `~/.config/talos/app`).
public enum BridgeLog {
  public static func path(configEnv: [String: String], processEnv: [String: String], home: String) -> String {
    func nonEmpty(_ v: String?) -> String? { v.flatMap { $0.isEmpty ? nil : $0 } }
    let appHome = nonEmpty(configEnv["TALOS_APP_HOME"]) ?? nonEmpty(processEnv["TALOS_APP_HOME"]) ?? home + "/.config/talos/app"
    return PathUtil.expandTilde(appHome, home: home) + "/bridge.log"
  }
}

enum JSONValue {
  /// An integer from JSON (never a boolean, never 2.5).
  static func int(_ v: Any?) -> Int? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let d = n.doubleValue
    guard d == d.rounded(), abs(d) < 9_007_199_254_740_992 else { return nil }
    return n.intValue
  }
  static func bool(_ v: Any?) -> Bool? {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
    return n.boolValue
  }
}

public enum ThreadIdRule {
  /// `^[a-z][a-z0-9_]{0,31}$`, and not "all".
  public static func isValid(_ s: String) -> Bool {
    guard s != "all", let f = s.unicodeScalars.first, (1...32).contains(s.unicodeScalars.count) else { return false }
    guard ("a"..."z").contains(Character(f)) else { return false }
    return s.unicodeScalars.allSatisfy { ("a"..."z").contains(Character($0)) || ("0"..."9").contains(Character($0)) || $0 == "_" }
  }
}

/// An in-app path: one leading "/", URL-safe characters only, no dot segments, and never into the media or API spaces
/// (percent-escapes are decoded, repeatedly, before the rule is applied).
public enum AppPath {
  static let safe = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~!$&'()*+,;=:@%/?#-")
  static let blocked = ["media", "api", "bridge", "hook", "ws"]

  public static func isValid(_ p: String) -> Bool {
    guard p.utf16.count <= 512, p.hasPrefix("/"), !p.hasPrefix("//"), p.allSatisfy({ safe.contains($0) }) else {
      return false
    }
    var path = String(p.prefix { $0 != "?" && $0 != "#" })
    for _ in 0..<4 {
      guard let next = path.removingPercentEncoding else { return false }
      if next == path { break }
      path = next
    }
    guard !path.hasPrefix("//"), !path.contains("\\"),
      !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else { return false }
    let segments = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
    if segments.contains(where: { $0 == "." || $0 == ".." }) { return false }
    let first = segments.first.map { String($0).lowercased() } ?? ""
    return !blocked.contains(first)
  }
}

public enum ExternalURL {
  /// http(s) or mailto only, at most 2048 characters. Anything else is nil.
  public static func parse(_ s: String) -> URL? {
    let lower = s.lowercased()
    guard s.utf16.count <= 2048, lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:"),
      let u = URL(string: s), let scheme = u.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme)
    else { return nil }
    if scheme != "mailto" && (u.host ?? "").isEmpty { return nil }
    return u
  }
}

/// Crockford base32, 26 characters (`packages/protocol/src/enroll.ts normalizeEnrollCode`).
public enum EnrollCode {
  static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

  public static func normalize(_ input: String) -> String? {
    var c = input.uppercased().filter { !$0.isWhitespace && $0 != "-" }
    c = c.replacingOccurrences(of: "I", with: "1").replacingOccurrences(of: "L", with: "1")
      .replacingOccurrences(of: "O", with: "0")
    guard c.count == 26, c.allSatisfy({ alphabet.contains($0) }), let first = alphabet.firstIndex(of: c.first!),
      first <= 7
    else { return nil }
    return c
  }
}
