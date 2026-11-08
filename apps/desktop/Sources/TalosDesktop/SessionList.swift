import Foundation
import TalosDesktopCore
import TalosSupervisor

/// Facts about Main that both the Terminals window and the Terminal screen in the main window list from.
@MainActor
enum SessionList {
  /// Main's facts as the switcher lists them. `hasScreen`: a tmux session for Main exists (live or with a dead pane).
  static func mainFacts(_ model: SupervisorController, hasScreen: Bool) -> SessionSwitcher.MainFacts {
    let state: SessionSwitcher.MainState
    if !model.configured {
      state = .notSetUp
    } else {
      switch model.status.phase {
      case .idle: state = .notStarted
      case .starting, .cleaningUp, .waitingToRestart: state = .starting
      case .running: state = .running
      case .stopping: state = .stopping
      case .blocked: state = .stopped(failure: SupervisorNotice.blocked)
      case .stopped(let r): state = .stopped(failure: r.isFailure ? r.plainSentence : nil)
      }
    }
    var waiting: String?
    switch model.status.needsYou {
    case .dialog(let what)?: waiting = what
    case let n?: waiting = SupervisorController.describe(n)
    case nil: break
    }
    return .init(state: state, hasScreen: hasScreen, needsYou: waiting)
  }

  static func resumeOutcome(_ r: WorkerManager.ResumeRequest) -> TerminalSessions.ResumeOutcome {
    switch r {
    case .asked: return .asked
    case .alreadyPending: return .alreadyPending
    case .parkPending: return .parkPending
    case .failed: return .failed
    }
  }
}
