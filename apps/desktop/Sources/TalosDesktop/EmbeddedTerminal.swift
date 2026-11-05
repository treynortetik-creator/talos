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

  /// Where the view gets its facts. `live` reads the supervisor; tests hand in their own.
  struct Source {
    var host: () -> Host
    var configured: () -> Bool
    var hasLiveChild: () -> Bool
    var sessionExists: () -> Bool

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
        sessionExists: { model()?.agentSessionExists() ?? false })
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

  /// Tests: what the owner sees and what is running.
  var noteTextForTest: String? { note.isHidden ? nil : note.stringValue }
  var hasViewerForTest: Bool { viewer != nil }
  var viewerForTest: NSView? { viewer }
  var viewerIsRunningForTest: Bool { viewer?.process.running == true }

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
    note.isHidden = true
    let env = ThreadSessionsPane.tmuxViewerEnvironment()
    v.startProcess(
      executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" })
    // Never takes the keyboard here: this runs because of what the page asked, and a page that could move the owner's typing
    // into the agent could type for them. The keyboard goes to the viewer only on a click in it (`SafeTerminalView.mouseDown`).
  }

  private func removeViewer() {
    guard let v = viewer else { return }
    if v.process.running { v.terminate() }
    v.removeFromSuperview()
    viewer = nil
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
