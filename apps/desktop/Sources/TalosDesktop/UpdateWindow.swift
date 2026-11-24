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
    // a failed update waiting for Try again: its line is shown first (the window's Try again does the repair), no new check starts
    if let u = updater, u.needsRepair() {
      u.showRepairLine()
      return
    }
    if status.pendingVersion == nil, !status.isBusy {
      if status.allowClone != nil { updater?.checkNow() } else { startCheck() }
    }
  }

  /// The update window's Check again / Try again: one check that always ends in an answer (`startCheck`).
  func checkAgain() { ownerTry { self.startCheck() } }

  /// The one owner-press entry for a check (the window's Check again / Try again, and About's button): the UPDATER is asked whether a
  /// failed update waits for repair, and if so that is retried first; `proceed` (the check) runs only when nothing is left to repair.
  /// No timer, launch or menu open goes through here, so a failing repair cannot loop.
  func ownerTry(_ proceed: @escaping @MainActor () -> Void) {
    guard let u = updater, u.needsRepair() else { return proceed() }
    u.retryRepair { passed in Task { @MainActor in if passed { proceed() } } }
  }

  /// The updater's own full check, for after the owner has allowed the Talos code folder (the question is answered, the release waits).
  func recheckAfterAllow() { updater?.checkNow() }

  /// How many checks the About window's button really started.
  private(set) var aboutChecks = 0
  /// Tests replace the check itself (the real one reaches the network); nil means the updater's.
  var checkOverride: (() -> Void)?

  /// The About window's Check for Updates: the same check as the menu item, once. Ignored while one is running or an update is waiting.
  func checkFromAbout() {
    guard !status.isBusy, status.pendingVersion == nil, status.allowClone == nil else { return }
    aboutChecks += 1
    if let f = checkOverride { f() } else { ownerTry { self.startCheck() } }
  }

  // MARK: a check that always answers

  /// A look at the release feed that needs no agent, no Talos code folder and no sign-in (`AutoUpdater.probe`); runs off the main thread.
  /// The app sets it when the updater is built; nil here means there is nothing to look with, which is said, not hidden.
  var probe: (@Sendable () -> UpdateProbeResult)?
  /// Whether Talos installs updates by itself (desktop.json). A newer version found while it is off is said, not downloaded.
  var updatesAreOn: () -> Bool = { true }
  /// Whether Talos is set up (an agent folder exists). Before that a newer version is only announced.
  var isSetUp: () -> Bool = { true }
  /// How long a check may take before it says it could not check.
  var checkTimeout: Double = 15
  /// How many checks `startCheck` really began.
  private(set) var checksStarted = 0
  private var checkGen = 0
  private var watchdog: Task<Void, Never>?

  /// Check for Updates and Check again: "Checking...", then ONE of: up to date, an update (ready, or downloading), or a plain reason it
  /// could not check with Try again. Nothing here waits on a session, the bridge or the clone question; a stalled look ends after
  /// `checkTimeout` seconds.
  func startCheck() {
    guard !status.isBusy, status.pendingVersion == nil, status.allowClone == nil else { return }
    checkGen += 1
    checksStarted += 1
    let gen = checkGen
    apply(.checking)
    watchdog?.cancel()
    let limit = checkTimeout
    watchdog = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
      guard !Task.isCancelled else { return }
      self?.checkTimedOut(gen)
    }
    guard let look = probe else { return finishCheck(gen, .problem(.other)) }
    Task.detached {
      let r = look()
      await MainActor.run { self.finishCheck(gen, r) }
    }
  }

  private func checkTimedOut(_ gen: Int) {
    // only a check still "Checking" is cut off; one that moved on to downloading is already answering
    guard gen == checkGen, status == .checking else { return }
    checkGen += 1
    apply(.couldntCheck(.timedOut))
  }

  private func finishCheck(_ gen: Int, _ r: UpdateProbeResult) {
    guard gen == checkGen, status == .checking else { return }
    switch r {
    case .upToDate(let v):
      watchdog?.cancel()
      apply(.upToDate(version: v))
    case .problem(let p):
      watchdog?.cancel()
      apply(.couldntCheck(p))
    case .newer(let v):
      watchdog?.cancel()
      if !updatesAreOn() {
        apply(.available(version: v))
      } else if !isSetUp() {
        // before setup there is no Talos code folder to update: said, with nothing to press, and installed after setup
        apply(.availableAfterSetup(version: v))
      } else if let u = updater {
        // the existing path: fetch, verify, "ready" with Install (or its own plain reason). No timeout watches it now: the fetch of the
        // release can take longer than the look did, and the updater has its own limits. "Getting Talos x" stands until it speaks.
        apply(.fetching(version: v))
        u.checkNow()
      } else {
        apply(.available(version: v))
      }
    }
  }

  /// Reached only from `RealClickButton`.
  func updateNow() {
    updateNowPresses += 1
    dismissBanner()
    updater?.updateNow()
  }

  /// Reached only from `RealClickButton`: skips the rest of the thread agents' wait (never Main's running turn).
  func skipThreadWait() {
    updater?.skipThreadWait()
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
  /// A fixed face width; nil is the title's own width (at least 84 pt).
  var width: CGFloat?
  /// Drawn by `PillRealClickButton` (a borderless button with fixed ink text that reads the same in light and dark appearance).
  var plain = false
  var action: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(action: action) }

  /// Never stretched to what the row offers: a button keeps its own face (the proposal made the filled one fill the whole panel).
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
    plain ? nil : UpdateFaceButton.faceSize(nsView, width: width)
  }

  func makeNSView(context: Context) -> NSButton {
    let b = UpdateFaceButton(title: title, target: context.coordinator, action: #selector(Coordinator.pressed(_:)))
    b.keyEquivalent = ""
    // The panels are cream in light AND dark, so the button must not follow the system appearance: a dark-mode bezel is a translucent
    // white one with white text, which on cream is unreadable (the "Later" / "Update now" bug). Pinned to light, it is always the
    // system's light bezel with the system's dark text.
    b.appearance = NSAppearance(named: .aqua)
    if plain {
      b.isBordered = false
      b.attributedTitle = Self.inkTitle(title)
      return b
    }
    if accent {
      b.isBordered = false
      b.wantsLayer = true
      b.layer?.backgroundColor = UpdatePalette.accentFillNS.cgColor
      b.layer?.cornerRadius = UpdateFaceButton.faceHeight / 2
      b.attributedTitle = Self.faceTitle(title, color: .white)
    } else {
      b.bezelStyle = .rounded
      b.controlSize = .large
    }
    return b
  }

  static func faceTitle(_ t: String, color: NSColor) -> NSAttributedString {
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    return NSAttributedString(string: t, attributes: [.foregroundColor: color, .font: NSFont.systemFont(ofSize: 13, weight: .semibold), .paragraphStyle: para])
  }

  static func inkTitle(_ t: String) -> NSAttributedString {
    let para = NSMutableParagraphStyle()
    para.alignment = .center
    let font = NSFont(name: "Inter", size: 14) ?? NSFont.systemFont(ofSize: 14, weight: .semibold)
    return NSAttributedString(string: t, attributes: [.foregroundColor: NSColor(red: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1), .font: font, .paragraphStyle: para])
  }

  func updateNSView(_ b: NSButton, context: Context) {
    b.title = title
    if plain { b.attributedTitle = Self.inkTitle(title) } else if accent { b.attributedTitle = Self.faceTitle(title, color: .white) }
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

/// The onboarding look for a real-click button: filled Talos orange (primary) or an outlined pill (secondary), 44 pt tall, ink text.
/// The capsule is drawn here (`OutlineCapsule` for the outline); the AppKit button on top keeps the real-click check and has no key equivalent.
struct PillRealClickButton: View {
  var title: String
  var primary = false
  var width: CGFloat = 130
  var action: () -> Void

  var body: some View {
    ZStack {
      if primary { Capsule().fill(OB.accent) } else { OutlineCapsule(color: OB.line) }
      RealClickButton(title: title, plain: true, action: action).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(width: width, height: 44)
    .environment(\.colorScheme, .light)
  }
}

/// A button with a fixed face height, so the filled primary and the system bezel line up.
final class UpdateFaceButton: NSButton {
  static let faceHeight: CGFloat = 28
  static func faceSize(_ b: NSButton, width: CGFloat?) -> CGSize {
    let w = width ?? max(84, b.fittingSize.width)
    return CGSize(width: w, height: faceHeight)
  }
  override var intrinsicContentSize: NSSize {
    let s = super.intrinsicContentSize
    return NSSize(width: isBordered ? s.width : s.width + 28, height: Self.faceHeight)
  }
}

/// A plain (not real-click) action button for the update window: Later, Close, Check again. The same pinned-light system bezel as
/// `RealClickButton`'s secondary look, so it reads the same in light and dark appearance. `escape` makes Esc press it.
struct UpdateTextButton: NSViewRepresentable {
  var title: String
  var escape = false
  var width: CGFloat?
  var action: () -> Void

  func makeCoordinator() -> Coordinator { Coordinator(action: action) }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSButton, context: Context) -> CGSize? {
    UpdateFaceButton.faceSize(nsView, width: width)
  }

  func makeNSView(context: Context) -> NSButton {
    let b = UpdateFaceButton(title: title, target: context.coordinator, action: #selector(Coordinator.pressed))
    b.appearance = NSAppearance(named: .aqua)
    b.bezelStyle = .rounded
    b.controlSize = .large
    b.keyEquivalent = escape ? "\u{1b}" : ""
    return b
  }

  func updateNSView(_ b: NSButton, context: Context) {
    b.title = title
    context.coordinator.action = action
  }

  @MainActor final class Coordinator: NSObject {
    var action: () -> Void
    init(action: @escaping () -> Void) { self.action = action }
    @objc func pressed() { action() }
  }
}

enum UpdatePalette {
  static let cream = Color(red: 0xF3 / 255, green: 0xE6 / 255, blue: 0xCF / 255)
  static let ink = Color(red: 0x5A / 255, green: 0x4A / 255, blue: 0x3C / 255)
  static let accent = Color(red: 0xD9 / 255, green: 0x69 / 255, blue: 0x2B / 255)
  /// The fill of a primary button with white text: darker than `accent` (white on D9692B is only 3.5:1), 5.2:1 on white.
  static let accentFillNS = NSColor(red: 0xB8 / 255, green: 0x4A / 255, blue: 0x12 / 255, alpha: 1)
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
      UpdateTextButton(title: "Close", escape: true) { NSApp.keyWindow?.close() }
      PillRealClickButton(title: AllowUpdatesCopy.allowButton, primary: true, width: 150) { allow.allowFromWindow(clone: clone) }
    } else if s.offersSkipThreadWait {
      // only thread agents are left: their wait is the line above; Main's own turn never gets this button
      UpdateTextButton(title: "Later", escape: true) { controller.later() }
      RealClickButton(title: UpdateStatus.skipThreadWaitButton, accent: true, width: 170) { controller.skipThreadWait() }
    } else if s.pendingVersion != nil {
      UpdateTextButton(title: "Later", escape: true) { controller.later() }
      RealClickButton(title: AboutCopy.installButton, accent: true, width: 110) { controller.updateNow() }
    } else if s.isBusy {
      UpdateTextButton(title: "Close", escape: true) { NSApp.keyWindow?.close() }
    } else {
      UpdateTextButton(title: "Close", escape: true) { NSApp.keyWindow?.close() }
      if case .done = s {
      } else {
        UpdateTextButton(title: AboutCopy.checkButtonTitle(s) == AboutCopy.checkButton ? "Check again" : AboutCopy.tryAgainButton) { controller.checkAgain() }
      }
    }
  }
}
