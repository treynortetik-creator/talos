import AppKit
import TalosDesktopCore
import TalosSupervisor

/// Needs-you prompts, the Mac popup: the window (docs/OPTION-C.md "Needs-you prompts: the Mac side, as built"). What it says and when is
/// `NeedsYouPopupCoordinator` (Core); what a click does is `WorkerManager.popupAnswer` (Supervisor). This file only draws and positions.
///
/// SAFETY: a popup must never be answered by a stray keystroke. The panel is `.nonactivatingPanel` (set in the initializer), can never become key
/// or main (so showing it takes no focus and a key goes to whatever the owner is typing in), has no default button and no key equivalent on any
/// button, and eats any key event it is somehow sent: keys never reach it (it is never key), so Esc does nothing either. The close button
/// only hides it. A real click on an answer button is the only way to answer (`NeedsYouPopupView.isRealClick`).
final class NeedsYouPanel: NSPanel {
  init(size: CGSize) {
    super.init(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    level = .floating
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = true
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isMovable = false
    canHide = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    sharingType = .none  // a folder path and a thread name: out of screenshots and screen shares, as the other panels do (a request, not a guarantee)
    defaultButtonCell = nil
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func keyDown(with event: NSEvent) {}
  override func performKeyEquivalent(with event: NSEvent) -> Bool { false }
}

/// One answer button: a rounded line in the panel's cream on its dark ground; wraps long labels (the longest real row is 56 characters).
private final class PopupButtonCell: NSButtonCell {
  override func titleRect(forBounds rect: NSRect) -> NSRect { rect.insetBy(dx: 12, dy: 8) }
}

final class PopupAnswerButton: NSButton {
  static let font = NSFont.systemFont(ofSize: 13, weight: .medium)
  private let width: CGFloat

  init(text: String, width: CGFloat, tag: Int, enabled: Bool) {
    self.width = width
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 36))
    cell = PopupButtonCell()
    self.tag = tag
    isBordered = false
    isEnabled = enabled
    keyEquivalent = ""  // never Return, never Esc
    wantsLayer = true
    (cell as? NSButtonCell)?.wraps = true
    (cell as? NSButtonCell)?.lineBreakMode = .byWordWrapping
    let p = NSMutableParagraphStyle()
    p.alignment = .left
    p.lineBreakMode = .byWordWrapping
    attributedTitle = NSAttributedString(
      string: text, attributes: [.font: Self.font, .foregroundColor: CompanionColors.cream.withAlphaComponent(enabled ? 1 : 0.5), .paragraphStyle: p])
    setAccessibilityRole(.button)
    setAccessibilityLabel(text)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override var intrinsicContentSize: NSSize {
    let r = (title as NSString).boundingRect(
      with: NSSize(width: width - 24, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], attributes: [.font: Self.font])
    return NSSize(width: width, height: ceil(r.height) + 16)
  }

  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75), xRadius: 8, yRadius: 8)
    (isHighlighted ? CompanionColors.cream.withAlphaComponent(0.18) : CompanionColors.cream.withAlphaComponent(0.06)).setFill()
    path.fill()
    CompanionColors.cream.withAlphaComponent(0.55).setStroke()
    path.lineWidth = 1.5
    path.stroke()
    super.draw(dirtyRect)
  }
}

/// The popup's content: header, title, the folder or server, one sentence, the answers, the footer.
final class NeedsYouPopupView: NSView {
  static let width: CGFloat = 380
  private let inner: CGFloat = 380 - 32
  private let onClick: (Int) -> Void
  private let onClose: () -> Void
  private let currentEvent: () -> NSEvent?

  /// `currentEvent` is the event the app is handling when a button's action runs (`NSApp.currentEvent`); tests bring their own.
  init(
    popup: NeedsYouPopupCoordinator.Popup, onClick: @escaping (Int) -> Void, onClose: @escaping () -> Void,
    currentEvent: @escaping () -> NSEvent? = { NSApp.currentEvent }
  ) {
    self.onClick = onClick
    self.onClose = onClose
    self.currentEvent = currentEvent
    super.init(frame: .zero)
    let c = popup.content
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 10
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16), stack.topAnchor.constraint(equalTo: topAnchor, constant: 14),
      stack.widthAnchor.constraint(equalToConstant: inner),
    ])

    // header: the Talos icon, "Talos · <thread> needs you", and the close button
    let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
    icon.imageScaling = .scaleProportionallyUpOrDown
    icon.widthAnchor.constraint(equalToConstant: 20).isActive = true
    icon.heightAnchor.constraint(equalToConstant: 20).isActive = true
    let header = label(c.header, size: 12, weight: .medium, alpha: 0.75)
    header.lineBreakMode = .byTruncatingTail
    header.maximumNumberOfLines = 1
    let close = FirstMouseButton(title: "✕", target: self, action: #selector(closeClicked))
    close.tag = -1
    close.isBordered = false
    close.keyEquivalent = ""
    close.attributedTitle = NSAttributedString(string: "✕", attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: CompanionColors.cream.withAlphaComponent(0.75)])
    close.setAccessibilityLabel("Hide this popup")
    close.toolTip = "Hide this popup. Nothing is pressed; it is still on your phone."
    let row = NSStackView(views: [icon, header, close])
    row.orientation = .horizontal
    row.spacing = 8
    row.alignment = .centerY
    row.distribution = .fill
    header.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    close.setContentHuggingPriority(.required, for: .horizontal)
    stack.addArrangedSubview(row)
    row.widthAnchor.constraint(equalToConstant: inner).isActive = true

    stack.addArrangedSubview(label(c.title, size: 16, weight: .semibold, alpha: 1))
    if let subject = c.subject {
      let box = NSView()
      box.wantsLayer = true
      box.layer?.backgroundColor = CompanionColors.cream.withAlphaComponent(0.08).cgColor
      box.layer?.cornerRadius = 6
      let mono = label(subject, size: 12, weight: .regular, alpha: 1, mono: true)
      mono.translatesAutoresizingMaskIntoConstraints = false
      box.addSubview(mono)
      NSLayoutConstraint.activate([
        mono.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 10), mono.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -10),
        mono.topAnchor.constraint(equalTo: box.topAnchor, constant: 7), mono.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -7),
      ])
      box.translatesAutoresizingMaskIntoConstraints = false
      stack.addArrangedSubview(box)
      box.widthAnchor.constraint(equalToConstant: inner).isActive = true
    }
    stack.addArrangedSubview(label(c.sentence, size: 12, weight: .regular, alpha: 0.85))

    switch popup.phase {
    case .asking, .working:
      for (i, b) in c.buttons.enumerated() {
        let btn = PopupAnswerButton(text: b.text, width: inner, tag: i, enabled: popup.phase == .asking)
        btn.target = self
        btn.action = #selector(answerClicked(_:))
        stack.addArrangedSubview(btn)
      }
      if popup.phase == .working { stack.addArrangedSubview(label("Working on it…", size: 12, weight: .medium, alpha: 0.85)) }
    case .failed(let words):
      stack.addArrangedSubview(label(words, size: 13, weight: .medium, alpha: 1))
    }
    stack.addArrangedSubview(label(c.footer, size: 11, weight: .regular, alpha: 0.6))

    layoutSubtreeIfNeeded()
    setFrameSize(NSSize(width: Self.width, height: ceil(stack.fittingSize.height) + 28))
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight, alpha: CGFloat, mono: Bool = false) -> NSTextField {
    let t = NSTextField(wrappingLabelWithString: text)
    t.font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
    t.textColor = CompanionColors.cream.withAlphaComponent(alpha)
    t.preferredMaxLayoutWidth = inner - (mono ? 20 : 0)
    t.isSelectable = false
    return t
  }

  /// Whether this action is the owner's own click on this button: the event the app is handling is a left mouse button event, a moment old at
  /// most, in this button's window and on the button. WHY: an Accessibility press (VoiceOver, another app driving the UI) or an AppleScript
  /// click reaches the same action method but sends no mouse event, so `NSApp.currentEvent` is nil or something that has nothing to do with
  /// this button. Only the owner's hand at the Mac may answer; a program that can press a button for him may not.
  static func isRealClick(_ event: NSEvent?, on button: NSButton, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
    guard let e = event else { return false }
    let kind: PopupClickCheck.Kind = e.type == .leftMouseUp ? .leftMouseUp : e.type == .leftMouseDown ? .leftMouseDown : .other
    return PopupClickCheck.isRealClick(
      kind: kind, age: now - e.timestamp, sameWindow: button.window.map { $0.windowNumber == e.windowNumber } ?? false,
      onButton: button.bounds.contains(button.convert(e.locationInWindow, from: nil)))
  }

  @objc private func answerClicked(_ sender: NSButton) {
    guard Self.isRealClick(currentEvent(), on: sender) else { return }
    onClick(sender.tag)
  }
  @objc private func closeClicked() { onClose() }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }
  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 12, yRadius: 12)
    CompanionColors.ground.setFill()
    path.fill()
    CompanionColors.cream.withAlphaComponent(0.4).setStroke()
    path.lineWidth = 1
    path.stroke()
  }
}

/// Keeps one panel per popup the coordinator says is on the screen. A popup is put on the screen once (when it first appears, or when what it
/// says changes); it is never made key and never activates the app.
@MainActor
final class NeedsYouPopupController {
  /// Tests replace this so no panel is shown.
  var orderFront: (NSPanel) -> Void = { $0.orderFrontRegardless() }
  private let coordinator: NeedsYouPopupCoordinator
  private(set) var panels: [String: NeedsYouPanel] = [:]
  /// What each panel shows now.
  private struct Shown: Equatable {
    var content: NeedsYouPopupContent
    var phase: NeedsYouPopupCoordinator.Phase
  }
  private var shown: [String: Shown] = [:]
  private var timer: Timer?

  init(coordinator: NeedsYouPopupCoordinator) { self.coordinator = coordinator }

  /// The live wiring: the manager's offers, the status coordinator's quiet hours, and the manager's answer to a click.
  convenience init(source workers: NeedsYouPopupSource, quiet: @escaping () -> Bool?, interval: TimeInterval = 0.5) {
    let c = NeedsYouPopupCoordinator(
      offers: { workers.popupOffers() }, quiet: quiet, now: { Double(DispatchTime.now().uptimeNanoseconds) / 1e9 },
      answer: { thread, id, action, done in
        let back = MainBox(done)
        workers.popupAnswer(thread: thread, dialogId: id, action: action) { r in DispatchQueue.main.async { back.value(r) } }
      })
    self.init(coordinator: c)
    timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
      // the timer fires on the main run loop: no hop through a task, which would also wait for whatever holds the main actor
      MainActor.assumeIsolated { self?.tick() }
    }
  }

  /// The event a button's action is judged by (a real click). Tests bring their own.
  var currentEvent: () -> NSEvent? = { NSApp.currentEvent }

  func stop() {
    timer?.invalidate()
    timer = nil
  }

  /// The quiet decision the popup follows: the status coordinator's (nil until the bridge has been read).
  static func statusQuiet() -> Bool? { StatusCoordinator.shared.quietNow }

  func tick() {
    let popups = coordinator.refresh()
    let ids = Set(popups.map(\.item.dialog.id))
    for (id, p) in panels where !ids.contains(id) {
      p.orderOut(nil)
      panels[id] = nil
      shown[id] = nil
    }
    var fresh: [NeedsYouPanel] = []
    for p in popups {
      let id = p.item.dialog.id
      // a popup is rebuilt only when what it says changes (not for the dialog's cursor row)
      if shown[id] == Shown(content: p.content, phase: p.phase), panels[id] != nil { continue }
      let panel = Self.makePanel(
        for: p,
        onClick: { [weak self] i in
          self?.coordinator.click(dialogId: id, button: i)
          self?.tick()
        },
        onClose: { [weak self] in
          self?.coordinator.hide(dialogId: id)
          self?.tick()
        },
        currentEvent: { [weak self] in self?.currentEvent() })
      panels[id]?.orderOut(nil)
      panels[id] = panel
      shown[id] = Shown(content: p.content, phase: p.phase)
      fresh.append(panel)
    }
    place(popups.map(\.item.dialog.id), fresh: fresh)
    for panel in fresh { orderFront(panel) }  // after it stands where it belongs: none flashes at the bottom left
  }

  /// Top right of the main screen, stacked downward, the oldest on top. A popup that was already up and now stands somewhere else (the one
  /// above it closed or grew) has its first-moment click delay restarted: the next click is not for it.
  private func place(_ order: [String], fresh: [NeedsYouPanel]) {
    let area = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    var top = area.maxY - 16
    for id in order {
      guard let panel = panels[id] else { continue }
      let h = panel.frame.height
      let target = NSPoint(x: area.maxX - panel.frame.width - 16, y: top - h)
      if panel.frame.origin != target {
        panel.setFrameOrigin(target)
        if !fresh.contains(where: { $0 === panel }) { coordinator.rearm(dialogId: id) }
      }
      top -= h + 12
    }
  }

  static func makePanel(
    for popup: NeedsYouPopupCoordinator.Popup, onClick: @escaping (Int) -> Void, onClose: @escaping () -> Void,
    currentEvent: @escaping () -> NSEvent? = { NSApp.currentEvent }
  ) -> NeedsYouPanel {
    let view = NeedsYouPopupView(popup: popup, onClick: onClick, onClose: onClose, currentEvent: currentEvent)
    let panel = NeedsYouPanel(size: view.frame.size)
    panel.contentView = view
    return panel
  }
}

/// Carries the coordinator's `done` across to the main queue. It is only ever called there.
private final class MainBox<T>: @unchecked Sendable {
  let value: (T) -> Void
  init(_ v: @escaping (T) -> Void) { value = v }
}
