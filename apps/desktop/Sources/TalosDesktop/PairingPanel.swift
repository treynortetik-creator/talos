import AppKit
import Combine
import TalosDesktopCore

/// The app's own sign-in window: the four words with "The words match" and "They don't match". It is a prompt window (`SyntheticInputGuard`), built
/// like the needs-you popup (`NeedsYouPanel`): a non-activating panel that can never become key or main, so showing it takes no focus from what
/// the owner is typing in and a key goes nowhere near it; it has no default button and no key equivalent, and eats any key it is somehow sent.
/// "The words match" is answered only by a real click on the button (`PairingController.approve`): an agent's synthetic Return or click, an
/// Accessibility press or AppleScript approve nothing. It is out of screenshots (the four words are on it).
@MainActor
final class PairingPanel: NSPanel, NSWindowDelegate {
  private weak var controller: PairingController?
  private var bag = Set<AnyCancellable>()
  private var secretNumber: UInt32?
  /// The event the app is handling when a button's action runs; tests bring their own.
  var handlingEvent: () -> NSEvent? = { NSApp.currentEvent }
  private(set) var approveButton: NSButton?
  private(set) var declineButton: NSButton?
  private(set) var wordLabels: [NSTextField] = []

  init(controller: PairingController) {
    self.controller = controller
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 240), styleMask: [.titled, .closable, .nonactivatingPanel],
      backing: .buffered, defer: false)
    title = "Sign this Mac in"
    isFloatingPanel = true
    becomesKeyOnlyIfNeeded = true
    level = .floating
    hidesOnDeactivate = false
    canHide = false
    isReleasedWhenClosed = false
    animationBehavior = .none
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    sharingType = .none
    defaultButtonCell = nil
    delegate = self
    center()
    // A new phase redraws; the 0.7 s enable only flips the button in place, so a click already in flight is not lost to a rebuild.
    controller.$phase.removeDuplicates().receive(on: DispatchQueue.main).sink { [weak self] _ in self?.render() }.store(in: &bag)
    controller.$confirmEnabled.removeDuplicates().receive(on: DispatchQueue.main)
      .sink { [weak self] on in self?.approveButton?.isEnabled = on }.store(in: &bag)
    render()
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
  override func keyDown(with event: NSEvent) {}
  override func performKeyEquivalent(with event: NSEvent) -> Bool { false }

  /// The title-bar X: before the owner confirmed it is "They don't match" (decline and end); after, it only hides the window.
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    controller?.closeWindow()
    return false
  }

  /// In front of the Talos window, over every Space's app, with no activation and no key (so nothing the owner types lands here).
  static func bringToFront(_ p: NSPanel) {
    p.orderFrontRegardless()
    (p as? PairingPanel)?.hideFromCapture()
  }

  /// Registers this window's number with `ScreenSecretWindows` (what `ScreenCore` reads at capture time), as the Terminals window does.
  func hideFromCapture() {
    guard windowNumber > 0 else { return }
    if let old = secretNumber, old != UInt32(windowNumber) { ScreenSecretWindows.set(old, hidden: false) }
    secretNumber = UInt32(windowNumber)
    ScreenSecretWindows.set(UInt32(windowNumber), hidden: true)
  }

  override func close() {
    if let n = secretNumber { ScreenSecretWindows.set(n, hidden: false) }
    secretNumber = nil
    super.close()
  }

  override func orderOut(_ sender: Any?) {
    if let n = secretNumber { ScreenSecretWindows.set(n, hidden: false) }
    secretNumber = nil
    super.orderOut(sender)
  }

  // MARK: drawing

  private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
    let t = NSTextField(wrappingLabelWithString: text)
    t.font = .systemFont(ofSize: size, weight: weight)
    t.textColor = secondary ? .secondaryLabelColor : .labelColor
    t.isSelectable = false
    t.preferredMaxLayoutWidth = 400
    return t
  }

  private func button(_ title: String, action: Selector, enabled: Bool = true) -> NSButton {
    // A FirstMouseButton: this panel is never key and the app is often not active, so the first click must press the button, not just activate
    let b = FirstMouseButton(title: title, target: self, action: action)
    b.bezelStyle = .rounded
    b.isEnabled = enabled
    b.keyEquivalent = ""  // never Return, never Esc
    return b
  }

  func render() {
    guard let c = controller else { return }
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 12
    stack.edgeInsets = NSEdgeInsets(top: 16, left: 20, bottom: 16, right: 20)
    approveButton = nil
    declineButton = nil
    wordLabels = []
    func row(_ views: [NSView]) -> NSStackView {
      let r = NSStackView(views: views)
      r.orientation = .horizontal
      r.spacing = 8
      return r
    }
    switch c.phase {
    case .idle, .starting:
      stack.addArrangedSubview(label("Starting the sign-in\u{2026}", secondary: true))
      stack.addArrangedSubview(row([button("Cancel", action: #selector(cancelTapped)), button("Show details", action: #selector(detailsTapped))]))
    case .waiting:
      stack.addArrangedSubview(label("Sent to the Talos window. Waiting for it to show four words\u{2026}"))
      stack.addArrangedSubview(row([button("Cancel", action: #selector(cancelTapped)), button("Show details", action: #selector(detailsTapped))]))
    case .confirm(let words):
      stack.addArrangedSubview(label("Check that the Talos window shows these words:", size: 14, weight: .semibold))
      let chips = words.map { w -> NSTextField in
        let t = NSTextField(labelWithString: w)
        t.font = .systemFont(ofSize: 15, weight: .semibold)
        t.alignment = .center
        t.wantsLayer = true
        t.layer?.cornerRadius = 10
        t.layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.15).cgColor
        t.translatesAutoresizingMaskIntoConstraints = false
        t.widthAnchor.constraint(equalToConstant: 92).isActive = true
        t.heightAnchor.constraint(equalToConstant: 36).isActive = true
        return t
      }
      wordLabels = chips
      stack.addArrangedSubview(row(chips))
      let no = button("They don't match", action: #selector(declineTapped))
      let yes = button("The words match", action: #selector(approveTapped), enabled: c.confirmEnabled)
      yes.setAccessibilityElement(false)  // an Accessibility press must not approve (the click check refuses it too)
      declineButton = no
      approveButton = yes
      stack.addArrangedSubview(row([button("Show details", action: #selector(detailsTapped)), no, yes]))
    case .mismatch:
      stack.addArrangedSubview(label("Nothing was connected. Make a new code and try again."))
      stack.addArrangedSubview(row([button("Close", action: #selector(closeTapped)), button("Make a new code", action: #selector(newCodeTapped))]))
    case .done(let m):
      stack.addArrangedSubview(label(m))
      stack.addArrangedSubview(row([button("Close", action: #selector(closeTapped))]))
    case .failed(let m):
      stack.addArrangedSubview(label(m))
      stack.addArrangedSubview(row([button("Close", action: #selector(closeTapped)), button("Make a new code", action: #selector(newCodeTapped))]))
    }
    stack.setAccessibilityElement(false)
    contentView = stack
    let size = stack.fittingSize
    setContentSize(NSSize(width: max(440, size.width), height: size.height))
  }

  // MARK: actions
  @objc private func approveTapped(_ sender: NSButton) { _ = controller?.approve(clickedBy: handlingEvent(), on: sender) }
  @objc private func declineTapped() { controller?.mismatch() }
  @objc private func cancelTapped() { controller?.cancel() }
  @objc private func closeTapped() { controller?.closeWindow() }
  @objc private func newCodeTapped() { controller?.newCode() }
  @objc private func detailsTapped() { controller?.showDetails() }
}
