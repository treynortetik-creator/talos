import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// The menus beside the Apple logo, the setup screen's sign-in command and the Settings window, with the real AppKit pieces.
// Runs only with TALOS_GUI_TESTS=1. Nothing here activates the app, uses the general pasteboard or plays a sound.

@MainActor
@Suite("Top menu (real NSMenu)", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct TopMenuGuiTests {
  final class Rec { var ran: [AppMenuSpec.Action] = []; var on = false; var signedIn = false; var offers = true; var relay = true }

  func menu(_ rec: Rec) -> AppMenu {
    let m = AppMenu()
    m.host = AppMenu.Host(
      run: { rec.ran.append($0) }, companionOn: { rec.on }, signedIn: { rec.signedIn }, offersSignIn: { rec.offers }, hasRelay: { rec.relay })
    return m
  }

  func allItems(_ m: NSMenu) -> [NSMenuItem] {
    m.items.flatMap { [$0] + ($0.submenu.map(allItems) ?? []) }
  }

  @Test func topLevelMenusAreTalosEditWindowHelp() {
    _ = NSApplication.shared
    let m = menu(Rec()).build()
    #expect(m.items.map(\.title) == ["Talos", "Edit", "Window", "Help"])
  }

  @Test func settingsIsThereWithCommandCommaAndOpensSettings() throws {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    let built = am.build()
    let s = try #require(allItems(built).first { $0.title == "Settings\u{2026}" })
    #expect(s.keyEquivalent == ",")
    #expect(s.keyEquivalentModifierMask == .command)
    #expect(s.isEnabled || am.validateMenuItem(s))
    am.fire(s)
    #expect(rec.ran == [.settings])
  }

  @Test func helpMenuHoldsTalosHelpAndItRuns() throws {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    let built = am.build()
    let help = try #require(built.items.first { $0.title == "Help" }?.submenu)
    #expect(help.items.map(\.title) == ["Talos Help"])
    am.fire(help.items[0])
    #expect(rec.ran == [.help])
  }

  @Test func everyItemReachesItsAction() {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    for i in allItems(am.build()) where i.representedObject != nil { am.fire(i) }
    let own = Set(AppMenuSpec.Action.allCases).subtracting([.hide, .hideOthers, .showAll, .closeWindow, .minimize])
    #expect(Set(rec.ran) == own, "every menu item must be wired: missing \(own.subtracting(Set(rec.ran)))")
  }

  @Test func installPutsItAsTheMainMenuAndHelpMenuAndSurvivesASwap() {
    _ = NSApplication.shared
    let am = menu(Rec())
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    am.install()
    #expect(NSApp.mainMenu === am.menu)
    #expect(NSApp.helpMenu?.title == "Help")
    NSApp.mainMenu = NSMenu(title: "SwiftUI replaced it")  // what a scene change can do
    am.install()
    #expect(NSApp.mainMenu === am.menu, "put back")
  }

  func cmd(_ key: String) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: .command, timestamp: 0, windowNumber: 0, context: nil, characters: key,
      charactersIgnoringModifiers: key, isARepeat: false, keyCode: 0)!
  }

  @Test func swiftUIRewritingTheSameMenuInPlaceIsPutRight() {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    am.install()
    #expect(am.isInstalledIntact)
    // What SwiftUI did in the probe: the SAME NSMenu object, its items swapped for its own.
    let same = NSApp.mainMenu!
    for top in same.items { top.submenu?.removeAllItems() }
    same.items[0].submenu?.addItem(NSMenuItem(title: "Quit", action: nil, keyEquivalent: "q"))
    #expect(NSApp.mainMenu === same && !am.isInstalledIntact, "the identity check used to say this was fine")
    am.install()
    #expect(am.isInstalledIntact)
    #expect(NSApp.mainMenu?.performKeyEquivalent(with: cmd(",")) == true, "Cmd-comma reaches Settings again")
    #expect(rec.ran == [.settings])
  }

  @Test func theMenuIsRepairedByItselfWhenItsItemsChange() {
    _ = NSApplication.shared
    let am = menu(Rec())
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    am.install()
    am.keepInstalled()
    NSApp.mainMenu?.items[3].submenu?.removeItem(at: 0)  // Help emptied behind our back
    #expect(!am.isInstalledIntact)
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    #expect(am.isInstalledIntact, "the change notification brought the menu back")
  }

  @Test func aSilentRewriteIsRepairedWhenTheAppBecomesActive() {
    _ = NSApplication.shared
    let am = menu(Rec())
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    am.install()
    am.keepInstalled()
    NSApp.mainMenu?.items[0].submenu?.removeAllItems()  // posts nothing
    RunLoop.main.run(until: Date().addingTimeInterval(0.2))
    #expect(!am.isInstalledIntact, "nothing noticed it yet")
    NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
    RunLoop.main.run(until: Date().addingTimeInterval(0.4))
    #expect(am.isInstalledIntact, "the menu is checked every time Talos comes to the front, which is when it shows")
  }

  @Test func appKitsOwnEditAdditionsDoNotCountAsDamage() {
    _ = NSApplication.shared
    let am = menu(Rec())
    let before = NSApp.mainMenu
    defer { NSApp.mainMenu = before }
    am.install()
    NSApp.mainMenu?.items[1].submenu?.addItem(NSMenuItem(title: "Start Dictation\u{2026}", action: nil, keyEquivalent: ""))
    #expect(am.isInstalledIntact, "macOS appends Writing Tools, Dictation and Emoji to Edit")
  }

  @Test func closeAndMinimizeAreInTheWindowMenuAndAnswerOnTheResponderChain() throws {
    _ = NSApplication.shared
    let win = try #require(menu(Rec()).build().items.first { $0.title == "Window" }?.submenu)
    let close = try #require(win.items.first { $0.title == "Close" })
    let mini = try #require(win.items.first { $0.title == "Minimize" })
    #expect(close.keyEquivalent == "w" && close.action == #selector(NSWindow.performClose(_:)) && close.target == nil)
    #expect(mini.keyEquivalent == "m" && mini.action == #selector(NSWindow.performMiniaturize(_:)) && mini.target == nil)
  }

  @Test func theEditMenuIsThereSoPasteWorksInSettings() throws {
    _ = NSApplication.shared
    let edit = try #require(menu(Rec()).build().items.first { $0.title == "Edit" }?.submenu)
    #expect(edit.items.map(\.keyEquivalent).contains("v"))
  }

  @Test func signInAndSignOutShowOnlyWhenTheyApply() throws {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    let built = am.build()
    let signIn = try #require(allItems(built).first { $0.title == "Sign in\u{2026}" })
    let signOut = try #require(allItems(built).first { $0.title == "Sign out" })
    _ = am.validateMenuItem(signIn); _ = am.validateMenuItem(signOut)
    #expect(!signIn.isHidden && signOut.isHidden)
    rec.signedIn = true; rec.offers = false
    _ = am.validateMenuItem(signIn); _ = am.validateMenuItem(signOut)
    #expect(signIn.isHidden && !signOut.isHidden)
    // Relay down or page still loading: not signed in as far as we know, but the page has not said "signed out" either.
    rec.signedIn = false; rec.offers = false
    _ = am.validateMenuItem(signIn); _ = am.validateMenuItem(signOut)
    #expect(signIn.isHidden, "no Sign in while the page has not said the owner is signed out (audit D46)")
    rec.offers = true
    rec.signedIn = false; rec.relay = false
    #expect(!am.validateMenuItem(signIn), "no relay: Sign in is greyed, not hidden")
  }

  @Test func theCompanionItemShowsTheSwitch() throws {
    _ = NSApplication.shared
    let rec = Rec()
    let am = menu(rec)
    let item = try #require(allItems(am.build()).first { $0.title == "Show Companion" })
    rec.on = true
    _ = am.validateMenuItem(item)
    #expect(item.state == .on)
    rec.on = false
    _ = am.validateMenuItem(item)
    #expect(item.state == .off)
  }

  @Test func theWindowMenusToggleReallyShowsAndHidesTheCharacter() {
    _ = NSApplication.shared
    let std = UserDefaults.standard
    std.removeObject(forKey: CompanionController.Key.enabled)
    defer { std.removeObject(forKey: CompanionController.Key.enabled) }
    let c = CompanionController(defaults: std)
    c.host = CompanionController.Host(screens: { [CompanionScreen(uuid: "T", frame: CompanionFixture.realVisible, visibleFrame: CompanionFixture.realVisible, isPrimary: true)] })
    setenv("TALOS_COMPANION_DIR", companionFixtures, 1)
    c.start(inputs: { CompanionInputs() }, host: c.host)
    defer { c.shutdown() }
    #expect(!c.isOnScreen)
    AppMenuActions.toggleCompanion(c)  // what the menu item runs
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(c.isOnScreen, "the character appears")
    AppMenuActions.toggleCompanion(c)
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(!c.isOnScreen && c.panels.isEmpty, "and goes away")
  }
}

@MainActor
@Suite("Setup screen", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct SetupScreenGuiTests {
  @Test func copyPutsTheExactCommandOnThePasteboard() {
    let pb = NSPasteboard(name: NSPasteboard.Name("talos.test.\(UUID().uuidString)"))
    defer { pb.releaseGlobally() }
    let cmd = SignInHelp.command(resolved: nil)
    SignInAction.copy(cmd, to: pb)
    #expect(pb.string(forType: .string) == cmd)
  }

  @Test func ownQuitActionsCancelTheRescue() {
    let g = RelaunchGuard()
    g.appPath = "/Applications/Fake.app"
    g.opener = "/usr/bin/true"
    g.arm()
    g.deliberateQuit()
    #expect(!g.isArmed)
  }

  @Test func theGuardOnlyArmsForARealAppBundle() {
    let g = RelaunchGuard()
    g.appPath = "/home/alex/.build/debug/TalosDesktop"
    g.arm()
    #expect(!g.isArmed, "a dev build has no bundle to reopen")
    g.disarm()
  }

  @Test func armingThenDisarmingEndsTheHelper() throws {
    let g = RelaunchGuard()
    g.appPath = "/Applications/Fake.app"
    g.opener = "/usr/bin/true"
    g.arm()
    #expect(g.isArmed)
    g.arm()  // twice is still one helper
    g.disarm()
    #expect(!g.isArmed)
  }
}

@MainActor
@Suite("Which windows make Talos a Dock app", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct WindowPolicyGuiTests {
  /// A panel that is willing to be the main window (a floating overlay can be): the rule must still not count it.
  final class MainablePanel: NSPanel { override var canBecomeMain: Bool { true } }

  @Test func aNormalWindowCountsAPanelDoesNot() {
    _ = NSApplication.shared
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 80, height: 60), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    let p = MainablePanel(contentRect: NSRect(x: 0, y: 0, width: 80, height: 60), styleMask: [.titled], backing: .buffered, defer: false)
    defer { w.close(); p.close() }
    #expect(!ActivationPolicyController.counts(w), "not on screen yet")
    w.orderFrontRegardless(); p.orderFrontRegardless()
    #expect(ActivationPolicyController.counts(w))
    #expect(!ActivationPolicyController.counts(p), "the character's overlays and quick compose are panels")
  }
}

/// Not an assertion suite: renders the Settings window's tabs, the setup screen and Help to PNG files so a person can look at
/// them. Runs only with TALOS_GUI_TESTS=1 and TALOS_SHOT_DIR (a folder). The controller is the safe scratch-HOME one.
@MainActor
@Suite("Screens to PNG", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled && ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"] != nil))
struct ScreenShotTests {
  func shoot<V: View>(_ v: V, size: NSSize, to path: String) throws {
    _ = NSApplication.shared
    let host = NSHostingView(rootView: v.frame(width: size.width, height: size.height))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled], backing: .buffered, defer: false)
    w.appearance = NSAppearance(named: .aqua)
    w.contentView = host
    host.appearance = NSAppearance(named: .aqua)
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    RunLoop.main.run(until: Date().addingTimeInterval(1.2))  // the sign-in command resolves off the main thread
    host.layoutSubtreeIfNeeded()
    let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: path))
  }

  @Test func render() throws {
    let dir = try #require(ProcessInfo.processInfo.environment["TALOS_SHOT_DIR"])
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let world = try TmuxWorld()
    let m = world.model
    for (tab, name) in [
      (SettingsNavigator.Tab.session, "settings-session"), (.connection, "settings-connection"), (.companion, "settings-companion"),
      (.general, "settings-general"),
    ] {
      SettingsNavigator.shared.selected = tab
      try shoot(SettingsView(model: m), size: NSSize(width: 700, height: 560), to: dir + "/\(name).png")
    }
    try shoot(OnboardingView(model: m), size: NSSize(width: 560, height: 640), to: dir + "/setup-screen.png")
  }
}
