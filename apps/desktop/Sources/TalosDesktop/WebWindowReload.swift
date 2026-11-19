import AppKit
import Foundation
import WebKit

/// View > Reload (Cmd-R), kept apart from `WebWindow.swift`.
extension WebController {
  /// True when the Talos web window (not the terminal window, Settings or any other) is the key or main window.
  var webWindowIsFront: Bool {
    guard webView != nil, let w = window else { return false }
    return w.isKeyWindow || w.isMainWindow
  }

  /// The page loads again so a new relay or web build shows, with no quit and no new session. Only when the web window is the front
  /// one; otherwise nothing happens. It reloads the page's current address, so the route stays; when there is none yet (a first load
  /// that failed) it loads the start address, like Try now. A new document asks for its terminal room again (`pageReady` going false
  /// closes the view and stops the tab list push), but the sessions belong to the Mac app, not to the page, so none of them stops.
  /// Returns whether it acted.
  @discardableResult
  func reloadFrontWindow() -> Bool {
    guard webWindowIsFront, let wv = webView else { return false }
    if wv.url != nil, !loadFailed {
      cancelRetries()
      wv.reload()
    } else if let relay {
      cancelRetries()
      wv.load(URLRequest(url: relay.url))
    } else {
      return false
    }
    return true
  }
}
