import Foundation

/// The menu bar's picture of Talos: one of four icon states and the menu's first lines (DESKTOP-SPEC 6.2).
public struct HealthSummary: Equatable, Sendable {
  /// `unknown` is a fifth look on purpose (spec call, D4 review): the session is up but Talos can't confirm the bridge
    /// or the relay (no `status.json` yet, relay not checked), so it must not read as fine or as broken.
    public enum Icon: String, Equatable, Sendable, CaseIterable { case ok, working, needsYou, down, unknown }
  public var icon: Icon
  public var lines: [String]
  /// The one line the Your agent tab shows under its heading, and whether it is good news.
  public var headline: Headline = Headline(text: "", ok: false)
  /// The same word the menu's "Your Mac:" line ends with (connected / not connected / checking): whether Talos on this Mac is
  /// carrying the agent's messages to the Talos server. The Phone & Mac tab reads it, so the two never disagree.
  public var macConnection: String = ""

  public struct Headline: Equatable, Sendable {
    public var text: String
    public var ok: Bool
    public init(text: String, ok: Bool) {
      self.text = text
      self.ok = ok
    }
  }
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
    HealthSummary(icon: icon(i), lines: lines(i), headline: headline(i), macConnection: macWord(i))
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

  /// The menu's first lines, in the shared words (web and iPhone say the same): "your agent", "Talos server", "your Mac". The
  /// engineer words (session, bridge, relay, tmux) live in Advanced only (`MacWords`).
  static func lines(_ i: Inputs) -> [String] {
    var out: [String] = []
    out.append(MacWords.agentLine(agentWord(i.session)))
    out.append(MacWords.serverLine(serverWord(i)))
    out.append(MacWords.macLine(macWord(i)))
    if i.badge > 0 { out.append("Needs you: \(i.badge)") }
    return out
  }

  /// "Running · Talos server connected": the agent first, then how far it can be reached. Orange until both are well.
  static func headline(_ i: Inputs) -> HealthSummary.Headline {
    let busy: Bool = { if case .running(let a) = i.session { return a == "busy" } else { return false } }()
    let lead: String
    switch i.session {
    case .notConfigured: return .init(text: "Not set up yet", ok: false)
    case .notStarted, .stopped, .blocked: return .init(text: "Not running", ok: false)
    case .starting, .restarting: return .init(text: "Starting\u{2026}", ok: false)
    case .stopping: return .init(text: "Stopping\u{2026}", ok: false)
    case .running: lead = busy ? "Working" : "Running"
    }
    let server = serverWord(i)
    return .init(text: lead + " \u{00B7} Talos server " + server, ok: server == "connected")
  }

  /// running / starting / not running (and not set up before the Mac has an agent folder).
  static func agentWord(_ s: Session) -> String {
    switch s {
    case .notConfigured: return "not set up"
    case .notStarted, .stopped, .blocked: return "not running"
    case .starting, .restarting: return "starting"
    case .running: return "running"
    case .stopping: return "stopping"
    }
  }

  /// connected / can't reach / not set up (and "checking" until the first answer).
  static func serverWord(_ i: Inputs) -> String {
    switch i.relayReachable {
    case .some(true): return "connected"
    case .some(false): return "can't reach"
    case .none: return i.relayConfigured ? "checking" : "not set up"
    }
  }

  /// "Your Mac" is Talos on this Mac, the part that carries the agent's messages to the Talos server: connected / not connected.
  /// Unknown is "checking" only while the agent is coming up or running (it has not reported yet); otherwise nothing is connected.
  static func macWord(_ i: Inputs) -> String {
    switch i.bridge {
    case .healthy?, .relayDown?: return "connected"
    case .stale?, .dead?, .superseded?, .headless?: return "not connected"
    case nil:
      switch i.session {
      case .starting, .restarting, .running: return "checking"
      default: return "not connected"
      }
    }
  }
}
