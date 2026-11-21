import Foundation

/// "Keep it working when I quit Talos": the plain face of the terminal host choice (`host` in `desktop.json`). On is the automatic
/// host, which keeps the agent in tmux when tmux is usable (so it outlives Talos); off is Talos's own terminal, which stops with
/// Talos. The three-way choice stays in Advanced; this switch is the same setting with the engineer words taken out.
public enum KeepWorking {
  /// What the switch shows: the agent really would outlive Talos with this saved choice on this Mac.
  public static func isOn(choice: DesktopConfig.Host, tmuxUsable: Bool) -> Bool {
    HostChoice.usesTmux(choice: choice, tmuxUsable: tmuxUsable)
  }

  /// What a flip saves.
  public static func choice(turningOn on: Bool) -> DesktopConfig.Host { on ? .auto : .direct }

  /// Why the switch cannot be flipped right now, in plain words; nil when it can.
  public static func lockNote(sessionUp: Bool, workersRunning: Bool, helperAvailable: Bool) -> String? {
    if sessionUp && workersRunning { return "Stop your agent and your thread agents to change this." }
    if workersRunning { return "Stop your thread agents to change this." }
    if sessionUp { return "Stop your agent to change this." }
    if !helperAvailable { return "Your agent stops when you quit Talos: this Mac is missing a helper that keeps it going." }
    return nil
  }
}
