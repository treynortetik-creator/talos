import AppKit
import SwiftUI
import TalosDesktopCore

/// The look of Mac settings, from the approved mock (SetAgent, SetPhone, SetAccess, SetGeneral, SetAdvanced): the same cream, Cinzel
/// and Inter as the setup, update and About windows (`OB`, `UpdatePalette`), a sidebar, cards of one-line rows with green switches,
/// and clay accents. Everything here is looks only; what a row says and does is in the tab that uses it.
@MainActor
enum SP {
  static let cream = OB.cream
  static let card = OB.paper
  static let nav = Color(hex: 0xEFE0C4)
  static let line = OB.line
  static let rowLine = OB.track
  static let ink = OB.ink
  static let muted = OB.muted
  static let accent = OB.accent
  static let done = OB.done
  static let link = OB.link
  static let danger = OB.danger
  static let switchOff = Color(hex: 0xC9B38F)
  static let orange = Color(hex: 0x9A3F12)
  static let width: CGFloat = 900
  static let height: CGFloat = 640
  static let sidebarWidth: CGFloat = 210
}

/// A tab's page: the Cinzel heading (with the robot and a status line on Your agent, and a button at the right), then the content,
/// scrolling when the window is short.
struct SettingsPage<Content: View>: View {
  let title: String
  var subtitle: String?
  var icon: NSImage?
  /// A coloured status line under the heading (Your agent: "Running · Talos server connected").
  var status: (text: String, ok: Bool)?
  var trailing: AnyView?
  @ViewBuilder var content: Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        HStack(spacing: 16) {
          if let icon { Image(nsImage: icon).resizable().scaledToFit().frame(width: 56, height: 56).accessibilityHidden(true) }
          VStack(alignment: .leading, spacing: 4) {
            Text(title).font(OB.heading(26)).foregroundStyle(SP.ink).accessibilityAddTraits(.isHeader)
            if let status {
              HStack(spacing: 8) {
                Circle().fill(status.ok ? SP.done : SP.orange).frame(width: 8, height: 8).accessibilityHidden(true)
                Text(status.text).font(OB.body(14, .medium)).foregroundStyle(status.ok ? SP.done : SP.orange)
              }
              .accessibilityElement(children: .combine)
              .accessibilityIdentifier("agent-status")
            }
            if let subtitle {
              Text(subtitle).font(OB.body(14)).foregroundStyle(SP.muted).fixedSize(horizontal: false, vertical: true)
            }
          }
          Spacer(minLength: 0)
          if let trailing { trailing }
        }
        content
      }
      .padding(.horizontal, 40).padding(.vertical, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(SP.cream)
  }
}

/// A section: a 15 pt heading over its card or controls.
struct SettingsSection<Content: View>: View {
  let title: String
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title).font(OB.body(15, .semibold)).foregroundStyle(SP.ink).accessibilityAddTraits(.isHeader)
      content
    }
  }
}

/// The rounded cream-white card rows sit in.
struct SettingsCard<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 0) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 14).fill(SP.card))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(SP.line, lineWidth: 1))
  }
}

struct SettingsDivider: View {
  var body: some View { SP.rowLine.frame(height: 1) }
}

/// One line: its words on the left, its control on the right.
struct SettingsRow<Trailing: View>: View {
  let title: String
  var size: CGFloat = 15
  @ViewBuilder var trailing: Trailing
  var body: some View {
    HStack(spacing: 16) {
      Text(title).font(OB.body(size)).foregroundStyle(SP.ink).frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
      trailing
    }
    .padding(.horizontal, 18).padding(.vertical, 12)
    .frame(minHeight: 48)
  }
}

/// The mock's switch: 44 by 26, green when on, a white knob.
struct SettingsSwitchStyle: ToggleStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    Button {
      configuration.isOn.toggle()
    } label: {
      ZStack(alignment: configuration.isOn ? .trailing : .leading) {
        Capsule().fill(configuration.isOn ? SP.done : SP.switchOff).frame(width: 44, height: 26)
        Circle().fill(Color.white).frame(width: 20, height: 20).padding(3)
      }
      .opacity(enabled ? 1 : 0.5)
      .animation(.easeOut(duration: 0.15), value: configuration.isOn)
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text(configuration.isOn ? "On" : "Off"))
    .accessibilityAddTraits(.isButton)
  }
}

/// A row with a switch. The label is the row's text and the switch's accessibility name.
struct SettingsSwitchRow: View {
  let title: String
  @Binding var isOn: Bool
  var size: CGFloat = 15
  @Environment(\.isEnabled) private var enabled
  var body: some View {
    SettingsRow(title: title, size: size) {
      Toggle(title, isOn: $isOn).toggleStyle(SettingsSwitchStyle()).labelsHidden()
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityValue(Text(isOn ? "On" : "Off"))
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { if enabled { isOn.toggle() } }
  }
}

/// The small pills: an outline (default), the clay one for the main action, a red outline for one that undoes something.
struct SettingsPillStyle: ButtonStyle {
  enum Kind { case outline, primary, danger }
  var kind: Kind = .outline
  var height: CGFloat = 36
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    let fg: Color = kind == .primary ? SP.ink : (kind == .danger ? SP.danger : SP.ink)
    configuration.label
      .font(OB.body(13, kind == .primary ? .semibold : .regular))
      .foregroundStyle(fg)
      .padding(.horizontal, 14)
      .frame(minHeight: height)
      .background(Capsule().fill(kind == .primary ? SP.accent : Color.clear))
      .overlay { if kind != .primary { Capsule().strokeBorder(kind == .danger ? SP.danger : SP.line, lineWidth: 1) } }
      .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
      .contentShape(Capsule())
  }
}

/// A text link in the mock's brown.
struct SettingsLinkStyle: ButtonStyle {
  var size: CGFloat = 13
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(OB.body(size)).foregroundStyle(SP.link).underline()
      .opacity(configuration.isPressed ? 0.7 : 1).contentShape(Rectangle())
  }
}

/// A one-sentence caption under a section (at most one a section).
struct SettingsCaption: View {
  let text: String
  var color: Color = SP.muted
  var size: CGFloat = 13
  init(_ text: String, color: Color = SP.muted, size: CGFloat = 13) {
    self.text = text
    self.color = color
    self.size = size
  }
  var body: some View {
    Text(text).font(OB.body(size)).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
  }
}

extension View {
  /// A text box in the mock's look (a cream field with a thin line).
  func settingsField() -> some View {
    self.textFieldStyle(.plain)
      .font(OB.body(14))
      .padding(.horizontal, 12).padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: 8).fill(SP.cream))
      .overlay(RoundedRectangle(cornerRadius: 8).stroke(SP.line, lineWidth: 1))
  }
}
