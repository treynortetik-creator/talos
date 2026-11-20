import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// What the update window and the menu read: the updater's live step (`UpdateStatus`), and the one-time banner. The updater runs on its
/// own queue and publishes through `apply`; nothing here decides whether to update.
///
/// SAFETY (the owner may be typing): the banner is a non-activating panel that can never become key, so it takes no focus and a key goes
/// to whatever the owner is typing in. Neither it nor the window has a default button or a key equivalent on "Update now", and that
/// button needs a real click (`RealClickButton`, the same check as the Needs-you popup): Return does nothing.
@MainActor
final class UpdateController: ObservableObject {
  static let shared = UpdateController()

  @Published private(set) var status: UpdateStatus = .idle
  /// Shown once per version, the first time it is ready; cleared by Update now or Later.
  @Published private(set) var banner: String?
  weak var updater: AutoUpdater?
  var openWindow: () -> Void = {}
  /// Tests replace this so no panel is shown.
  var orderFront: (NSPanel) -> Void = { $0.orderFrontRegardless() }
  private(set) var bannerPanel: UpdateBannerPanel?
  /// How many times "Update now" was really pressed.
  private(set) var updateNowPresses = 0
  private let announcedKey = "talos.update.announced"
  private var announced: Set<String> {
    get { Set(UserDefaults.standard.stringArray(forKey: announcedKey) ?? []) }
    set { UserDefaults.standard.set(Array(newValue.suffix(20)), forKey: announcedKey) }
  }

  func apply(_ s: UpdateStatus) {
    status = s
    // the owner pressed Update now before the app was replaced: this (new) app shows them the restart and the end, without taking focus
    if let u = updater, let made = (try? FileManager.default.attributesOfItem(atPath: u.ownerAskedPath))?[.modificationDate] as? Date {
      let fresh = Date().timeIntervalSince(made) < 3600
      switch s {
      case .restarting where fresh: presentBanner(s.words.headline, offersUpdate: false)
      case .done, .failed:
        if fresh { presentBanner(s.words.headline + ". " + s.words.detail, offersUpdate: false) }
        try? FileManager.default.removeItem(atPath: u.ownerAskedPath)
      default: break
      }
    }
    if let line = UpdateBanner.announce(s, announced: announced), let v = s.pendingVersion {
      announced.insert(v)
      banner = line
      presentBanner(line, offersUpdate: true)
    }
  }

  /// The banner, on screen without activating the app or taking key.
  func presentBanner(_ text: String, offersUpdate: Bool) {
    bannerPanel?.orderOut(nil)
    let p = UpdateBannerPanel(controller: self, text: text, offersUpdate: offersUpdate)
    bannerPanel = p
    orderFront(p)
  }

  func dismissBanner() {
    banner = nil
    bannerPanel?.orderOut(nil)
    bannerPanel = nil
  }

  /// The window the owner opens from the menu: they asked for it, so it comes forward.
  func show() {
    openWindow()
    NSApp.activate(ignoringOtherApps: true)
  }

  /// "Check for Updates…" (or "Update to x…" when one is waiting): the window opens, and a check runs unless one is already waiting.
  func menuChoice() {
    show()
    if status.pendingVersion == nil, !status.isBusy { updater?.checkNow() }
  }

  func checkAgain() { updater?.checkNow() }

  /// Reached only from `RealClickButton`.
  func updateNow() {
    updateNowPresses += 1
    dismissBanner()
    updater?.updateNow()
  }

  func later() {
    dismissBanner()
    NSApp.keyWindow?.close()
  }

  /// The menu's title and dot, for the top menu and the menu bar menu.
  var menuTitle: String { UpdateMenu.title(status) }
  var menuDot: Bool { UpdateMenu.showsDot(status) }
}

/// A button that only a real click presses: not Return, not an Accessibility press, not a click a program posts (`NeedsYouPopupView.isRealClick`).
/// No key equivalent, never the window's default.
struct RealClickButton: NSViewRepresentable {
  var title: String
  var accent = false
  var action: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(action: action) }

  func makeNSView(context: Context) -> NSButton {
    let b = NSButton(title: title, target: context.coordinator, action: #selector(Coordinator.pressed(_:)))
    b.keyEquivalent = ""
    b.bezelStyle = .rounded
    if accent { b.bezelColor = NSColor(red: 0xD9 / 255, green: 0x69 / 255, blue: 0x2B / 255, alpha: 1) }
    return b
  }

  func updateNSView(_ b: NSButton, context: Context) {
    b.title = title
    context.coordinator.action = action
  }

  @MainActor final class Coordinator: NSObject {
    var action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    @objc func pressed(_ sender: NSButton) {
      let e = NSApp.currentEvent
      guard NeedsYouPopupView.isRealClick(e, on: sender) else {
        SyntheticInput.flight.drop(e.map(SyntheticInputGuard.token(of:)) ?? 0)
        return
      }
      action()
    }
  }
}

enum UpdatePalette {
  static let cream = Color(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255)
  static let ink = Color(red: 0x5A / 255, green: 0x4A / 255, blue: 0x3C / 255)
  static let accent = Color(red: 0xD9 / 255, green: 0x69 / 255, blue: 0x2B / 255)
}

/// The banner: never key, never main, no default button, eats any key sent to it.
final class UpdateBannerPanel: NSPanel {
  @MainActor
  init(controller: UpdateController, text: String, offersUpdate: Bool) {
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 360, height: 120), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    level = .floating
    hidesOnDeactivate = false
    hasShadow = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isReleasedWhenClosed = false
    animationBehavior = .none
    defaultButtonCell = nil
    let host = NSHostingView(rootView: UpdateBannerView(controller: controller, text: text, offersUpdate: offersUpdate))
    contentView = host
    setContentSize(host.fittingSize)
    if let f = NSScreen.main?.visibleFrame { setFrameOrigin(NSPoint(x: f.maxX - frame.width - 16, y: f.maxY - frame.height - 16)) }
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func keyDown(with event: NSEvent) {}
  override func performKeyEquivalent(with event: NSEvent) -> Bool { false }
}

struct UpdateBannerView: View {
  @ObservedObject var controller: UpdateController
  var text: String
  var offersUpdate: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(text)
        .font(.custom("Inter", size: 13).weight(.semibold))
        .foregroundStyle(UpdatePalette.ink)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        if offersUpdate {
          RealClickButton(title: "Later") { controller.dismissBanner() }
          RealClickButton(title: "Update now", accent: true) { controller.updateNow() }
        } else {
          RealClickButton(title: "Close") { controller.dismissBanner() }
        }
      }
    }
    .padding(16)
    .frame(width: 360, alignment: .leading)
    .background(UpdatePalette.cream, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(UpdatePalette.accent, lineWidth: 1))
  }
}

/// The small Talos-branded window: cream, Cinzel headings, Inter body, the clay accent (the onboarding mock's palette).
struct UpdateWindow: View {
  @ObservedObject var controller: UpdateController
  /// Where Allow updates answers (the app's one center; a test hands in its own).
  var allow: CloneConfirmCenter = .shared

  var body: some View {
    let s = controller.status
    let w = s.words
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        if s.isBusy { ProgressView().controlSize(.small).tint(UpdatePalette.accent) }
        Text(w.headline)
          .font(.custom("Cinzel", size: 21).weight(.bold))
          .foregroundStyle(UpdatePalette.ink)
          .accessibilityAddTraits(.isHeader)
      }
      Text(w.detail)
        .font(.custom("Inter", size: 14))
        .foregroundStyle(UpdatePalette.ink)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      Spacer(minLength: 4)
      HStack {
        Spacer()
        buttons(s)
      }
    }
    .padding(22)
    .frame(width: 440, height: 250, alignment: .topLeading)
    .background(UpdatePalette.cream)
    // when the folder the window names changes, the owner has not read the new one yet (`CloneConfirmCenter.windowShows`)
    .onAppear { allow.windowShows(controller.status.allowClone) }
    .onChange(of: controller.status.allowClone) { _, new in allow.windowShows(new) }
    .onDisappear { allow.windowShows(nil) }
  }

  /// No button here is the default: Return does nothing. Esc closes.
  @ViewBuilder private func buttons(_ s: UpdateStatus) -> some View {
    if let clone = s.allowClone {
      Button("Close") { NSApp.keyWindow?.close() }.keyboardShortcut(.cancelAction)
      RealClickButton(title: AllowUpdatesCopy.allowButton, accent: true) { allow.allowFromWindow(clone: clone) }.frame(width: 120)
    } else if s.pendingVersion != nil {
      Button("Later") { controller.later() }.keyboardShortcut(.cancelAction)
      RealClickButton(title: "Update now", accent: true) { controller.updateNow() }.frame(width: 110)
    } else if s.isBusy {
      Button("Close") { NSApp.keyWindow?.close() }.keyboardShortcut(.cancelAction)
    } else {
      Button("Close") { NSApp.keyWindow?.close() }.keyboardShortcut(.cancelAction)
      if case .done = s {
      } else {
        Button("Check again") { controller.checkAgain() }
      }
    }
  }
}
