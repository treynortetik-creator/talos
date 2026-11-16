import Foundation
import TalosDesktopCore

/// Where Main's first start stands, for the setup screen: the development-channel warning is answered in the Talos popup (already
/// there), and the step says "done" only when Main's Talos bridge is live (`Status.bridgeLive`, from `status.json`). A failure carries
/// the reason from Claude Code's MCP log, the same sentence the Needs-you line uses.
public enum FirstStartCheck {
  public enum State: Equatable, Sendable {
    case notStarted
    case warning
    /// A dialog only the owner answers (trust, connector consent, sign-in): it opens Terminal, not the popup.
    case terminalDialog
    case blocked
    case waitingForBridge
    case done
    case failed(String)
    case stopped

    public var isDone: Bool { self == .done }

    public var message: String {
      switch self {
      case .notStarted: return OnboardingText.firstStartIdle
      case .warning: return OnboardingText.firstStartWarning
      case .terminalDialog: return OnboardingText.firstStartTerminal
      case .blocked: return OnboardingText.firstStartBlocked
      case .waitingForBridge: return OnboardingText.firstStartWaiting
      case .done: return OnboardingText.firstStartDone
      case .failed(let why): return why
      case .stopped: return OnboardingText.firstStartStopped
      }
    }
  }

  public static func state(_ s: Supervisor.Status) -> State { state(phase: s.phase, needsYou: s.needsYou, bridgeLive: s.bridgeLive) }

  public static func state(phase: Supervisor.Phase, needsYou: Supervisor.NeedsYou?, bridgeLive: Bool) -> State {
    if case .bridgeNotLive(let why)? = needsYou { return .failed(SupervisorNotice.bridgeNotLive(why)) }
    switch phase {
    case .idle: return .notStarted
    case .blocked: return .blocked
    case .stopped, .stopping: return .stopped
    case .starting, .running, .cleaningUp, .waitingToRestart:
      if phase == .running, bridgeLive { return .done }
      switch needsYou {
      case .stuck?, .startStalled?: return .failed(OnboardingText.firstStartStalled)
      case .dialog?: return .terminalDialog
      case .some: return .warning
      case nil: return .waitingForBridge
      }
    }
  }
}
