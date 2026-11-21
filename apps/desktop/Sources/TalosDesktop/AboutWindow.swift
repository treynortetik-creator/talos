import AppKit
import SwiftUI
import TalosDesktopCore

/// "About Talos": the Talos-branded window that replaces the stock Mac About panel. It shows the robot, the version, and a Check for
/// Updates button whose answer appears inline. It reads the same `UpdateController` as the Check for Updates menu item and the update
/// window (one check, one set of words); the only difference is that it does not open the update window.
struct AboutView: View {
  @ObservedObject var controller: UpdateController
  /// Where Allow updates answers (the app's one center; a test hands in its own).
  var allow: CloneConfirmCenter = .shared
  var version: String = WebController.version
  var build: String? = WebController.build

  var body: some View {
    let s = controller.status
    VStack(spacing: 8) {
      Group {
        if let img = OnboardingFonts.robot() ?? NSApp?.applicationIconImage {
          Image(nsImage: img).resizable().scaledToFit()
        } else {
          Color.clear
        }
      }
      .frame(width: 88, height: 88)
      .accessibilityHidden(true)
      Text("Talos")
        .font(.custom("Cinzel", size: 28).weight(.bold))
        .foregroundStyle(UpdatePalette.ink)
        .accessibilityAddTraits(.isHeader)
      Text(AboutCopy.version(version))
        .font(.custom("Inter", size: 14).weight(.semibold))
        .foregroundStyle(UpdatePalette.ink)
      if let b = AboutCopy.build(build, version: version) {
        Text(b).font(.custom("Inter", size: 11)).foregroundStyle(OB.muted)
      }
      VStack(spacing: 4) {
        HStack(spacing: 8) {
          if s.isBusy { ProgressView().controlSize(.small).tint(UpdatePalette.accent) }
          Text(AboutCopy.headline(s))
            .font(.custom("Inter", size: 14).weight(.semibold))
            .foregroundStyle(UpdatePalette.ink)
        }
        if let d = AboutCopy.detail(s) {
          Text(d)
            .font(.custom("Inter", size: 12))
            .foregroundStyle(OB.muted)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
      }
      .frame(minHeight: 70, alignment: .top)
      .padding(.top, 10)
      .accessibilityElement(children: .combine)
      buttons(s).padding(.top, 4)
    }
    .padding(.horizontal, 28).padding(.vertical, 24)
    .frame(width: 400, alignment: .center)
    .background(UpdatePalette.cream)
    .environment(\.colorScheme, .light)  // cream either way: the text is fixed ink
    // the folder the window names changes, the owner has not read the new one yet (`CloneConfirmCenter.windowShows`)
    .onAppear { allow.windowShows(controller.status.allowClone) }
    .onChange(of: controller.status.allowClone) { _, new in allow.windowShows(new) }
    .onDisappear { allow.windowShows(nil) }
  }

  /// No key equivalent and no default button; Allow updates and Update now need a real click (`RealClickButton`).
  @ViewBuilder private func buttons(_ s: UpdateStatus) -> some View {
    if let clone = s.allowClone {
      PillRealClickButton(title: AllowUpdatesCopy.allowButton, primary: true, width: 170) { allow.allowFromWindow(clone: clone) }
    } else if s.pendingVersion != nil && AboutCopy.offersUpdateNow(s) {
      PillRealClickButton(title: AboutCopy.installButton, primary: true, width: 170) { controller.updateNow() }
    } else if !s.isBusy && s.pendingVersion == nil {
      Button(AboutCopy.checkButtonTitle(s)) { controller.checkFromAbout() }
        .buttonStyle(AboutPrimaryStyle())
        .frame(width: 200, height: 44)
    }
  }
}

/// The filled Talos-orange pill (`PillStyle` primary) at a fixed width, so its whole face is the click target.
private struct AboutPrimaryStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(OB.body(15, .semibold))
      .foregroundStyle(OB.ink)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Capsule().fill(OB.accent))
      .opacity(configuration.isPressed ? 0.85 : 1)
      .contentShape(Capsule())
  }
}
