import AppKit
import Foundation
import SwiftTerm

/// Stands between a pane shell's terminal and SwiftTerm's own handling of what the terminal reports, to take the clipboard out
/// of it. SwiftTerm answers the OSC 52 escape sequence by default: anything printed in the shell (a file, a log, what a remote
/// host sends) could then set the Mac's clipboard, or ask for it and have it written into the shell's input. Here a request to
/// set it does nothing and a request to read it gets no answer. Everything else goes on to the view unchanged, the keys the
/// owner types among them. Copy and paste by the owner's own keys and menu do not come this way and still work.
@MainActor
final class ShellClipboardGuard: TerminalViewDelegate {
  private unowned let inner: LocalProcessTerminalView

  /// Takes over as `view`'s terminal delegate. The view keeps it only weakly: the caller holds the guard as long as the view.
  init(guarding view: LocalProcessTerminalView) {
    inner = view
    view.terminalDelegate = self
  }

  // The clipboard: refused.
  func clipboardCopy(source: TerminalView, content: Data) {}
  func clipboardRead(source: TerminalView) -> Data? { nil }
  func kittyClipboardCapabilities(source: TerminalView) -> KittyClipboardCapabilities { [] }
  func kittyClipboardAvailableMimeTypes(source: TerminalView, location: KittyClipboardLocation) -> [String]? { nil }
  func kittyClipboardRead(source: TerminalView, location: KittyClipboardLocation, mimeType: String) -> KittyClipboardReadResult? { nil }
  func kittyClipboardRequestPermission(source: TerminalView, request: KittyClipboardPermissionRequest) -> KittyClipboardPermissionResult { .deny }
  func kittyClipboardWrite(source: TerminalView, location: KittyClipboardLocation, content: KittyClipboardWriteContent) -> KittyClipboardWriteResult {
    inner.kittyClipboardWrite(source: source, location: location, content: content)  // the view asks its own delegate, which has none: refused
  }

  // Everything else: the view's own handling.
  func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) { inner.sizeChanged(source: source, newCols: newCols, newRows: newRows) }
  func setTerminalTitle(source: TerminalView, title: String) { inner.setTerminalTitle(source: source, title: title) }
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) { inner.hostCurrentDirectoryUpdate(source: source, directory: directory) }
  func send(source: TerminalView, data: ArraySlice<UInt8>) { inner.send(source: source, data: data) }
  func scrolled(source: TerminalView, position: Double) { inner.scrolled(source: source, position: position) }
  func requestOpenLink(source: TerminalView, link: String, params: [String: String]) { inner.requestOpenLink(source: source, link: link, params: params) }
  func bell(source: TerminalView) { inner.bell(source: source) }
  func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) { inner.iTermContent(source: source, content: content) }
  func rangeChanged(source: TerminalView, startY: Int, endY: Int) { inner.rangeChanged(source: source, startY: startY, endY: endY) }
  func programStatusChanged(source: TerminalView, records: [TerminalProgramStatus]) { inner.programStatusChanged(source: source, records: records) }
}
