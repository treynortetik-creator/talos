import Foundation

/// The terminal host as a choice in Mac settings → Session (`host` in `desktop.json`). The host is picked once, when Talos
/// opens, so a change applies the next time Talos opens. It cannot be changed while a session is up: a switch with a live tmux
/// agent could leave two sessions on one channel.
public enum HostChoice {
  public static let all: [DesktopConfig.Host] = [.auto, .tmux, .direct]

  public static func label(_ h: DesktopConfig.Host) -> String {
    switch h {
    case .auto: return "Automatic (tmux if it is installed)"
    case .tmux: return "tmux (the agent keeps running when Talos quits)"
    case .direct: return "Talos's own terminal (the agent stops when Talos quits)"
    }
  }

  public static let appliesNote = "Applies the next time Talos opens."
  public static let lockedNote =
    "Stop the session, and any thread sessions, to change this. Switching with an agent running could leave an agent with nothing watching it."

  /// Whether the picker may change right now. A thread's own session in tmux counts as much as the main one: switching to Talos's
  /// own terminal would leave it running with no supervisor (nothing re-adopts it and no Quit reaches it).
  public static func canChange(sessionUp: Bool, workersRunning: Bool = false) -> Bool { !sessionUp && !workersRunning }

  /// The host a launch with this saved choice would use: tmux when it is asked for or automatic and usable, else Talos's own.
  public static func usesTmux(choice: DesktopConfig.Host, tmuxUsable: Bool) -> Bool {
    switch choice {
    case .direct: return false
    case .auto, .tmux: return tmuxUsable
    }
  }

  /// Set when the saved choice differs from the host this run is using. Starting now would run the agent in the old host, and
  /// the next launch would then open on the other one with that agent still alive and nothing in charge of it. nil = go ahead.
  public static func startBlock(saved: DesktopConfig.Host, runningTmux: Bool, tmuxUsable: Bool) -> String? {
    guard usesTmux(choice: saved, tmuxUsable: tmuxUsable) != runningTmux else { return nil }
    return "You changed the terminal host. It applies when Talos next opens, so quit and reopen Talos before starting the session."
  }

  /// What the running app is actually using, in plain words.
  public static func runningLine(tmux: Bool) -> String {
    tmux
      ? "Right now: tmux. The agent keeps running when Talos quits."
      : "Right now: Talos's own terminal. The agent stops when Talos quits."
  }

  /// A warning when the saved choice cannot be honoured: tmux was chosen and is missing or older than 3.2.
  public static func caveat(choice: DesktopConfig.Host, tmuxUsable: Bool) -> String? {
    guard choice == .tmux, !tmuxUsable else { return nil }
    return "tmux 3.2 or newer was not found, so Talos will use its own terminal until it is installed."
  }

  /// The choice the saved file holds, or nil for a value this build doesn't know (a newer build wrote it).
  public static func parse(_ raw: String) -> DesktopConfig.Host? { DesktopConfig.Host(rawValue: raw) }
}
