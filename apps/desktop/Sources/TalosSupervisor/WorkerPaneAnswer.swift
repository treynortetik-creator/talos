import Foundation
import TalosDesktopCore

/// Pane-prompts plan rows 8 and 9, a thread session's side of the ANSWER: what a verified card tap or a real popup click on a tool permission or the
/// agent's question does to the pane. `WorkerManager.press` hands it over; the steps are `PaneAnswerDriver`'s (one number key per choice; a free-text
/// answer's words typed and Enter, each on a fresh read of the offered screen), every key through `WorkerManager.sendKey` with the offer's own
/// binding (`KeyGuard.Intent.pane`), never while a tmux client may be typing.
///
/// Who may get here: a card answer only after `isAuthentic` (the owner's signature from a paired device, over this card, for this sighting, once), a
/// popup click only from the popup button's action behind `NeedsYouPopupView.isRealClick`. An agent, a worker, a synthetic or Accessibility press
/// and an unsigned file never reach it.
extension WorkerManager {
  func pressPane(_ id: String, _ offer: DialogOffer, _ choice: Int, _ chosen: String, text: String?) -> AnswerOutcome {
    guard let bound = rt[id]?.offer.paneBound, offer.options.indices.contains(choice), ExactText.equal(offer.options[choice], chosen) else { return .nothing() }
    let kind: PaneSelect.Kind = offer.kind == .toolPermission ? .toolPermission : .agentQuestion
    let driver = PaneAnswerDriver(
      kind: kind, bound: bound, freeText: offer.free_text,
      read: { [self] in
        let c = run(tmux(id).capturePane())
        return c.ok ? TmuxCommands.parseCapture(c.out) : nil
      },
      typing: { [self] in typingBlock(id).map { $0 == .typing ? PaneAnswerDriver.Blocked.typing : .unreadable } },
      send: { [self] step, intent in
        guard let r = sendKey(id, paneKeyArgv(id, step), intent) else { return .refused }
        return r.ok ? .sent : (r.timedOut ? .unknown : .failed)
      },
      awake: { [self] in awake() }, echoWait: Self.echoWait)
    switch driver.run(option: choice, text: text) {
    case .delivered:
      rt[id]?.offer.enterSentFor = offer.id
      audit("worker_pane_answered thread=\(id) kind=\(offer.kind.rawValue) choice=\(choice)")
      return .init(outcome: .pressed, choice: choice, label: chosen)
    case .unknown:
      // a timeout may have been delivered: no second key for this offer, and the unchanged screen is offered again after a short memory
      rt[id]?.offer.disturbed = true
      rt[id]?.offer.enterUnsentFor = offer.id
      rt[id]?.offer.enterUnsentUntil = awake() + options.unsentEnterMemory
      audit("worker_pane_send_unconfirmed thread=\(id) kind=\(offer.kind.rawValue)")
      return .init(outcome: .nothingPressed, reason: .unconfirmed)  // sent, not seen to take: never reported as an answer that stood
    case .blocked(let b): return .blocked(b == .typing ? .typing : .unreadable)
    case .changed: return .nothing()
    case .partial:
      // the free-text field was focused and the rest was stopped: this offer is spent, the owner finishes it at the Mac
      rt[id]?.offer.disturbed = true
      rt[id]?.offer.enterSentFor = offer.id
      audit("worker_pane_partial thread=\(id) kind=\(offer.kind.rawValue)")
      return .nothing()
    }
  }
}
