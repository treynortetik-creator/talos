import AppKit
import Carbon.HIToolbox
import Foundation
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// Regression tests for the quick-compose panel, through the real panel and real Carbon. Needs TALOS_GUI_TESTS=1.
/// The two Send tests keep the panel off screen and send to a real web view whose page records what it is handed
/// (QuickComposeSendGuiTests). The layout test below them still puts the panel on screen for a moment, without activating the
/// app, and the hotkey tests register real Carbon hot keys.
@MainActor
@Suite("ReviewD5 compose", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ReviewD5ComposeTests {
  func find<T: NSView>(_ root: NSView, _ t: T.Type) -> [T] {
    (root as? T).map { [$0] } ?? [] + root.subviews.flatMap { find($0, t) }
  }

  func thread(_ id: String, _ name: String) -> [String: Any] { ["id": id, "name": name] }

  /// Through the strict decoder, as a page would send them.
  func threads(_ items: [[String: Any]]) throws -> WebToNative {
    try #require(WebToNative.decode(["type": "threads", "items": items]))
  }

  func signIn(_ list: [[String: Any]]) throws {
    _ = NSApplication.shared
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    WebController.shared.nativeMessage(.ready(signedIn: true, features: []))
    WebController.shared.nativeMessage(try threads(list))
  }

  func cleanUp() {
    UserDefaults.standard.removeObject(forKey: QuickCompose.lastThreadKey)
    if let none = try? threads([]) { WebController.shared.nativeMessage(none) }
    WebController.shared.nativeMessage(.ready(signedIn: false, features: []))
  }

  func panelParts() throws -> (root: NSView, popup: NSPopUpButton, text: NSTextView, send: NSButton) {
    let root = try #require(QuickCompose.shared.contentViewForTest())
    let popup = try #require(find(root, NSPopUpButton.self).first)
    let scroll = try #require(find(root, NSScrollView.self).first)
    let text = try #require(scroll.documentView as? NSTextView)
    let send = try #require(find(root, NSButton.self).first { $0.title == "Send" })
    return (root, popup, text, send)
  }

  /// The pieces of the panel, read without putting it on screen (the panel is built and filled by `rig`).
  func windowlessPanelParts() throws -> (popup: NSPopUpButton, text: NSTextView) {
    let root = try #require(QuickCompose.shared.panelForTest?.contentView)
    let popup = try #require(find(root, NSPopUpButton.self).first)
    let scroll = try #require(find(root, NSScrollView.self).first)
    return (popup, try #require(scroll.documentView as? NSTextView))
  }

  /// attach.ts sends "A thread" for every agent-made thread under the DEFAULT `show_thread_names: fixed_only`, so equal
  /// names are the normal case. `addItems(withTitles:)` keeps one item per title, so the popup's indexes stop matching
  /// `shown` and the owner picks one thread and Send uses another. The page here is a real web view that records what it is
  /// handed, so the thread that comes out is the thread Send chose.
  @Test func equalThreadNamesKeepOneRowPerThreadAndSendUsesTheRowPicked() async throws {
    cannotTakeTheKeyboard()
    let s = QuickComposeSendGuiTests()
    let r = try await s.rig(
      page: QuickComposeSendGuiTests.page(receiver: "return true"),
      threads: [("general", "General"), ("t_agent1", "A thread"), ("work", "Work"), ("t_agent2", "A thread")])
    defer { s.cleanUp(r) }
    let p = try windowlessPanelParts()
    #expect(p.popup.numberOfItems == 4, "one row per thread")
    for id in ["t_agent2", "t_agent1"] {
      let row = try #require(p.popup.itemArray.firstIndex { ($0.representedObject as? String) == id })
      p.popup.selectItem(at: row)
      p.text.string = "for \(id)"
      await s.send()
    }
    #expect(
      try await r.received() == [
        ["type": "compose", "thread_id": "t_agent2", "text": "for t_agent2"],
        ["type": "compose", "thread_id": "t_agent1", "text": "for t_agent1"],
      ], "each message went to the row that was picked, though two rows share a name")
  }

  /// Control: with distinct names the row picked is the thread that gets the message.
  @Test func distinctNamesGoToTheRowPicked() async throws {
    cannotTakeTheKeyboard()
    let s = QuickComposeSendGuiTests()
    let r = try await s.rig(
      page: QuickComposeSendGuiTests.page(receiver: "return true"),
      threads: [("general", "General"), ("work", "Work"), ("home", "Home")])
    defer { s.cleanUp(r) }
    let p = try windowlessPanelParts()
    p.popup.selectItem(withTitle: "Home")
    p.text.string = "hello"
    await s.send()
    #expect(try await r.received() == [["type": "compose", "thread_id": "home", "text": "hello"]])
  }

  /// `.fullSizeContentView` puts the content under the title bar, and the root stack doesn't use the safe area.
  @Test func thePickerIsNotUnderTheTitleBar() throws {
    try signIn([thread("general", "General")])
    defer { cleanUp() }
    let p = try panelParts()
    defer { p.root.window?.orderOut(nil) }
    let w = try #require(p.root.window)
    p.root.layoutSubtreeIfNeeded()
    let inWindow = p.popup.convert(p.popup.bounds, to: nil)
    #expect(inWindow.maxY <= w.contentLayoutRect.maxY + 0.5, "popup top \(inWindow.maxY), title bar starts at \(w.contentLayoutRect.maxY)")
  }
}

/// Another process holding the combination, which is what "taken by another app" means. The builder's conflict test holds
/// it in the same process, the one case Carbon reports with options 0.
@MainActor
@Suite("ReviewD5 hotkey conflict", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ReviewD5HotkeyConflictTests {
  static let helper = """
    #include <Carbon/Carbon.h>
    #include <stdio.h>
    #include <unistd.h>
    int main(void) { EventHotKeyRef r = 0; EventHotKeyID id = {'TSTK', 1};
      OSStatus s = RegisterEventHotKey(109, cmdKey|shiftKey|optionKey|controlKey, id, GetApplicationEventTarget(), 1, &r);
      printf("%d\\n", (int)s); fflush(stdout); sleep(20); return 0; }
    """

  /// Holder registers ctrl+opt+shift+cmd+f10 with the exclusive option. Measured with two processes: options 0 on our side
  /// gets noErr; the exclusive option on our side gets -9878 (eventHotKeyExistsErr). HotKeys.swift:43 passes 0.
  @Test func aCombinationAnotherProcessHoldsIsReportedAsTaken() throws {
    _ = NSApplication.shared
    let dir = NSTemporaryDirectory() + "talos-rv-hk-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    try Self.helper.write(toFile: dir + "/h.c", atomically: true, encoding: .utf8)
    let cc = Process()
    cc.executableURL = URL(fileURLWithPath: "/usr/bin/clang")
    cc.arguments = ["-framework", "Carbon", "-o", dir + "/h", dir + "/h.c"]
    try cc.run()
    cc.waitUntilExit()
    #expect(cc.terminationStatus == 0)

    let holder = Process()
    holder.executableURL = URL(fileURLWithPath: dir + "/h")
    let out = Pipe()
    holder.standardOutput = out
    try holder.run()
    defer { holder.terminate() }  // our own child only
    let line = out.fileHandleForReading.availableData
    #expect(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) == "0", "the holder got the key")

    let h = HotKeys.shared
    defer { h.unregister() }
    #expect(h.register(try HotkeySpec.parse("ctrl+opt+shift+cmd+f10")) == .taken)
  }
}
