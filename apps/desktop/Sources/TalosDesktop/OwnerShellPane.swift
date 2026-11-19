import AppKit
import Foundation
import SwiftTerm
import TalosDesktopCore

/// The owner's own shell in the Talos window's Terminal pane (docs/TERMINAL-PANE.md). The page leaves a slot and says where it
/// is and which thread it belongs to; this view is laid over it. Each tab is the owner's login shell on a pty this app owns,
/// started in the thread's folder. It is not the agent's terminal: nothing here attaches to `tmux -L talos`, and there is no
/// tmux socket anyone else could send keys through.
///
/// What reaches a shell's input is what the owner types or pastes into the native view (AppKit), and the terminal's own answers
/// to a program that asks where the cursor is or what kind of terminal this is. This file has no call that writes to a shell
/// and no call that hands anything a shell printed to the page, the relay or the bridge; the page can move, show, hide and
/// close the pane, and nothing else. `Tests/…/ShellPaneReachTests` holds the file to that.
@MainActor
final class OwnerShellPane: NSObject, LocalProcessTerminalViewDelegate {
  /// Where the pane gets its facts. `live` reads this Mac; tests hand in their own.
  struct Source {
    /// The folder a thread's shell starts in. Read from this Mac, never from the page.
    var folder: (String) -> String
    var shell: () -> ShellPane.Shell
    /// Arguments after `argv[0]`. None for the owner's shell; a test's stand-in shell takes its script here.
    var args: [String] = []
    var environment: () -> [String: String]
    /// The clock the page's start limit reads.
    var now: () -> Date = { Date() }

    @MainActor static func live() -> Source {
      Source(
        folder: { thread in
          let model = TerminalWindowController.shared.supervisorModel
          let home = NSHomeDirectory()
          let config = model.flatMap { FileManager.default.contents(atPath: $0.workersHome + "/config.json") }
          return ShellPane.folder(
            threadId: thread, config: config, agentDir: model?.configNow.agentDir ?? "", home: home,
            isFolder: { path in
              var dir: ObjCBool = false
              return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
            })
        },
        shell: {
          let account = getpwuid(getuid()).flatMap { $0.pointee.pw_shell }.map { String(cString: $0) }
          return ShellPane.loginShell(
            account: account, env: ProcessInfo.processInfo.environment["SHELL"],
            isExecutable: FileManager.default.isExecutableFile)
        },
        environment: { ShellPane.environment(from: ProcessInfo.processInfo.environment) })
    }
  }

  @MainActor
  final class Tab {
    let id: Int
    fileprivate let view: SafeTerminalView
    /// Keeps the clipboard out of what the shell's output can reach (`ShellClipboardGuard`); lives as long as the view.
    private let clipboardGuard: ShellClipboardGuard
    let folder: String
    let title: String
    let started = Date()
    /// How much this shell has printed lately (a count and a time, never bytes): `runScript` reads it to see that the shell answered.
    fileprivate let pulse = OutputPulse()
    /// One `runScript` at a time in this shell.
    fileprivate let gate = AsyncGate()
    fileprivate init(id: Int, view: SafeTerminalView, folder: String, title: String) {
      self.id = id
      self.view = view
      clipboardGuard = ShellClipboardGuard(guarding: view)
      self.folder = folder
      self.title = title
    }
  }

  private struct Shells {
    var tabs: [Tab] = []
    var selected: Int?
    /// How many shells this pane has started, for the tab labels.
    var started = 0
  }

  static let stripHeight: CGFloat = 26
  static let endedNote = "This shell has ended. Press + for a new one."
  static let fullNote = "That is as many shells as Talos keeps open at once. Close one to start another."
  static let tooFastNote = "Too many shells were started in the last minute, so Talos did not start this one. Close this pane and open it again in a minute."
  static func failedNote(_ shell: String) -> String { "Talos couldn't start your shell (\(shell)). Press + to try again." }
  /// A shell that ends this soon after it starts, with an error, never ran: the owner is told so, not "ended".
  static let neverRanWithin: TimeInterval = 1

  /// The smallest slot the pane is shown in: `ShellPane.minColumns` by `minRows` cells of the terminal's own font, plus the tab strip.
  static let minimumSize: CGSize = {
    let v = SafeTerminalView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    v.resize(cols: ShellPane.minColumns, rows: ShellPane.minRows)
    let s = v.getOptimalFrameSize().size
    return CGSize(width: s.width, height: s.height + stripHeight)
  }()

  var source: Source = .live()
  /// The tab strip, the shell and the note. Opaque, so the page's placeholder underneath never shows through.
  let container = WindowBackgroundView(frame: .zero)
  private let strip = NSStackView()
  private let holder = NSView()
  private let note = NSTextField(wrappingLabelWithString: "")
  private var threads: [String: Shells] = [:]
  private var nextTab = 1
  /// Shells that were told to end and may not be gone yet: they still count toward the limit.
  private var ending = 0
  /// When the page's own messages started a shell, for `ShellPane.pageMayStart`.
  private var pageStarts: [Date] = []
  /// The thread whose pane is laid over the page right now, nil while hidden.
  private(set) var showing: String?

  override init() {
    super.init()
    strip.orientation = .horizontal
    strip.spacing = 4
    strip.alignment = .centerY
    strip.edgeInsets = NSEdgeInsets(top: 0, left: 6, bottom: 0, right: 6)
    strip.setAccessibilityLabel("Shell tabs")
    for v in [strip, holder] as [NSView] {
      v.translatesAutoresizingMaskIntoConstraints = false
      container.addSubview(v)
    }
    note.textColor = .secondaryLabelColor
    note.translatesAutoresizingMaskIntoConstraints = false
    note.isHidden = true
    holder.addSubview(note)
    NSLayoutConstraint.activate([
      strip.topAnchor.constraint(equalTo: container.topAnchor),
      strip.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      strip.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor),
      strip.heightAnchor.constraint(equalToConstant: Self.stripHeight),
      holder.topAnchor.constraint(equalTo: strip.bottomAnchor),
      holder.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      holder.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      holder.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      note.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: 12),
      note.trailingAnchor.constraint(equalTo: holder.trailingAnchor, constant: -12),
      note.topAnchor.constraint(equalTo: holder.topAnchor, constant: 12),
    ])
  }

  // MARK: what the page may ask for

  /// Lays `thread`'s pane over `frame` of `host`, or moves it there. A thread whose pane has not been opened (or was closed)
  /// gets its first shell now. Never takes the keyboard: this runs on the page's word, and a page that could move the owner's
  /// typing into a shell could type for them. The keyboard goes to a shell on a click in it, or on the owner's own + press.
  func show(thread: String, in host: NSView, frame: CGRect) {
    container.frame = frame
    if container.superview !== host { host.addSubview(container) }
    let switched = showing != thread
    if switched {
      releaseKeyboard()
      showing = thread
      note.isHidden = true  // the note was the other thread's
    }
    if threads[thread] == nil {
      // panes left with no shell (it ended, or never ran) are not kept once another pane opens: a page that names one thread
      // after another leaves nothing behind
      for (id, shells) in threads where shells.tabs.isEmpty { threads[id] = nil }
      // a pane that could not get its first shell (a limit) is not kept either: a later report of the slot tries again
      threads[thread] = Shells()
      if !spawn(in: thread, takeKeyboard: false) { threads[thread] = nil }
      layoutTabs()
    } else if switched {
      layoutTabs()
    }
  }

  /// Takes the pane off the page. Every shell keeps running; showing the thread again brings them back as they were.
  func hide() {
    guard showing != nil || container.superview != nil else { return }
    releaseKeyboard()
    showing = nil
    container.removeFromSuperview()
  }

  /// The owner closed this thread's Terminal pane: its shells end.
  func close(thread: String) {
    guard let shells = threads.removeValue(forKey: thread) else { return }
    if showing == thread { hide() }
    for t in shells.tabs { end(t) }
  }

  /// Sign-out from the Mac: every shell in every pane ends.
  func closeAll() {
    for id in Array(threads.keys) { close(thread: id) }
    hide()
  }

  // MARK: the one entry for a script (ShellRunChannel)

  /// Puts a Run's script into the selected shell of the thread whose pane is on screen. Takes a `Ticket`, which only `ShellRunChannel` can
  /// make, and only after the owner's own click vouched for this exact Run, so this is the single way into a shell's input other than the
  /// owner's own keys and paste. It writes only when the shell is at its line editor: its process runs and has had a moment to start, the
  /// terminal's foreground process group is the shell's own, and the shell has turned on bracketed paste. Otherwise nothing is written
  /// (`.wait`: not yet, the channel asks again for a few seconds). When it is, whatever is on the shell's line (a half-typed command, an
  /// open `for`) is discarded first with Ctrl+C, and the script goes only once the shell has answered it and is back at its prompt, as
  /// one bracketed paste and one Return: never appended to someone else's line.
  func runScript(_ ticket: ShellRunChannel.Ticket, deadline: Double, now: @escaping () -> Double) async -> ShellRunChannel.Step {
    guard showing == ticket.thread, container.superview != nil, threads[ticket.thread] != nil else { return .wait(.noPane) }
    guard let tab = selectedTab(ticket.thread) else { return .wait(.noShell) }
    let v = tab.view
    // one Run at a time in a shell: a second waits for the first to be done with the line
    await tab.gate.lock()
    defer { tab.gate.unlock() }
    noteEntered()
    defer { noteLeft() }
    guard showing == ticket.thread, selectedTab(ticket.thread) === tab else { return .wait(.noPane) }
    guard atLineEditor(tab) else { return .wait(started(tab) ? .busy : .noShell) }
    // nothing is written after the Run's budget: a Run the bridge has stopped waiting for must not run
    guard now() < deadline else { return .refused(.busy) }
    // discard the line (and any continuation), then wait for the shell to take it: output since, quiet, line editor back
    let before = tab.pulse.state.count
    put([0x03], in: v)
    let clearEnd = min(now() + PaneRun.clearWaitSeconds, deadline)
    while true {
      try? await Task.sleep(nanoseconds: 10_000_000)
      guard showing == ticket.thread, selectedTab(ticket.thread) === tab else { return .refused(.noPane) }
      let pulse = tab.pulse.state
      if pulse.count > before, Monotonic.now() - pulse.lastAt >= PaneRun.promptQuietSeconds, atLineEditor(tab) { break }
      if now() >= clearEnd { return .refused(.busy) }  // it did not come back to its prompt: nothing more is written
    }
    guard now() < deadline else { return .refused(.busy) }
    put(PaneRun.bytes(script: ticket.script), in: v)
    return .wrote
  }

  private func started(_ tab: Tab) -> Bool {
    guard let p = tab.view.process, p.running, p.shellPid > 1 else { return false }
    return Date().timeIntervalSince(tab.started) >= PaneRun.shellStartSeconds
  }

  /// Started, the terminal's foreground process group is the shell's own (if that cannot be read, it is not known to be), and the shell has
  /// bracketed paste on: a shell at its line editor. A startup profile still running, a `read`, a `vared`, a running program are not.
  private func atLineEditor(_ tab: Tab) -> Bool {
    guard started(tab), let p = tab.view.process, tcgetpgrp(p.childfd) == p.shellPid else { return false }
    return tab.view.terminalStateSnapshot().bracketedPasteMode  // only this one flag is read
  }

  /// The one write to a shell in the app that is not the owner's own keys.
  private func put(_ bytes: [UInt8], in v: SafeTerminalView) { v.send(data: bytes[...]); noteWrite(bytes) }

  // MARK: what only the owner can do (clicks on the native strip)

  @objc private func plusPressed(_ sender: Any?) {
    guard let thread = showing else { return }
    spawn(in: thread, takeKeyboard: true)
    layoutTabs()
  }

  @objc private func tabPressed(_ sender: NSButton) {
    guard let thread = showing, threads[thread]?.tabs.contains(where: { $0.id == sender.tag }) == true else { return }
    threads[thread]?.selected = sender.tag
    layoutTabs()
    if let v = selectedTab(thread)?.view { v.window?.makeFirstResponder(v) }
  }

  @objc private func closePressed(_ sender: NSButton) {
    guard let thread = showing, let i = threads[thread]?.tabs.firstIndex(where: { $0.id == sender.tag }),
      let tab = threads[thread]?.tabs[i]
    else { return }
    remove(tab, from: thread)
    end(tab)
    layoutTabs()
  }

  // MARK: shells

  private var liveShells: Int { threads.values.reduce(0) { $0 + $1.tabs.count } + ending }

  private func selectedTab(_ thread: String) -> Tab? {
    guard let s = threads[thread] else { return nil }
    return s.tabs.first { $0.id == s.selected }
  }

  /// Starts one more login shell for `thread`. Only `source` decides what runs, where and with which environment.
  /// `takeKeyboard` is also "the owner asked" (+): a start the page asked for is held to `ShellPane.maxPageStarts`.
  @discardableResult
  private func spawn(in thread: String, takeKeyboard: Bool) -> Bool {
    guard var shells = threads[thread] else { return false }
    guard shells.tabs.count < ShellPane.maxTabsPerThread, liveShells < ShellPane.maxShells else {
      if shells.tabs.isEmpty { say(Self.fullNote) }
      return false
    }
    if !takeKeyboard {
      let now = source.now()
      pageStarts.removeAll { now.timeIntervalSince($0) >= ShellPane.pageStartWindow }
      guard ShellPane.pageMayStart(now: now, earlier: pageStarts) else {
        say(Self.tooFastNote)
        return false
      }
      pageStarts.append(now)
    }
    let folder = source.folder(thread)
    let shell = source.shell()
    let env = source.environment()
    let v = SafeTerminalView(frame: holder.bounds)
    v.autoresizingMask = [.width, .height]
    v.processDelegate = self
    shells.started += 1
    let tab = Tab(id: nextTab, view: v, folder: folder, title: ShellPane.tabTitle(folder: folder, number: shells.started))
    nextTab += 1
    v.setProcessOutputHandler { [pulse = tab.pulse] in pulse.tick() }
    shells.tabs.append(tab)
    shells.selected = tab.id
    threads[thread] = shells
    holder.addSubview(v)
    v.startProcess(
      executable: shell.executable, args: source.args, environment: env.keys.sorted().map { "\($0)=\(env[$0] ?? "")" },
      execName: shell.execName, currentDirectory: folder)
    if takeKeyboard { v.window?.makeFirstResponder(v) }
    return true
  }

  private func remove(_ tab: Tab, from thread: String) {
    guard var shells = threads[thread], let i = shells.tabs.firstIndex(where: { $0 === tab }) else { return }
    if tab.view.window?.firstResponder === tab.view { releaseKeyboard() }
    shells.tabs.remove(at: i)
    if shells.selected == tab.id { shells.selected = shells.tabs.isEmpty ? nil : shells.tabs[min(i, shells.tabs.count - 1)].id }
    threads[thread] = shells
  }

  /// Whether `pid` is a child of this app that has not ended. A child that ended stays ours (its pid cannot be given to another
  /// process) until SwiftTerm collects it, and this looks without collecting; a pid that is not our child answers ECHILD.
  private static func isRunningChild(_ pid: pid_t) -> Bool {
    var info = siginfo_t()
    guard waitid(P_PID, id_t(pid), &info, WEXITED | WNOHANG | WNOWAIT) == 0 else { return false }
    return info.si_pid == 0
  }

  /// Ends one shell, and what runs in it. An interactive shell ignores SIGTERM, so it gets what closing a terminal window
  /// sends: a hangup, to it and to whatever holds the terminal's foreground. One that is still there two seconds on is killed.
  /// Every signal is sent only to a pid that is, at that moment, a running child of this app (or a group in that child's own
  /// terminal session), never to a number remembered from earlier.
  private func end(_ tab: Tab) {
    let v = tab.view
    v.processDelegate = nil
    v.removeFromSuperview()
    guard let p = v.process, p.running else { return }
    let pid = p.shellPid
    guard pid > 1, Self.isRunningChild(pid) else { return }
    ending += 1
    let front = tcgetpgrp(p.childfd)
    if front > 1, getsid(front) == pid { killpg(front, SIGHUP) }
    kill(pid, SIGHUP)
    v.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      self?.ending -= 1
      guard v.process.running, v.process.shellPid == pid, Self.isRunningChild(pid) else { return }
      kill(pid, SIGKILL)
      self?.forcedKillsForTest += 1
    }
  }

  /// A shell that held the keyboard leaves it with the page's view, not with the bare window (which beeps at every key).
  private func releaseKeyboard() {
    guard let w = container.window, let r = w.firstResponder as? NSView, r === container || r.isDescendant(of: container),
      let host = container.superview
    else { return }
    w.makeFirstResponder(host)
  }

  private func say(_ text: String) {
    note.stringValue = text
    note.isHidden = false
  }

  /// Rebuilds the strip and puts the selected shell in front, for the thread that is showing.
  private func layoutTabs() {
    for v in strip.arrangedSubviews {
      strip.removeArrangedSubview(v)
      v.removeFromSuperview()
    }
    for (_, shells) in threads { for t in shells.tabs { t.view.isHidden = true } }
    guard let thread = showing, let shells = threads[thread] else { return }
    for t in shells.tabs {
      let b = NSButton(title: t.title, target: self, action: #selector(tabPressed(_:)))
      b.tag = t.id
      b.bezelStyle = .recessed
      b.setButtonType(.pushOnPushOff)
      b.state = t.id == shells.selected ? .on : .off
      b.toolTip = t.folder
      b.setAccessibilityLabel("Shell in \(t.folder)")
      let x = NSButton(title: "×", target: self, action: #selector(closePressed(_:)))
      x.tag = t.id
      x.isBordered = false
      x.setAccessibilityLabel("Close shell \(t.title)")
      strip.addArrangedSubview(b)
      strip.addArrangedSubview(x)
    }
    let plus = NSButton(title: "+", target: self, action: #selector(plusPressed(_:)))
    plus.bezelStyle = .recessed
    plus.toolTip = "New shell"
    plus.setAccessibilityLabel("New shell")
    plus.isEnabled = shells.tabs.count < ShellPane.maxTabsPerThread && liveShells < ShellPane.maxShells
    strip.addArrangedSubview(plus)
    if let tab = selectedTab(thread) {
      tab.view.frame = holder.bounds
      tab.view.isHidden = false
      note.isHidden = true
    } else if note.isHidden {
      say(Self.endedNote)
    }
  }

  // MARK: LocalProcessTerminalViewDelegate
  func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
  func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
  func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

  /// A shell ended by itself (`exit`, Ctrl+D): its tab goes. The pane stays, with the note when it was the last one.
  func processTerminated(source: TerminalView, exitCode: Int32?) {
    let tab = threads.values.flatMap(\.tabs).first { $0.view === source }
    let neverRan = (exitCode ?? 0) != 0 && tab.map { Date().timeIntervalSince($0.started) < Self.neverRanWithin } == true
    drop(source, saying: neverRan ? Self.failedNote(self.source.shell().executable) : Self.endedNote)
  }

  /// The shell could not be started: the owner is told in the pane, never left with an empty one.
  func processFailedToStart(source: TerminalView, error: LocalProcessError) {
    drop(source, saying: Self.failedNote(self.source.shell().executable))
  }

  private func drop(_ view: TerminalView, saying text: String) {
    for (thread, shells) in threads {
      guard let tab = shells.tabs.first(where: { $0.view === view }) else { continue }
      remove(tab, from: thread)
      tab.view.removeFromSuperview()
      if showing == thread {
        if threads[thread]?.tabs.isEmpty == true { say(text) }
        layoutTabs()
      }
      return
    }
  }

  /// How many shells did not go on the hangup and had to be killed.
  private(set) var forcedKillsForTest = 0

  #if DEBUG
    /// What `runScript` wrote and how many ran at once: tests only.
    private(set) var writesForTest: [[UInt8]] = []
    private(set) var maxRunsInFlightForTest = 0
    private var runsInFlight = 0
    private func noteWrite(_ b: [UInt8]) { writesForTest.append(b) }
    private func noteEntered() {
      runsInFlight += 1
      maxRunsInFlightForTest = max(maxRunsInFlightForTest, runsInFlight)
    }
    private func noteLeft() { runsInFlight -= 1 }
  #else
    private func noteWrite(_ b: [UInt8]) {}
    private func noteEntered() {}
    private func noteLeft() {}
  #endif

  // MARK: tests. Not in the app that ships: a release build has no way from outside this file to a shell's view.
  #if DEBUG
    var noteTextForTest: String? { note.isHidden ? nil : note.stringValue }
    func tabsForTest(_ thread: String) -> [Tab] { threads[thread]?.tabs ?? [] }
    /// The terminal views of a thread's tabs, in order: what a test types into, the way AppKit hands a typed line to the view.
    func viewsForTest(_ thread: String) -> [SafeTerminalView] { tabsForTest(thread).map(\.view) }
    var shellCountForTest: Int { threads.values.reduce(0) { $0 + $1.tabs.count } }
    var openThreadsForTest: [String] { threads.keys.sorted() }
    func pressPlusForTest() { plusPressed(nil) }
    func pressCloseForTest(tab id: Int) {
      let b = NSButton()
      b.tag = id
      closePressed(b)
    }
    func pressTabForTest(_ id: Int) {
      let b = NSButton()
      b.tag = id
      tabPressed(b)
    }
  #endif
}

/// A first-come lock for async work on the main actor: `lock()` returns when the caller holds it; `unlock()` hands it to the next in line.
@MainActor
final class AsyncGate {
  private var held = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  func lock() async {
    if !held {
      held = true
      return
    }
    await withCheckedContinuation { waiters.append($0) }
  }
  func unlock() {
    if waiters.isEmpty { held = false } else { waiters.removeFirst().resume() }
  }
}
