import AppKit
import Foundation
import TalosDesktopCore

/// The Terminals window's left side: Main and every thread session, each with a state badge. A click (or Return/Space on the
/// focused row, or Cmd+1 … Cmd+9 anywhere in the window) picks one. Rows are rebuilt only when what they show changes, so a
/// click is never lost to a refresh, and the focused row keeps focus.
@MainActor
final class SessionSidebar: NSView {
  static let width: CGFloat = 220

  var onPick: (String) -> Void = { _ in }
  private let stack = NSStackView()
  private let scroll = NSScrollView()
  private let empty = NSTextField(wrappingLabelWithString: "")
  private var signature = ""
  private(set) var rows: [SessionRow] = []

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    setAccessibilityLabel("Sessions")
    setAccessibilityRole(.list)
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 2
    stack.edgeInsets = NSEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
    stack.translatesAutoresizingMaskIntoConstraints = false
    let flipped = FlippedView()
    flipped.translatesAutoresizingMaskIntoConstraints = false
    flipped.addSubview(stack)
    scroll.documentView = flipped
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scroll)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: topAnchor),
      scroll.bottomAnchor.constraint(equalTo: bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.topAnchor.constraint(equalTo: flipped.topAnchor),
      stack.leadingAnchor.constraint(equalTo: flipped.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: flipped.trailingAnchor),
      stack.bottomAnchor.constraint(equalTo: flipped.bottomAnchor),
      flipped.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override func updateLayer() {
    layer?.backgroundColor = NSColor.controlBackgroundColor.cgColor
  }

  override var wantsUpdateLayer: Bool { true }

  func update(entries: [SwitcherEntry], selected: String) {
    let sig = entries.map { "\($0.id)|\($0.title)|\($0.badge.rawValue)" }.joined(separator: "\n") + "#" + selected
    guard sig != signature else { return }
    signature = sig
    let focused = window?.firstResponder as? SessionRow
    let focusedId = focused?.entryId
    for r in rows { stack.removeView(r) }
    rows = entries.enumerated().map { i, e in
      let row = SessionRow(entry: e, index: i, selected: e.id == selected)
      row.target = self
      row.action = #selector(pick(_:))
      return row
    }
    for r in rows {
      stack.addArrangedSubview(r)
      r.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -12).isActive = true
    }
    if let focusedId, let again = rows.first(where: { $0.entryId == focusedId }) { window?.makeFirstResponder(again) }
  }

  @objc private func pick(_ sender: SessionRow) { onPick(sender.entryId) }

  /// Tests: what the owner reads, row by row.
  var rowSummariesForTest: [String] { rows.map { "\($0.titleText)|\($0.badgeText)|\($0.isSelected ? "selected" : "")" } }
}

private final class FlippedView: NSView {
  override var isFlipped: Bool { true }
}

/// One entry. A real button, so it takes keyboard focus (Full Keyboard Access), answers Space and Return, and is read by
/// VoiceOver as "Title, state".
@MainActor
final class SessionRow: NSButton {
  let entryId: String
  let titleText: String
  let badgeText: String
  let isSelected: Bool

  init(entry: SwitcherEntry, index: Int, selected: Bool) {
    entryId = entry.id
    titleText = entry.title
    badgeText = entry.badge.text
    isSelected = selected
    super.init(frame: .zero)
    isBordered = false
    bezelStyle = .regularSquare
    setButtonType(.momentaryChange)
    alignment = .left
    lineBreakMode = .byTruncatingTail
    imagePosition = .noImage
    wantsLayer = true
    layer?.cornerRadius = 6
    translatesAutoresizingMaskIntoConstraints = false
    heightAnchor.constraint(equalToConstant: 44).isActive = true
    focusRingType = .exterior
    let key = SessionSwitcher.shortcutLabel(index: index)
    let title = NSMutableAttributedString(
      string: entry.title + "\n",
      attributes: [.font: NSFont.systemFont(ofSize: 13, weight: selected ? .semibold : .regular), .foregroundColor: NSColor.labelColor])
    let dot = NSAttributedString(
      string: "\u{25CF} ", attributes: [.font: NSFont.systemFont(ofSize: 10), .foregroundColor: Self.color(entry.badge)])
    let line2 = NSMutableAttributedString(attributedString: dot)
    line2.append(
      NSAttributedString(
        string: entry.badge.text + (key.map { " \u{00B7} \($0)" } ?? ""),
        attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor]))
    title.append(line2)
    attributedTitle = title
    toolTip = entry.detail
    setAccessibilityLabel("\(entry.title), \(entry.badge.text)")
    setAccessibilityHelp(entry.detail)
    setAccessibilityRole(.button)
    setAccessibilitySelected(selected)
    applySelection()
  }

  /// The highlight is a CGColor, which doesn't follow a theme change by itself: set again when the appearance changes.
  private func applySelection() {
    effectiveAppearance.performAsCurrentDrawingAppearance {
      layer?.backgroundColor = isSelected ? NSColor.selectedContentBackgroundColor.withAlphaComponent(0.25).cgColor : nil
    }
  }

  override func viewDidChangeEffectiveAppearance() {
    super.viewDidChangeEffectiveAppearance()
    applySelection()
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override var acceptsFirstResponder: Bool { true }

  /// Return and Space press the focused row, the way a button does.
  override func keyDown(with event: NSEvent) {
    if event.keyCode == 36 || event.keyCode == 49 { performClick(nil) } else { super.keyDown(with: event) }
  }

  /// System colours, so both themes read.
  static func color(_ b: SwitcherEntry.Badge) -> NSColor {
    switch b {
    case .needsYou: return .systemOrange
    case .failed: return .systemRed
    case .working: return .systemBlue
    case .idle, .live: return .systemGreen
    case .starting, .stopping: return .systemYellow
    case .parked, .notStarted, .unknown: return .systemGray
    }
  }
}
