import AppKit
import SwiftUI
import TalosDesktopCore

/// Mac settings, Phone & Mac (mock "Settings: Phone and Mac"): whether this Mac is connected so a phone can reach the agent through
/// it, and the Claude account the agent uses. The Talos server address, the talos-app command and the sign-in command are in Advanced.
///
/// Left out on purpose: the mock's "Your phones" list (used 2 minutes ago, Remove) and "Add a phone": the Mac has no list of phones
/// (the Talos page keeps it; the "See and remove your devices" row opens it in the Talos window) and the phone step exists only inside setup.
extension SettingsView {
  var phoneTab: some View {
    SettingsPage(title: MacWords.tabPhone) {
      SettingsSection(title: "This Mac") { macCard }
      SettingsSection(title: "Your devices") { devicesCard }
      SettingsSection(title: "Claude account") {
        SettingsCard {
          HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Your agent uses the Claude account you signed in with.").font(OB.body(15, .medium)).foregroundStyle(SP.ink)
                .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button("Switch account\u{2026}") { model.showSignIn(startNow: true) }
              .buttonStyle(SettingsPillStyle())
              .accessibilityIdentifier("switch-account")
          }
          .padding(.horizontal, 18).padding(.vertical, 14)
        }
      }
    }
  }

  private var devicesCard: some View {
    SettingsCard {
      let plan = DevicesPage.plan(hasRelay: web.hasRelay)
      HStack(spacing: 14) {
        Image(systemName: "iphone").frame(width: 18).foregroundStyle(SP.muted).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(DevicesPage.rowTitle).font(OB.body(15, .medium)).foregroundStyle(SP.ink)
          if case .disabled(let reason) = plan {
            Text(reason).font(OB.body(13)).foregroundStyle(SP.muted).fixedSize(horizontal: false, vertical: true)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        Button(DevicesPage.rowButton) {
          guard case .open(let path) = plan else { return }
          web.show()
          // queued until the page is ready, so it lands once the window has loaded
          web.sendWhenReady(.navigate(path: path), reveal: false)
        }
        .buttonStyle(SettingsPillStyle())
        .disabled({ if case .open = plan { return false } else { return true } }())
        .accessibilityIdentifier("open-devices")
      }
      .padding(.horizontal, 18).padding(.vertical, 14)
    }
  }

  private var macCard: some View {
    SettingsCard {
      VStack(alignment: .leading, spacing: 12) {
        VStack(alignment: .leading, spacing: 2) {
          Text(macHeadline).font(OB.body(15, .medium)).foregroundStyle(SP.ink)
          Text(macDetail).font(OB.body(13)).foregroundStyle(SP.muted).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("this-mac-status")
        macButtons.lineLimit(1).fixedSize()
      }
      .padding(.horizontal, 18).padding(.vertical, 14)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var offer: SignInHelp.Offer { SignInHelp.offer(hasRelay: web.hasRelay, page: web.pageState) }

  private var macHeadline: String {
    switch offer {
    case .signedIn: return MacWords.thisMacSignedIn
    case .connecting: return "Connecting\u{2026}"
    case .unreachable, .needsRelay, .button: return MacWords.thisMacSignedOut
    }
  }

  private var macDetail: String {
    switch offer {
    case .signedIn: return phoneLine
    case .connecting: return "Talos is reaching your Talos server."
    case .unreachable: return PageState.unreachableLine
    case .needsRelay: return "Talos needs the address of your Talos server first. Add it in \(MacSettingsText.connectionPath)."
    case .button: return "Connect this Mac so your phone can reach your agent through it. Talos shows four words to check."
    }
  }

  /// Whether a phone can reach the agent through this Mac is a different fact from the window being signed in: it is the menu's
  /// "Your Mac:" word (Talos on this Mac, carrying messages to the Talos server).
  private var phoneLine: String {
    switch status.summary.macConnection {
    case "connected": return "Your Mac is connected, so your phone can reach your agent through it."
    case "checking": return "Checking whether your phone can reach your agent through this Mac\u{2026}"
    default: return "Your Mac is not connected right now, so your phone can't reach your agent through it. Your agent may not be running."
    }
  }

  @ViewBuilder private var macButtons: some View {
    switch offer {
    case .signedIn:
      HStack(spacing: 8) {
        Button(MacWords.signOutWindow) { SignOutAction.run(web: web) }
          .buttonStyle(SettingsPillStyle())
          .accessibilityIdentifier("sign-out-window")
        Button(MacWords.disconnectThisMac) {
          commitDrafts()
          web.forgetThisMac(config: model.configNow)
        }
        .buttonStyle(SettingsPillStyle(kind: .danger))
        .disabled(!web.hasRelay)
        .accessibilityIdentifier("disconnect-this-mac")
      }
    case .button:
      Button(MacWords.connectThisMac) {
        commitDrafts()
        SignInAction.start(model: model)
      }
      .buttonStyle(SettingsPillStyle(kind: .primary))
      .accessibilityIdentifier("connect-this-mac")
    case .unreachable:
      Button("Try now") { web.retryNow() }.buttonStyle(SettingsPillStyle())
    case .needsRelay:
      Button("Open Advanced") { nav.selected = .advanced }.buttonStyle(SettingsPillStyle())
    case .connecting:
      ProgressView().controlSize(.small)
    }
  }
}
