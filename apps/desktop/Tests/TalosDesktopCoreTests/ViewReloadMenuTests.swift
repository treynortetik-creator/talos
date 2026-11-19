import Foundation
import Testing

@testable import TalosDesktopCore

/// View > Reload (Cmd-R): the Mac app's way to pick up a new relay or web build without quitting (a quit drops every session the app
/// owns). The agent presses it with `screen_key "cmd+r"`, which the screen tools allow only for the front app's own menu shortcuts.
@Suite("View > Reload")
struct ViewReloadMenuTests {
  var reloadItem: AppMenuSpec.Item? { AppMenuSpec.viewMenu.items.compactMap { $0 }.first { $0.action == .reload } }

  @Test func theViewMenuHoldsReloadOnCommandR() {
    #expect(AppMenuSpec.viewMenu.title == "View")
    #expect(reloadItem?.title == "Reload")
    #expect(reloadItem?.key == "r")
    #expect(reloadItem?.shift == false && reloadItem?.option == false)
    #expect(AppMenuSpec.all.map(\.title) == ["Talos", "View", "Window", "Help"], "Edit is added by the app between Talos and View")
    #expect(AppMenuSpec.actions.contains(.reload))
  }

  /// The page's own keymap has no Cmd-R, so the menu key is not shadowing a web shortcut. Read from the web source, where the
  /// chords live in one table.
  @Test func theWebAppBindsNoCommandR() throws {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    let keymap = try String(contentsOf: url.appendingPathComponent("apps/web/src/lib/keymap.ts"), encoding: .utf8)
    #expect(keymap.contains("code: 'KeyK'"), "the keymap file was found and read")
    #expect(!keymap.contains("'KeyR'"), "a web chord on Cmd-R would fight View > Reload")
  }

  /// A menu bar shaped like Talos's own (the spec plus the Edit menu), walked the way the live code walks it. The walk's output
  /// is what `menuShortcuts(pid:)` returns, and `screen_key` accepts a command key only when it is in that list.
  private struct Node { var role: String; var combo: ScreenKeyCombo?; var kids: [Node] = [] }

  private func talosBar() throws -> Node {
    func combo(_ i: AppMenuSpec.Item) -> ScreenKeyCombo? {
      guard !i.key.isEmpty else { return nil }
      var parts = ["cmd"]
      if i.shift { parts.append("shift") }
      if i.option { parts.append("opt") }
      return try? ScreenKeyCombo.parse((parts + [i.key]).joined(separator: "+"))  // Help's "?" has no key name here
    }
    var tops: [Node] = []
    for m in AppMenuSpec.all {
      let items = m.items.compactMap { $0 }.map { Node(role: "AXMenuItem", combo: combo($0)) }
      tops.append(Node(role: "AXMenuBarItem", combo: nil, kids: [Node(role: "AXMenu", combo: nil, kids: items)]))
    }
    return Node(role: "AXMenuBar", combo: nil, kids: tops)
  }

  @Test func theMenuWalkOfTalosListsCommandR() throws {
    let bar = try talosBar()
    let found = MenuWalk.shortcuts(bar: bar, children: \.kids, role: \.role, shortcut: \.combo)
    let cmdR = try ScreenKeyCombo.parse("cmd+r")
    #expect(found.contains { $0.keyCode == cmdR.keyCode && $0.flags == cmdR.flags })
  }

  @Test func screenKeyAcceptsCommandRForTalosAndStillRefusesOtherCombinations() throws {
    let bar = try talosBar()
    let menu = MenuWalk.shortcuts(bar: bar, children: \.kids, role: \.role, shortcut: \.combo)
    let input = FakeInput()
    let apps = FakeApps(front: Fx.talos)
    apps.menu = menu
    let c = Fx.core(input: input, apps: apps)
    let allowed: Set<String> = [ScreenCore.talosBundleID]
    #expect(try c.perform(.key("cmd+r"), allowedBundleIDs: allowed) == 1)
    #expect(input.posted.count == 1)
    // a key that is in no Talos menu still goes nowhere, so the new item did not loosen the rule
    #expect(throws: ScreenRefusal.keyNotInMenu(keys: "cmd+opt+r", app: "Talos")) { try c.perform(.key("cmd+opt+r"), allowedBundleIDs: allowed) }
    #expect(input.posted.count == 1)
  }
}
