import AppKit
import SwiftUI
import TalosDesktopCore

/// Mac settings, General (mock "Settings: General"): when Talos opens, the Dock, keeping the Mac awake, updates, the Companion and
/// the Quick message shortcut. Opening the Talos window at launch is in Advanced.
extension SettingsView {
  var generalTab: some View {
    SettingsPage(title: MacWords.tabGeneral) {
      SettingsCard {
        SettingsSwitchRow(title: "Open Talos when I log in", isOn: Binding(get: { login.isOn }, set: { login.set($0) }))
        if !login.message.isEmpty {
          SettingsCaption(login.message, color: login.message == MacSettingsText.loginPending ? SP.orange : SP.muted, size: 12)
            .padding(.horizontal, 18).padding(.bottom, 10)
        }
        SettingsDivider()
        SettingsSwitchRow(
          title: "Show Talos in the Dock",
          isOn: Binding(
            get: { showDock },
            set: {
              showDock = $0
              ActivationPolicyController.shared.refresh()
            }))
        SettingsDivider()
        SettingsSwitchRow(
          title: "Keep my Mac awake while it's plugged in",
          isOn: Binding(
            get: { cfg.keepAwakeOnAC },
            set: { on in
              save { $0.keepAwakeOnAC = on }
              KeepAwake.shared.setEnabled(on)
            }))
        if let n = KeepAwake.stateNote(awake.status) {
          SettingsCaption(n, color: SP.orange, size: 12).padding(.horizontal, 18).padding(.bottom, 10)
        }
        SettingsDivider()
        SettingsSwitchRow(
          title: MacSettingsText.autoUpdateTitle,
          isOn: Binding(get: { cfg.autoUpdate }, set: { on in save { $0.autoUpdate = on } }))
      }
      HStack(alignment: .top, spacing: 18) {
        CompanionCard().frame(maxWidth: .infinity)
        QuickMessageCard(model: model)
      }
      SettingsCaption(versionFooter).accessibilityIdentifier("version-footer")
    }
  }

  /// "Talos 0.1.9 · up to date": the version, and what the last update check said once there is one.
  var versionFooter: String {
    let base = "Talos \(WebController.version)"
    let said = AboutCopy.headline(updates.status)
    return said.isEmpty ? base : base + " \u{00B7} " + said
  }
}
