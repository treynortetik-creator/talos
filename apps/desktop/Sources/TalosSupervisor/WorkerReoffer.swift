import Foundation
import TalosDesktopCore

/// A question left standing. A tap-answerable dialog is offered for `cardLifetime` (a day; the card is closed sooner when the question leaves the screen); the person may be away
/// from the Mac for longer, and the agent waits on the question all that time. When the offer's time is up and the SAME dialog is still on THIS look's screen (the check that
/// finds the offer is still the same one, `syncOffer` / `offerPane`, runs on a fresh read of a screen that has held still), it is offered
/// again as a new sighting: a new number, so a new card; the old card is over and a tap on it presses nothing (every answer is for its own
/// offer number, `WorkerDialogAnswer`). There is only ever one offer in the entry, so two are never live for one question. Nothing here
/// offers anything: it only says the old offer's time has passed, and every other rule of a re-offer is the one a first offer already has
/// (an answered, changed or ended dialog is never offered again; a relaunch finds a new sighting; the same-screen checks stay).
///
/// Main's own dialogs do not use this: they re-offer at the same point in `SupervisorPanePrompt` and `SupervisorDevCard`.
/// Twin: `offerRanOut` in apps/bridge/src/supervisor/worker-dialogs.ts.
enum WorkerReoffer {
  /// The offer's time has passed at `wallNow` (seconds, wall clock). A time that cannot be read counts as run out: such an offer can never be
  /// answered, so offering it anew is safe.
  static func ranOut(_ o: DialogOffer, wallNow: Double) -> Bool {
    guard let expires = ISOTime.parse(o.expires_at) else { return true }
    return !(wallNow < expires)
  }
}

extension WorkerManager {
  /// A verified tap of the owner pressed nothing (the typing guard, clients that could not be read, a changed screen, a proof that could not be recorded).
  /// The offer is marked disturbed, which is what every other end of an offer without an answer already does: no answer for its id presses anything,
  /// the popup lists it no more, and the next look at the same dialog on a settled screen is a new sighting with a new id and a new card. Without it the
  /// question would keep a card that has already failed until its day was up. Only a tap that proved itself gets here (a forged one never ends an
  /// offer), and each new card needs a new real tap, so it cannot repeat by itself.
  func endOfferAfterRefusedTap(_ id: String) {
    rt[id]?.offer.disturbed = true
  }
}
