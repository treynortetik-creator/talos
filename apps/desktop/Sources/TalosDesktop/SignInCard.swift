import AppKit
import SwiftUI
import TalosDesktopCore
import TalosSupervisor

/// "Sign in to Claude again": the window a login card's button (the Mac popup, or the phone card) and the menu item open. It is the same
/// sign-in as the setup window's step (`SignInClaudePanel`: the browser link, Copy link, the code box whose value `ClaudeLoginSession`
/// types, then Return as a write of its own), run by the one `ClaudeSignInCoordinator`, so a second window finds the same login and never
/// starts another. No terminal. When Claude says it is signed in, `onSignedIn` runs (Main starts again if it was waiting on this) and the
/// window closes: the card listens through its own `SignInDoneWatcher`, which the setup window's `onChange` slot cannot take away.
///
/// A login is started only by the owner: `startNow` is true for his click (the popup button, the menu item). From a needs-you event the
/// window is only put on screen, without activating the app or taking the keyboard.
@MainActor
final class SignInCardController {
  static let shared = SignInCardController()
  private var window: NSWindow?
  private let ob = OnboardingModel()
  private var watcher: SignInDoneWatcher?
  fileprivate var startWhenReady = false

  func show(config: DesktopConfig, startNow: Bool, onSignedIn: @escaping @MainActor () -> Void) {
    startWhenReady = startWhenReady || startNow
    ob.refresh(config: config, setupDone: true)
    if window == nil {
      let w = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 460, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
      w.title = "Sign in to Claude"
      w.isReleasedWhenClosed = false
      w.contentView = NSHostingView(rootView: SignInCardView(ob: ob, card: self))
      w.center()
      window = w
    }
    if startNow {
      NSApp.activate(ignoringOtherApps: true)
      window?.makeKeyAndOrderFront(nil)
    } else {
      window?.orderFront(nil)  // on screen, not key, app not activated: the owner clicks into it
    }
    watcher?.stop()
    watcher = SignInDoneWatcher { [weak self] in
      Task { @MainActor in
        self?.startWhenReady = false
        self?.window?.close()
        onSignedIn()
      }
    }
  }
}

/// The card: a plain sentence, then the panel the setup window uses. The login starts by itself only when the owner's click opened the card.
struct SignInCardView: View {
  @ObservedObject var ob: OnboardingModel
  let card: SignInCardController

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(OnboardingText.signInAgainSentence).fixedSize(horizontal: false, vertical: true)
      SignInClaudePanel(ob: ob)
      Spacer(minLength: 0)
    }
    .padding(16)
    .frame(width: 460, height: 300, alignment: .topLeading)
    .onChange(of: ob.found?.claude?.path) { _, path in
      guard card.startWhenReady, let path, !ClaudeSignInCoordinator.shared.isRunning, ob.auth != true else { return }
      card.startWhenReady = false
      ClaudeSignInCoordinator.shared.start(claude: path, env: ob.loginEnv)
    }
  }
}
