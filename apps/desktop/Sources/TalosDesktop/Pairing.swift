import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore

/// What a pairing run is for: this Mac's own window (the sign-in window with the four words), or the phone step of the setup (the setup
/// screen shows the code and the four words itself, so the separate sign-in window never opens and the code goes nowhere but its QR).
enum PairingPurpose: Equatable {
  case thisMac, phone
  var deviceName: String { self == .phone ? "Phone" : SignInHelp.label }
}

/// What the sign-in window says right now.
enum PairingPhase: Equatable {
  case idle
  /// Looking for the talos-app command / waiting for its link.
  case starting
  /// The code went to the Talos window; waiting for it to show the four words.
  case waiting
  /// The four words, whole, from the program's own question.
  case confirm([String])
  case done(String)
  case failed(String)
  /// The owner said the words do not match: `n` was written, the child ended, nothing is connected. A new code is offered.
  case mismatch
}

/// Sign in with the one-time setup code (DESKTOP-SPEC 5.2). Runs `talos-app enroll --label "Mac app" --no-qr` in a pty the owner
/// does not have to see: reads the link it prints, hands the code to the page once, then shows the four words (read from the
/// program's own question) in the app's sign-in window with Confirm and Cancel. Confirm writes `y` and Return to that pty,
/// once; Cancel writes `n`, ends the child and cleans up. The terminal pane (tab 2 of the Terminals window) is only a
/// "Show details" option.
@MainActor
final class PairingController: NSObject, ObservableObject, NSWindowDelegate, LocalProcessTerminalViewDelegate {
  static let shared = PairingController()

  @Published private(set) var phase: PairingPhase = .idle
  /// The one-use link the phone opens (the setup's QR), once the program printed it. nil for this Mac's own sign-in.
  @Published private(set) var link: String?
  private(set) var purpose: PairingPurpose = .thisMac
  /// How the enroll program ended once the owner had said yes (0: it registered the device). nil until then.
  @Published private(set) var confirmedExit: Int32?
  /// Whether Confirm does anything yet (the program counts a too-quick answer as a no).
  @Published private(set) var confirmEnabled = false
  /// Tests: the clock, how long the owner has to answer, and a place to write instead of the pty.
  var now: () -> Date = Date.init
  var pinWait: TimeInterval = PairingSession.defaultPinWait
  var readDelay: TimeInterval = PairingSession.defaultReadDelay
  /// Brings the sign-in window forward; tests count it instead of activating the test process.
  var front: (NSPanel) -> Void = { PairingPanel.bringToFront($0) }
  /// How long after the owner's Confirm the child may take to finish on its own before it is ended (never sooner: it writes the answer).
  var exitGrace: TimeInterval = 15
  private var exitWatch: Task<Void, Never>?
  var panelForTest: PairingPanel? { panel }
  var writeOverride: (([UInt8]) -> Void)?
  private var pinTimer: Task<Void, Never>?
  private var panel: PairingPanel?
  /// Tests: how many times the sign-in window was brought to the front, and the details pane opened.
  private(set) var panelFronted = 0
  private(set) var detailsShown = 0

  private var container: NSView?
  private var terminal: LocalProcessTerminalView?
  private var label: NSTextField?
  private var session: PairingSession?
  private var web: WebController?
  private var starting = false
  private var launched: [String]?
  private var launchedEnv: [String: String] = [:]
  private var lastConfig: DesktopConfig?

  var isRunning: Bool { terminal?.process.running ?? false }

  func start(config: DesktopConfig, web: WebController, purpose: PairingPurpose = .thisMac) {
    // A sign-in is already open: bring its window forward, never a second enroll.
    guard !starting, !isRunning else { frontPanel(); return }
    // the purpose first: whoever listens for this run's phases reads it, so a failure said below is never taken for another run's
    self.purpose = purpose
    link = nil
    guard let relay = web.relay else {
      if purpose == .phone { phase = .failed(OnboardingCopy.pairFailed) }
      return
    }
    starting = true
    lastConfig = config
    confirmedExit = nil
    phase = .starting
    confirmEnabled = false
    self.web = web
    if purpose == .thisMac { web.show() }  // the page must be up to receive the code
    Task.detached {
      let r = TalosAppCLI.resolve(config: config)
      await MainActor.run {
        self.starting = false
        guard let r else {
          self.phase = .failed(
            SignInHelp.fallback(
              command: SignInHelp.command(resolved: nil), why: "Talos couldn't find the talos-app command.")
              + "\n" + TalosAppLocator.notFoundMessage)
          self.frontPanel()
          return
        }
        self.launch(r, relay: relay)
      }
    }
  }

  private func launch(_ r: TalosAppCLI.Resolved, relay: RelayOrigin) {
    launched = r.command
    launchedEnv = r.env
    exitWatch?.cancel()
    var fresh = PairingSession(relay: relay, deviceName: purpose.deviceName)
    fresh.readDelay = readDelay
    fresh.pinWait = pinWait
    session = fresh
    let term = SafeTerminalView(frame: NSRect(x: 0, y: 0, width: 720, height: 300))
    term.processDelegate = self
    term.setProcessOutputHandler { [weak self] in
      DispatchQueue.main.async { self?.screenChanged() }
    }
    terminal = term
    // Every run gets a fresh pane; the old one (shown or not) is gone, and the sign-in window, not the pane, is where the owner answers.
    container = nil
    TerminalWindowController.shared.setPairingTab(nil)
    phase = .starting
    frontPanel()
    let env = r.env.keys.sorted().map { "\($0)=\(r.env[$0] ?? "")" }
    term.startProcess(
      executable: r.command[0], args: Array(r.command.dropFirst()) + ["enroll", "--label", purpose.deviceName, "--no-qr"], environment: env)
  }

  private func screenChanged() {
    guard let term = terminal, var s = session else { return }
    // Rows the terminal wrapped are joined back, so a long relay address is still one link.
    let rows = term.terminalStateSnapshot().visibleRows.map { (text: $0.text, wrapped: $0.isWrapped) }
    ingest(screen: ScreenText.join(rows), session: &s)
    session = s
  }

  /// Tests hand a screen in directly.
  func ingestForTest(screen: String) {
    guard var s = session else { return }
    ingest(screen: screen, session: &s)
    session = s
  }

  private func ingest(screen text: String, session s: inout PairingSession) {
    let code = s.update(screen: text, now: now())
    if let code {
      // This Mac's own window gets the code; a phone's code is only ever shown as the QR the phone scans.
      if purpose == .thisMac { web?.sendWhenReady(.enrollCode(code)) } else { link = s.link }
      phase = .waiting
    } else if s.ambiguous {
      phase = .failed("Two different setup links appeared, so nothing was sent. Close this and try again.")
      endChild()
      return
    }
    guard s.answered == nil else { return }
    if let words = s.words(now: now()) {
      if phase != .confirm(words) {
        phase = .confirm(words)
        frontPanel()
        armPinTimers(remaining: pinWait - now().timeIntervalSince(s.readySince ?? now()))
      }
      confirmEnabled = s.confirmable(now: now())
    } else {
      confirmEnabled = false
      if case .confirm = phase { phase = .waiting }  // withdrawn, or only part of the question is left
      if s.pin == .withdrawn { phase = .failed("That sign-in question was withdrawn (another device used the code, or it timed out). Nothing was signed in. Try again.") }
    }
  }

  /// Enables Confirm after the read delay, and ends the offer when the program would have withdrawn the question.
  private func armPinTimers(remaining: TimeInterval) {
    pinTimer?.cancel()
    let delay = readDelay
    pinTimer = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard !Task.isCancelled, let self else { return }
      self.refresh()
      try? await Task.sleep(nanoseconds: UInt64(max(0, remaining - delay) * 1_000_000_000))
      guard !Task.isCancelled else { return }
      self.refresh()
      if case .confirm = self.phase { self.timedOut() }
    }
  }

  private func refresh() {
    guard let s = session else { return }
    confirmEnabled = s.words(now: now()) != nil && s.confirmable(now: now())
  }

  /// Out of time: the program withdraws its question on its own; nothing is confirmable, and the child is ended.
  func timedOut() {
    guard var s = session, s.answered == nil else { return }
    _ = s.decline()
    session = s
    confirmEnabled = false
    phase = .failed("The four words were not confirmed in time, so nothing was signed in. Try again.")
    endChild()
  }

  /// The owner's Confirm, from a real click on the panel's button and from nowhere else: an agent's synthetic key or click, an Accessibility
  /// press or AppleScript (no mouse event) approve nothing. Writes `y` and Return to our own enroll child, once. Returns whether it wrote.
  @discardableResult
  func approve(clickedBy event: NSEvent?, on button: NSButton) -> Bool {
    guard NeedsYouPopupView.isRealClick(event, on: button) else {
      SyntheticInput.flight.drop(event.map(SyntheticInputGuard.token(of:)) ?? 0)  // the agent that tried is told it answered nothing
      return false
    }
    return writeYes()
  }

  private func writeYes() -> Bool {
    guard var s = session, isRunning || writeOverride != nil, s.confirm(now: now()) else { return false }
    session = s
    confirmEnabled = false
    pinTimer?.cancel()
    write(PairingSession.yesBytes)
    phase = .done("Confirmed. If the Talos window shows This device is ready, you're signed in.")
    // From here the child is never ended early: it writes the owner's answer and exits by itself; only a stuck one is ended, after a grace.
    exitWatch?.cancel()
    let grace = exitGrace
    let mine = terminal  // only this run's child: a later run's must never be ended by this timer
    exitWatch = Task { @MainActor in
      try? await Task.sleep(nanoseconds: UInt64(grace * 1_000_000_000))
      guard !Task.isCancelled, let mine, mine.process.running else { return }
      mine.terminate()
    }
    return true
  }

  /// "They don't match": writes `n` (only while a whole question is open), ends the child, and offers a new code. Nothing is connected.
  func mismatch() {
    guard var s = session, s.answered == nil, case .confirm = phase else { return cancel() }
    if s.decline() { write(PairingSession.noBytes) }
    session = s
    confirmEnabled = false
    pinTimer?.cancel()
    endChild()
    phase = .mismatch
    frontPanel()
  }

  /// Ends our own enroll child for good (SIGKILL by its process id): the one that ignored the polite end. Nothing else is touched.
  func killChild() {
    if let pid = terminal?.process.shellPid, pid > 0 { kill(pid, SIGKILL) }
  }

  /// "Make a new code" after a mismatch or a failure: a fresh enroll (a new one-use code); the old child is already gone.
  func newCode() {
    guard let cfg = lastConfig, let web, !isRunning, !starting else { return }
    start(config: cfg, web: web, purpose: purpose)
  }

  /// One place the sign-in answer is written to our own enroll child's pty (KeyGuardTests names it).
  private func write(_ bytes: [UInt8]) {
    if let writeOverride { return writeOverride(bytes) }
    terminal?.send(data: bytes[...])
  }

  /// Ends our own enroll child (`n` first when a question is open, then SIGTERM via LocalProcess) and removes tab 2 and the
  /// sign-in window. Nothing else is touched.
  @objc func cancel() {
    // After the owner confirmed, nothing ends the child: it has the answer to write. The window just goes away; `exitWatch` ends a stuck one.
    if session?.answered == true, isRunning {
      panel?.orderOut(nil)
      return
    }
    if var s = session {
      if s.decline() { write(PairingSession.noBytes) }
      session = s
    }
    pinTimer?.cancel()
    exitWatch?.cancel()
    endChild()
    container = nil
    label = nil
    TerminalWindowController.shared.setPairingTab(nil)
    phase = .idle
    link = nil
    confirmEnabled = false
    panel?.close()
    panel = nil
  }

  /// Close, and the title-bar X: before the owner confirmed it is a decline (`n`, end the child); after, it only hides the window.
  func closeWindow() {
    if isRunning, session?.answered != true { return cancel() }
    if isRunning { panel?.orderOut(nil); return }
    panel?.close()
    panel = nil
    phase = .idle
  }

  private func endChild() {
    pinTimer?.cancel()
    if isRunning { terminal?.terminate() }
  }

  // MARK: the sign-in window
  /// The app's own sign-in window: forward and key, over the Talos window, so the owner never hunts for it.
  func frontPanel() {
    guard purpose == .thisMac else { return }  // the setup screen is the window for a phone's four words
    let p = panel ?? PairingPanel(controller: self)
    panel = p
    panelFronted += 1
    front(p)
  }

  /// The "Show details" option: the terminal pane in the Terminals window, in front.
  func showDetails() {
    guard let t = terminal else { return }
    detailsShown += 1
    if container == nil {
      let l = NSTextField(wrappingLabelWithString: "The sign-in command's own output. You don't need to type here: use Confirm in the sign-in window.")
      label = l
      let stack = NSStackView()
      stack.orientation = .vertical
      stack.alignment = .leading
      stack.spacing = 8
      stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
      stack.addArrangedSubview(l)
      t.setContentHuggingPriority(.defaultLow, for: .vertical)
      stack.addArrangedSubview(t)
      t.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -24).isActive = true
      container = stack
      TerminalWindowController.shared.setPairingTab(stack)
    }
    TerminalWindowController.shared.show()
  }

  // MARK: LocalProcessTerminalViewDelegate
  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    // Only the run on screen speaks: a cancelled run's late exit must not overwrite a new run's message, and a "two links"
    // answer is not the same as "ended before it showed a link".
    guard source === terminal else { return }
    pinTimer?.cancel()
    confirmEnabled = false
    // The child died while the question was open (or before it was asked): nothing can be confirmed any more.
    if var s = session, s.answered == nil { _ = s.decline(); session = s }
    if case .done = phase { confirmedExit = exitCode ?? -1 }
    switch phase {
    case .done, .failed, .idle, .mismatch: return
    default: break
    }
    if let m = SignInHelp.exitMessage(
      sent: session?.sent == true, ambiguous: session?.ambiguous == true, command: SignInHelp.command(resolved: launched, env: launchedEnv))
    {
      phase = session?.sent == true ? .failed("The sign-in command ended before you confirmed. Nothing was signed in. Try again.") : .failed(m)
    }
  }
}
