import AppKit
import SwiftUI
import TalosDesktopCore

/// The Quick message card on Mac settings → General: the shortcut that opens the little box from any app, and how to change it
/// (press Change shortcut, then the new keys). It used to be the Hotkeys tab.
struct QuickMessageCard: View {
  @ObservedObject var model: SupervisorController
  @ObservedObject private var hot = HotkeyController.shared
  @State private var recording = false
  @State private var monitor: Any?
  @State private var note = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Quick message").font(OB.body(15, .semibold)).foregroundStyle(SP.ink).accessibilityAddTraits(.isHeader)
      SettingsCaption("Write to your agent from any app.")
      HStack(spacing: 4) {
        ForEach(Array(keys.enumerated()), id: \.offset) { _, k in
          Text(k).font(OB.body(15)).foregroundStyle(SP.ink)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(SP.cream))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(SP.line, lineWidth: 1))
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Shortcut: \(hot.spec?.display ?? MacWords.shortcutNotSet)")
      HStack(spacing: 12) {
        Button(recording ? "Press the new keys\u{2026} (Esc cancels)" : (hot.spec == nil ? MacWords.setShortcut : MacWords.changeShortcut)) { recording ? stop() : start() }
          .buttonStyle(SettingsLinkStyle(size: 14))
        Button("Reset") { rebind(HotkeyController.fallback) }.buttonStyle(SettingsLinkStyle())
      }
      if let line = shown {
        SettingsCaption(line, color: SP.orange, size: 12)
      }
    }
    .padding(.horizontal, 18).padding(.vertical, 14)
    .frame(width: 220, alignment: .topLeading)
    .frame(maxHeight: .infinity, alignment: .topLeading)
    .background(RoundedRectangle(cornerRadius: 14).fill(SP.card))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(SP.line, lineWidth: 1))
    .onDisappear { stop() }
  }

  /// The shortcut as one key cap each ("⌃", "⌥", "Space").
  private var keys: [String] {
    guard let d = hot.spec?.display, !d.isEmpty else { return [MacWords.shortcutNotSet] }
    var caps: [String] = []
    var rest = ""
    for ch in d {
      if "\u{2303}\u{2325}\u{21E7}\u{2318}".contains(ch) { caps.append(String(ch)) } else { rest.append(ch) }
    }
    if !rest.isEmpty { caps.append(rest) }
    return caps
  }

  /// A problem line: the note from a refused key press, or the controller's own line unless it only says the shortcut is active.
  private var shown: String? {
    if !note.isEmpty { return note }
    let m = hot.message
    return (m.isEmpty || m.hasPrefix("Active:")) ? nil : m
  }

  private func start() {
    recording = true
    note = ""
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
      if e.keyCode == 53 { stop(); return nil }  // Esc
      guard let s = HotkeySpec.from(keyCode: UInt32(e.keyCode), carbonModifiers: e.modifierFlags.carbon) else {
        note = "That combination can't be used. Use two modifiers, for example \u{2303}\u{2325}."
        return nil
      }
      stop()
      rebind(s.text)
      return nil
    }
  }

  private func stop() {
    recording = false
    if let m = monitor { NSEvent.removeMonitor(m) }
    monitor = nil
  }

  private func rebind(_ text: String) {
    guard let s = try? HotkeySpec.parse(text) else { return }
    note = ""
    HotkeyController.shared.apply(s) { saved in
      // Before setup there is no desktop.json, and writing one would make the next launch start an agent: keep the shortcut
      // in the app's own defaults until the config exists.
      if model.configured {
        // one field, as an edit on the supervisor's queue: a read, change and replace here would write over a settings change
        // that is still on its way there
        model.saveComposeHotkey(saved)
      } else {
        UserDefaults.standard.set(saved, forKey: HotkeyController.preSetupKey)
      }
    }
  }
}
