import AppKit
import TalosDesktopCore

/// Sign out of this Mac's Talos window: asked first, with the exact effect, from every place that offers it (the menu bar item, the
/// top menu, Phone & Mac). It is not the Claude account and not Disconnect this Mac.
@MainActor
enum SignOutAction {
  /// The yes/no. A test replaces it; the app asks with a real alert.
  static var confirm: () -> Bool = {
    let a = NSAlert()
    a.messageText = MacWords.signOutTitle
    a.informativeText = MacWords.signOutBody
    a.addButton(withTitle: MacWords.signOutButton)
    a.addButton(withTitle: "Cancel")
    return a.runModal() == .alertFirstButtonReturn
  }
  /// What a yes does. A test replaces it.
  static var perform: (WebController) async -> Void = { await $0.signOut() }

  static func run(web: WebController = .shared) {
    guard confirm() else { return }
    Task { await perform(web) }
  }
}
