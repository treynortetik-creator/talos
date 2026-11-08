import AppKit
import Foundation
import TalosDesktopCore

// The controller's settings keys and the hooks it needs from the rest of the app, kept out of the controller itself.
extension CompanionController {
  enum Key {
    static let enabled = "companion.enabled"
    static let size = "companion.size"
    static let moments = "companion.moments"
    static let snoozeUntil = "companion.snoozeUntil"
    static let display = "companion.display"
    static let posPrefix = "companion.pos."
    /// C-LIVE: also post the page's reply banners while he is on (spec 4.3). Off by default.
    static let replyBanners = "companion.replyBanners"
    /// Mini Talos delivers thread replies in his bubble (header, first line, Open and Later). On unless turned off; off is the plain one-line bubble.
    static let replyBubbles = "companion.replyBubbles"
  }

  /// Everything the controller needs from the rest of the app, so tests can stand in for it.
  @MainActor struct Host {
    var openTalos: () -> Void = {}
    var openSettings: () -> Void = {}
    var showCompose: (_ anchor: NSRect?) -> Void = { _ in }
    var composeIsVisible: () -> Bool = { false }
    var screens: () -> [CompanionScreen] = { CompanionController.liveScreens() }
    /// Opens Talos at an in-app path (`/t/<id>`, or `/` for Home): `web.show()` then `navigate`.
    var openPath: (_ path: String) -> Void = { _ in }
    var showTerminal: () -> Void = {}
    /// The page's newest agent reply in a thread, as plain text; the outcome comes once.
    var requestReply: (_ thread: String, _ done: @escaping @MainActor (LastReplyTracker.Outcome) -> Void) -> Void = { _, done in done(.unavailable) }
    var cancelReply: () -> Void = {}
    /// The fixed-phrase "New reply in <thread>" banner, posted when he took a reply and never showed it, or a held one waited too long.
    var postReplyBanner: (_ thread: String, _ name: String) -> Void = { _, _ in }
    /// Tells the page whether he delivers new replies himself right now, and which held replies he just showed or posted.
    var setRepliesFlag: (_ on: Bool, _ shown: [HeldReply], _ epoch: Int) -> Void = { _, _, _ in }
  }
}
