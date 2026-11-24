import Foundation
import TalosDesktopCore

/// Pane-prompts plan rows 8 and 9, a thread session's side: a tool permission or the agent's own question on the pane, read exactly
/// (`PaneSelect`), is offered in the thread's `workers.json` entry as `dialog` (kind `tool_permission` / `agent_question`), so the bridge makes a card
/// with buttons and the Mac popup lists the same. Offered like every dialog: only on a screen that has held still, one sighting per id, the same
/// unknown-delivery memory and re-offer after a timed-out answer key (`unsentEnterMemory`).
///
/// What is offered is NOT the screen's rows: a tool permission offers `Allow once` and `Deny` only (the rows that grant more than this once stay at
/// the Mac), and a question offers its rows with the free-text one as `Other…`. The offer is tied to the exact screen it was made for
/// (`OfferState.paneBound`), and every key of the answer is checked against that screen (WorkerPaneAnswer.swift).
extension WorkerManager {
  /// One look at a pane that shows no known dialog. True when this is a tool permission or a question (or the offer for one is still standing):
  /// nothing else then ends or replaces the offer. The Select is offered once its own rows have held still for `dialogSettle`; an offer ends when
  /// the pane has shown none for that long; a different screen is a new sighting with a new id.
  func syncPane(_ id: String, rows: [String]) -> Bool {
    guard let r = rt[id] else { return false }
    let t = awake()
    guard let s = PaneSelect.read(rows: rows) else {
      guard r.offer.isPane else { return false }
      if rt[id]?.offer.paneGoneSince == nil { rt[id]?.offer.paneGoneSince = t }
      rt[id]?.offer.paneSeen = nil
      if t - (rt[id]?.offer.paneGoneSince ?? t) >= options.dialogSettle { endOffer(id) }
      return true
    }
    rt[id]?.offer.paneGoneSince = nil
    if r.offer.paneSeen != s.bound {
      rt[id]?.offer.paneSeen = s.bound
      rt[id]?.offer.paneSince = t
    }
    // a different screen in place of the offered one: that offer ends (a tap for it presses nothing) and a new sighting follows once it holds still
    if r.offer.isPane, r.offer.paneBound != s.bound, r.entry.dialog != nil, r.offer.enterUnsentFor == nil { endOffer(id) }
    if t - (rt[id]?.offer.paneSince ?? t) >= options.dialogSettle { offerPane(id, s) }
    return true
  }

  func offerPane(_ id: String, _ s: PaneSelect.Screen) {
    guard let r = rt[id] else { return }
    let offered = PaneSelect.offered(s)
    let kind = DialogReader.Kind(rawValue: s.kind.rawValue) ?? .agentQuestion
    let subject = s.displaySubject
    let free = PaneSelect.freeTextOption(s)
    rt[id]?.offer.misses = 0
    func same(_ o: DialogOffer) -> Bool {
      o.kind == kind && ExactText.equal(o.subject, subject) && ExactText.equal(o.options, offered) && o.free_text == free && r.offer.paneBound == s.bound
    }
    // inside the memory of an answer key that may have landed: neither answerable nor re-offered yet
    if let o = r.entry.dialog, r.offer.enterUnsentFor == o.id, same(o), awake() < r.offer.enterUnsentUntil { return }
    let t = now()
    // the same sighting, still there, not answered, not seen to change and not run out of time (a question left standing is offered
    // again under a new id once its card's time is up: `WorkerReoffer`)
    if let o = r.entry.dialog, same(o), !r.offer.disturbed, r.offer.enterSentFor != o.id, r.offer.sinceAwake != nil,
      !WorkerReoffer.ranOut(o, wallNow: t)
    {
      return
    }
    rt[id]?.entry.dialog = DialogOffer(
      id: DialogOffer.newId(), kind: kind, subject: subject, options: offered, cursor: nil, free_text: free, seen_at: ISOTime.string(t),
      expires_at: ISOTime.string(t + options.cardLifetime))
    rt[id]?.offer.sinceAwake = awake()
    rt[id]?.offer.disturbed = false
    rt[id]?.offer.enterUnsentFor = nil
    rt[id]?.offer.paneBound = s.bound
    dirty = true
  }
}
