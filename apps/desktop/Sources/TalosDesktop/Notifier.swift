import AppKit
import Foundation
import TalosDesktopCore
@preconcurrency import UserNotifications

/// macOS notifications (DESKTOP-SPEC 6.1). Texts come only from `NotificationPolicy` (fixed phrases). Permission is
/// asked the first time something would show. A click brings the window forward and, when the notice carries an
/// in-app path, navigates the page there.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  static let shared = Notifier()
  private var limiter = NotificationPolicy.RateLimiter(window: 60)
  private var center: UNUserNotificationCenter? {
    // `swift run` has no bundle; UserNotifications would trap.
    Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
  }

  func start() {
    center?.delegate = self
  }

  /// What macOS says now, for the page's Settings. nil when there is no app bundle to ask for (`swift run`).
  func currentPermission(_ done: @escaping @MainActor (NotifyPermission?) -> Void) {
    guard let center else { return done(nil) }
    center.getNotificationSettings { s in
      let p = NotifyPermission(authorizationStatusRaw: s.authorizationStatus.rawValue)
      Task { @MainActor in done(p) }
    }
  }

  /// Tests: sees every notice that passed the rate limit, whether or not macOS can show it (a build with no app bundle has no
  /// notification center, and a test must still see what the app decided to say).
  var observer: ((NativeNotice) -> Void)?
  func resetRateLimitForTest() { limiter = NotificationPolicy.RateLimiter(window: 60) }

  func show(_ n: NativeNotice) {
    guard limiter.allow(n.tag, now: Date()) else { return }
    observer?(n)
    guard let center else { return }
    center.getNotificationSettings { s in
      switch s.authorizationStatus {
      case .notDetermined:
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
          if ok { Self.post(center, n) }
          // The answer changes what Settings should say.
          Task { @MainActor in WebController.shared.pushNotifyPermission() }
        }
      case .authorized, .provisional, .ephemeral: Self.post(center, n)
      default: break
      }
    }
  }

  nonisolated private static func post(_ center: UNUserNotificationCenter, _ n: NativeNotice) {
    let c = UNMutableNotificationContent()
    c.title = n.title
    c.body = n.body
    c.sound = n.quiet ? nil : .default
    if let p = n.navigate { c.userInfo = ["navigate": p] }
    if n.opensTerminal { c.userInfo = ["terminal": true] }
    center.add(UNNotificationRequest(identifier: n.tag, content: c, trigger: nil))
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    let path = info["navigate"] as? String
    let terminal = info["terminal"] as? Bool == true
    Task { @MainActor in
      // "Talos needs you at the Mac" means the pane, not the chat (audit D8).
      if terminal {
        TerminalWindowController.shared.show()
        return
      }
      WebController.shared.show()
      if let path { WebController.shared.sendWhenReady(.navigate(path: path)) }
    }
    completionHandler()
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner])
  }
}
