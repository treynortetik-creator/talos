import Foundation

extension Supervisor {
  /// A napping app's timers are held back, and the menu-bar app has no window most of the time: the tick carries the start and stop
  /// deadlines, the dev-channel answer, the stall warnings and the status. Held while the tick runs and Main is live, never otherwise.
  /// A tick with nothing live (a passive copy's re-attach look, a phone's restore request after a stop) may run late; such a request
  /// stays valid for minutes. On the queue: from `phase`'s `didSet`, `startTicking` and `detach`.
  func syncNapGuard() {
    if timer != nil && isLive { napGuard.hold() } else { napGuard.release() }
  }
}
