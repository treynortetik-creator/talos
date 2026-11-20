import AppKit
import Foundation
import SwiftUI
import TalosDesktopCore

/// After a move to ~/Applications: the first launch from there looks for the downloaded copy in ~/Downloads and asks whether to put
/// it in the Trash. Nothing happens without the owner's real click on "Move to Trash"; a copy that cannot be proved to be the
/// downloaded one is never offered (see `DownloadTidy`).
@MainActor
enum DownloadTidyPrompt {
  private static var panel: UpdateBannerPanelBase?

  static func runIfNeeded(
    bundlePath: String = Bundle.main.bundlePath, home: String = NSHomeDirectory(), defaults: UserDefaults = .standard
  ) {
    // only the copy that was moved to ~/Applications, and only when the marker says a move just happened
    guard MoveMarker.read(defaults: defaults) != nil,
      (bundlePath as NSString).standardizingPath.hasPrefix(AppLocation.destinationFolder(home: home) + "/"),
      let mine = BundleFacts.read(path: bundlePath, team: nil, running: true)
    else { return }
    // the corner may hold the Allow updates panel or the setup window: wait (every few seconds) until both are gone
    DownloadTidyGate.whenClear(
      blocked: {
        DownloadTidyGate.blocked(
          allowUpdatesUp: CloneConfirmCenter.shared.visible,
          onboardingUp: OnboardingShared.isActive || NSApp.windows.contains { $0.isVisible && $0.title == OnboardingCopy.windowTitle })
      },
      retryLater: { next in DispatchQueue.main.asyncAfter(deadline: .now() + 3) { MainActor.assumeIsolated { next() } } },
      show: { offer(bundlePath: bundlePath, home: home, defaults: defaults, mine: mine) })
  }

  private static func offer(bundlePath: String, home: String, defaults: UserDefaults, mine: BundleFacts) {
    DownloadTidy.offer(
      defaults: defaults, downloads: home + "/Downloads", mine: mine, minePath: bundlePath,
      seam: DownloadTidy.liveSeam(isRunning: { AppMovePrompt.isRunning(path: $0) }),
      ask: { _, answer in
        let settle = DownloadTidyGate.Settle(shownAt: ProcessInfo.processInfo.systemUptime)
        let p = UpdateBannerPanelBase(
          rootView: DownloadTidyView(
            answer: { yes in
              // a click inside the first second was meant for what was there before: ignored, the panel stays
              guard settle.accepts(now: ProcessInfo.processInfo.systemUptime) else { return }
              hide()
              answer(yes)
            }))
        panel = p
        p.orderFrontRegardless()
      },
      report: { msg in
        let a = NSAlert()
        a.alertStyle = .warning
        a.messageText = DownloadTidyCopy.title
        a.informativeText = msg
        a.runModal()
      })
  }

  private static func hide() {
    panel?.orderOut(nil)
    panel = nil
  }
}

/// Cream, orange primary and an outlined secondary, like the Allow updates panel; both buttons need a real click and take no Return.
struct DownloadTidyView: View {
  var answer: (Bool) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(DownloadTidyCopy.title)
        .font(.custom("Cinzel", size: 19).weight(.bold))
        .foregroundStyle(UpdatePalette.ink)
        .accessibilityAddTraits(.isHeader)
      Text(DownloadTidyCopy.body)
        .font(.custom("Inter", size: 13))
        .foregroundStyle(UpdatePalette.ink)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        PillRealClickButton(title: DownloadTidyCopy.keep, width: 110) { answer(false) }
        PillRealClickButton(title: DownloadTidyCopy.trash, primary: true, width: 150) { answer(true) }
      }
    }
    .padding(16)
    .environment(\.colorScheme, .light)
    .frame(width: 400, alignment: .leading)
    .background(UpdatePalette.cream, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(UpdatePalette.accent, lineWidth: 1))
  }
}
