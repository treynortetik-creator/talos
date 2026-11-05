import AppKit
import Foundation
import TalosDesktopCore

/// Talos starts as a menu-bar-only app (no Dock icon), and macOS gives such an app no menu beside the Apple logo, so Settings
/// and Help there were never visible (measured with a probe, 2026-11-01). While any Talos window is open the app becomes a
/// regular one (a Dock icon appears and the top menu with it); when the last window closes it goes back, unless the owner
/// chose "Show a Dock icon".
@MainActor
final class ActivationPolicyController {
  static let shared = ActivationPolicyController()
  private var observers: [NSObjectProtocol] = []
  var defaults = UserDefaults.standard

  /// A window the owner would call a Talos window: not a panel, not the status item, not the character's overlays.
  static func counts(_ w: NSWindow) -> Bool {
    !(w is NSPanel) && w.level == .normal && w.canBecomeMain && (w.isVisible || w.isMiniaturized)
  }

  func start() {
    refresh()
    guard observers.isEmpty else { return }
    let nc = NotificationCenter.default
    for name in [
      NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didDeminiaturizeNotification,
    ] {
      observers.append(
        nc.addObserver(forName: name, object: nil, queue: .main) { _ in
          MainActor.assumeIsolated { ActivationPolicyController.shared.refresh() }
        })
    }
    observers.append(
      nc.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { note in
        let closing = note.object as? NSWindow
        MainActor.assumeIsolated { ActivationPolicyController.shared.refresh(excluding: closing) }
      })
  }

  /// Sets the policy the windows call for. Switching to a regular app also brings it to the front once, so its menu shows.
  func refresh(excluding closing: NSWindow? = nil) {
    let open = NSApp.windows.contains { $0 !== closing && Self.counts($0) }
    let want = ActivationPolicyRule.policy(showDockIcon: defaults.bool(forKey: "showDockIcon"), hasOpenWindow: open)
    let now: ActivationPolicyRule.Policy = NSApp.activationPolicy() == .regular ? .regular : .accessory
    guard want != now else { return }
    NSApp.setActivationPolicy(want == .regular ? .regular : .accessory)
    if want == .regular { NSApp.activate(ignoringOtherApps: true) }
    AppMenu.shared.repairSoon()
  }
}
