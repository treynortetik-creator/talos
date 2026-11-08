import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop

/// The menu's "needs you" line describes what `status.needsYou` holds now, not what the last event said. The supervisor puts a
/// question back quietly (no event) after a blank screen or when a warning about another dialog ends, so the text set by an
/// earlier event can be about a different dialog. Pure: no controller, no process, no tmux.
@MainActor
@Suite("Menu notice follows status.needsYou")
struct MenuNoticeFollowsTests {
  typealias C = SupervisorController
  func eventNotice(_ n: Supervisor.NeedsYou) -> String { "\(SupervisorNotice.needsYou): \(C.describe(n))" }
  func shown(_ notice: String, sentBy event: String?, now: Supervisor.NeedsYou?) -> String {
    C.following(notice, eventNotice: event, current: now)
  }

  @Test func theFolderTrustLineBecomesTheColdStartQuestionWhenItIsRestoredQuietly() {
    let trust = eventNotice(.dialog("folder trust"))
    #expect(trust.contains("folder trust"))
    let text = shown(trust, sentBy: trust, now: .confirmColdStart)
    #expect(text == eventNotice(.confirmColdStart))
    #expect(text.contains("dev-channel") && !text.contains("folder trust"))
  }

  @Test func theTrustToDevChannelHandOverWithoutAnEventShowsTheDevChannelQuestion() {
    // trust stalls (event) -> a blank frame empties the slot -> the dev-channel dialog returns and the question is restored quietly
    let trust = eventNotice(.dialog("folder trust"))
    #expect(shown(trust, sentBy: trust, now: .dialog("folder trust")) == trust, "still the same dialog")
    #expect(shown(trust, sentBy: trust, now: .confirmColdStart) == eventNotice(.confirmColdStart))
    // the slot moves straight from one dialog's alarm to another's
    #expect(shown(trust, sentBy: trust, now: .dialog("MCP consent")) == eventNotice(.dialog("MCP consent")))
  }

  @Test func everyQuestionIsDescribedByTheSameWordsAsTheTerminalsRow() {
    let all: [Supervisor.NeedsYou] = [
      .dialog("folder trust"), .confirmColdStart, .restartNotConfirmed(.channelsMismatch), .stuck, .startStalled,
    ]
    let old = eventNotice(.dialog("login"))
    for n in all { #expect(shown(old, sentBy: old, now: n) == eventNotice(n), "\(n)") }
  }

  @Test func nothingWaitingLeavesTheTextAloneAndTheMenuHidesIt() {
    let trust = eventNotice(.dialog("folder trust"))
    #expect(shown(trust, sentBy: trust, now: nil) == trust, "the text is only rewritten while something waits")
    #expect(SupervisorNotice.isStale(shown(trust, sentBy: trust, now: nil), phase: .running, needsYou: false))
    #expect(!SupervisorNotice.isStale(shown(trust, sentBy: trust, now: .confirmColdStart), phase: .starting, needsYou: true))
  }

  @Test func otherNoticesAreNotRewritten() {
    let others = [
      "\(SupervisorNotice.needsYou): the Sales session is waiting on a 'Bash command' prompt. Open Terminals…",  // a thread session's
      SupervisorNotice.restarted, SupervisorNotice.stoppedRestarting, SupervisorNotice.resumeFailed,
      "\(SupervisorNotice.blocked): Another Claude session holds Telegram.", SupervisorNotice.confirmFailed,
      SupervisorNotice.couldNotStart, SupervisorNotice.crashedNoRestart, SupervisorNotice.recovery(.restartedOnRequest),
    ]
    let event = eventNotice(.dialog("folder trust"))
    for n in others {
      #expect(shown(n, sentBy: event, now: .confirmColdStart) == n, "\(n)")
      #expect(shown(n, sentBy: nil, now: .confirmColdStart) == n, "\(n)")
    }
  }

  @Test func aThreadSessionsLineThatIsTheSameWordsAsNothingStaysPut() {
    // no supervisor event has set a line yet: a needs-you line is a thread session's, and it is left as it is
    let thread = "\(SupervisorNotice.needsYou): the Sales session is waiting on a 'Bash command' prompt. Open Terminals…"
    #expect(shown(thread, sentBy: nil, now: .stuck) == thread)
  }
}
