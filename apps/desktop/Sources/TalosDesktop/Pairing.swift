import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore

/// Sign in with the one-time setup code (DESKTOP-SPEC 5.2). Runs `talos-app enroll --label "Mac app" --no-qr` in a pty the owner
/// can see, reads the link it prints, and hands the code to the page once. The owner types `y` in this pane when the four
/// words match the window. The pane is tab 2 of the terminal window (WP-D2).
@MainActor
final class PairingController: NSObject, NSWindowDelegate, LocalProcessTerminalViewDelegate {
  static let shared = PairingController()

  private var container: NSView?
  private var terminal: LocalProcessTerminalView?
  private var label: NSTextField?
  private var session: PairingSession?
  private var web: WebController?
  private var starting = false
  private var launched: [String]?
  private var launchedEnv: [String: String] = [:]

  var isRunning: Bool { terminal?.process.running ?? false }

  func start(config: DesktopConfig, web: WebController) {
    guard !starting, !isRunning else { TerminalWindowController.shared.show(); return }
    guard let relay = web.relay else { return }
    starting = true
    self.web = web
    web.show()  // the page must be up to receive the code
    Task.detached {
      let r = TalosAppCLI.resolve(config: config)
      await MainActor.run {
        self.starting = false
        guard let r else {
          self.present(
            message: SignInHelp.fallback(
              command: SignInHelp.command(resolved: nil), why: "Talos couldn't find the talos-app command.")
              + "\n" + TalosAppLocator.notFoundMessage)
          return
        }
        self.launch(r, relay: relay)
      }
    }
  }

  private func launch(_ r: TalosAppCLI.Resolved, relay: RelayOrigin) {
    launched = r.command
    launchedEnv = r.env
    session = PairingSession(relay: relay)
    let term = SafeTerminalView(frame: NSRect(x: 0, y: 0, width: 720, height: 300))
    term.processDelegate = self
    term.setProcessOutputHandler { [weak self] in
      DispatchQueue.main.async { self?.screenChanged() }
    }
    terminal = term
    // Every run gets a fresh pane: the new pty must be the one on screen (that is where the owner types `y`).
    container = nil
    TerminalWindowController.shared.setPairingTab(nil)
    present(message: "Waiting for the setup link…")
    let env = r.env.keys.sorted().map { "\($0)=\(r.env[$0] ?? "")" }
    term.startProcess(
      executable: r.command[0], args: Array(r.command.dropFirst()) + ["enroll", "--label", "Mac app", "--no-qr"], environment: env)
  }

  private func screenChanged() {
    guard let term = terminal, var s = session else { return }
    // Rows the terminal wrapped are joined back, so a long relay address is still one link.
    let rows = term.terminalStateSnapshot().visibleRows.map { (text: $0.text, wrapped: $0.isWrapped) }
    let text = ScreenText.join(rows)
    let code = s.update(screen: text)
    session = s
    if let code {
      web?.sendWhenReady(.enrollCode(code))
      label?.stringValue = "Sent to the Talos window. When it shows four words, check they match, then type y here and press Return."
    } else if s.ambiguous {
      label?.stringValue = "Two different setup links appeared, so nothing was sent. Close this and try again."
    }
  }

  private func present(message: String) {
    if container == nil {
      let l = NSTextField(wrappingLabelWithString: message)
      label = l
      let cancel = NSButton(title: "Cancel sign-in", target: self, action: #selector(cancel))
      let stack = NSStackView()
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 8
      stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
      stack.addArrangedSubview(l)
      if let t = terminal {
        t.setContentHuggingPriority(.defaultLow, for: .vertical)
        stack.addArrangedSubview(t)
        t.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
      }
      stack.addArrangedSubview(cancel)
      container = stack
      TerminalWindowController.shared.setPairingTab(stack)
    }
    label?.stringValue = message
    TerminalWindowController.shared.show()
  }

  /// Ends our own enroll child (SIGTERM via LocalProcess) and removes tab 2. Nothing else is touched.
  @objc func cancel() {
    if isRunning { terminal?.terminate() }
    terminal = nil
    container = nil
    label = nil
    TerminalWindowController.shared.setPairingTab(nil)
  }

  // MARK: LocalProcessTerminalViewDelegate
  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    // Only the run on screen speaks: a cancelled run's late exit must not overwrite a new run's message, and a "two links"
    // answer is not the same as "ended before it showed a link".
    guard source === terminal else { return }
    if let m = SignInHelp.exitMessage(
      sent: session?.sent == true, ambiguous: session?.ambiguous == true, command: SignInHelp.command(resolved: launched, env: launchedEnv))
    {
      label?.stringValue = m
    }
  }
}
