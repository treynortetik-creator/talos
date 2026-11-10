import Foundation
import TalosDesktopCore

/// Main's own dialog, on its way into `workers.json` as `supervisor.main_dialog` (the development-channels card, SupervisorDevCard.swift).
/// Main is the supervisor's, not this manager's, so the manager is only handed what to write: `read` gives the offer now (set once, before
/// ticking), and `lastId` is the one the last write carried, so a new or gone offer is written within the tick, not at the next heartbeat.
final class MainDialogFeed: @unchecked Sendable {
  var read: (@Sendable () -> DialogOffer?)?
  private(set) var lastId: String?

  func current() -> DialogOffer? { read?() }

  /// Whether the offer changed since the last write (true once per change).
  func changed() -> Bool {
    let id = current()?.id
    defer { lastId = id }
    return id != lastId
  }
}

extension WorkerManager {
  /// Where the app hands Main's offer over: `workers.mainDialog = { supervisor.status.devDialog }`.
  public func setMainDialog(_ read: @escaping @Sendable () -> DialogOffer?) { mainDialogFeed.read = read }
}
