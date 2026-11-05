import AppKit
import Combine
import Foundation
import TalosDesktopCore

/// The floating compose panel (DESKTOP-SPEC 6.3): a multi-line field (Wispr Flow lands in it), a thread picker with the
/// last used thread first, Send (⌘↩), Esc. Send goes to the page as a `compose` message, which the page signs as a normal
/// owner message. Not signed in: "Sign in first" with [Open Talos].
@MainActor
final class QuickCompose: NSObject, NSWindowDelegate, NSTextViewDelegate {
  static let shared = QuickCompose()
  static let lastThreadKey = "quickCompose.lastThread"

  private final class Panel: NSPanel {
    override var canBecomeKey: Bool { true }
    var onEscape: (() -> Void)?
    override func cancelOperation(_ sender: Any?) { onEscape?() ?? orderOut(nil) }  // Esc
  }

  private var panel: Panel?
  private var popup: NSPopUpButton?
  private var text: NSTextView?
  private var status: NSTextField?
  private var sendButton: NSButton?
  private var signInStack: NSStackView?
  private var signInMessage: NSTextField?
  private var composeStack: NSStackView?
  private var shown: [WebToNative.Thread] = []
  /// The thread a kept draft was written for (Esc keeps the draft; the picker must keep its pick with it).
  private var draftThread: String?
  /// The draft's thread left the list: nothing is selected and Send is off until the owner picks a thread.
  private var threadGone = false
  /// A message is out and the page has not answered yet: Send stays off, so one press is one message.
  private var sending = false
  /// The last Send ended as the page going away without answering: the message may or may not have been saved. The warning stays
  /// until the box is emptied or a later Send is taken, whatever else happens to the line (typing, closing and opening the panel,
  /// the page reloading and listing no threads, picking a thread, a Send that sends nothing). It is the only guard against sending
  /// the same message twice blind.
  private var lost = false
  /// The last Send was not taken by the page (not open, not signed in): the text is kept. Typing or the next Send ends it.
  private var notTaken = false
  /// The short line the last action left (a Send that sent nothing, newer text kept). A refresh while the panel is open puts it back
  /// unless `ComposeStatus` finds a reason that outranks it; opening the panel starts without one.
  private var lastEvent: ComposeStatus.Event?
  /// What the panel last read from the page; an open panel reads again when the page's answer differs (`ComposeRefresh`).
  private var shownWorld: ComposeRefresh.World?
  private var webWatch: AnyCancellable?
  private var previousApp: NSRunningApplication?
  private var web = WebController.shared
  /// The companion's frame, when he is on screen on the pointer's screen: compose opens beside him (spec 3.6). nil centers.
  var anchorProvider: (() -> NSRect?)?
  /// Opening compose counts as the owner being there (it keeps him awake).
  var onShown: (() -> Void)?
  /// The thread a caller (the pet, the tray) would like selected. It only applies to an empty field: a message must never go
  /// to a different thread than it was written for (spec 8).
  private var requestedThread: String?

  /// Tests: builds the panel, puts it on screen for a moment without activating the app, returns its content view.
  func contentViewForTest() -> NSView? {
    if panel == nil { build() }
    refresh()
    panel?.setFrameOrigin(NSPoint(x: 80, y: 80))
    panel?.orderFrontRegardless()
    panel?.contentView?.layoutSubtreeIfNeeded()
    return panel?.contentView
  }

  func toggle() {
    if panel?.isVisible == true { cancelPressed() } else { show(anchor: anchorProvider?()) }
  }

  var isVisible: Bool { panel?.isVisible == true }

  func show(anchor: NSRect? = nil, thread: String? = nil) {
    prepareShow(thread: thread)
    NSApp.activate(ignoringOtherApps: true)
    if let anchor { anchorTo(anchor) } else { centerOnScreenInUse() }
    panel?.makeKeyAndOrderFront(nil)
    if let t = text { panel?.makeFirstResponder(t) }
    onShown?()
  }

  /// Everything `show` does before the window comes up: split out so a test can run it without activating the app.
  func prepareShow(thread: String?) {
    if panel == nil { build() }
    if panel?.isVisible != true {
      let front = NSWorkspace.shared.frontmostApplication
      previousApp = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : front
    } else {
      // `refresh()` rebuilds the picker. On a panel that is already open it would reset the pick while `draftThread` is still
      // unset, so remember the draft's thread first.
      rememberDraft()
    }
    requestedThread = thread
    lastEvent = nil
    refresh()
  }

  /// Tests: where the panel would open when anchored, without showing it.
  func anchoredOriginForTest(_ a: NSRect, visible: NSRect) -> NSRect? {
    guard let p = panel else { return nil }
    return CompanionPlacement.composeFrame(sprite: a, size: p.frame.size, in: visible)
  }

  /// Beside the companion, clear of him, kept on screen.
  private func anchorTo(_ a: NSRect) {
    guard let p = panel else { return }
    let mid = CGPoint(x: a.midX, y: a.midY)
    guard let screen = NSScreen.screens.first(where: { $0.frame.contains(mid) }) ?? NSScreen.main else { return centerOnScreenInUse() }
    let f = CompanionPlacement.composeFrame(sprite: a, size: p.frame.size, in: screen.visibleFrame)
    p.setFrameOrigin(f.origin)
  }

  /// On the display the owner is working on (the one under the pointer), not the one the panel was last on.
  private func centerOnScreenInUse() {
    guard let p = panel else { return }
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
    guard let f = screen?.visibleFrame else { return p.center() }
    p.setFrameOrigin(NSPoint(x: f.midX - p.frame.width / 2, y: f.midY - p.frame.height / 2 + f.height * 0.1))
  }

  /// Gives focus back to the app the owner was in.
  private func handBack() {
    previousApp?.activate()
    previousApp = nil
  }

  private func world() -> ComposeRefresh.World { ComposeRefresh.World(threads: web.threads, signedIn: web.signedIn, page: web.pageState) }

  /// An open panel follows the page: a new thread list, a sign-in, or the page going away and coming back reads it again. The page
  /// announces a change before it is made, so the check waits for the next turn of the run loop.
  private func watchWeb() {
    webWatch = web.objectWillChange.sink { [weak self] _ in DispatchQueue.main.async { MainActor.assumeIsolated { self?.followWeb() } } }
  }

  private func followWeb() {
    guard ComposeRefresh.needed(open: isVisible, shown: shownWorld, now: world()) else { return }
    // Reading rebuilds the picker: a draft keeps the thread it was written for, and so does the owner's pick in an empty box.
    rememberDraft()
    if (text?.string ?? "").isEmpty, let id = selectedThreadId() { requestedThread = id }
    refresh()
  }

  private func refresh() {
    shownWorld = world()
    let signed = web.signedIn
    composeStack?.isHidden = !signed
    signInStack?.isHidden = signed
    // Not signed in is three different things (audit D46): the owner is signed out, the page is still loading, or Talos can't be reached.
    switch web.pageState {
    case .unreachable: signInMessage?.stringValue = PageState.unreachableLine
    case .loading: signInMessage?.stringValue = "Connecting to Talos…"
    default: signInMessage?.stringValue = "Sign in first"
    }
    let hasDraft = !(text?.string ?? "").isEmpty
    // A kept draft wins: the pick stays on the thread the draft was written for. `requestedThread` only applies to an empty field.
    let last = (hasDraft ? draftThread : nil) ?? (hasDraft ? nil : requestedThread) ?? UserDefaults.standard.string(forKey: Self.lastThreadKey)
    shown = ComposeRules.order(web.threads, lastUsed: last)
    // One menu item per thread, carrying the thread id: items must never be looked up by title (equal names are normal).
    popup?.removeAllItems()
    for (t, label) in zip(shown, ComposeRules.labels(shown)) {
      let item = NSMenuItem(title: label, action: nil, keyEquivalent: "")
      item.representedObject = t.id
      popup?.menu?.addItem(item)
    }
    popup?.selectItem(at: 0)
    // A draft whose thread has left the list must not fall through to item 0: nothing is selected and Send is off.
    threadGone = false
    if hasDraft, let d = draftThread, !shown.contains(where: { $0.id == d }) {
      threadGone = true
      popup?.selectItem(at: -1)
    }
    var keeping: String?
    if !threadGone, hasDraft, let want = requestedThread, let d = draftThread, want != d, let i = shown.firstIndex(where: { $0.id == d }) {
      keeping = ComposeRules.labels(shown)[i]
    }
    let kept = ComposeStatus.eventKeptThroughRefresh(lastEvent, statusInputs(keeping: keeping))
    applyStatus(event: kept?.line, eventIsInfo: kept?.isInfo ?? false, keeping: keeping)
  }

  private func statusInputs(keeping: String?) -> ComposeStatus.Inputs {
    var i = ComposeStatus.Inputs()
    i.signedIn = web.signedIn
    i.hasThreads = !shown.isEmpty
    i.threadGone = threadGone
    i.sending = sending
    i.text = text?.string ?? ""
    i.lost = lost
    i.notTaken = notTaken
    i.keepingDraftFor = keeping
    return i
  }

  /// The line under the box and the Send switch, both from `ComposeStatus` so Send is never off without a reason on screen. `event`
  /// is what the last action said (a Send that sends nothing); what a sent message left behind is `lost` and `notTaken`.
  private func applyStatus(event: String? = nil, eventIsInfo: Bool = false, keeping: String? = nil) {
    lastEvent = event.map { ComposeStatus.Event(line: $0, isInfo: eventIsInfo) }
    let r = ComposeStatus.evaluate(statusInputs(keeping: keeping), event: event, eventIsInfo: eventIsInfo)
    status?.stringValue = r.line
    status?.textColor = r.info ? .secondaryLabelColor : .systemRed
    sendButton?.isEnabled = r.sendEnabled
  }

  /// Tests: what the picker and the status line say.
  var pickedThreadForTest: String? { selectedThreadId() }
  var statusForTest: String { status?.stringValue ?? "" }
  var signInMessageForTest: String { signInMessage?.stringValue ?? "" }
  var sendEnabledForTest: Bool { sendButton?.isEnabled ?? false }
  func setTextForTest(_ s: String) {
    if panel == nil { build() }
    text?.string = s
  }
  func resetForTest() {
    text?.string = ""
    draftThread = nil
    requestedThread = nil
    threadGone = false
    sending = false
    lost = false
    notTaken = false
    lastEvent = nil
    shownWorld = nil
    panel?.orderOut(nil)
  }
  var panelForTest: NSPanel? { panel }
  /// Tests: compose talks to this controller instead of the app's one.
  func useWebForTest(_ w: WebController) {
    web = w
    watchWeb()
  }
  /// Tests: forget the app that was in front, so a finished send does not activate the owner's app.
  func dropPreviousAppForTest() { previousApp = nil }
  var textForTest: String { text?.string ?? "" }
  var sendPressedForTest: () -> Void { { [weak self] in self?.sendPressed() } }
  /// Tests: Esc / Cancel, which keeps the draft and the thread it was written for.
  func cancelForTest() { cancelPressed() }

  private func build() {
    let p = Panel(
      contentRect: NSRect(x: 0, y: 0, width: 520, height: 260), styleMask: [.titled, .closable, .utilityWindow],
      backing: .buffered, defer: false)
    p.title = "Quick compose"
    p.level = .floating
    p.isReleasedWhenClosed = false
    p.hidesOnDeactivate = false
    p.delegate = self
    p.onEscape = { [weak self] in self?.cancelPressed() }
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

    let pop = NSPopUpButton(frame: .zero, pullsDown: false)
    pop.target = self
    pop.action = #selector(threadPicked)
    let tv = NSTextView(frame: NSRect(x: 0, y: 0, width: 480, height: 150))
    tv.isRichText = false
    tv.font = .systemFont(ofSize: 14)
    tv.isAutomaticQuoteSubstitutionEnabled = false
    tv.isAutomaticDashSubstitutionEnabled = false
    tv.allowsUndo = true
    tv.delegate = self
    tv.textContainerInset = NSSize(width: 6, height: 6)
    tv.autoresizingMask = [.width]
    let scroll = NSScrollView()
    scroll.documentView = tv
    scroll.hasVerticalScroller = true
    scroll.borderType = .bezelBorder
    scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 140).isActive = true

    let send = NSButton(title: "Send", target: self, action: #selector(sendPressed))
    send.keyEquivalent = "\r"
    send.keyEquivalentModifierMask = .command
    let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancelPressed))
    cancel.keyEquivalent = "\u{1b}"
    let row = NSStackView(views: [cancel, send])
    row.orientation = .horizontal
    let st = NSTextField(wrappingLabelWithString: "")
    st.textColor = .systemRed

    let compose = NSStackView(views: [pop, scroll, st, row])
    compose.orientation = .vertical
    compose.alignment = .trailing
    pop.widthAnchor.constraint(greaterThanOrEqualToConstant: 160).isActive = true
    compose.spacing = 8
    pop.setContentHuggingPriority(.defaultHigh, for: .vertical)
    scroll.widthAnchor.constraint(equalTo: compose.widthAnchor).isActive = true

    let msg = NSTextField(wrappingLabelWithString: "Sign in first")
    msg.font = .boldSystemFont(ofSize: 15)
    signInMessage = msg
    let open = NSButton(title: "Open Talos", target: self, action: #selector(openTalos))
    let signIn = NSStackView(views: [msg, open])
    signIn.orientation = .vertical
    signIn.alignment = .leading
    signIn.spacing = 12

    let root = NSStackView(views: [compose, signIn])
    root.orientation = .vertical
    root.alignment = .leading
    root.edgeInsets = NSEdgeInsets(top: 12, left: 16, bottom: 14, right: 16)
    p.contentView = root
    compose.translatesAutoresizingMaskIntoConstraints = false
    compose.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -32).isActive = true

    watchWeb()
    panel = p
    popup = pop
    text = tv
    status = st
    sendButton = send
    composeStack = compose
    signInStack = signIn
  }

  @objc private func openTalos() {
    panel?.orderOut(nil)
    web.show()
  }

  private func selectedThreadId() -> String? { popup?.selectedItem?.representedObject as? String }

  @objc private func cancelPressed() {
    rememberDraft()
    panel?.orderOut(nil)
    handBack()
  }

  /// Nothing selected (the draft's thread left the list) must not erase which thread the draft was written for: the next open
  /// would otherwise treat it as a draft with no thread and fall through to item 0 with Send on.
  private func rememberDraft() { draftThread = (text?.string ?? "").isEmpty ? nil : (selectedThreadId() ?? draftThread) }

  /// The owner picked a thread by hand. In the "that thread is gone" state this is the way out: the draft now belongs to the
  /// thread they chose, and Send comes back.
  @objc private func threadPicked() {
    guard threadGone, let id = selectedThreadId() else { return }
    threadGone = false
    draftThread = id
    applyStatus()
  }
  var threadGoneForTest: Bool { threadGone }
  /// Tests: the same thing the popup does when the owner picks an item.
  func pickThreadForTest(_ id: String) {
    guard let i = popup?.menu?.items.firstIndex(where: { ($0.representedObject as? String) == id }) else { return }
    popup?.selectItem(at: i)
    if let pop = popup, let action = pop.action { _ = NSApp.sendAction(action, to: pop.target, from: pop) }  // the real action path
  }

  @objc private func sendPressed() {
    guard !sending else { return }  // the page has not answered the last one; the page cannot tell a repeat from a new message
    let id = selectedThreadId()
    switch ComposeRules.check(text: text?.string ?? "", threadId: id, known: web.threads.map(\.id)) {
    // A Send that sends nothing says why, in front of the warning that the last message may already have gone.
    case .failure(.empty): applyStatus(event: ComposeStatus.emptyLine)
    case .failure(.tooLong): applyStatus(event: ComposeStatus.tooLongLine)
    case .failure(.unknownThread): applyStatus(event: ComposeStatus.pickLine)
    case .success(let m):
      guard web.signedIn else { refresh(); return }
      UserDefaults.standard.set(m.thread, forKey: Self.lastThreadKey)
      notTaken = false  // an earlier message may still have gone: `lost` stays, so a Send that is not taken does not wipe that warning
      sending = true
      applyStatus()
      // The text stays until the page says it took the message: nothing is cleared on hand-off.
      let sent = m.text  // what went out, trimmed: the box is compared with this, not with the raw box
      web.sendAcknowledged(.compose(threadId: m.thread, text: m.text)) { [weak self] ack in
        guard let self else { return }
        self.sending = false
        switch ack {
        case .notTaken:
          self.notTaken = true
          self.applyStatus()
        case .lost:
          // The page may have saved it before it went away, so this does not invite a plain retry.
          self.lost = true
          self.notTaken = false
          self.applyStatus()
        case .taken:
          self.lost = false
          self.notTaken = false
          self.finishSent(sent)
        }
      }
    }
  }

  /// The page took `sent`. The owner may have kept typing while it worked: only what was sent leaves, and a box that holds
  /// anything else is never cut (`ComposeRules.boxAfterSend`).
  private func finishSent(_ sent: String) {
    if let keep = ComposeRules.boxAfterSend(box: text?.string ?? "", sent: sent) {
      text?.string = keep
      applyStatus(event: "Sent. Your newer text is kept.", eventIsInfo: true)
      return
    }
    text?.string = ""
    draftThread = nil
    applyStatus()
    panel?.orderOut(nil)
    handBack()
  }

  func windowWillClose(_ notification: Notification) { rememberDraft() }

  func textDidChange(_ notification: Notification) {
    // The line follows the text: a reason left from a refused Send and "didn't take that" are gone, the reason Send is off stays, and
    // so does the "went away" warning while there is text it is about.
    notTaken = false
    if (text?.string ?? "").isEmpty { lost = false }  // the warning is about text: with the box emptied by hand it is over
    applyStatus()
  }
}
