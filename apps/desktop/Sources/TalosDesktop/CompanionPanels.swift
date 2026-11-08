import AppKit
import TalosDesktopCore

/// Every companion window is this: a borderless, non-activating panel that is never key and never main, on every Space, over
/// full-screen apps (spec 3.1). Showing one never activates the app, so it can't take focus from what the owner is typing in.
///
/// `sharing` is `.none` unless a caller says otherwise: a panel asks macOS to stay out of screenshots and screen shares, because the
/// bubble, controls, tray and reply card can carry thread names and reply text. That is a request, not a guarantee, and nothing
/// relies on it (a mirrored display shows the panel). Only the character's own panel is `.readOnly` (owner's yes 2026-11-01,
/// spec 3.1): he is meant to show in a screenshot or a share.
final class CompanionPanel: NSPanel {
  init(size: CGSize, sharing: NSWindow.SharingType = .none) {
    // styleMask goes in the initializer: assigning .nonactivatingPanel later doesn't take (spec 3.1).
    super.init(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    isFloatingPanel = true
    level = .floating
    hidesOnDeactivate = false
    isOpaque = false
    backgroundColor = .clear
    hasShadow = false
    collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    isMovable = false  // dragging sets the frame
    canHide = false  // Hide Others (option-cmd-H) must not take him: nothing would bring him back
    isReleasedWhenClosed = false  // the default over-releases under ARC
    animationBehavior = .none
    sharingType = sharing  // set, never relied on: .none for everything that can show text, .readOnly for the sprite alone
  }

  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

/// A button that works on the first click even though the app is never active (spec 3.1).
final class FirstMouseButton: NSButton {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

enum CompanionColors {
  /// Bubble ground and text: the same in light and dark (spec 3.4). Contrast is measured in a test. Cream is the brand's
  /// `--talos-cream` (apps/web/src/theme/tokens.css), and a test reads that file so the two cannot drift.
  static let ground = NSColor(srgbRed: 0x14 / 255.0, green: 0x11 / 255.0, blue: 0x10 / 255.0, alpha: 1)
  static let cream = NSColor(srgbRed: 0xF3 / 255.0, green: 0xE6 / 255.0, blue: 0xCF / 255.0, alpha: 1)

  /// WCAG relative luminance contrast of two sRGB colors.
  static func contrast(_ a: NSColor, _ b: NSColor) -> Double {
    func lum(_ c: NSColor) -> Double {
      let s = c.usingColorSpace(.sRGB) ?? c
      func ch(_ v: CGFloat) -> Double {
        let x = Double(v)
        return x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4)
      }
      return 0.2126 * ch(s.redComponent) + 0.7152 * ch(s.greenComponent) + 0.0722 * ch(s.blueComponent)
    }
    let (l1, l2) = (lum(a), lum(b))
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)
  }
}

/// The bubble: black ground, cream text, a 1.5 px cream inner line, system font, one line (spec 3.4).
final class CompanionBubbleView: NSView {
  private let label = NSTextField(labelWithString: "")
  var onClick: (() -> Void)?
  var onHoverChanged: ((Bool) -> Void)?
  private var tracking: NSTrackingArea?

  static let font = NSFont.systemFont(ofSize: 12, weight: .medium)

  override init(frame: NSRect) {
    super.init(frame: frame)
    label.font = Self.font
    label.textColor = CompanionColors.cream
    label.lineBreakMode = .byTruncatingTail
    label.maximumNumberOfLines = 1
    label.alignment = .center
    addSubview(label)
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  var text: String {
    get { label.stringValue }
    set {
      label.stringValue = newValue
      setAccessibilityLabel(newValue)
    }
  }

  static func width(of text: String) -> CGFloat {
    ceil((text as NSString).size(withAttributes: [.font: font]).width)
  }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }
  override func layout() {
    super.layout()
    let h = label.intrinsicContentSize.height
    label.frame = NSRect(x: 10, y: (bounds.height - h) / 2, width: bounds.width - 20, height: h)
  }

  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8)
    CompanionColors.ground.setFill()
    path.fill()
    let inner = NSBezierPath(roundedRect: bounds.insetBy(dx: 2.5, dy: 2.5), xRadius: 6, yRadius: 6)
    CompanionColors.cream.setStroke()
    inner.lineWidth = 1.5
    inner.stroke()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect], owner: self, userInfo: nil)
    addTrackingArea(t)
    tracking = t
  }
  override func mouseEntered(with event: NSEvent) { onHoverChanged?(true) }
  override func mouseExited(with event: NSEvent) { onHoverChanged?(false) }
  override func mouseUp(with event: NSEvent) { onClick?() }
}

/// Hover controls: the word line above Compose, the status list (with a count) and Open Talos.
final class CompanionControlsView: NSView {
  let wordLabel = NSTextField(labelWithString: "")
  let composeButton: FirstMouseButton
  let openButton: FirstMouseButton
  let statusButton: FirstMouseButton
  private let countLabel = NSTextField(labelWithString: "")
  var onCompose: (() -> Void)?
  var onStatus: (() -> Void)?
  var onOpen: (() -> Void)?
  var onHoverChanged: ((Bool) -> Void)?
  private var tracking: NSTrackingArea?

  override init(frame: NSRect) {
    composeButton = FirstMouseButton(title: "", target: nil, action: nil)
    openButton = FirstMouseButton(title: "", target: nil, action: nil)
    statusButton = FirstMouseButton(title: "", target: nil, action: nil)
    super.init(frame: frame)
    wordLabel.font = .systemFont(ofSize: 11, weight: .medium)
    wordLabel.textColor = CompanionColors.cream
    wordLabel.alignment = .center
    wordLabel.lineBreakMode = .byTruncatingTail
    for (b, name, label) in [
      (composeButton, "square.and.pencil", "Compose a message"), (statusButton, "list.bullet", "Status list"),
      (openButton, "arrow.up.forward.app", "Open Talos"),
    ] {
      b.image = NSImage(systemSymbolName: name, accessibilityDescription: label)
      b.imagePosition = .imageOnly
      b.isBordered = false
      b.contentTintColor = CompanionColors.cream
      b.setAccessibilityLabel(label)
      b.toolTip = label
      b.focusRingType = .default
      addSubview(b)
    }
    composeButton.target = self
    composeButton.action = #selector(composeTapped)
    statusButton.target = self
    statusButton.action = #selector(statusTapped)
    openButton.target = self
    openButton.action = #selector(openTapped)
    countLabel.font = .systemFont(ofSize: 10, weight: .bold)
    countLabel.textColor = CompanionColors.cream
    countLabel.alignment = .right
    countLabel.isHidden = true
    addSubview(countLabel)
    addSubview(wordLabel)
    setAccessibilityElement(false)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  @objc private func composeTapped() { onCompose?() }
  @objc private func openTapped() { onOpen?() }
  @objc private func statusTapped() { onStatus?() }

  /// How many things are on the list (the rows): shown beside the icon, and read by VoiceOver.
  var statusCount = 0 {
    didSet {
      countLabel.stringValue = statusCount > 0 ? String(min(statusCount, 99)) : ""
      countLabel.isHidden = statusCount == 0
      let label = statusCount > 0 ? "Status list, \(min(statusCount, 99))" : "Status list"
      statusButton.setAccessibilityLabel(label)
      statusButton.toolTip = label
    }
  }

  override func layout() {
    super.layout()
    // Three 44 pt targets.
    let b: CGFloat = 44
    let gap: CGFloat = 8
    let total = b * 3 + gap * 2
    let x0 = (bounds.width - total) / 2
    composeButton.frame = NSRect(x: x0, y: 4, width: b, height: b)
    statusButton.frame = NSRect(x: x0 + b + gap, y: 4, width: b, height: b)
    openButton.frame = NSRect(x: x0 + 2 * (b + gap), y: 4, width: b, height: b)
    countLabel.frame = NSRect(x: statusButton.frame.maxX - 16, y: statusButton.frame.maxY - 16, width: 14, height: 12)
    wordLabel.frame = NSRect(x: 8, y: b + 10, width: bounds.width - 16, height: 16)
  }

  override func draw(_ dirtyRect: NSRect) {
    let path = NSBezierPath(roundedRect: bounds, xRadius: 10, yRadius: 10)
    CompanionColors.ground.setFill()
    path.fill()
    CompanionColors.cream.setStroke()
    let inner = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 9, yRadius: 9)
    inner.lineWidth = 1.5
    inner.stroke()
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let t = tracking { removeTrackingArea(t) }
    let t = NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect], owner: self, userInfo: nil)
    addTrackingArea(t)
    tracking = t
  }
  override func mouseEntered(with event: NSEvent) { onHoverChanged?(true) }
  override func mouseExited(with event: NSEvent) { onHoverChanged?(false) }
}
