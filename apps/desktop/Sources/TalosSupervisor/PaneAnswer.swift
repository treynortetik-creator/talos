import Foundation
import TalosDesktopCore

/// How one answer to a tool permission or the agent's question reaches the pane (pane-prompts plan rows 8 and 9). The same steps for Main
/// (`Supervisor`) and a thread session (`WorkerManager`): each hands this the three things only it can do (read the pane, say whether a person
/// may be typing, send one key through ITS key gate), and the steps are here once.
///
/// Every key is checked against the screen the offer was made for: the key gate (`KeyGuard.Intent.pane`) reads the live pane and refuses unless
/// its `bound` (kind, tool, subject, every numbered row) is the offered one, and this driver reads it again itself right before each key. A screen
/// that changed between the offer and the answer presses nothing.
///
/// A choice is ONE key: the number drawn on its row. A tool permission's choices are only `Allow once` (the `Yes` row) and `Deny` (the `No` row);
/// the rows that grant more (always allow, auto mode, accept edits) have no choice here and so no key. A question's free-text choice is the
/// row's number (the field takes focus), the owner's words typed literally, and Enter; each step on a fresh read, and the typing and Enter only
/// when the screen shows the field on that row holding those words. A refused or failed step in the middle stops all of it (`.partial`: the field
/// was focused, nothing more was sent, and the question still waits for the owner).
struct PaneAnswerDriver {
  enum Step { case number(SelectNumber), text(AnswerText), enter, escape
    /// `n` Backspaces: only the usage-limit answer's clearing of its own typed `/model`.
    case backspaces(Int) }

  enum Blocked: Equatable { case typing, unreadable }

  enum Result: Equatable {
    /// The key that answers it was confirmed sent.
    case delivered
    /// It was sent and tmux timed out: it may have landed. Never sent again for this offer.
    case unknown
    /// A person may be typing in the pane, or the clients could not be read: nothing was sent.
    case blocked(Blocked)
    /// The screen is not the offered one (or a key was refused or failed before any was sent): nothing was sent.
    case changed
    /// A free-text answer that stopped after its first key: the field is focused and the rest was not sent.
    case partial
    /// A Switch model that stopped after the Escape went (`UsageLimitScreen.Stop`): the menu is closed, so it is never "nothing pressed".
    case usageStopped(UsageLimitScreen.Stop)
  }

  let kind: PaneSelect.Kind
  /// The offered screen's `bound`.
  let bound: String
  let freeText: Int?
  /// The pane's rows now; nil when they could not be read.
  var read: () -> [String]?
  /// Whether a person may be typing in the pane (or the clients can not be read): never a key on a guess.
  var typing: () -> Blocked?
  /// One key, through the key gate with the intent given; the gate reads the pane itself. `.refused` / `.failed`: no key went.
  var send: (Step, KeyGuard.Intent) -> SendOutcome
  var awake: () -> Double
  var pause: () -> Void = { usleep(50_000) }
  /// How long a focused field gets to show.
  var echoWait: Double = 2

  private func screen(freeTextAt: Int? = nil) -> PaneSelect.Screen? {
    guard let rows = read() else { return nil }
    return screen(rows: rows, freeTextAt: freeTextAt)
  }

  /// The offered screen in `rows`, or nil when they are another screen (or the usage-limit menu, which takes no key).
  private func screen(rows: [String], freeTextAt: Int? = nil) -> PaneSelect.Screen? {
    // the usage-limit menu takes no key but its own card's Escape (`runUsageLimit`); every other offer is never read on it
    guard kind == .usageLimit || !DialogMatcher.takesNoKeys(rows), let s = PaneSelect.read(rows: rows, freeTextAt: freeTextAt), s.kind == kind, ExactText.equal(s.bound, bound)
    else { return nil }
    return s
  }

  private func intent(tolerant: Bool) -> KeyGuard.Intent {
    .pane(KeyGuard.PaneBinding(kind: kind, bound: bound, freeText: tolerant ? freeText : nil))
  }

  /// `option`: the card's option index. `text`: the owner's words, for the free-text option only.
  func run(option: Int, text: String?) -> Result {
    if kind == .usageLimit { return text == nil ? runUsageLimit(option: option) : .changed }
    let freeChoice = freeText != nil && option == freeText
    // a text goes with the free-text option and nowhere else, and is the owner's words exactly
    let typed: AnswerText?
    if freeChoice {
      guard let text, let t = AnswerText(text) else { return .changed }
      typed = t
    } else {
      guard text == nil else { return .changed }
      typed = nil
    }
    if let b = typing() { return .blocked(b) }
    guard let first = screen(), let row = PaneSelect.row(first, forOption: option), first.rows.indices.contains(row),
      let number = SelectNumber(first.rows[row].number), !freeChoice || first.freeText == row
    else { return .changed }
    // the typing check again and the last look, straight before the key
    if let b = typing() { return .blocked(b) }
    guard let last = screen(), last.rows.indices.contains(row), last.rows[row].number == number.value else { return .changed }
    let sent = send(.number(number), intent(tolerant: false))
    if sent.notSent { return .changed }
    guard freeChoice, let typed, let field = freeText else { return sent == .sent && offeredScreenGone() ? .delivered : .unknown }
    // the free-text answer: the field must take focus (an unknown delivery of the number stops here: the next key cannot be known to be safe)
    guard sent == .sent else { return .partial }
    let until = awake() + echoWait
    var focused = false
    repeat {
      pause()
      if let s = screen(freeTextAt: field), s.cursor == field { focused = true }
    } while !focused && awake() < until
    guard focused else { return .partial }
    if typing() != nil { return .partial }
    guard screen(freeTextAt: field)?.cursor == field, send(.text(typed), intent(tolerant: true)) == .sent else { return .partial }
    // the words are in the field, on the focused row, and only then Enter
    var shown = false
    let wait = awake() + echoWait
    repeat {
      pause()
      if let s = screen(freeTextAt: field), s.cursor == field, s.typed?.contains(typed.text) == true { shown = true }
    } while !shown && awake() < wait
    guard shown, typing() == nil else { return .partial }
    let enter = send(.enter, intent(tolerant: true))
    if enter.notSent { return .partial }
    return enter == .sent && offeredScreenGone() ? .delivered : .unknown
  }

  /// The usage-limit card (row 7). `Stop and wait` is Escape, once, on the menu this card was made for. `Switch model` is that Escape, then (on the idle prompt
  /// for the same limit, nobody typing) `/model` typed into the empty box, then Enter once the box holds exactly it. Every key goes through its own
  /// `KeyGuard.Intent.usageLimit` after a fresh read; a step that cannot be checked stops the rest (`.partial`: the menu is gone and the owner finishes at
  /// the Mac). Never a number, never an arrow, never a row of the menu.
  private func runUsageLimit(option: Int) -> Result {
    if let b = typing() { return .blocked(b) }
    guard let first = screen(), let limit = first.limit else { return .changed }
    let offered = PaneSelect.offered(first)
    guard offered.indices.contains(option) else { return .changed }
    let switching = offered[option] == UsageLimitScreen.switchLabel
    let key = UsageLimitScreen.limitKey(limit)
    func intent(_ step: KeyGuard.UsageStep, idle: String? = nil) -> KeyGuard.Intent {
      .usageLimit(KeyGuard.UsageBinding(bound: bound, limit: key, step: step, idle: idle))
    }
    if let b = typing() { return .blocked(b) }
    guard screen() != nil else { return .changed }
    let esc = send(.escape, intent(.escape))
    if esc.notSent { return .changed }
    // the menu-gone read: its idle prompt is THE screen every later key is tied to (a headline that stays on the pane is only an extra check)
    let gone = menuGoneRows(idle: switching)
    if !switching { return esc == .sent && gone != nil ? .delivered : .unknown }
    // an Escape not seen to take (a timeout, or the menu still there): nothing more is sent, and it is said as unconfirmed
    guard esc == .sent, let idleRows = gone else { return .unknown }
    guard let idle = KeyGuard.idleSignature(idleRows) else { return .usageStopped(.closed) }
    if typing() != nil { return .usageStopped(.closed) }
    guard let model = AnswerText(UsageLimitScreen.modelCommand), send(.text(model), intent(.typeModel, idle: idle)) == .sent else {
      return .usageStopped(.closed)
    }
    // the words are in the box, and only then Enter
    var shown = false
    let wait = awake() + echoWait
    repeat {
      pause()
      if let rows = read(), KeyGuard.boxHolds(rows, UsageLimitScreen.modelCommand) { shown = true }
    } while !shown && awake() < wait
    guard shown else { return .usageStopped(.closed) }
    if typing() != nil { return .usageStopped(.typed) }
    let enter = send(.enter, intent(.enterModel, idle: idle))
    if enter == .unknown { return .unknown }
    if enter == .sent { return .delivered }
    // the Enter was refused or failed: `/model` is in the box. Backspaces take it out again, guarded: only while the box holds exactly `/model`
    // for this same screen, and nobody typing
    if typing() != nil { return .usageStopped(.typed) }
    let cleared = send(.backspaces(UsageLimitScreen.modelCommand.count), intent(.clearModel, idle: idle))
    if cleared.notSent { return .usageStopped(.typed) }
    let until = awake() + echoWait
    repeat {
      pause()
      if let rows = read(), !KeyGuard.boxHolds(rows, UsageLimitScreen.modelCommand) { return .usageStopped(.cleared) }
    } while awake() < until
    return .usageStopped(.typed)
  }

  /// The pane's rows once the usage-limit menu is gone from them (Escape took), or nil when it is still there after `echoWait`. With `idle`: the idle prompt
  /// is drawn (a frame caught between Claude Code's clear and its redraw has no input box) and the same on two looks in a row, so the signature every later
  /// key is tied to is of a finished screen.
  private func menuGoneRows(idle: Bool = false) -> [String]? {
    let until = awake() + echoWait
    var last: String?
    repeat {
      pause()
      if let rows = read(), UsageLimitScreen.readMenu(rows) == nil {
        guard idle else { return rows }
        if let sig = KeyGuard.idleSignature(rows) {
          if sig == last { return rows }
          last = sig
        } else {
          last = nil
        }
      }
    } while awake() < until
    return nil
  }

  /// The answer key was sent and the offered screen goes (the prompt took it). Unconfirmed is NOT answered: a digit is ASSUMED to choose a numbered row at once
  /// (docs/OPTION-C.md), and a screen that is still there `echoWait` after a confirmed send says the key did not take, which the owner is shown as a
  /// prompt offered again, never as an answer that stood. A pane that cannot be read says nothing.
  private func offeredScreenGone() -> Bool {
    let until = awake() + echoWait
    repeat {
      pause()
      if let rows = read(), screen(rows: rows, freeTextAt: freeText) == nil { return true }
    } while awake() < until
    return false
  }
}
