import AppKit
import SwiftUI
import TalosDesktopCore

/// Sign this Mac in: one action for the menu, Settings and the setup screen.
@MainActor
enum SignInAction {
  static func start(model: SupervisorController) {
    TerminalWindowController.shared.attach(model: model)
    PairingController.shared.start(config: model.supervisor.currentConfig(), web: WebController.shared)
  }

  /// Puts text on a pasteboard (the general one unless a test hands in its own).
  static func copy(_ text: String, to pb: NSPasteboard = .general) {
    pb.clearContents()
    pb.setString(text, forType: .string)
  }
}

/// "Sign this device in": the button when it can do the job, and the exact command with a Copy button when it can't, or
/// when the owner would rather type it. Shown on the setup screen and in Settings.
struct SignInPanel: View {
  @ObservedObject var model: SupervisorController
  /// Runs just before the button starts the sign-in (Settings saves a half-confirmed talos-app command first).
  var beforeSignIn: () -> Void = {}
  @ObservedObject private var web = WebController.shared
  @State private var command = SignInHelp.command(resolved: nil)
  @State private var copied = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("Sign this device in").font(.headline)
      // Sign in is offered only when the page itself said the owner is signed out (audit D46): a relay that is down or a page
      // still loading must not look like a signed-out Mac, and a second enroll would mint a code for a device already pinned.
      switch SignInHelp.offer(hasRelay: web.hasRelay, page: web.pageState) {
        case .needsRelay:
          HStack {
            Button("Sign in\u{2026}") {}.disabled(true)
            Text("Needs a relay address first: \(MacSettingsText.connectionPath).").font(.caption).foregroundStyle(.secondary)
          }
        case .signedIn: Text("This Mac is signed in.").foregroundStyle(.secondary)
        case .connecting: Text("Connecting to Talos\u{2026}").foregroundStyle(.secondary)
        case .unreachable:
          HStack {
            Text(PageState.unreachableLine).foregroundStyle(.secondary)
            Button("Try now") { web.retryNow() }
          }
        case .button:
          Button("Sign in\u{2026}") {
            beforeSignIn()
            SignInAction.start(model: model)
          }
          Text("Talos runs the sign-in for you and shows four words. Type y in the small terminal pane when they match the Talos window.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      Text("Or run it yourself in Terminal:").font(.caption).foregroundStyle(.secondary)
      HStack(alignment: .firstTextBaseline) {
        Text(command).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
        Spacer()
        Button(copied ? "Copied" : "Copy") {
          SignInAction.copy(command)
          copied = true
        }
      }
      Text(SignInHelp.how).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    .task {
      let cfg = model.supervisor.currentConfig()
      let resolved = await Task.detached { TalosAppCLI.resolve(config: cfg)?.command }.value
      command = SignInHelp.command(resolved: resolved, env: cfg.env)
    }
  }
}
