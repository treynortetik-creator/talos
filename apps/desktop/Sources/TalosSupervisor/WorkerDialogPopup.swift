import Foundation
import TalosDesktopCore

/// Needs-you prompts, the Mac popup: the manager's side (docs/OPTION-C.md "Needs-you prompts: the Mac side, as built"). The popup lists what is
/// on offer (`popupOffers`) and asks `popupAnswer` for the owner's click. A click is the owner's, at the Mac, so it needs no proof; it reaches
/// here only from the popup button's action on the main thread (nothing reads a file, a URL scheme, an AppleScript or a notification for it).
/// It is then the SAME press as a verified card answer: the dialog id is the one offered now, the label is the one the owner saw and the one
/// the screen shows now at that row, the typing guard fails closed, the arrows and the Enter come from the fresh cursor row, and the
/// once-per-dialog rule is shared with the card (whichever comes first presses). It runs on the worker queue, so the main thread never waits.
extension WorkerManager: NeedsYouPopupSource {}

extension WorkerManager {
  /// The dialogs a popup may show: ones THIS process has seen on the screen hold still (`sinceAwake`), never a record read back from
  /// workers.json; not past `expires_at`; not pressed or opened (by a card or a click). A result that pressed nothing (a forged answer, a
  /// phone that is not paired) closes nothing: the popup is then the way to answer.
  public func popupOffers() -> [NeedsYouPopupItem] {
    let t = now()
    return published().popup.filter { (ISOTime.parse($0.dialog.expires_at) ?? 0) > t }
  }

  /// What `publish` puts out for `popupOffers`. On the queue.
  func popupItems() -> [NeedsYouPopupItem] {
    var out: [NeedsYouPopupItem] = []
    for id in rt.keys.sorted() {
      guard let r = rt[id], let d = r.entry.dialog, r.offer.sinceAwake != nil, Self.offerStates.contains(r.entry.state), d.isValid,
        !r.offer.pressed(d.id)
      else { continue }
      out.append(NeedsYouPopupItem(thread: id, threadName: threadName(id), dialog: d))
    }
    return out
  }

  /// The owner clicked a popup button. `completion` is called on the worker queue, after the result file is written and before any tick can
  /// drop the dialog from workers.json.
  public func popupAnswer(
    thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void
  ) {
    queue.async {
      let result = self.popupClick(thread, dialogId, action)
      self.publish()
      completion(result)
    }
  }

  private func popupClick(_ id: String, _ dialogId: String, _ action: NeedsYouPopupAction) -> PopupAnswerResult {
    guard WorkerSpec.isThreadId(id), let r = rt[id], let offer = r.entry.dialog, r.offer.sinceAwake != nil, folderIsReal(id),
      ExactText.equal(offer.id, dialogId), let expires = ISOTime.parse(offer.expires_at), now() < expires
    else { return .nothing(.notOffered) }
    // one press per dialog id, whoever comes first: a verified card answer pressed (or opened) already
    if r.offer.pressed(offer.id) {
      return .nothing(.alreadyAnswered(by: DialogCardAck.answered(path: dir(id) + "/" + DialogCardAck.fileName, dialogId: offer.id)))
    }
    switch action {
    case .choose(let choice, let label):
      guard offer.kind != .login else { return .nothing(.notOffered) }  // a login dialog has nothing to choose
      guard offer.options.indices.contains(choice), ExactText.equal(offer.options[choice], label) else { return .nothing(.screenChanged) }
      let o = press(id, offer, choice, label)
      guard o.outcome == .pressed else {
        switch o.blocked {
        case .typing?: return .nothing(.typing)
        case .unreadable?: return .nothing(.couldNotCheck)
        case nil: return .nothing(.screenChanged)
        }
      }
      writeMacResult(id, offer, .pressed, choice: choice, label: label)
      return .pressed(choice: choice, label: label)
    case .open:
      guard offer.kind == .login else { return .nothing(.notOffered) }
      guard let open = openTerminals, open(id) else { return .nothing(.noWindow) }
      rt[id]?.offer.openedFor = offer.id
      writeMacResult(id, offer, .opened)
      return .opened
    }
  }

  /// `source: 'mac'`, 0600, atomic, written through the same checked folder as a card result. No result is ever written for a click that
  /// pressed nothing: the schema has no mac `nothing_pressed`.
  private func writeMacResult(_ id: String, _ offer: DialogOffer, _ outcome: DialogResult.Outcome, choice: Int? = nil, label: String? = nil) {
    guard folderIsReal(id) else { return }
    let data = DialogResult.encodeMac(dialogId: offer.id, outcome: outcome, choice: choice, label: label, at: now())
    try? AtomicFile.write(data, to: dir(id) + "/" + DialogResult.fileName, mode: 0o600)
  }
}
