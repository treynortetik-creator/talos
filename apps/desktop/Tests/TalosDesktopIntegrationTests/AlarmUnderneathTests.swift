import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// What the one `needsYou` slot goes back to when a warning about another dialog is over. Pure: no tmux, no process.
@Suite("Supervisor: the alarm under a dialog's warning")
struct AlarmUnderneathTests {
  func launch(_ notified: Set<String> = [], question: Supervisor.NeedsYou? = nil) -> Supervisor.Launch {
    var l = Supervisor.Launch(
      kind: .cold, resumeId: nil, sessionId: "s", startedAt: 0, childPid: 1, fingerprint: "f", cliVersion: nil, expectsDevDialog: true,
      devDialogSeen: nil)
    l.notifiedScreens = notified
    l.question = question
    return l
  }
  func back(_ l: Supervisor.Launch, _ phase: Supervisor.Phase = .starting, devDialog: Bool = true) -> Supervisor.NeedsYou? {
    Supervisor.alarmUnderneath(l, phase: phase, devDialogOnScreen: devDialog)
  }

  @Test func theColdStartQuestionComesBackWhileTheDevChannelDialogIsUp() {
    #expect(back(launch(["cold"], question: .confirmColdStart)) == .confirmColdStart)
  }

  @Test func aRefusedRestartComesBackWithItsOwnReason() {
    for why in [AutoConfirmGuard.Refusal.channelsMismatch, .wrongHighlight, .outsideWindow, .alreadyConfirmedThisStart] {
      #expect(back(launch(["refuse"], question: .restartNotConfirmed(why))) == .restartNotConfirmed(why), "\(why)")
    }
  }

  @Test func theQuestionIsOnlyAboutTheDialogThatIsUp() {
    let l = launch(["cold"], question: .confirmColdStart)
    #expect(back(l, devDialog: false) == nil, "the dev-channel dialog is not on screen: nothing to press Enter on")
    #expect(back(l, .running) == nil, "the start is over")
    #expect(back(launch(["cold", "start"], question: .confirmColdStart), devDialog: false) == .startStalled, "the old fallbacks stay")
  }

  @Test func theQuestionOutranksTheStartStalledWarningWhileItsDialogIsUp() {
    #expect(back(launch(["cold", "start"], question: .confirmColdStart)) == .confirmColdStart)
  }

  @Test func stuckAndStartStalledComeBackAsBefore() {
    #expect(back(launch(["stuck"]), .running, devDialog: false) == .stuck)
    #expect(back(launch(["start"]), .starting, devDialog: false) == .startStalled)
    #expect(back(launch(["start"]), .running, devDialog: false) == nil)
    #expect(back(launch(), .starting, devDialog: false) == nil)
  }
}
