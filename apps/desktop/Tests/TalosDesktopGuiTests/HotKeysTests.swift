import AppKit
import Carbon.HIToolbox
import Foundation
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// Real Carbon registration (no Accessibility permission needed). Uses a combination nobody binds. Needs TALOS_GUI_TESTS=1.
@MainActor
@Suite("HotKeys", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct HotKeysTests {
  let a = try! HotkeySpec.parse("ctrl+opt+shift+cmd+f12")
  let b = try! HotkeySpec.parse("ctrl+opt+shift+cmd+f11")

  @Test func registersReplacesAndUnregisters() {
    _ = NSApplication.shared
    let h = HotKeys.shared
    defer { h.unregister() }
    #expect(h.register(a) == .ok)
    #expect(h.current == a)
    #expect(h.register(a) == .ok)  // the same combination again is not a conflict with itself
    #expect(h.register(b) == .ok)
    #expect(h.current == b)
    h.unregister()
    #expect(h.current == nil)
  }

  @Test func aCombinationAnotherRegistrationHoldsReportsTheConflictAndKeepsTheOld() {
    _ = NSApplication.shared
    let h = HotKeys.shared
    defer { h.unregister() }
    #expect(h.register(a) == .ok)
    // A second, independent claim on `b` (as another app would hold it).
    var other: EventHotKeyRef?
    let st = RegisterEventHotKey(b.keyCode, b.modifiers, EventHotKeyID(signature: 0x4F54_4852, id: 9), GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &other)
    #expect(st == noErr)
    defer { if let other { UnregisterEventHotKey(other) } }
    #expect(h.register(b) == .taken)
    #expect(h.current == a, "the old hotkey still works after a refused rebind")
  }
}
