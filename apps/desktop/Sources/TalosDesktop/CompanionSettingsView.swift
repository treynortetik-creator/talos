import SwiftUI
import TalosDesktopCore

/// The Companion card on Mac settings → General (it used to have a tab of its own). Every control takes effect at once, no relaunch.
/// Failures show here as lines. "Also show reply banners" is in Advanced.
struct CompanionCard: View {
  @ObservedObject private var companion = CompanionController.shared
  @AppStorage(CompanionController.Key.enabled) private var enabled = false
  @AppStorage(CompanionController.Key.size) private var size = "standard"
  @AppStorage(CompanionController.Key.moments) private var moments = true
  @AppStorage(CompanionController.Key.replyBubbles) private var replyBubbles = true

  var body: some View {
    SettingsCard {
      HStack(spacing: 12) {
        Text(MacSettingsText.companionName).font(OB.body(15, .semibold)).foregroundStyle(SP.ink)
          .frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
        Toggle("Show the Companion", isOn: $enabled).toggleStyle(SettingsSwitchStyle()).labelsHidden()
      }
      .padding(.horizontal, 18).padding(.vertical, 12)
      SettingsDivider()
      SettingsRow(title: "Size") {
        HStack(spacing: 0) {
          sizeChoice("Standard", tag: "standard")
          sizeChoice("Small", tag: "mini")
        }
        .overlay(Capsule().stroke(SP.line, lineWidth: 1))
        .clipShape(Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Companion size")
      }
      SettingsDivider()
      SettingsSwitchRow(title: "Let it wander now and then", isOn: $moments)
      SettingsDivider()
      SettingsSwitchRow(title: "It brings me new replies", isOn: $replyBubbles)
      if let until = companion.snoozedUntil {
        SettingsDivider()
        SettingsRow(title: "Snoozed until \(until.formatted(date: .omitted, time: .shortened))", size: 13) {
          Button("End snooze") { companion.endSnooze() }.buttonStyle(SettingsPillStyle())
        }
      }
      if let p = companion.artProblem { problem(p) }
      if let m = companion.micLine { problem(m) }
    }
  }

  private func sizeChoice(_ title: String, tag: String) -> some View {
    let on = size == tag
    return Button { size = tag } label: {
      Text(title).font(OB.body(13)).foregroundStyle(on ? SP.cream : SP.ink)
        .padding(.horizontal, 14).padding(.vertical, 6).background(on ? SP.ink : Color.clear)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(title)
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
  }

  private func problem(_ text: String) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      SettingsDivider()
      SettingsCaption(text, color: SP.orange, size: 12).padding(.horizontal, 18).padding(.vertical, 10)
    }
  }
}
