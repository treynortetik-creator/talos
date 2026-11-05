import Foundation

/// The menu bar's picture of Talos: one of four icon states and the menu's first lines (DESKTOP-SPEC 6.2).
public struct HealthSummary: Equatable, Sendable {
  /// `unknown` is a fifth look on purpose (spec call, D4 review): the session is up but Talos can't confirm the bridge
    /// or the relay (no `status.json` yet, relay not checked), so it must not read as fine or as broken.
    public enum Icon: String, Equatable, Sendable, CaseIterable { case ok, working, needsYou, down, unknown }
  public var icon: Icon
  public var lines: [String]
}

public enum HealthModel {
  public enum Session: Equatable, Sendable {
    case notConfigured
    case notStarted
    case starting
    case running(activity: String?)  // `busy` / `waiting` / `idle` from `claude agents --json`
    case restarting
    case stopping
    case stopped(String)
    case blocked
  }

  public struct Inputs: Equatable, Sendable {
    public var session: Session
    /// The session itself needs the owner at the Mac (a dialog, stuck, a cold-start confirm).
    public var sessionNeedsYou: Bool
    /// The web page's Needs-you count (`badge`).
    public var badge: Int
    /// nil = no `status.json` yet (the bridge half isn't deployed): shown as unknown, never as down.
    public var bridge: BridgeStatus.Health?
    /// nil = not checked yet.
    public var relayReachable: Bool?
    /// False when no relay address is known: the relay line says so instead of "checking" forever.
    public var relayConfigured: Bool
    public var host: String  // "tmux" | "owned pty"

    public init(
      session: Session, sessionNeedsYou: Bool = false, badge: Int = 0, bridge: BridgeStatus.Health? = nil,
      relayReachable: Bool? = nil, relayConfigured: Bool = true, host: String = "tmux"
    ) {
      self.session = session
      self.sessionNeedsYou = sessionNeedsYou
      self.badge = badge
      self.bridge = bridge
      self.relayReachable = relayReachable
      self.relayConfigured = relayConfigured
      self.host = host
    }
  }

  public static func summarize(_ i: Inputs) -> HealthSummary {
    HealthSummary(icon: icon(i), lines: lines(i))
  }

  static func icon(_ i: Inputs) -> HealthSummary.Icon {
    switch i.session {
    case .notConfigured: return .down
    case .notStarted, .stopped, .stopping: return .down
    case .blocked: return .needsYou
    case .starting, .restarting, .running: break
    }
    if i.sessionNeedsYou || i.badge > 0 { return .needsYou }
    // Coming up or restarting: the bridge is legitimately absent for a moment; that is not an outage.
    if case .starting = i.session { return .working }
    if case .restarting = i.session { return .working }
    // Healthy needs every input to say so. Not running, not reporting, not connected, not receiving app messages: down.
    if let b = i.bridge, b != .healthy { return .down }
    if i.relayReachable == false { return .down }
    // Nothing is wrong, but nothing is confirmed either: unknown bridge, relay not checked or no relay address.
    if i.bridge == nil || i.relayReachable == nil { return .unknown }
    if case .running(let a) = i.session, a == "busy" { return .working }
    return .ok
  }

  static func lines(_ i: Inputs) -> [String] {
    var out: [String] = []
    switch i.session {
    case .notConfigured: out.append("Session: not set up")
    case .notStarted: out.append("Session: not started · \(i.host)")
    case .starting: out.append("Session: starting · \(i.host)")
    case .running(let a): out.append("Session: \(a ?? "running") · \(i.host)")
    case .restarting: out.append("Session: restarting · \(i.host)")
    case .stopping: out.append("Session: stopping")
    case .stopped(let why): out.append("Session: \(why)")
    case .blocked: out.append("Session: blocked, another session holds the channels")
    }
    if let b = i.bridge {
      switch b {
      case .healthy: out.append("Bridge: connected")
      case .relayDown: out.append("Bridge: running, relay disconnected")
      case .stale: out.append("Bridge: not reporting")
      case .dead: out.append("Bridge: not running")
      case .superseded: out.append("Bridge: replaced by another session")
      case .headless: out.append("Bridge: headless (no app messages)")
      }
    } else {
      out.append("Bridge: unknown")
    }
    switch i.relayReachable {
    case .some(true): out.append("Relay: reachable")
    case .some(false): out.append("Relay: not reachable")
    case .none: out.append(i.relayConfigured ? "Relay: checking" : "Relay: not set (\(MacSettingsText.connectionPath))")
    }
    if i.badge > 0 { out.append("Needs you: \(i.badge)") }
    return out
  }
}
