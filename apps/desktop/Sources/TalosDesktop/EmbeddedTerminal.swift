import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore
import TalosSupervisor

/// The agent's terminal inside the main window: the Terminal item in the page's sidebar. The page leaves an empty space and
/// says where it is (`terminal_view`); this view is laid over that space. It is a second viewer on the agent's tmux session,
/// the same `tmux attach` the Terminals window runs, so closing it ends only our own child and the agent keeps running.
/// While the view is open it looks again every 1.5 s, like the window does: a session that starts later is attached when it
/// appears, and a viewer that ended (the agent stopped, tmux detached us) is replaced by the dead pane's last screen or by a note.
@MainActor
final class EmbeddedTerminal: NSObject, LocalProcessTerminalViewDelegate {
  /// What this Mac's agent host looks like right now.
  enum Host {
    /// No supervisor yet (Talos starts it at launch; this is only the moment before).
    case none
    /// The owned-pty host: no tmux 3.2+, so there is nothing to attach to. The Terminals window mirrors it.
    case noTmux
    case tmux(attach: [String])
  }

  typealias ThreadTarget = TerminalSessions.ThreadTarget
  static let goneNote = TerminalSessions.goneNote

  /// The thread target for a session id the page named (see `TerminalSessions.threadTarget`).
  static func threadTarget(
    _ id: String, snapshot: (entries: [SwitcherEntry], workers: WorkersFile?)?, attach: (SwitcherEntry) -> [String]?
  ) -> ThreadTarget {
    TerminalSessions.threadTarget(id, entries: snapshot?.entries, workers: snapshot?.workers, attach: attach)
  }

  /// Where the view gets its facts. `live` reads the supervisor; tests hand in their own.
  struct Source {
    var host: () -> Host
    var configured: () -> Bool
    var hasLiveChild: () -> Bool
    var sessionExists: () -> Bool
    /// What a thread's tab shows (not used for Main, which keeps `host` above).
    var thread: (String) -> ThreadTarget = { _ in .gone }

    @MainActor static func live() -> Source {
      func model() -> SupervisorController? { TerminalWindowController.shared.supervisorModel }
      return Source(
        host: {
          guard let m = model() else { return .none }
          guard m.hostKind == .tmux, let argv = m.tmuxAttach else { return .noTmux }
          return .tmux(attach: argv)
        },
        configured: { model()?.configured ?? false },
        hasLiveChild: { model()?.status.childPid != nil },
        sessionExists: { TerminalWindowController.shared.cachedAgentSessionExists() },
        thread: { id in
          let c = TerminalWindowController.shared
          return EmbeddedTerminal.threadTarget(id, snapshot: c.switcherSnapshot(), attach: { c.attachArgv(for: $0) })
        })
    }
  }

  static let noTmuxNote =
    "This Mac has no tmux 3.2 or newer, so the agent runs in a pty Talos owns and can't be shown here. Menu → Terminals… mirrors it."

  /// The smallest room the view is shown in: `TerminalViewRect.minColumns` by `minRows` cells of the viewer's own font, plus its
  /// scroller. Smaller, and the page's own text stays showing. The agent's screen takes the size of the last viewer and keeps it.
  static let minimumSize: CGSize = {
    let v = SafeTerminalView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    v.resize(cols: TerminalViewRect.minColumns, rows: TerminalViewRect.minRows)
    return v.getOptimalFrameSize().size
  }()

  var source: Source = .live()
  /// Holds the note and the viewer; laid over the page's empty space. Opaque, so the page's text underneath never shows.
  let container = NSView()
  private let note = NSTextField(wrappingLabelWithString: "")
  private var viewer: LocalProcessTerminalView?
  /// The session the view shows: "main" or a thread id the page named. Switching ends only our own viewer.
  private(set) var session = TerminalSessions.mainId
  private var keyboardClaimUntil = Date.distantPast
  private var timer: Timer?
  private var lastViewerStart = Date.distantPast
  private(set) var isOpen = false

  override init() {
    super.init()
    container.wantsLayer = true
    container.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    note.textColor = .secondaryLabelColor
    note.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(note)
    NSLayoutConstraint.activate([
      note.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
      note.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
      note.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
    ])
  }

  /// Key codes of the digits 1 … 9 on the digit row and on the keypad. The chord is decided by the physical key, so a layout that
  /// prints something else on the row (French "é" for 2) is the same tab. The page uses the same rule (`Digit1-9`, `Numpad1-9`).
  static let digitKeyCodes: [UInt16: Int] = [
    18: 1, 19: 2, 20: 3, 21: 4, 23: 5, 22: 6, 26: 7, 28: 8, 25: 9,
    83: 1, 84: 2, 85: 3, 86: 4, 87: 5, 88: 6, 89: 7, 91: 8, 92: 9,
  ]

  /// The digit of a Ctrl+digit key event, nil for anything else. Caps Lock and the keypad flag are not modifiers anyone pressed
  /// for this chord and are ignored; Shift, Option, Command or Function make it another chord, which is left to the terminal.
  static func controlDigit(_ event: NSEvent) -> Int? {
    guard event.type == .keyDown else { return nil }
    let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad])
    guard mods == .control else { return nil }
    return digitKeyCodes[event.keyCode]
  }

  /// Whether `responder` is this view's own terminal (the one the owner clicked into).
  func holdsKeyboard(_ responder: NSResponder?) -> Bool {
    guard let v = responder as? NSView, let viewer else { return false }
    return v === viewer || v.isDescendant(of: viewer)
  }

  /// Tests: what the owner sees and what is running.
  var noteTextForTest: String? { note.isHidden ? nil : note.stringValue }
  var hasViewerForTest: Bool { viewer != nil }
  var viewerForTest: NSView? { viewer }
  var viewerIsRunningForTest: Bool { viewer?.process.running == true }

  /// Re-points the view at another session. Ends our own `tmux attach` child and nothing else: no key is sent, and no session is
  /// detached or killed (the others keep running). The next look attaches to the new one.
  func select(_ id: String, keepKeyboard: Bool = false) {
    guard id != session, TerminalSessions.isValidSession(id) else { return }
    session = id
    // The owner's own key switched it: the viewer that attaches next takes the keyboard (for a few seconds only). A switch the
    // page asked for never does: the page must not be able to move the owner's typing into a terminal.
    keyboardClaimUntil = keepKeyboard ? Date().addingTimeInterval(4) : .distantPast
    removeViewer()
    note.isHidden = true
    lastViewerStart = .distantPast
    if isOpen { tick() }
  }

  /// Shows the view over `frame` of `host`, or moves it there when it is already showing.
  func show(in host: NSView, frame: CGRect) {
    container.frame = frame
    guard !isOpen || container.superview !== host else { return }
    isOpen = true
    host.addSubview(container)
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
    tick()
  }

  /// Takes the view away. Ends only our own `tmux attach`; the agent is another process in tmux.
  func close() {
    timer?.invalidate()
    timer = nil
    removeViewer()
    container.removeFromSuperview()
    isOpen = false
  }

  func tick() {
    guard isOpen else { return }
    if session != TerminalSessions.mainId { return tickThread() }
    switch source.host() {
    case .none:
      say(TerminalPane.choose(configured: false, hasLiveChild: false, sessionExists: false))
    case .noTmux:
      say(.note(Self.noTmuxNote))
    case .tmux(let argv):
      if viewer?.process.running == true { note.isHidden = true; return }
      let live = source.hasLiveChild()
      let choice = TerminalPane.choose(
        configured: source.configured(), hasLiveChild: live, sessionExists: live || source.sessionExists())
      guard case .attach = choice else { return say(choice) }
      guard Date().timeIntervalSince(lastViewerStart) > 1.0 else { return }
      lastViewerStart = Date()
      start(argv)
    }
  }

  /// A thread's tab: attach its session when it has a pane, say why when it doesn't.
  private func tickThread() {
    guard case .tmux = source.host() else { return say(.note(Self.noTmuxNote)) }
    switch source.thread(session) {
    case .gone: say(.note(Self.goneNote))
    case .note(let text): say(.note(text))
    case .attach(let argv):
      if viewer?.process.running == true { note.isHidden = true; return }
      guard Date().timeIntervalSince(lastViewerStart) > 1.0 else { return }
      lastViewerStart = Date()
      start(argv)
    }
  }

  private func say(_ choice: TerminalPane.Choice) {
    guard case .note(let text) = choice else { return }
    note.stringValue = text
    note.isHidden = false
    removeViewer()
  }

  private func start(_ argv: [String]) {
    removeViewer()
    let v = SafeTerminalView(frame: container.bounds)
    v.autoresizingMask = [.width, .height]
    v.processDelegate = self
    container.addSubview(v)
    viewer = v
    if Date() < keyboardClaimUntil {
      keyboardClaimUntil = .distantPast
      container.window?.makeFirstResponder(v)
    }
    note.isHidden = true
    let env = ThreadSessionsPane.tmuxViewerEnvironment()
    v.startProcess(
      executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" })
    // Never takes the keyboard here: this runs because of what the page asked, and a page that could move the owner's typing
    // into the agent could type for them. The keyboard goes to the viewer only on a click in it (`SafeTerminalView.mouseDown`).
  }

  private func removeViewer() {
    guard let v = viewer else { return }
    // A viewer that held the keyboard leaves it with the page's view, not with the bare window: a window that is first
    // responder beeps at every key and no shortcut reaches it.
    let host = container.superview
    let held = v.window?.firstResponder === v
    if v.process.running { v.terminate() }
    v.removeFromSuperview()
    viewer = nil
    if held, let host { host.window?.makeFirstResponder(host) }
  }

  // MARK: LocalProcessTerminalViewDelegate
  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    // The viewer ended. tick() looks again and attaches when a session is alive.
    if source === viewer { lastViewerStart = Date() }
  }
}
