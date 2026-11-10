import Foundation

/// Needs-you prompts, the Mac popup (docs/OPTION-C.md "Needs-you prompts: the Mac side, as built"). Pure: what the popup says, when it is on
/// the screen and what a click asks for. No window, no tmux, no clock of its own.

/// Text from the screen made safe to show on one line: every invisible, direction-changing or control character becomes `⟦U+XXXX⟧`, and so do
/// the marker brackets themselves, so no label can print a marker of its own. This is the card's `dialogVisibleText`
/// (packages/protocol/src/dialog-card.ts, over `INVISIBLE_OR_BIDI` in permission.ts), so a popup reads the same as the card. Every match is
/// marked, an emoji selector or a joiner inside one too (the web app's `revealHidden` lets those through; the card does not, and neither does this).
public enum DialogVisibleText {
  public static func show(_ text: String) -> String {
    let u = Array(text.unicodeScalars)
    var out = ""
    var i = 0
    while i < u.count {
      let s = u[i]
      if listed(s) || s == "\u{27E6}" || s == "\u{27E7}" || categorised(s) {
        out += marker(s)
        i += 1
      } else if isMark(s) {
        // `\p{M}{4,}`: more than three combining marks in a row hide something; the whole run is shown
        var j = i
        while j < u.count, isMark(u[j]) { j += 1 }
        if j - i >= 4 {
          for k in i..<j { out += marker(u[k]) }
          i = j
        } else {
          out.unicodeScalars.append(s)
          i += 1
        }
      } else {
        out.unicodeScalars.append(s)
        i += 1
      }
    }
    return out
  }

  private static func marker(_ s: Unicode.Scalar) -> String {
    let hex = String(s.value, radix: 16, uppercase: true)
    return "\u{27E6}U+" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex + "\u{27E7}"
  }

  private static func isMark(_ s: Unicode.Scalar) -> Bool {
    switch s.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark: return true
    default: return false
    }
  }

  /// Default_Ignorable_Code_Point, format (Cf), unassigned (Cn), private use (Co), surrogate (Cs) and U+FFFC.
  private static func categorised(_ s: Unicode.Scalar) -> Bool {
    if s.value == 0xFFFC || s.properties.isDefaultIgnorableCodePoint { return true }
    switch s.properties.generalCategory {
    case .format, .unassigned, .privateUse, .surrogate: return true
    default: return false
    }
  }

  /// The listed ranges of `INVISIBLE_OR_BIDI`.
  private static let ranges: [ClosedRange<UInt32>] = [
    0x0000...0x001F, 0x007F...0x009F, 0x00AD...0x00AD, 0x034F...0x034F, 0x0334...0x0338, 0x0600...0x0604, 0x061C...0x061C,
    0x070F...0x070F, 0x0890...0x0891, 0x115F...0x1160, 0x17B4...0x17B5, 0x180B...0x180F, 0x200B...0x200F, 0x202A...0x202E,
    0x2028...0x2029, 0x2060...0x206F, 0x2800...0x2800, 0x3164...0x3164, 0xFE00...0xFE0F, 0xFEFF...0xFEFF, 0xFFA0...0xFFA0,
    0xFFF0...0xFFFB, 0xE0000...0xE007F, 0xE0100...0xE01EF, 0x1BCA0...0x1BCA3, 0x1D173...0x1D17A,
  ]
  private static func listed(_ s: Unicode.Scalar) -> Bool { ranges.contains { $0.contains(s.value) } }
}

/// Whether a button's action is the owner's own click: the event the app is handling is a left mouse button event, under a second old, in this
/// button's window and on the button. An Accessibility press or an AppleScript click reaches the same action method with no such event. Pure,
/// so CI checks it without a window (the view only reads the event and asks this).
public enum PopupClickCheck {
  public enum Kind: Sendable { case leftMouseDown, leftMouseUp, other }
  public static func isRealClick(kind: Kind, age: Double, sameWindow: Bool, onButton: Bool) -> Bool {
    kind != .other && abs(age) < 1 && sameWindow && onButton
  }
}

/// What a click on a popup button asks for: the option at an index (with the label the owner saw on the button, so what is pressed is the
/// label as read, not a row number), or the login popup's one button.
public enum NeedsYouPopupAction: Equatable, Sendable {
  case choose(Int, label: String)
  case open
}

/// Why a click pressed nothing.
public enum PopupNothing: Equatable, Sendable {
  /// The screen was not the dialog offered (it changed, the owner is typing, a key could not be checked), or the click did not fit the dialog.
  case screenChanged
  /// A verified card answer (or an earlier click) pressed first. `by` is the device the bridge's card file names, display only.
  case alreadyAnswered(by: String?)
  /// That dialog id is not on offer now (gone, a new sighting, expired, or only a record read back from disk).
  case notOffered
  /// Login: no Terminals window could be brought forward.
  case noWindow
  /// A tmux client typed within the quiet time: the owner is at the keys.
  case typing
  /// The tmux clients could not be read, so a key is never sent on a guess.
  case couldNotCheck
}

/// What the popup controller needs of the worker manager (the live one is `WorkerManager`; tests bring their own).
public protocol NeedsYouPopupSource: AnyObject, Sendable {
  func popupOffers() -> [NeedsYouPopupItem]
  func popupAnswer(thread: String, dialogId: String, action: NeedsYouPopupAction, completion: @escaping @Sendable (PopupAnswerResult) -> Void)
}

public enum PopupAnswerResult: Equatable, Sendable {
  case pressed(choice: Int, label: String)
  case opened
  case nothing(PopupNothing)
}

/// One offered dialog, as the popup needs it.
public struct NeedsYouPopupItem: Equatable, Sendable {
  public var thread: String
  public var threadName: String
  public var dialog: DialogOffer
  /// Main's development-channels popup only: the Mac posted its notice to the phone for this start.
  public var phoneTold: Bool
  /// Shown before every other popup, whatever its age (Main's warning is not hidden behind older popups).
  public var first: Bool
  public init(thread: String, threadName: String, dialog: DialogOffer, phoneTold: Bool = false, first: Bool = false) {
    self.thread = thread
    self.threadName = threadName
    self.dialog = dialog
    self.phoneTold = phoneTold
    self.first = first
  }
}

public struct NeedsYouPopupButton: Equatable, Sendable {
  /// As drawn: hidden characters shown.
  public var text: String
  public var action: NeedsYouPopupAction
  public init(text: String, action: NeedsYouPopupAction) {
    self.text = text
    self.action = action
  }
}

public struct NeedsYouPopupContent: Equatable, Sendable {
  public var header: String
  public var title: String
  /// The folder or server, in the monospace box; nil when the Mac could not read it exactly.
  public var subject: String?
  public var sentence: String
  /// The dialog's options exactly as read, in screen order, none dropped or edited (login: the one "Open in Terminals").
  public var buttons: [NeedsYouPopupButton]
  public var footer: String

  public static let footer = "Also on your phone. Answer either one."
  /// `DIALOG_WORDING.footer.popupMain`: Main's own popup, where the phone only gets a notice.
  public static let footerMain = "Your phone is told to come here."
  public static let openLabel = "Open in Terminals"
  /// The phone notice while Main waits at the Mac (`DIALOG_WORDING.phone.devChannelsWaiting`, committed in fixtures/needs-you/wording.json; the
  /// tests assert they are equal). Posted by the Mac itself, so it needs no bridge.
  public static let devWaitingPhone = "Main is waiting at your Mac: answer the Talos popup there."
  /// `DIALOG_WORDING.footer.popupMainHere`: Main's popup when the phone was not told (the owner started Main at the Mac).
  public static let footerMainHere = "Answer it here."
  static let screenChangedWords = "screen changed, so Talos left it alone. A new popup comes if it still needs you."

  /// The plain English is above the buttons; only the buttons are the screen's own words. The heading, the sentence and the footer are the
  /// shared wording table in packages/protocol (`DIALOG_WORDING`, committed as fixtures/needs-you/wording.json): the tests assert they are equal.
  public static func make(_ item: NeedsYouPopupItem) -> NeedsYouPopupContent {
    let name = threadLabel(item.threadName)
    let d = item.dialog
    let title: String
    let sentence: String
    switch d.kind {
    case .trust:
      title = "Trust this folder?"
      sentence = "\(name)'s session wants to work in this folder. Claude will be able to read, change and run files in it, and in folders inside it."
    case .mcpConsent:
      title = "Allow this MCP server?"
      sentence = "\(name)'s session wants to turn on this server's tools for its folder."
    case .login:
      title = "\(name) needs you to sign in"
      sentence = "\(name)'s session needs you to sign in to Claude on the Mac."
    case .devChannels:
      title = "Allow Talos's development channel?"
      sentence = Self.devChannelsSentence(subject: d.subject, launchChanged: d.launch_changed)
    }
    let buttons =
      d.kind == .login
      ? [NeedsYouPopupButton(text: openLabel, action: .open)]
      : d.options.enumerated().map { NeedsYouPopupButton(text: DialogVisibleText.show($1), action: .choose($0, label: $1)) }
    return NeedsYouPopupContent(
      header: "Talos · \(name) needs you", title: title, subject: d.subject.map(DialogVisibleText.show), sentence: sentence, buttons: buttons,
      footer: d.kind != .devChannels ? footer : item.phoneTold ? footerMain : footerMainHere)
  }

  /// The card's words for Main's development-channels warning (`DIALOG_WORDING.sentence.dev_channels` and `.devChannels` in the protocol, committed
  /// as fixtures/needs-you/wording.json; the tests assert these equal it): the sentence, a channel Talos did not add, and a start command that
  /// is not the confirmed one with what changed.
  static func devChannelsSentence(subject: String?, launchChanged: [String]?) -> String {
    var lines = ["Main session's start needs this to talk to the Talos app."]
    let others = (subject ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && $0 != "server:talos-app" }
    if !others.isEmpty { lines.append("Also loads \(others.map(DialogVisibleText.show).joined(separator: ", ")), which Talos didn't add.") }
    if let lc = launchChanged {
      lines.append(lc.isEmpty ? "Main's start command isn't confirmed on this Mac yet." : "Main's start command changed since you last confirmed it.")
      if !lc.isEmpty { lines.append("Changed: \(lc.joined(separator: ", ")).") }
    }
    return lines.joined(separator: " ")
  }

  /// What the popup says when a click pressed nothing.
  public static func failureText(_ why: PopupNothing, threadName: String) -> String {
    let name = threadLabel(threadName)
    switch why {
    case .screenChanged, .notOffered: return "Nothing pressed: \(name)'s \(screenChangedWords)"
    case .alreadyAnswered(let by): return "Already answered on \(by.map(DialogVisibleText.show) ?? "another device")"
    case .noWindow: return "Nothing opened: Talos could not bring Terminals forward. Open it from the Talos menu."
    case .typing: return "You were typing in \(name)'s session, so Talos left it alone."
    case .couldNotCheck: return "Talos could not check whether you were typing in \(name)'s session, so it left it alone."
    }
  }

  static func threadLabel(_ n: String) -> String {
    let t = DialogVisibleText.show(n).trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? "A thread" : t
  }
}

/// What is on the Mac's screen. Pure state, driven from the main thread: `refresh` once a tick, `click` and `hide` from the popup's buttons.
/// It decides nothing about pressing: a click only asks `answer` (the manager), and what comes back is shown.
public final class NeedsYouPopupCoordinator {
  public enum Phase: Equatable, Sendable {
    case asking
    case working
    /// Nothing was pressed; these are the words, shown for `failureShown` seconds.
    case failed(String)
  }

  public struct Popup: Equatable, Sendable {
    public var item: NeedsYouPopupItem
    public var content: NeedsYouPopupContent
    public var phase: Phase
    public init(item: NeedsYouPopupItem, content: NeedsYouPopupContent, phase: Phase) {
      self.item = item
      self.content = content
      self.phase = phase
    }
  }

  /// At most this many popups at once; the rest wait.
  public static let maxShown = 3
  /// A click in the first moment after a popup appears is ignored: one that appears under the cursor is not answered by the click meant for
  /// whatever was there.
  public static let clickDelay: Double = 0.6
  /// How long the words for a failed click stay.
  public static let failureShown: Double = 6

  private struct Entry {
    var item: NeedsYouPopupItem
    var phase: Phase
    /// When the popup last became clickable-from-now: its first appearance, a move on the screen, or its return after a failure.
    var shownAt: Double
    var failedAt: Double?
  }

  private let offers: () -> [NeedsYouPopupItem]
  private let quiet: () -> Bool?
  private let now: () -> Double
  private let answer: (String, String, NeedsYouPopupAction, @escaping (PopupAnswerResult) -> Void) -> Void
  private var entries: [String: Entry] = [:]
  /// Dialog ids the popup is done with: hidden by the owner or answered. They do not come back.
  private var closed: Set<String> = []

  /// `now` is any steady clock in seconds. `answer(thread, dialogId, action, done)` must call `done` on the thread the coordinator is driven from.
  public init(
    offers: @escaping () -> [NeedsYouPopupItem], quiet: @escaping () -> Bool?, now: @escaping () -> Double,
    answer: @escaping (_ thread: String, _ dialogId: String, _ action: NeedsYouPopupAction, _ done: @escaping (PopupAnswerResult) -> Void) -> Void
  ) {
    self.offers = offers
    self.quiet = quiet
    self.now = now
    self.answer = answer
  }

  /// The popups to show now, in order. `quiet == true` shows none and forgets nothing but a failure's words: a dialog still offered when the
  /// window ends is shown then. `nil` (the bridge has not been read) shows. The words of a failed click stay their full time even when the
  /// dialog goes away first (a phone answer that won ends it); after that, if the same dialog id is still offered, the popup asks again,
  /// with a fresh first moment.
  public func refresh() -> [Popup] {
    let all = offers()
    let ids = Set(all.map(\.dialog.id))
    closed.formIntersection(ids)
    let t = now()
    for (id, e) in entries {
      if case .failed = e.phase {
        if let f = e.failedAt, t - f >= Self.failureShown { entries[id] = nil }  // still offered: it is a question again, below
      } else if !ids.contains(id) {
        entries[id] = nil  // the dialog is no longer offered: gone, a new sighting, expired
      }
    }
    guard quiet() != true else {
      entries = entries.filter { $0.value.phase == .working }
      return []
    }
    var items = all.filter { !closed.contains($0.dialog.id) }
    for e in entries.values where !ids.contains(e.item.dialog.id) { items.append(e.item) }  // the words of a click that failed, dialog gone
    items.sort {
      let a = ISOTime.parse($0.dialog.seen_at) ?? 0, b = ISOTime.parse($1.dialog.seen_at) ?? 0
      return ($0.first ? 0 : 1, a, $0.thread, $0.dialog.id) < ($1.first ? 0 : 1, b, $1.thread, $1.dialog.id)
    }
    let shown = Array(items.prefix(Self.maxShown))
    let shownIds = Set(shown.map(\.dialog.id))
    entries = entries.filter { shownIds.contains($0.key) || $0.value.phase == .working }
    return shown.map { item in
      let id = item.dialog.id
      var e = entries[id] ?? Entry(item: item, phase: .asking, shownAt: t)
      if ids.contains(id) { e.item = item }
      entries[id] = e
      return Popup(item: e.item, content: NeedsYouPopupContent.make(e.item), phase: e.phase)
    }
  }

  /// The owner clicked button `button` of the popup for `dialogId`. Only a popup that is on the screen, asking, past its first moment, and a
  /// button it has can be clicked; one click at a time.
  public func click(dialogId: String, button: Int) {
    let shown = refresh()
    guard let p = shown.first(where: { $0.item.dialog.id == dialogId }), p.phase == .asking, let e = entries[dialogId],
      now() - e.shownAt >= Self.clickDelay, p.content.buttons.indices.contains(button)
    else { return }
    entries[dialogId]?.phase = .working
    let item = p.item
    answer(item.thread, dialogId, p.content.buttons[button].action) { [weak self] result in self?.finished(item, result) }
  }

  /// The popup moved on the screen (a popup above it closed or grew): the first moment starts again, so a click meant for what was under the
  /// cursor before is not taken for an answer.
  public func rearm(dialogId: String) {
    entries[dialogId]?.shownAt = now()
  }

  /// The close button: the popup goes and nothing is pressed. The card on the phone stays.
  public func hide(dialogId: String) {
    closed.insert(dialogId)
    entries[dialogId] = nil
  }

  private func finished(_ item: NeedsYouPopupItem, _ result: PopupAnswerResult) {
    let id = item.dialog.id
    switch result {
    case .pressed, .opened:
      closed.insert(id)
      entries[id] = nil
    case .nothing(let why):
      guard let e = entries[id], !closed.contains(id) else { return }
      entries[id] = Entry(
        item: item, phase: .failed(NeedsYouPopupContent.failureText(why, threadName: item.threadName)), shownAt: e.shownAt, failedAt: now())
    }
  }
}
