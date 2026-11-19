import AppKit
import Foundation
import TalosDesktopCore

/// The Terminal pane's slot in the Talos window (docs/TERMINAL-PANE.md): what the page's two messages do. Kept apart from
/// `WebWindow.swift` (the stored state stays there). The page says where the slot is and which thread it belongs to; the
/// native pane (`OwnerShellPane`) is laid over it. Nothing here writes to a shell or sends the page anything about one.
extension WebController {
  /// The run channel (ShellRunChannel.swift): the pane, the Talos window whose clicks it reads, and the barred flag of a Mac that is signing out.
  func makeRunChannel() -> ShellRunChannel {
    let c = ShellRunChannel(
      pane: shellPane, window: { [weak self] in self?.window as? WebNSWindow })
    c.barred = { [weak self] in self?.shellPaneBarred ?? true }
    c.report = { [weak self] id, a in self?.tellPageHowARunWent(id, a) }
    return c
  }

  /// `shell_pane`: the slot for `thread` is at `rect`, or (nil) is not showing right now. The shells keep running while hidden.
  func shellPaneAsked(thread: String, rect: TerminalViewRect?) {
    shellPaneSlot = rect.map { (thread, $0) }
    applyShellPane()
  }

  /// `shell_pane_close`: the owner closed that thread's Terminal pane. Its shells end, whichever thread is showing.
  func shellPaneClosed(thread: String) {
    if shellPaneSlot?.thread == thread { shellPaneSlot = nil }
    shellPane.close(thread: thread)
    applyShellPane()
  }

  /// Sign out, or Forget this Mac: every shell ends, and no pane opens again until a new document has loaded.
  func endShellPanes() {
    shellPaneBarred = true
    shellPaneSlot = nil
    runChannel.clear()
    shellPane.closeAll()
  }

  /// The slot belonged to the document that is gone; a new document asks again. The shells are the owner's and keep running.
  func forgetShellPaneSlot() {
    shellPaneSlot = nil
    runChannel.clear()  // what the old page vouched for goes with it
    shellPane.hide()
  }

  /// Lays the pane over the slot the page asked for, or takes it off the page: nothing asked, the window is hidden, the page is
  /// not loaded or not signed in, this Mac is signing out, or what is left of the slot inside the window is too small. Hiding
  /// ends no shell.
  func applyShellPane() {
    guard !shellPaneBarred, let wv = webView, let slot = shellPaneSlot,
      let frame = TerminalViewRect.placement(
        asked: slot.rect, pageReady: pageReady, signedIn: signedIn,
        windowVisible: windowVisibleForTest ?? (window?.isVisible == true), in: wv.bounds.size, flipped: wv.isFlipped,
        minimum: OwnerShellPane.minimumSize)
    else { return shellPane.hide() }
    shellPane.show(thread: slot.thread, in: wv, frame: frame)
  }
}
