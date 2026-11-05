import AppKit
import TalosDesktopCore

/// The status list under his hover controls, and the reply card a click on a "New reply" bubble opens (DESKTOP-COMPANION-SPEC
/// 3.1, 4). Both are AppKit views in a never-key `CompanionPanel`: the app is never active, so they take no focus. The rows come
/// from `CompanionTray.build`; nothing here decides what a row says.

/// One row: the thread's label and its state word. A button to VoiceOver, a first-click target for the mouse.
final class CompanionTrayRowView: NSView {
  let row: CompanionTray.Row
  var onClick: ((CompanionTray.Row) -> Void)?
  private let title = NSTextField(labelWithString: "")
  private let word = NSTextField(labelWithString: "")

  init(row: CompanionTray.Row, width: CGFloat, dimmed: Bool) {
    self.row = row
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: CompanionTrayView.rowHeight))
    title.stringValue = row.title
    title.font = .systemFont(ofSize: 12, weight: .medium)
    title.textColor = CompanionColors.cream
    title.lineBreakMode = .byTruncatingTail
    word.stringValue = row.word
    word.font = .systemFont(ofSize: 11)
    word.textColor = CompanionColors.cream.withAlphaComponent(0.78)
    word.alignment = .right
    word.lineBreakMode = .byTruncatingTail
    addSubview(title)
    addSubview(word)
    alphaValue = dimmed ? 0.55 : 1
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel("\(row.title), \(row.word.lowercased())")
    toolTip = "\(row.title), \(row.word.lowercased())"
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }
  override func layout() {
    super.layout()
    let wordW = min(112, ceil((word.stringValue as NSString).size(withAttributes: [.font: word.font as Any]).width) + 4)
    let h: CGFloat = 16
    let y = (bounds.height - h) / 2
    word.frame = NSRect(x: bounds.width - 12 - wordW, y: y, width: wordW, height: h)
    title.frame = NSRect(x: 12, y: y, width: max(0, bounds.width - 24 - wordW - 6), height: h)
  }
  override func mouseUp(with event: NSEvent) {
    if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?(row) }
  }
  override func accessibilityPerformPress() -> Bool {
    onClick?(row)
    return true
  }
}

/// A plain text button in the cream-on-black look (Open Talos, "+N more").
final class CompanionLinkView: NSView {
  var onClick: (() -> Void)?
  private let label = NSTextField(labelWithString: "")

  init(text: String, width: CGFloat, height: CGFloat) {
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: height))
    label.stringValue = text
    label.font = .systemFont(ofSize: 12, weight: .semibold)
    label.textColor = CompanionColors.cream
    label.alignment = .center
    addSubview(label)
    setAccessibilityElement(true)
    setAccessibilityRole(.button)
    setAccessibilityLabel(text)
  }
  required init?(coder: NSCoder) { fatalError("not used") }
  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }
  override func layout() {
    super.layout()
    label.frame = NSRect(x: 0, y: (bounds.height - 16) / 2, width: bounds.width, height: 16)
  }
  override func draw(_ dirtyRect: NSRect) {
    let p = NSBezierPath(roundedRect: bounds.insetBy(dx: 12, dy: 2), xRadius: 6, yRadius: 6)
    CompanionColors.cream.setStroke()
    p.lineWidth = 1
    p.stroke()
  }
  override func mouseUp(with event: NSEvent) {
    if bounds.contains(convert(event.locationInWindow, from: nil)) { onClick?() }
  }
  override func accessibilityPerformPress() -> Bool {
    onClick?()
    return true
  }
}

/// The status list: 280 pt wide, at most 8 rows, then "+N more" (spec 4.1). Loading, empty, failed and dimmed states are the
/// `CompanionTray` value's: this view draws what it is given.
final class CompanionTrayView: NSView {
  static let rowHeight: CGFloat = 32
  static let lineHeight: CGFloat = 26
  static let pad: CGFloat = 8
  static let buttonHeight: CGFloat = 34

  var onRow: ((CompanionTray.Row) -> Void)?
  var onMore: (() -> Void)?
  var onOpenTalos: (() -> Void)?
  private(set) var current = CompanionTray()
  private(set) var rowViews: [CompanionTrayRowView] = []
  /// Hello's still frame, drawn above "All quiet." (spec 4.2). Set by the controller from the atlas.
  var still: CGImage? {
    didSet {
      if (still == nil) != (oldValue == nil) { applied = false }
      needsDisplay = true
    }
  }
  private var applied = false
  private var height: CGFloat = 0
  private var stillRect: NSRect?
  var stillRectForTest: NSRect? { stillRect }
  static let stillHeight: CGFloat = 52

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }

  /// Rebuilds the content and returns the height it needs.
  @discardableResult
  func apply(_ t: CompanionTray) -> CGFloat {
    // The same content again changes nothing. Rebuilding the subviews between a mouse down and its mouse up (a render runs at
    // least every 2 s) would drop the click and VoiceOver's place, so an equal value is left alone.
    if applied, t == current { return height }
    current = t
    subviews.forEach { $0.removeFromSuperview() }
    rowViews = []
    stillRect = nil
    let w = CompanionPlacement.traySize.width
    var y = Self.pad
    if t.showsStill, still != nil {
      let h = Self.stillHeight
      let sw = h * 96 / 104
      stillRect = NSRect(x: (w - sw) / 2, y: y, width: sw, height: h)
      y += h + 4
    }
    func line(_ text: String, dim: Bool) {
      let l = NSTextField(labelWithString: text)
      l.font = .systemFont(ofSize: 12, weight: .medium)
      l.textColor = dim ? CompanionColors.cream.withAlphaComponent(0.78) : CompanionColors.cream
      l.alignment = .center
      l.lineBreakMode = .byTruncatingTail
      l.frame = NSRect(x: 12, y: y + (Self.lineHeight - 16) / 2, width: w - 24, height: 16)
      l.setAccessibilityElement(true)
      l.setAccessibilityRole(.staticText)
      l.setAccessibilityLabel(text)
      addSubview(l)
      y += Self.lineHeight
    }
    if let h = t.headline { line(h, dim: false) }
    for r in t.rows {
      let v = CompanionTrayRowView(row: r, width: w, dimmed: t.dimmed)
      v.frame = NSRect(x: 0, y: y, width: w, height: Self.rowHeight)
      v.onClick = { [weak self] in self?.onRow?($0) }
      addSubview(v)
      rowViews.append(v)
      y += Self.rowHeight
    }
    if t.more > 0 {
      let m = CompanionLinkView(text: "+\(t.more) more", width: w, height: Self.buttonHeight)
      m.frame = NSRect(x: 0, y: y, width: w, height: Self.buttonHeight)
      m.onClick = { [weak self] in self?.onMore?() }
      addSubview(m)
      y += Self.buttonHeight
    }
    if let f = t.footer { line(f, dim: true) }
    if t.offersOpenTalos {
      let b = CompanionLinkView(text: "Open Talos", width: w, height: Self.buttonHeight)
      b.frame = NSRect(x: 0, y: y, width: w, height: Self.buttonHeight)
      b.onClick = { [weak self] in self?.onOpenTalos?() }
      addSubview(b)
      y += Self.buttonHeight
    }
    y += Self.pad
    setAccessibilityElement(false)
    needsDisplay = true
    applied = true
    height = y
    return y
  }

  override func draw(_ dirtyRect: NSRect) {
    CompanionTrayView.paintGround(bounds)
    if let r = stillRect, let cg = still {
      NSImage(cgImage: cg, size: r.size).draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
  }

  static func paintGround(_ r: NSRect) {
    let path = NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10)
    CompanionColors.ground.setFill()
    path.fill()
    CompanionColors.cream.setStroke()
    let inner = NSBezierPath(roundedRect: r.insetBy(dx: 1, dy: 1), xRadius: 9, yRadius: 9)
    inner.lineWidth = 1.5
    inner.stroke()
  }
}

/// The reply card: about 500 characters of plain text in a wrapped `NSTextField` and an Open in Talos button (spec 3.1, 7.2).
/// The text lives in this view only. It is never stored or logged, and `clear()` empties it on close and sign-out.
final class CompanionReplyCardView: NSView {
  static let maxHeight: CGFloat = 300
  var onOpenTalos: (() -> Void)?
  private let body = NSTextField(wrappingLabelWithString: "")
  private let open: CompanionLinkView
  private(set) var shownText: String?
  private(set) var bodyIsCapped = false

  override init(frame: NSRect) {
    open = CompanionLinkView(text: "Open in Talos", width: frame.width, height: CompanionTrayView.buttonHeight)
    super.init(frame: frame)
    body.font = .systemFont(ofSize: 12)
    body.textColor = CompanionColors.cream
    body.isSelectable = false
    body.maximumNumberOfLines = 0
    body.lineBreakMode = .byWordWrapping
    body.cell?.truncatesLastVisibleLine = true  // past the card's height the last line ends in an ellipsis, never a cut
    addSubview(body)
    open.onClick = { [weak self] in self?.onOpenTalos?() }
    addSubview(open)
  }
  required init?(coder: NSCoder) { fatalError("not used") }

  override var isFlipped: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override var mouseDownCanMoveWindow: Bool { false }
  var textField: NSTextField { body }

  /// Sets the text (or a plain status line) and returns the height the card needs.
  @discardableResult
  func show(_ text: String, isReply: Bool) -> CGFloat {
    shownText = isReply ? text : nil
    body.stringValue = text
    let w = CompanionPlacement.replyCardWidth
    let textW = w - 24
    // Measured by the field's own cell at the width it will wrap at: `boundingRect` at the full width undercounts a line now
    // and then, and the last line was cut.
    let h = ceil(body.cell?.cellSize(forBounds: NSRect(x: 0, y: 0, width: textW, height: 100_000)).height ?? 0)
    let bodyH = min(h, Self.maxHeight - 2 * CompanionTrayView.pad - CompanionTrayView.buttonHeight)
    body.frame = NSRect(x: 12, y: CompanionTrayView.pad + 4, width: textW, height: bodyH)
    open.frame = NSRect(x: 0, y: body.frame.maxY + 6, width: w, height: CompanionTrayView.buttonHeight)
    body.setAccessibilityLabel(isReply ? "Last reply: \(text)" : text)
    bodyIsCapped = h > bodyH
    needsDisplay = true
    return open.frame.maxY + CompanionTrayView.pad
  }

  func clear() {
    shownText = nil
    body.stringValue = ""
    body.setAccessibilityLabel(nil)  // the reply text must not outlive the card in the accessibility tree either
  }

  override func draw(_ dirtyRect: NSRect) { CompanionTrayView.paintGround(bounds) }
}
