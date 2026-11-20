import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// The update banner and window, with the real AppKit pieces. Runs only with TALOS_GUI_TESTS=1. Nothing here activates the app.

@MainActor
@Suite("Update window and banner (real AppKit)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct UpdateWindowGuiTests {
  func buttons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? [] + v.subviews.flatMap(buttons) }

  func host(_ c: UpdateController) -> (NSWindow, NSView) {
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 250), styleMask: [.titled], backing: .buffered, defer: true)
    let h = NSHostingView(rootView: UpdateWindow(controller: c))
    w.contentView = h
    h.layoutSubtreeIfNeeded()
    return (w, h)
  }

  func returnKey(_ w: NSWindow) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil, characters: "\r",
      charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
  }

  @Test func theBannerNeverTakesFocusAndHasNoDefaultButton() {
    _ = NSApplication.shared
    let c = UpdateController()
    var shown: [NSPanel] = []
    c.orderFront = { shown.append($0) }  // nothing is put on the screen
    c.presentBanner("Talos 0.1.5 is ready to update.", offersUpdate: true)
    let p = try! #require(shown.first)
    #expect(!p.canBecomeKey && !p.canBecomeMain, "it can never be key: a key goes to what the owner is typing in")
    #expect(p.styleMask.contains(.nonactivatingPanel))
    #expect(p.defaultButtonCell == nil)
    #expect(!p.isKeyWindow)
    #expect(!p.performKeyEquivalent(with: returnKey(p)), "Return is not a key equivalent of anything on it")
    p.keyDown(with: returnKey(p))
    #expect(c.updateNowPresses == 0)
    for b in buttons(p.contentView!) { #expect(b.keyEquivalent.isEmpty, "\(b.title) has no key equivalent") }
  }

  @Test func returnOnTheWindowDoesNothingAndUpdateNowNeedsARealClick() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.ready(version: "0.1.5"))  // the pending state: the window offers Update now
    let (w, root) = host(c)
    let all = buttons(root)
    let update = try! #require(all.first { $0.title == "Update now" })
    #expect(update.keyEquivalent.isEmpty && w.defaultButtonCell == nil, "no default button on the window")
    #expect(all.allSatisfy { $0.keyEquivalent != "\r" })
    #expect(!w.performKeyEquivalent(with: returnKey(w)), "Return is not taken by anything")
    w.keyDown(with: returnKey(w))
    #expect(c.updateNowPresses == 0)
    // a press that is no mouse event (Accessibility, AppleScript, `performClick`) is not a click
    update.performClick(nil)
    #expect(c.updateNowPresses == 0, "a press with no real click behind it does nothing")
  }

  @Test func theWindowHasNoUpdateNowWhenNothingIsReady() {
    _ = NSApplication.shared
    let c = UpdateController()
    c.orderFront = { _ in }
    c.apply(.upToDate(version: "0.1.4"))
    let (_, root) = host(c)
    #expect(!buttons(root).contains { $0.title == "Update now" })
  }
}
