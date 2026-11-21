import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore

@testable import TalosDesktop

/// Renders every Mac settings tab (Advanced shut at the window's size and opened full length), the Your agent tab not set up, and the
/// menu bar menu with its Advanced submenu, to PNG files for a person to compare with the approved mock and the plain-words board.
/// Runs only with TALOS_GUI_TESTS=1 and TALOS_SETTINGS_SHOTS (a folder). It also asserts what a picture cannot show: each picture is
/// not blank, is the mock's 900 by 640, and the tabs differ from one another. The menu is the real `StatusMenuContent` view drawn
/// with plain buttons (the menu bar's own chrome is macOS's and cannot be drawn offscreen).
@MainActor
@Suite(
  "Settings and menu to PNG", .serialized, .guiExclusive,
  .enabled(if: guiTestsEnabled && ProcessInfo.processInfo.environment["TALOS_SETTINGS_SHOTS"] != nil))
struct SettingsShotsGuiTests {
  nonisolated(unsafe) static var keep: [NSWindow] = []

  func resources() -> URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Resources/onboarding")
  }

  func model(configured: Bool) throws -> SupervisorController {
    cannotTakeTheKeyboard()
    _ = TmuxWorld.root
    TmuxWorld.hookBundle()
    try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    let m = SupervisorController(store: MemoryStore())
    if configured { #expect(m.importCommand("claude --permission-mode auto") == nil) }
    return m
  }

  func render<V: View>(_ v: V, size: CGSize, to path: String) async throws -> Data {
    _ = NSApplication.shared
    OnboardingFonts.directoryOverride = resources()
    let host = NSHostingView(rootView: AnyView(v.frame(width: size.width, height: size.height)))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.animationBehavior = .none
    Self.keep.append(w)
    w.appearance = NSAppearance(named: .aqua)
    w.contentView = host
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    await pump(1.6)
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    let raw = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: raw)
    let rep = try #require(raw.converting(to: NSColorSpace.sRGB, renderingIntent: .default))
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: path))
    // not blank: the cream ground and several other colours
    var seen = Set<UInt32>()
    for x in stride(from: 0, to: rep.pixelsWide, by: 5) {
      for y in stride(from: 0, to: rep.pixelsHigh, by: 5) {
        if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
          seen.insert(UInt32(c.redComponent * 255) << 16 | UInt32(c.greenComponent * 255) << 8 | UInt32(c.blueComponent * 255))
        }
      }
    }
    #expect(seen.count > 8, "\(path) looks blank")
    #expect(rep.pixelsWide % Int(size.width) == 0)
    return png
  }

  /// The menu bar menu as a person reads it: items in a quiet panel, dividers between groups.
  struct MenuShot<C: View>: View {
    let title: String
    @ViewBuilder var content: C
    var body: some View {
      VStack(alignment: .leading, spacing: 0) {
        Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary).padding(.bottom, 6)
        VStack(alignment: .leading, spacing: 5) { content }
          .buttonStyle(.plain)
          .font(.system(size: 13))
          .padding(12)
          .frame(width: 330, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color(white: 0.97)))
          .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(white: 0.8)))
      }
      .padding(16)
      .background(Color.white)
      .environment(\.colorScheme, .light)
    }
  }

  @Test func everyTabAndTheMenu() async throws {
    let dir = try #require(ProcessInfo.processInfo.environment["TALOS_SETTINGS_SHOTS"])
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let m = try model(configured: true)
    defer {
      let d = (SupervisorController.configPath as NSString).deletingLastPathComponent
      chmod(d, 0o700)
      try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    }
    let std = CGSize(width: SP.width, height: SP.height)
    var sizes: [String: Int] = [:]
    let names: [SettingsNavigator.Tab: String] = [
      .agent: "1-your-agent", .phone: "2-phone-and-mac", .access: "3-privacy-and-access", .general: "4-general", .advanced: "5-advanced",
    ]
    for tab in SettingsNavigator.Tab.allCases {
      SettingsNavigator.shared.selected = tab
      let name = try #require(names[tab])
      var view = SettingsView(model: m)
      view.headlineForTest = .init(text: "Running \u{00B7} Talos server connected", ok: true)
      sizes[name] = try await render(view, size: std, to: dir + "/\(name).png").count
    }
    // Advanced opened: its whole length (the window scrolls; this is every row, one after another)
    SettingsNavigator.shared.selected = .advanced
    _ = try await render(SettingsView(model: m), size: CGSize(width: SP.width, height: 1500), to: dir + "/5-advanced-opened-full.png")
    // not set up: the first run's Your agent tab
    let bare = try model(configured: false)
    SettingsNavigator.shared.selected = .agent
    _ = try await render(SettingsView(model: bare), size: std, to: dir + "/1-your-agent-not-set-up.png")
    // the menu
    let web = WebController.shared
    func menu(_ model: SupervisorController, _ title: String) -> some View {
      MenuShot(title: title) {
        StatusMenuContent(
          model: model, web: web, status: StatusCoordinator.shared, companion: CompanionController.shared,
          updates: UpdateController.shared, allowUpdates: CloneConfirmCenter.shared, companionOn: .constant(false))
      }
    }
    _ = try await render(menu(m, "Menu bar menu"), size: CGSize(width: 380, height: 760), to: dir + "/6-menu-bar-menu.png")
    _ = try await render(menu(bare, "Menu bar menu, not set up"), size: CGSize(width: 380, height: 760), to: dir + "/6-menu-bar-menu-not-set-up.png")
    _ = try await render(
      MenuShot(title: "Menu bar menu: Advanced") {
        AdvancedMenuItems(model: m, openWindow: { _ in }, asList: true)
      },
      size: CGSize(width: 380, height: 260), to: dir + "/6-menu-bar-menu-advanced.png")
    #expect(Set(sizes.values).count == sizes.count, "each tab drew something different: \(sizes)")
  }
}
