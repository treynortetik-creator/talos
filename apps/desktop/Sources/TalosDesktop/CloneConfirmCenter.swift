import AppKit
import Foundation
import SwiftUI
import TalosDesktopCore

/// The question "Allow Talos to update itself?": a recorded Talos code folder the app has not accepted. Whoever notices one (the app at
/// launch, a poll while it runs, a check that finds a release waiting) calls `request`; the answer is the owner's real click on
/// `AllowUpdatesView`'s Allow updates, nothing else. The state lives here in memory and is re-derived from the record and the Keychain
/// on every launch (`AllowUpdatesWatch`), so a relaunch (an update restarts the app) can never lose the question.
@MainActor
final class CloneConfirmCenter: ObservableObject {
  static let shared = CloneConfirmCenter()

  /// The clone that waits for an answer; nil: nothing is owed.
  @Published private(set) var pending: String?
  /// The prompt is on screen (or should be).
  @Published private(set) var visible = false
  /// Why the last Allow updates did nothing, in plain words.
  @Published private(set) var failure: String?
  private var lastVersion: String?

  /// One panel on screen: the clone it was made for never changes, and a click is judged against it, not against what is pending now.
  struct PanelToken: Equatable {
    let id = UUID()
    let clone: String
    /// `now()` when it appeared: monotonic seconds (`systemUptime`), so a clock change never shortens or lengthens the settle time.
    let shownAt: TimeInterval
  }
  /// The panel that may be answered now; nil when none is up. A dismissed panel is no longer this one, so a click on it is refused.
  private(set) var activePanel: PanelToken?
  /// A click this soon after a panel appears is ignored (it was meant for what was on screen before).
  var clickDelay: TimeInterval = 1
  var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

  var acceptance: any CloneAcceptance = KeychainCloneAcceptance()
  /// The record as it is now, and the folders a clone may not be in (the same judgement the updater and the Agent folder card use).
  var record: () -> (clone: String, file: String)? = { AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: NSHomeDirectory())) }
  var unsafe: () -> [String] = { [] }
  /// After an accept: run the check again so the release that waited goes ahead.
  var onAccepted: () -> Void = { UpdateController.shared.checkAgain() }
  /// Puts a panel on screen for this token; tests replace it.
  var present: (CloneConfirmCenter, PanelToken) -> Void = { AllowUpdatesPanelHost.show($0, $1) }
  var dismiss: () -> Void = { AllowUpdatesPanelHost.hide() }

  /// Someone found a clone that waits for the owner. A prompt that is up never changes its clone: a different clone dismisses it and
  /// asks fresh with a new panel. The same clone with the same release stays as it is (Not now holds); only a release after one the
  /// center already knew (v1 then v2) asks again. A first release after the launch watch's own look (nil, then v) is not new.
  func request(_ clone: String, version: String? = nil) {
    let newRelease = version != nil && lastVersion != nil && version != lastVersion
    if let version { lastVersion = version }
    if pending == clone, !newRelease { return }
    if pending != nil { takeDown() }
    pending = clone
    failure = nil
    visible = true
    show(clone)
  }

  private func show(_ clone: String) {
    let t = PanelToken(clone: clone, shownAt: now())
    activePanel = t
    present(self, t)
  }

  private func takeDown() {
    activePanel = nil
    dismiss()
  }

  /// Nothing is owed any more (accepted elsewhere, or the record changed): the prompt goes away.
  func clear() {
    pending = nil
    visible = false
    failure = nil
    takeDown()
  }

  /// What a look at the record and the Keychain found: a clone that waits, or nothing.
  func sync(unaccepted: String?) {
    if let c = unaccepted { request(c) } else if pending != nil { clear() }
  }

  /// "Not now": hidden until the next release or launch. The menu item brings it back.
  func notNow() {
    visible = false
    takeDown()
  }

  /// The menu item "Allow updates…": a new panel (and a new settle time).
  func showAgain() {
    guard let c = pending else { return }
    if activePanel != nil { takeDown() }
    visible = true
    show(c)
  }

  /// The update window's Allow button: the clone the window showed, and since when. A change from A to B re-renders the text and the
  /// button together, so a click right after a change is for a folder the owner has not read yet: it is ignored until `clickDelay` has
  /// passed, and a click that names a clone the window has not been showing is refused.
  private var windowSeen: (clone: String, at: TimeInterval)?
  func windowShows(_ clone: String?) {
    guard let clone else { windowSeen = nil; return }
    if windowSeen?.clone != clone { windowSeen = (clone, now()) }
  }
  func allowFromWindow(clone: String) {
    guard let seen = windowSeen, seen.clone == clone, now() - seen.at >= clickDelay else { return }
    allow(clone: clone)
  }

  /// Reached only from `RealClickButton` (a real click: no Return, no Accessibility press, no posted event). `panel`: the panel the
  /// click was on (nil: the update window, whose button names the folder it shows). A dismissed panel, a panel for another clone and a
  /// click inside the settle time do nothing. It then remembers exactly `clone`, only if the record still names it and it passes the checks.
  func allow(clone: String, panel: PanelToken? = nil) {
    if let panel {
      guard let live = activePanel, live.id == panel.id, panel.clone == clone, live.clone == clone else {
        failure = nil  // a stale panel: nothing here is its to say
        return
      }
      guard now() - panel.shownAt >= clickDelay else { return }
    }
    guard let rec = record(), rec.clone == clone else {
      failure = "The recorded Talos folder changed while this was open, so nothing was allowed. Talos will ask again."
      return
    }
    if let why = AgentFolderSetup.recordedCloneProblem(rec.clone, recordFile: rec.file, unsafe: unsafe()) {
      failure = why
      return
    }
    guard acceptance.accept(clone) else {
      failure = "Talos couldn't remember this in the Keychain, so nothing was allowed. Check that the login keychain is unlocked, then try again."
      return
    }
    clear()
    onAccepted()
  }
}

/// Looks for a recorded clone nobody accepted: at launch, then every few seconds while the app runs (an install.sh run from Terminal
/// records one while Talos is open). Only ever asks; accepting is the owner's click.
enum AllowUpdatesWatch {
  static func start(every seconds: UInt64 = 15, find: @escaping @Sendable () -> String?) {
    Task.detached {
      while !Task.isCancelled {
        let found = find()
        await MainActor.run { CloneConfirmCenter.shared.sync(unaccepted: found) }
        try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
      }
    }
  }
}

/// The prompt's panel: like the update banner, it takes no focus and never becomes key (a key goes to what the owner is typing in).
@MainActor
enum AllowUpdatesPanelHost {
  private static var panel: UpdateBannerPanelBase?
  static func show(_ c: CloneConfirmCenter, _ token: CloneConfirmCenter.PanelToken) {
    panel?.orderOut(nil)
    let p = UpdateBannerPanelBase(rootView: AllowUpdatesView(center: c, token: token))
    panel = p
    p.orderFrontRegardless()
  }
  static func hide() {
    panel?.orderOut(nil)
    panel = nil
  }
}

/// A floating, non-activating, never-key panel around a SwiftUI view, in the update banner's corner.
final class UpdateBannerPanelBase: NSPanel {
  @MainActor
  init<V: View>(rootView: V) {
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    level = .floating
    hidesOnDeactivate = false
    hasShadow = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isReleasedWhenClosed = false
    animationBehavior = .none
    defaultButtonCell = nil
    let host = NSHostingView(rootView: rootView)
    contentView = host
    setContentSize(host.fittingSize)
    if let f = NSScreen.main?.visibleFrame { setFrameOrigin(NSPoint(x: f.maxX - frame.width - 16, y: f.maxY - frame.height - 16)) }
  }
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func keyDown(with event: NSEvent) {}
  override func performKeyEquivalent(with event: NSEvent) -> Bool { false }
}

/// Cream, Cinzel and Inter, the clay accent: the update window's look. No default button, no key equivalent; Allow updates needs a real click.
struct AllowUpdatesView: View {
  @ObservedObject var center: CloneConfirmCenter
  /// What this panel was made for. It never follows `center.pending`.
  let token: CloneConfirmCenter.PanelToken

  var body: some View {
    let clone = token.clone
    VStack(alignment: .leading, spacing: 10) {
      Text(AllowUpdatesCopy.title)
        .font(.custom("Cinzel", size: 19).weight(.bold))
        .foregroundStyle(UpdatePalette.ink)
        .accessibilityAddTraits(.isHeader)
      Text(AllowUpdatesCopy.body(clone))
        .font(.custom("Inter", size: 13))
        .foregroundStyle(UpdatePalette.ink)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      if let f = center.failure {
        Text(f).font(.custom("Inter", size: 12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
      }
      HStack {
        Spacer()
        RealClickButton(title: AllowUpdatesCopy.notNowButton) { center.notNow() }
        RealClickButton(title: AllowUpdatesCopy.allowButton, accent: true) { center.allow(clone: clone, panel: token) }
      }
    }
    .padding(16)
    .frame(width: 400, alignment: .leading)
    .background(UpdatePalette.cream, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(UpdatePalette.accent, lineWidth: 1))
  }
}
