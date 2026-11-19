import Foundation

/// A recorded clone the updater asked the owner to accept (`AutoUpdater.Hooks.offerClone`): the Agent folder panel shows its existing
/// "Use this clone" card for it. Only the owner's press accepts; nothing here does.
@MainActor
final class CloneConfirmCenter: ObservableObject {
  static let shared = CloneConfirmCenter()
  @Published private(set) var pending: String?
  func request(_ clone: String) { pending = clone }
  func clear() { pending = nil }
}
