import SwiftUI
import TalosDesktopCore

/// Mac settings, Companion (spec 3.6). Every control takes effect at once, no relaunch. Failures show here as lines.
struct CompanionSettingsView: View {
  @ObservedObject private var companion = CompanionController.shared
  @AppStorage(CompanionController.Key.enabled) private var enabled = false
  @AppStorage(CompanionController.Key.size) private var size = "standard"
  @AppStorage(CompanionController.Key.moments) private var moments = true
  @AppStorage(CompanionController.Key.replyBanners) private var replyBanners = false
  @ObservedObject private var hotkeys = HotkeyController.shared

  static func showHotkeys() { SettingsNavigator.shared.selected = .hotkeys }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Toggle("Show Companion", isOn: $enabled)
      Text("A small character that shows what your agent is doing. Off until you turn it on; no sound, ever.")
        .font(.caption).foregroundStyle(.secondary)
      AppliesNote(setting: .companion)
      Picker("Size", selection: $size) {
        Text("Standard").tag("standard")
        Text("Mini").tag("mini")
      }
      .pickerStyle(.segmented)
      .frame(maxWidth: 260)
      Toggle("Rounds and little moments", isOn: $moments)
      Text("Now and then he walks a short patrol or thinks for a moment. Off keeps him still except when you poke him.")
        .font(.caption).foregroundStyle(.secondary)
      Toggle("Also show reply banners", isOn: $replyBanners)
      Text("While he is on and can show a reply himself, his bubble replaces the \u{201C}New reply\u{201D} banner. Turn this on to get both.")
        .font(.caption).foregroundStyle(.secondary)
      if let until = companion.snoozedUntil {
        HStack {
          Text("Snoozed until \(until.formatted(date: .omitted, time: .shortened))")
          Button("End snooze") { companion.endSnooze() }
        }
      }
      if let p = companion.artProblem { Text(p).foregroundStyle(.orange).font(.callout) }
      if let m = companion.micLine { Text(m).foregroundStyle(.orange).font(.callout) }
      Divider()
      HStack(spacing: 4) {
        Text("Quick compose still opens with \(hotkeys.spec?.display ?? "its hotkey").")
          .font(.caption).foregroundStyle(.secondary)
        Button("Change it in the Hotkeys tab") { Self.showHotkeys() }
          .buttonStyle(.link).font(.caption)
      }
      Spacer()
    }
    .padding()
  }
}
