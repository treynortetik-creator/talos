import AppKit
import SwiftUI
import TalosDesktopCore

/// Rebind the compose hotkey: press Record, then the new combination. WP-D6's Settings reuses this view.
struct HotkeyView: View {
  @ObservedObject var model: SupervisorController
  @ObservedObject private var hot = HotkeyController.shared
  @State private var recording = false
  @State private var monitor: Any?
  @State private var note = ""

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Quick compose hotkey").font(.headline)
      HStack {
        Text(hot.spec?.display ?? "none").font(.system(.title3, design: .monospaced))
        Button(recording ? "Press the new keys… (Esc cancels)" : "Record") { recording ? stop() : start() }
        Button("Reset") { rebind(HotkeyController.fallback) }
      }
      Text(note.isEmpty ? hot.message : note).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      AppliesNote(setting: .composeHotkey)
      Text("Use two modifiers (for example ⌃⌥) or an F-key. Common macOS shortcuts are refused. Talos can only tell when another app holds a combination exclusively.").font(.caption)
        .foregroundStyle(.secondary)
    }
    .padding()
    .frame(minWidth: 420, maxWidth: .infinity, minHeight: 160, maxHeight: .infinity, alignment: .topLeading)
    .onDisappear { stop() }
  }

  private func start() {
    recording = true
    note = ""
    monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { e in
      if e.keyCode == 53 { stop(); return nil }  // Esc
      guard let s = HotkeySpec.from(keyCode: UInt32(e.keyCode), carbonModifiers: e.modifierFlags.carbon) else {
        note = "That combination can't be used. Use two modifiers, for example ⌃⌥."
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
      // Before setup there is no desktop.json, and writing one would make the next launch start a session: keep the hotkey
      // in the app's own defaults until the config exists.
      if model.configured {
        var c = model.supervisor.currentConfig()
        c.hotkeys.compose = saved
        model.supervisor.updateConfig(c)
      } else {
        UserDefaults.standard.set(saved, forKey: HotkeyController.preSetupKey)
      }
    }
  }
}
