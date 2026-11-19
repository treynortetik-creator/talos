import Foundation
import TalosDesktopCore

extension WebController {
  /// What became of a Run for the terminal pane that the app accepted or refused, said to the page by its message id (`run_result`): ok,
  /// or why not (`RunResultReason`). A reason and nothing else: never text the shell printed, never the script.
  func tellPageHowARunWent(_ clientMsgId: String, _ answer: PaneRunAnswer) {
    deliver(.runResult(clientMsgId: clientMsgId, ok: answer.ok, reason: RunResultReason.forAnswer(answer)))
  }
}
