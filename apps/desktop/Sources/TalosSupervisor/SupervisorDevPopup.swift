import Foundation
import TalosDesktopCore

/// Main's development-channels warning on the Mac's own Needs-you popup. Main's bridge is Main's child (an MCP server of its claude process),
/// so while Main sits on this warning no bridge runs and no card can be posted: the popup is the path. A REAL click on "I am using this for
/// local development" is the same press as a verified card tap (`pressDevChoice`: a fresh look at the screen, the typing guard, at most one
/// arrow, one Enter) and seals the launch (`recordStartConfirmed(ownerConfirmed:)`, the key made if there is none). "Exit" presses Exit and
/// stores nothing. A click reaches here only from the popup button's action (`NeedsYouPopupView.isRealClick`, then the controller): no file, URL
/// scheme, AppleScript or notification asks for it, and a pane Enter still seals nothing.
public final class MainAndWorkersPopupSource: NeedsYouPopupSource, @unchecked Sendable {
  private let workers: NeedsYouPopupSource
  private let main: Supervisor
  public init(workers: NeedsYouPopupSource, main: Supervisor) {
    self.workers = workers
    self.main = main
  }

  public func popupOffers() -> [NeedsYouPopupItem] { workers.popupOffers() + (main.mainPopupItem().map { [$0] } ?? []) }

  public func popupAnswer(thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void) {
    if thread == Supervisor.mainPopupThread {
      main.popupAnswerMain(dialogId: dialogId, action: action, completion: completion)
    } else {
      workers.popupAnswer(thread: thread, dialogId: dialogId, action: action, completion: completion)
    }
  }
}

/// The workers' side when there are none (no tmux session host): Main's warning still has its popup.
public final class NoWorkerPopups: NeedsYouPopupSource, @unchecked Sendable {
  public init() {}
  public func popupOffers() -> [NeedsYouPopupItem] { [] }
  public func popupAnswer(thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void) {
    completion(.nothing(.notOffered))
  }
}

extension Supervisor {
  /// Main has no thread of its own; this is not a thread id, so no worker can be mistaken for it.
  public static let mainPopupThread = "supervisor:main"

  /// The popup item for Main's warning while it is offered and not past its time; nil when none.
  public func mainPopupItem() -> NeedsYouPopupItem? {
    guard let d = status.devDialog, d.isValid, (ISOTime.parse(d.expires_at) ?? 0) > options.wallClock() / 1000 else { return nil }
    return NeedsYouPopupItem(thread: Self.mainPopupThread, threadName: "Main", dialog: d, phoneTold: status.devPhoneTold, first: true)
  }

  /// The owner clicked a button of Main's popup. `completion` is called on the supervisor queue.
  public func popupAnswerMain(dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void) {
    q.async { completion(self.mainPopupClick(dialogId, action)) }
  }

  private func mainPopupClick(_ dialogId: String, _ action: NeedsYouPopupAction) -> PopupAnswerResult {
    guard var l = launch, let offer = l.devCard.offer, ExactText.equal(offer.id, dialogId), let expires = ISOTime.parse(offer.expires_at),
      options.wallClock() / 1000 < expires
    else { return .nothing(.notOffered) }
    // one key per sighting, whoever comes first: a card tap or the guard's own Enter pressed already
    guard l.devCard.pressedFor != offer.id, l.confirmsSent <= l.devCard.confirmsAtOffer else { return .nothing(.alreadyAnswered(by: nil)) }
    guard case .choose(let choice, let label) = action else { return .nothing(.notOffered) }
    guard offer.options.indices.contains(choice), ExactText.equal(offer.options[choice], label) else { return .nothing(.screenChanged) }
    let o = pressDevChoice(choice, label, offer, via: "popup", launch: &l)
    launch = l
    guard o.outcome == .pressed else {
      switch o.blocked {
      case .typing?: return .nothing(.typing)
      case .unreadable?: return .nothing(.couldNotCheck)
      case nil: return .nothing(.screenChanged)
      }
    }
    return .pressed(choice: choice, label: label)
  }

  /// `talos-app post` to the default thread: one plain line per start, the first time Main's warning is offered, and only when the owner
  /// is probably not at the Mac: a cold start the phone or a recovery began (`recovery.postColdStart`), or a crash restart. An owner who
  /// starts Main himself sees the popup. It needs no bridge (the Mac runs the command itself), which is the point: Main's own bridge cannot
  /// run while Main waits.
  func postDevWaitingToPhone(launch l: inout Launch) {
    guard !l.devCard.phonePosted, recovery.postColdStart || l.kind == .supervisorRestart else { return }
    l.devCard.phonePosted = true
    recovery.postColdStart = false
    l.devCard.phoneTold = postToPhone { _ in NeedsYouPopupContent.devWaitingPhone }
  }
}
