import Foundation

/// What may become a macOS notification, and how often (DESKTOP-SPEC 6.1, D11). Pure, so it is tested without
/// UserNotifications. Every text is a fixed phrase, and this file is what enforces it: a page-requested banner is shown
/// only if its body is one of the push builder's own templates, otherwise it reads "New activity".
public struct NativeNotice: Equatable, Sendable {
  public var title: String
  public var body: String
  /// An in-app path the click opens (already an AppPath), or nil to just bring the window forward.
  public var navigate: String?
  /// Same tag = replaces the earlier banner and is rate-limited together.
  public var tag: String
  public var quiet: Bool
  /// The click opens the terminal pane (the agent needs the owner there), not the chat window.
  public var opensTerminal: Bool = false
}

public enum NotificationPolicy {
  public enum Supervisor: Equatable, Sendable {
    case needsYou  // "Talos needs you at the Mac"
    case restartedAfterCrash  // quiet
    case stoppedRestarting
    case resumeFailed, confirmFailed, blocked, couldNotStart, crashedNoRestart
    case autoRestored  // quiet: it put back the last good setup by itself
    case restoreFailed
  }

  public static func notice(_ e: Supervisor, agent: String) -> NativeNotice {
    let name = cleanAgentName(agent)
    switch e {
    case .needsYou:
      return NativeNotice(
        title: name, body: "\(name) needs you at the Mac", navigate: nil, tag: "sup:needs_you", quiet: false, opensTerminal: true)
    case .restartedAfterCrash:
      return NativeNotice(
        title: name, body: "\(name) restarted after a crash and resumed", navigate: nil, tag: "sup:restarted", quiet: true)
    case .stoppedRestarting:
      return NativeNotice(
        title: name, body: "\(name) stopped restarting (crash loop)", navigate: nil, tag: "sup:crash_loop", quiet: false,
        opensTerminal: true)
    case .resumeFailed:
      return NativeNotice(
        title: name, body: "\(name) can't resume its conversation", navigate: nil, tag: "sup:resume_failed", quiet: false)
    case .confirmFailed:
      return NativeNotice(
        title: name, body: "\(name)'s restart wasn't confirmed", navigate: nil, tag: "sup:confirm_failed", quiet: false,
        opensTerminal: true)
    case .blocked:
      return NativeNotice(
        title: name, body: "Another session is holding \(name)'s channels", navigate: nil, tag: "sup:blocked", quiet: false)
    case .couldNotStart:
      return NativeNotice(
        title: name, body: "\(name) couldn't start", navigate: nil, tag: "sup:start_failed", quiet: false, opensTerminal: true)
    case .crashedNoRestart:
      return NativeNotice(
        title: name, body: "\(name) crashed and auto-restart is off", navigate: nil, tag: "sup:crashed", quiet: false,
        opensTerminal: true)
    case .autoRestored:
      return NativeNotice(
        title: name, body: "\(name) put back its last good setup and restarted", navigate: nil, tag: "sup:auto_restored", quiet: true)
    case .restoreFailed:
      return NativeNotice(
        title: name, body: "\(name) couldn't put back its last good setup", navigate: nil, tag: "sup:restore_failed", quiet: false,
        opensTerminal: true)
    }
  }

  /// The agent's name is plain text from config; keep it short and free of control characters.
  public static func cleanAgentName(_ s: String) -> String {
    let t = String(s.unicodeScalars.filter { $0.value >= 0x20 && $0.value != 0x7f }.prefix(40))
      .trimmingCharacters(in: .whitespaces)
    return t.isEmpty ? "Talos" : t
  }

  /// The push builder's templates (`packages/protocol/src/push.ts buildPushPayload`): the only bodies a banner may carry.
  /// `<x>` is a thread label or the agent's name, short and free of control characters.
  static let phrasePatterns: [String] = [
    #"^New reply in [^\n\r]{1,40}$"#, #"^Needs you in [^\n\r]{1,40}$"#, #"^Answer ready in [^\n\r]{1,40}$"#,
    #"^Overnight: [0-9]{1,5} items$"#, #"^[^\n\r]{1,40}'s Mac session stopped$"#, #"^New device pinned$"#,
    #"^Your bridge key may be in use somewhere else$"#, #"^Relay storage is nearly full$"#, #"^A scheduled job failed$"#,
    #"^Your scheduler needs you$"#, #"^[^\n\r]{1,40}'s mod stopped reporting$"#, #"^[^\n\r]{1,40}'s Mac is back$"#,
  ]

  public static func isPushPhrase(_ body: String) -> Bool {
    guard body.utf16.count <= 80, !body.unicodeScalars.contains(where: { $0.value < 0x20 && $0 != " " }) else { return false }
    return phrasePatterns.contains { body.range(of: $0, options: .regularExpression) != nil }
  }

  /// A page-requested notification: shown only while the window is not key, only to an in-app path, and only with one of
  /// the push phrases as its body. Anything else the page sends is replaced by "New activity" (never its text).
  public static func web(title: String, body: String, navigate: String, tag: String?, windowIsKey: Bool) -> NativeNotice? {
    guard !windowIsKey, AppPath.isValid(navigate) else { return nil }
    return NativeNotice(
      title: cleanAgentName(title), body: isPushPhrase(body) ? body : "New activity", navigate: navigate,
      tag: "web:" + (tag.map { String($0.prefix(64)) } ?? navigate), quiet: false)
  }

  /// Same tag within `window` seconds is dropped; a different tag is independent.
  public struct RateLimiter: Sendable {
    private var last: [String: Date] = [:]
    public let window: TimeInterval
    public init(window: TimeInterval = 60) { self.window = window }

    public mutating func allow(_ tag: String, now: Date) -> Bool {
      if let t = last[tag], now.timeIntervalSince(t) < window, now >= t { return false }
      last[tag] = now
      if last.count > 200 { last = last.filter { now.timeIntervalSince($0.value) < window } }
      return true
    }
  }
}

/// `quiet_window` and `timezone` from `$TALOS_APP_HOME/config.json` (the same fields the relay's push rules use).
/// Supervisor banners stay silent inside it, like the relay's Mac-side alarms; the menu still shows the state.
public struct QuietWindow: Equatable, Sendable {
  public var start: Int  // minutes after midnight
  public var end: Int
  public var timeZone: TimeZone

  public static func read(_ data: Data?) -> QuietWindow? {
    guard let data, let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      let q = o["quiet_window"] as? [String: Any], let s = minutes(q["start"] as? String), let e = minutes(q["end"] as? String),
      let tzName = o["timezone"] as? String, let tz = TimeZone(identifier: tzName)
    else { return nil }
    return QuietWindow(start: s, end: e, timeZone: tz)
  }

  static func minutes(_ hhmm: String?) -> Int? {
    guard let t = hhmm, t.count == 5, t[t.index(t.startIndex, offsetBy: 2)] == ":", let h = Int(t.prefix(2)),
      let m = Int(t.suffix(2)), (0..<24).contains(h), (0..<60).contains(m)
    else { return nil }
    return h * 60 + m
  }

  /// start == end is no window; the window may wrap midnight.
  public func isQuiet(_ at: Date) -> Bool {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = timeZone
    let c = cal.dateComponents([.hour, .minute], from: at)
    let now = (c.hour ?? 0) * 60 + (c.minute ?? 0)
    if start == end { return false }
    return start < end ? (now >= start && now < end) : (now >= start || now < end)
  }
}
