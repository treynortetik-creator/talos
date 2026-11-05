import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore
import TalosSupervisor

/// A button that types fixed bytes at the owned-pty agent.
final class DirectKeyButton: NSButton {
  var bytes: [UInt8] = []
}

/// A terminal view whose Cmd-click on a link only opens what the rest of the app would: http(s) and mailto. SwiftTerm's own
/// handler passes anything to `NSWorkspace.open`, including a `.command` file path or a custom scheme, and agent output is
/// untrusted text.
final class SafeTerminalView: LocalProcessTerminalView {
  override func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    guard let url = ExternalURL.parse(link) else { return }
    NSWorkspace.shared.open(url)
  }

  /// A click is how the owner gives a viewer the keyboard. Nothing else in the main window does it for them.
  override func mouseDown(with event: NSEvent) {
    window?.makeFirstResponder(self)
    super.mouseDown(with: event)
  }
}

/// The terminal window (DESKTOP-SPEC 4.6, WP-D2). Tab 1 is a viewer on the agent's tmux session: a SwiftTerm view running
/// `tmux -L talos attach -t agent`. Closing the window ends only that viewer (our own child); the agent keeps running in
/// tmux and the pane re-attaches next time. Tab 2 appears while the sign-in pane (Pairing) is open.
@MainActor
final class TerminalWindowController: NSObject, NSWindowDelegate, LocalProcessTerminalViewDelegate {
  static let shared = TerminalWindowController()

  private weak var model: SupervisorController?
  private var window: NSWindow?
  private var tabs: NSTabView?
  private var viewer: LocalProcessTerminalView?
  private var direct: NSView?
  private var directText: NSTextView?
  private var note: NSTextField?
  private var pairingItem: NSTabViewItem?
  private var threadsItem: NSTabViewItem?
  private var threadsPane: ThreadSessionsPane?
  private var timer: Timer?
  private var lastViewerStart = Date.distantPast
  private var wantsKeyboard = true

  func attach(model: SupervisorController) { self.model = model }
  func isAttached(to m: SupervisorController) -> Bool { model === m }
  /// The supervisor the window was attached to; the main window's terminal view reads the same facts.
  var supervisorModel: SupervisorController? { model }
  /// Tests: whether the last show() asked for the keyboard, and a way to put the window away again.
  var wantsKeyboardForTest: Bool { wantsKeyboard }
  func hideForTest() {
    removeViewer()
    threadsPane?.stopTerminal()
    timer?.invalidate()
    timer = nil
    window?.orderOut(nil)
  }

  var isVisible: Bool { window?.isVisible ?? false }

  /// `takeFocus: false` (the agent raised a dialog, the owner did nothing): the window comes forward but the app is not
  /// activated and nothing is made first responder, so typing in another app does not land in the dialog.
  func show(takeFocus: Bool = true) {
    if window == nil { build() }
    wantsKeyboard = takeFocus
    if takeFocus {
      NSApp.activate(ignoringOtherApps: true)
      window?.makeKeyAndOrderFront(nil)
    } else {
      window?.orderFront(nil)
    }
    tick()
    timer?.invalidate()
    timer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.tick() }
    }
  }

  private func build() {
    let w = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 900, height: 600),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    w.title = "Talos Terminal"
    w.isReleasedWhenClosed = false
    w.delegate = self
    w.setFrameAutosaveName("TalosTerminalWindow")
    let tv = NSTabView()
    let item = NSTabViewItem(identifier: "agent")
    item.label = "Agent"
    let n = NSTextField(wrappingLabelWithString: "")
    n.textColor = .secondaryLabelColor
    note = n
    let holder = NSView()
    n.translatesAutoresizingMaskIntoConstraints = false
    holder.addSubview(n)
    NSLayoutConstraint.activate([
      n.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 16),
      n.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -16),
      n.topAnchor.constraint(equalTo: holder.topAnchor, constant: 16),
    ])
    item.view = holder
    tv.addTabViewItem(item)
    tabs = tv
    w.contentView = tv
    w.center()
    window = w
  }

  // MARK: viewer

  /// Starts the tmux viewer when there is a session to look at and none running; says why when there isn't.
  private func tick() {
    guard let model, let holder = tabs?.tabViewItem(at: 0).view else { return }
    refreshThreadsTab(model)
    guard model.hostKind == .tmux, let argv = model.tmuxAttach else {
      showDirect(model, in: holder)  // no tmux 3.2+: the agent runs in a pty Talos owns; mirror it here
      return
    }
    if viewer?.process.running == true { note?.isHidden = true; return }
    let live = model.status.childPid != nil
    switch TerminalPane.choose(configured: model.configured, hasLiveChild: live, sessionExists: live || model.agentSessionExists()) {
    case .note(let text):
      note?.isHidden = false
      note?.stringValue = text
      removeViewer()
      return
    case .attach: break
    }
    guard Date().timeIntervalSince(lastViewerStart) > 1.0 else { return }
    lastViewerStart = Date()
    removeViewer()
    let v = SafeTerminalView(frame: holder.bounds)
    v.autoresizingMask = [.width, .height]
    v.processDelegate = self
    holder.addSubview(v)
    viewer = v
    note?.isHidden = true
    var env = ProcessInfo.processInfo.environment
    for k in ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID"] { env.removeValue(forKey: k) }
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    // A Finder or login-item launch has no locale; give the viewer one so every program in the pane sees UTF-8 too.
    if env["LC_ALL"] == nil, env["LC_CTYPE"] == nil, env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
    v.startProcess(
      executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" })
    // Only take the keyboard when the agent tab is the one showing: a re-attach behind the sign-in tab must not pull it
    // away from the pane where the owner is typing `y`.
    if tabs?.selectedTabViewItem === tabs?.tabViewItem(at: 0), wantsKeyboard { window?.makeFirstResponder(v) }
  }

  /// The owned-pty fallback: what the pty shows, and the keys the dev-channel dialog and a trust prompt need.
  private func showDirect(_ model: SupervisorController, in holder: NSView) {
    if direct == nil {
      let text = NSTextView(frame: .zero)
      text.isEditable = false
      text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
      text.textContainerInset = NSSize(width: 6, height: 6)
      let scroll = NSScrollView()
      scroll.documentView = text
      scroll.hasVerticalScroller = true
      scroll.translatesAutoresizingMaskIntoConstraints = false
      func key(_ title: String, _ bytes: [UInt8]) -> NSButton {
        let b = DirectKeyButton(title: title, target: self, action: #selector(directKey(_:)))
        b.bytes = bytes
        return b
      }
      let row = NSStackView(views: [
        key("Enter", [0x0d]), key("Esc", [0x1b]), key("y", [0x79]), key("n", [0x6e]), key("↑", [0x1b, 0x5b, 0x41]),
        key("↓", [0x1b, 0x5b, 0x42]),
      ])
      row.translatesAutoresizingMaskIntoConstraints = false
      let info = NSTextField(wrappingLabelWithString: "This Mac has no tmux 3.2 or newer, so the agent runs in a pty Talos owns (it stops when Talos quits). This is its screen; the buttons type at it. Install tmux to get a full terminal here.")
      info.textColor = .secondaryLabelColor
      info.translatesAutoresizingMaskIntoConstraints = false
      let box = NSView(frame: holder.bounds)
      box.autoresizingMask = [.width, .height]
      for v in [scroll, row, info] { box.addSubview(v) }
      NSLayoutConstraint.activate([
        info.topAnchor.constraint(equalTo: box.topAnchor, constant: 8), info.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12),
        info.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -12),
        row.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 12), row.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
        scroll.topAnchor.constraint(equalTo: info.bottomAnchor, constant: 8), scroll.leadingAnchor.constraint(equalTo: box.leadingAnchor),
        scroll.trailingAnchor.constraint(equalTo: box.trailingAnchor), scroll.bottomAnchor.constraint(equalTo: row.topAnchor, constant: -8),
      ])
      holder.addSubview(box)
      direct = box
      directText = text
      note?.isHidden = true
    }
    let rows = model.supervisor.hostScreen()
    let shown = rows.isEmpty ? "(no agent session yet: Menu → Start session)" : rows.joined(separator: "\n")
    if directText?.string != shown { directText?.string = shown }
  }

  @objc private func directKey(_ sender: NSButton) {
    guard let b = sender as? DirectKeyButton, let model else { return }
    model.supervisor.hostSend(b.bytes)
  }

  /// True for the agent tab's viewer (tests count the sign-in pane's terminals apart from it).
  func isAgentViewer(_ v: NSView) -> Bool { v === viewer }

  private func removeViewer() {
    guard let v = viewer else { return }
    if v.process.running { v.terminate() }  // our own `tmux attach` child; the agent is a different process in tmux
    v.removeFromSuperview()
    viewer = nil
  }

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    removeViewer()  // detach: tmux keeps the agent
    threadsPane?.stopTerminal()  // a thread viewer detaches the same way; a claude opened here for a question ends
    timer?.invalidate()
    timer = nil
    sender.orderOut(nil)
    return false
  }

  // MARK: thread sessions tab (D48)

  /// The "Thread sessions" tab exists while this Mac runs the worker manager (tmux host). Tab 0 stays the agent.
  private func refreshThreadsTab(_ model: SupervisorController) {
    guard let tabs, model.workers != nil else { return }
    if threadsItem == nil {
      let pane = ThreadSessionsPane()
      let item = NSTabViewItem(identifier: "threads")
      item.label = "Thread sessions"
      item.view = pane.view
      tabs.insertTabViewItem(item, at: min(1, tabs.numberOfTabViewItems))
      threadsItem = item
      threadsPane = pane
    }
    threadsPane?.source = ThreadSessionsPane.Source.live(model)
    threadsPane?.refresh()
  }

  /// Tests and the menu: the tab's pane.
  var threadSessionsPaneForTest: ThreadSessionsPane? { threadsPane }

  // MARK: tab 2 (sign-in)

  private static func firstTerminal(in v: NSView) -> LocalProcessTerminalView? {
    if let t = v as? LocalProcessTerminalView { return t }
    for s in v.subviews { if let t = firstTerminal(in: s) { return t } }
    return nil
  }

  func setPairingTab(_ view: NSView?) {
    if window == nil { build() }
    guard let tabs else { return }
    if let old = pairingItem {
      tabs.removeTabViewItem(old)
      pairingItem = nil
    }
    guard let view else { return }
    let item = NSTabViewItem(identifier: "pairing")
    item.label = "Sign in"
    item.view = view
    tabs.addTabViewItem(item)
    tabs.selectTabViewItem(item)
    pairingItem = item
    // The sign-in pane is what the owner types `y` into: give it the keyboard (the agent viewer behind it must not).
    if let t = Self.firstTerminal(in: view) { window?.makeFirstResponder(t) }
  }

  // MARK: LocalProcessTerminalViewDelegate
  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    // The viewer ended (the session ended or tmux detached us). tick() re-attaches when a session is alive.
    if source === viewer { lastViewerStart = Date() }
  }
}

/// The Thread sessions tab (D48): every worker in `workers.json` with its state and stop reason in plain words, a viewer on
/// a live worker's tmux pane, and, for a thread that stopped at a dialog only the Mac can answer, a button that opens
/// `claude` in that thread's folder in a pane. Nothing here types into a dialog: the owner reads it and answers it
/// (OPTION-C: only a person answers a dialog).
@MainActor
final class ThreadSessionsPane: NSObject, LocalProcessTerminalViewDelegate {
  let view = NSView()
  private let picker = NSPopUpButton(frame: .zero, pullsDown: false)
  private let status = NSTextField(wrappingLabelWithString: "")
  private let attachButton = NSButton(title: "Attach", target: nil, action: nil)
  private let openButton = NSButton(title: "Open claude in this folder", target: nil, action: nil)
  private let holder = NSView()
  private let empty = NSTextField(wrappingLabelWithString: "No thread sessions yet. A thread that runs its own session shows up here once it has started.")
  private var rows: [ThreadSessionRow] = []
  private var signature = ""
  private var terminal: LocalProcessTerminalView?

  /// Where the pane gets its rows and the commands it runs. `live` reads the worker manager; tests hand in their own.
  struct Source {
    var rows: () -> [ThreadSessionRow]
    /// The `tmux attach` argv for a worker's session, or nil when this Mac has no worker manager.
    var attachArgv: (ThreadSessionRow) -> [String]?
    var claudePath: () -> String?
    /// The worker's permission flag, the Talos home and the login environment workers run with.
    var permissionFlag: () -> String? = { nil }
    var talosHome: () -> String? = { nil }
    var loginEnv: () -> [String: String]? = { nil }

    @MainActor static func live(_ model: SupervisorController) -> Source {
      Source(
        rows: { ThreadSessions.rows(from: model.workers?.snapshot()) },
        attachArgv: { row in
          guard let o = model.workers?.options else { return nil }
          return TmuxCommands(tmux: o.tmux, socket: o.socket, configPath: o.tmuxConf, session: row.tmuxSession).attach()
        },
        claudePath: { model.workers?.options.claudePath },
        permissionFlag: { model.workers?.options.permissionFlag },
        talosHome: { model.workers?.options.talosHome },
        loginEnv: { model.workers?.loginEnvironment() })
    }
  }
  var source: Source?

  override init() {
    super.init()
    view.autoresizingMask = [.width, .height]
    attachButton.target = self
    attachButton.action = #selector(attach)
    openButton.target = self
    openButton.action = #selector(openClaude)
    picker.target = self
    picker.action = #selector(pickerChanged)
    status.textColor = .secondaryLabelColor
    empty.textColor = .secondaryLabelColor
    let buttons = NSStackView(views: [attachButton, openButton])
    buttons.spacing = 8
    for v in [picker, status, buttons, holder, empty] {
      v.translatesAutoresizingMaskIntoConstraints = false
      view.addSubview(v)
    }
    NSLayoutConstraint.activate([
      picker.topAnchor.constraint(equalTo: view.topAnchor, constant: 12),
      picker.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      picker.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
      buttons.centerYAnchor.constraint(equalTo: picker.centerYAnchor),
      buttons.leadingAnchor.constraint(equalTo: picker.trailingAnchor, constant: 12),
      status.topAnchor.constraint(equalTo: picker.bottomAnchor, constant: 8),
      status.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      status.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      holder.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 8),
      holder.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      holder.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      holder.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      empty.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
      empty.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      empty.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
    ])
  }

  /// The row the picker has selected.
  var selectedRow: ThreadSessionRow? {
    let i = picker.indexOfSelectedItem
    return rows.indices.contains(i) ? rows[i] : nil
  }
  /// Tests: what the controls say.
  var statusTextForTest: String { status.stringValue }
  var attachEnabledForTest: Bool { attachButton.isEnabled }
  var openClaudeVisibleForTest: Bool { !openButton.isHidden }
  var pickerTitlesForTest: [String] { picker.itemTitles }
  var hasTerminalForTest: Bool { terminal != nil }

  func refresh() {
    let next = source?.rows() ?? []
    let key = next.map { "\($0.threadId)|\($0.stateText)|\($0.detail)|\($0.dialogLabel ?? "")" }.joined(separator: "\n")
    let keep = selectedRow?.threadId
    rows = next
    if key != signature {
      signature = key
      picker.removeAllItems()
      picker.addItems(withTitles: next.map { "\($0.threadId): \($0.stateText)" })
      if let keep, let i = next.firstIndex(where: { $0.threadId == keep }) { picker.selectItem(at: i) }
    }
    empty.isHidden = !next.isEmpty
    for v in [picker, status, attachButton, openButton] as [NSView] { v.isHidden = next.isEmpty }
    guard let row = selectedRow else { stopTerminal(); return }
    var text = "\(row.stateText). \(row.detail)"
    if let label = row.dialogLabel { text += " The dialog said: \(label)" }
    if terminal != nil { text += " Closing this window ends the pane you opened." }
    if status.stringValue != text { status.stringValue = text }
    attachButton.isEnabled = row.canAttach
    openButton.isHidden = !row.needsMac
  }

  @objc private func pickerChanged() {
    stopTerminal()
    refresh()
  }

  @objc func attach() {
    guard let row = selectedRow, row.canAttach, TmuxCommands.isValidSessionName(row.tmuxSession),
      let argv = source?.attachArgv(row)
    else { return }
    start(argv: argv, cwd: nil, env: Self.tmuxViewerEnvironment())
  }

  @objc func openClaude() {
    guard let row = selectedRow, let path = source?.claudePath(),
      let inv = ThreadSessions.claudeInvocation(
        for: row, claudePath: path, permissionFlag: source?.permissionFlag(), talosHome: source?.talosHome())
    else { return }
    // this app's own environment may come from a shell a Claude session spawned: scrub it. The login environment workers
    // use wins: a Finder launch has no shell PATH, CLAUDE_CONFIG_DIR or API keys of its own.
    let env = ThreadSessions.claudeEnvironment(
      from: ClaudeEnvScrub.scrub(Self.tmuxViewerEnvironment()), deliberate: source?.loginEnv() ?? [:],
      talosHome: source?.talosHome())
    // a bare name (claude was not found when Talos started) is looked up on PATH by env
    let argv = inv.executable.hasPrefix("/") ? [inv.executable] + inv.args : ["/usr/bin/env", inv.executable] + inv.args
    start(argv: argv, cwd: inv.cwd, env: env)
  }

  static func tmuxViewerEnvironment() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    for k in ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID"] { env.removeValue(forKey: k) }
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    if env["LC_ALL"] == nil, env["LC_CTYPE"] == nil, env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
    return env
  }

  private func start(argv: [String], cwd: String?, env: [String: String]) {
    stopTerminal()
    let v = SafeTerminalView(frame: holder.bounds)
    v.autoresizingMask = [.width, .height]
    v.processDelegate = self
    holder.addSubview(v)
    terminal = v
    v.startProcess(
      executable: argv[0], args: Array(argv.dropFirst()), environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" },
      currentDirectory: cwd)
    view.window?.makeFirstResponder(v)
    refresh()
  }

  /// Ends what this tab started: a `tmux attach` child (the worker keeps running in tmux) or a claude opened for a question.
  func stopTerminal() {
    guard let v = terminal else { return }
    if v.process.running { v.terminate() }
    v.removeFromSuperview()
    terminal = nil
  }

  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    // The tmux session or the claude ended: drop the dead pane so the tab does not keep a frozen screen.
    if source === terminal { Task { @MainActor in self.stopTerminal(); self.refresh() } }
  }
}
