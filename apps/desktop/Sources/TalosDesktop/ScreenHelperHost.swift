import Foundation
import TalosDesktopCore

/// The screen helper's socket for the running app, in the Talos home the app uses now: started with the app and moved when
/// desktop.json names another home. Only an installed app (a `.app` bundle) answers, so no test process ever binds the real
/// home's socket. Every capture and event runs in this process, so macOS asks about Talos.app.
@MainActor
final class ScreenHelperHost {
  static let shared = ScreenHelperHost()
  private var socket: ScreenSocket?
  private var home: String?
  /// The owner's allowed apps in the home the socket serves (Settings shows and edits the same one).
  private(set) var store: ScreenAllowStore?
  /// Why the screen socket is not answering, for Setup's live test; nil while it answers. Written on the main thread only.
  nonisolated(unsafe) static var notServingReason: String? = "it has not started yet"
  /// Talos's own hotkeys as set now (quick compose), kept for the screen helper: an agent never presses them. Written on the main
  /// thread, read on the socket's: behind a lock.
  nonisolated static let talosHotkeys = LockedValue<[ScreenKeyCombo]>([])

  func follow(home: String) {
    guard Bundle.main.bundlePath.hasSuffix(".app") else {
      Self.notServingReason = "this copy of Talos is not the installed app"
      return
    }
    guard home != self.home || socket?.isRunning != true else { return }
    socket?.stop()
    socket = nil
    self.home = home
    let store = ScreenAllowStore.live(talosHome: home)
    self.store = store
    let s = ScreenSocket(
      path: ScreenSocket.path(talosHome: home),
      proto: ScreenProtocol(service: ScreenCore.live(talosHotkeys: { ScreenHelperHost.talosHotkeys.value }), allowList: store, signing: LiveCodeSigning(), store: store))
    do {
      try s.start()
      socket = s
      Self.notServingReason = nil
      DesktopLog.screen("listening at \(s.path)")
    } catch {
      Self.notServingReason = "\(error)"
      DesktopLog.screen("not started: \(error)")
    }
  }

  func stop() {
    socket?.stop()
    socket = nil
    Self.notServingReason = "it was stopped"
  }
}
