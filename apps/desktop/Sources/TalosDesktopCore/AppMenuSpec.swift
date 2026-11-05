import Foundation

/// The menus at the top of the screen, next to the Apple logo. A menu-bar-only app declares none of its own, so the owner
/// found no Settings there (2026-11-01). The names and keys live here, the actions in the app, and a test walks both.
public enum AppMenuSpec {
  public enum Action: String, Equatable, Sendable, CaseIterable {
    case about, settings, hide, hideOthers, showAll, quit
    case showTalos, showTerminal, quickCompose, companionToggle, signIn, signOut, setupChecklist, permissions
    case help
    /// Responder-chain window commands (Cmd-W, Cmd-M): SwiftUI's own menu had them, so ours must.
    case closeWindow, minimize
  }

  public struct Item: Equatable, Sendable {
    public var action: Action
    public var title: String
    /// Command-key shortcut, "" for none.
    public var key: String
    public var shift: Bool
    public var option: Bool
    public init(_ action: Action, _ title: String, key: String = "", shift: Bool = false, option: Bool = false) {
      self.action = action
      self.title = title
      self.key = key
      self.shift = shift
      self.option = option
    }
  }

  public struct Menu: Equatable, Sendable {
    public var title: String
    /// nil entries are separators.
    public var items: [Item?]
  }

  /// The Edit menu is built by the app from the standard text commands (Undo, Cut, Copy, Paste, Select All); it sits between
  /// these two so ⌘V works in every text box.
  public static let talosMenu = Menu(
    title: "Talos",
    items: [
      Item(.about, "About Talos"), nil,
      Item(.settings, "Settings\u{2026}", key: ","), nil,
      Item(.hide, "Hide Talos", key: "h"),
      Item(.hideOthers, "Hide Others", key: "h", option: true),
      Item(.showAll, "Show All"), nil,
      Item(.quit, "Quit Talos", key: "q"),
    ])

  public static let windowMenu = Menu(
    title: "Window",
    items: [
      Item(.closeWindow, "Close", key: "w"),
      Item(.minimize, "Minimize", key: "m"), nil,
      Item(.showTalos, "Show Talos", key: "t"),
      Item(.showTerminal, "Terminals…", key: "k"),
      Item(.quickCompose, "Quick compose\u{2026}", key: "n"), nil,
      Item(.companionToggle, "Show Companion"),
      Item(.signIn, "Sign in\u{2026}"),
      Item(.signOut, "Sign out"), nil,
      Item(.setupChecklist, "Setup checklist\u{2026}"),
      Item(.permissions, "Permissions\u{2026}"),
    ])

  public static let helpMenu = Menu(title: "Help", items: [Item(.help, "Talos Help", key: "?")])

  public static var all: [Menu] { [talosMenu, windowMenu, helpMenu] }

  /// Every action the spec offers.
  public static var actions: Set<Action> { Set(all.flatMap { $0.items.compactMap { $0?.action } }) }
}

/// Whether Talos is a Dock app right now. macOS shows a top menu only for a regular app, so a window being open makes it one.
public enum ActivationPolicyRule {
  public enum Policy: Equatable, Sendable { case regular, accessory }
  public static func policy(showDockIcon: Bool, hasOpenWindow: Bool) -> Policy {
    (showDockIcon || hasOpenWindow) ? .regular : .accessory
  }
}
