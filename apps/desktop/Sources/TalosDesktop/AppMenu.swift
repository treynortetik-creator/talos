import AppKit
import OSLog
import SwiftUI
import TalosDesktopCore

/// The menus at the top of the screen, beside the Apple logo (Talos, Edit, Window, Help). A menu-bar-only app has none of
/// its own, so the owner found no Settings there. They are built here from `AppMenuSpec` and installed as
/// `NSApp.mainMenu`, which works with or without a Dock icon: the menu shows whenever Talos is the frontmost app. The
/// actions go through one `run` closure so a test can press every item and see what it asked for.
@MainActor
final class AppMenu: NSObject, NSMenuItemValidation {
  static let shared = AppMenu()

  struct Host {
    var run: (AppMenuSpec.Action) -> Void
    var companionOn: () -> Bool
    var signedIn: () -> Bool
    /// True only when the page itself said the owner is signed out (`PageState.offersSignIn`), never while it is loading or
    /// the relay is down.
    var offersSignIn: () -> Bool
    var hasRelay: () -> Bool
  }

  var host: Host?
  private(set) var menu: NSMenu?
  private var observers: [NSObjectProtocol] = []

  // MARK: building

  func build() -> NSMenu {
    let main = NSMenu(title: "Main")
    for spec in AppMenuSpec.all {
      let host = NSMenuItem(title: spec.title, action: nil, keyEquivalent: "")
      let sub = NSMenu(title: spec.title)
      for entry in spec.items {
        guard let e = entry else { sub.addItem(.separator()); continue }
        sub.addItem(item(e))
      }
      host.submenu = sub
      main.addItem(host)
      if spec.title == AppMenuSpec.talosMenu.title { main.addItem(editItem()) }
    }
    return main
  }

  private func item(_ e: AppMenuSpec.Item) -> NSMenuItem {
    let i: NSMenuItem
    switch e.action {
    case .hide:
      i = NSMenuItem(title: e.title, action: #selector(NSApplication.hide(_:)), keyEquivalent: e.key)
      i.target = NSApp
    case .hideOthers:
      i = NSMenuItem(title: e.title, action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: e.key)
      i.target = NSApp
    case .showAll:
      i = NSMenuItem(title: e.title, action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: e.key)
      i.target = NSApp
    case .closeWindow:
      i = NSMenuItem(title: e.title, action: #selector(NSWindow.performClose(_:)), keyEquivalent: e.key)  // responder chain
    case .minimize:
      i = NSMenuItem(title: e.title, action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: e.key)
    default:
      i = NSMenuItem(title: e.title, action: #selector(fire(_:)), keyEquivalent: e.key)
      i.target = self
      i.representedObject = e.action.rawValue
    }
    var mods: NSEvent.ModifierFlags = e.key.isEmpty ? [] : [.command]
    if e.shift { mods.insert(.shift) }
    if e.option { mods.insert(.option) }
    i.keyEquivalentModifierMask = mods
    return i
  }

  /// Undo, Cut, Copy, Paste, Select All: without this Cmd-V does nothing in Settings' text boxes.
  private func editItem() -> NSMenuItem {
    let edit = NSMenu(title: "Edit")
    func add(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      edit.addItem(i)
    }
    add("Undo", Selector(("undo:")), "z")
    add("Redo", Selector(("redo:")), "z", [.command, .shift])
    edit.addItem(.separator())
    add("Cut", #selector(NSText.cut(_:)), "x")
    add("Copy", #selector(NSText.copy(_:)), "c")
    add("Paste", #selector(NSText.paste(_:)), "v")
    add("Select All", #selector(NSText.selectAll(_:)), "a")
    let host = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    host.submenu = edit
    return host
  }

  // MARK: installing

  /// What a menu looks like to the owner: titles, keys and who answers. Compared by content, because SwiftUI keeps the same
  /// NSMenu object and swaps its items in place (measured with a SwiftUI probe, 2026-11-01), so "is it my object" says yes
  /// while Settings and Help are gone.
  static func signature(_ m: NSMenu?) -> [[String]] {
    guard let m else { return [] }
    return m.items.map { top -> [String] in
      let subs = top.submenu?.items.map { i -> String in
        let t: String = i.target === NSApp ? "app" : (i.target is AppMenu ? "menu" : (i.target == nil ? "chain" : "other"))
        return i.isSeparatorItem ? "-" : "\(i.title)|\(i.keyEquivalent)|\(i.keyEquivalentModifierMask.rawValue)|\(t)"
      } ?? []
      return ["# \(top.title)"] + subs
    }
  }

  /// True when `NSApp.mainMenu` still holds our items.
  var isInstalledIntact: Bool {
    let want = expected ?? Self.signature(build())
    expected = want
    return MenuIntegrity.holds(Self.signature(NSApp.mainMenu), want)
  }
  private var expected: [[String]]?
  private var repairScheduled = false
  private var budget = MenuRepairBudget()
  private static let log = Logger(subsystem: "app.talos.desktop", category: "menu")

  /// Makes this the app's menu. Called at launch and again whenever SwiftUI or another window changed it. A menu whose items
  /// were replaced is not ours any more, even when it is the same object, so it is rebuilt.
  func install() {
    if !isInstalledIntact || menu == nil {
      let m = build()
      menu = m
      NSApp.mainMenu = m
    }
    if let help = NSApp.mainMenu?.items.first(where: { $0.title == AppMenuSpec.helpMenu.title })?.submenu { NSApp.helpMenu = help }
  }

  /// A repair from a notification, limited to a few per minute. Whatever disagrees about the menu, it can only cost a few
  /// rebuilds, and the owner's log says so once.
  func reinstallWithinBudget(now: Date = Date()) {
    switch budget.request(at: now) {
    case .go: install()
    case .stopAndLog:
      Self.log.error("top menu was rebuilt \(self.budget.limit) times in \(Int(self.budget.window)) s; leaving it alone until that passes")
      retryWhenAllowed(now: now)
    case .stop: retryWhenAllowed(now: now)
    }
  }

  /// A refused repair is not dropped: one more check is scheduled for when the oldest install ages out, so a real replacement
  /// that lands inside the window waits a little instead of staying wrong until some later notification. `repairSoon` keeps
  /// it to one pending check.
  private func retryWhenAllowed(now: Date) {
    repairSoon(after: budget.waitUntilAllowed(at: now) + 0.1)
  }

  /// Keeps the menu in place for the life of the app: on activation, on a window becoming key, and whenever a menu's items
  /// change (SwiftUI rewrites them after the first activation).
  func keepInstalled() {
    guard observers.isEmpty else { return }
    let nc = NotificationCenter.default
    for name in [
      NSApplication.didBecomeActiveNotification, NSWindow.didBecomeKeyNotification, NSMenu.didAddItemNotification,
      NSMenu.didRemoveItemNotification,
    ] {
      observers.append(
        nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated { self?.repairSoon() }
        })
    }
  }

  /// One check a moment later, however many notifications arrived: SwiftUI finishes its rewrite before we look.
  func repairSoon(after delay: TimeInterval = 0.05) {
    guard !repairScheduled else { return }
    repairScheduled = true
    let t = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.repairScheduled = false
        if !self.isInstalledIntact { self.reinstallWithinBudget() }
      }
    }
    RunLoop.main.add(t, forMode: .common)
  }

  // MARK: acting

  @objc func fire(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let a = AppMenuSpec.Action(rawValue: raw) else { return }
    host?.run(a)
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard let raw = item.representedObject as? String, let a = AppMenuSpec.Action(rawValue: raw), let host else { return true }
    switch a {
    case .companionToggle:
      item.state = host.companionOn() ? .on : .off
      return true
    case .signIn:
      item.isHidden = !host.offersSignIn()
      return host.hasRelay()
    case .signOut:
      item.isHidden = !host.signedIn()
      return true
    default:
      return true
    }
  }

  /// Dock icon clicked with no window showing: bring something back.
  func reopen() { host?.run(.showTalos) }
}
