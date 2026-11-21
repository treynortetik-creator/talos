import AppKit
import SwiftUI
import TalosDesktopCore

/// "You had unsent text when Talos updated": the copy an Update now saved of Main's input box, SHOWN (plain text, read-only) with Copy and
/// Dismiss. It is never typed anywhere. It appears only when the updater says an update this app recorded really happened, for that
/// version; the file is deleted on Dismiss, or after 24 hours.
@MainActor
final class DraftNoticeCenter: ObservableObject {
  static let shared = DraftNoticeCenter()

  @Published private(set) var note: DraftNote?
  /// The update was tried and failed (the title says "tried to update").
  @Published private(set) var tried = false
  /// Where the saved copy lives (the supervisor's `draftNotePath`); set by the app.
  var path: () -> String? = { nil }
  /// Tests replace these: the real ones put a panel on screen and write the real clipboard.
  var present: (DraftNoticeCenter) -> Void = { DraftNoticePanelHost.show($0) }
  var hide: () -> Void = { DraftNoticePanelHost.hide() }
  var copyText: (String) -> Void = { text in
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
  private(set) var copies = 0
  /// Where the digest of the saved copy is kept (the Keychain); tests hand in a memory store.
  var digests: any DraftDigestStore = DraftDigests.store

  /// How the update to `version` ended: the copy is shown when it happened, or when it started and failed (Main may have been
  /// restarted, and this copy is then the only one); deleted only when the swap never started. A copy the Keychain does not vouch for
  /// is never shown (`DraftNote.read`).
  func settled(version: String, outcome: DraftOutcome) {
    switch outcome {
    case .updated: offer(version: version, tried: false)
    case .triedAndFailed: offer(version: version, tried: true)
    case .neverStarted: discard()
    }
  }

  func offer(version: String, tried: Bool) {
    guard let p = path(), let n = DraftNote.read(path: p, forVersion: version, digests: digests) else { return }
    note = n
    self.tried = tried
    present(self)
  }

  /// The swap never started: the text is still in the box, so the copy goes.
  func discard() {
    if let p = path() { DraftNote.remove(path: p, digests: digests) }
    note = nil
    hide()
  }

  func copy() {
    guard let n = note else { return }
    copies += 1
    copyText(n.text)
  }

  func dismiss() {
    if let p = path() { DraftNote.remove(path: p, digests: digests) }
    note = nil
    hide()
  }
}

@MainActor
enum DraftNoticePanelHost {
  private static var panel: UpdateBannerPanelBase?
  static func show(_ c: DraftNoticeCenter) {
    panel?.orderOut(nil)
    let p = UpdateBannerPanelBase(rootView: DraftNoticeView(center: c))
    panel = p
    p.orderFrontRegardless()
  }
  static func hide() {
    panel?.orderOut(nil)
    panel = nil
  }
}

/// Cream, Cinzel and Inter, the clay accent, like the update window. The text is `Text(verbatim:)`: plain, never interpreted. Copy and
/// Dismiss need a real click; nothing is the default button.
struct DraftNoticeView: View {
  @ObservedObject var center: DraftNoticeCenter

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(center.tried ? DraftNoticeCopy.titleTried : DraftNoticeCopy.title)
        .font(.custom("Cinzel", size: 17).weight(.bold))
        .foregroundStyle(UpdatePalette.ink)
        .accessibilityAddTraits(.isHeader)
      if let n = center.note {
        Text(DraftNoticeCopy.saved(at: n.saved_at)).font(.custom("Inter", size: 12)).foregroundStyle(UpdatePalette.ink)
      }
      if center.note?.partial == true {
        Text(DraftNoticeCopy.partial).font(.custom("Inter", size: 12)).foregroundStyle(UpdatePalette.ink)
      }
      ScrollView {
        Text(verbatim: center.note?.text ?? "")
          .font(.custom("Inter", size: 13))
          .foregroundStyle(UpdatePalette.ink)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 120)
      .padding(8)
      .background(Color.white.opacity(0.5), in: RoundedRectangle(cornerRadius: 8))
      HStack {
        Spacer()
        RealClickButton(title: DraftNoticeCopy.copyButton) { center.copy() }
        RealClickButton(title: DraftNoticeCopy.dismissButton, accent: true) { center.dismiss() }
      }
    }
    .padding(16)
    .frame(width: 400, alignment: .leading)
    .background(UpdatePalette.cream, in: RoundedRectangle(cornerRadius: 12))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(UpdatePalette.accent, lineWidth: 1))
    .environment(\.colorScheme, .light)
  }
}
