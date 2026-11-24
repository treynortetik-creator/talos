import Foundation

/// The one check every key Talos sends to a pane makes first: an ALLOWLIST in both directions, decided from what Claude Code draws now, never
/// the transcript above it. The sender states what it means to press (`Intent`), and the live screen must be exactly that; anything else
/// gets no key, and the next look decides again. The Linux supervisor's twin is apps/bridge/src/supervisor/key-guard.ts; the two allow the
/// same keys on the same screens (KeyGuardTests reads the table both sides are checked against).
///
/// - `.box(.empty)` / `.box(.ours)`: typing Talos's pointer line into Claude's own input box, or the Enter or Backspaces for that line.
///   Allowed only when the box is positively live: Claude's exact frame (a solid rule, the cursor row, a solid rule) is the last frame on the
///   pane, every row under it is one of the status rows Claude Code draws there (`BoxFrame`), and it is EMPTY (no draft, no placeholder
///   taken for one: the coloured capture decides) or holds exactly Talos's line drawn as Claude Code draws typed text. A menu, under the box
///   or between rules that look like it, is never one of those rows, so it is never typed into, whatever its shape. For `.ours` (the
///   Enter and the Backspaces) also no prompt or dialog live anywhere on the pane (`prompt_on_pane`); the Enter is checked after it
///   went (`EnterDetection`).
/// - `.dialog(kind)`: a key for one of the screens Talos presses keys into. Allowed only when THAT kind's own exact reader matches the live
///   region (from the last solid rule down, or the whole pane when there is none): `DialogReader` for folder trust, MCP consent and the bypass
///   disclaimer (the tap answerer), the live warning for the development channels, the exact block for the computer-use permission dialog (its one Escape).
///   A phrase on screen never names anything by itself.
/// - `.devWarning(highlighted, channels)`: Main's auto-accept and its card and popup. The development-channels warning, with the cursor on
///   exactly the row the sender read and exactly the channel list it checked (`devWarning`): counts alone never name the row a key lands on.
/// - `.interrupt`: Escape for a model request that stopped answering (the stall auto-unstick, `Supervisor.unstickMain`). Allowed only when
///   Claude's input box is positively live and EMPTY (nobody is typing: a draft or a half-typed line refuses), the working line is on the
///   pane (a request is in flight: an idle Main gets no Escape), and no select, prompt or dialog is live anywhere (an Escape would answer
///   it: `prompt_on_pane`).
/// - `.interruptBlank`: the same Escape for a request that froze with NO working line drawn (the sender has established, this tick, that the
///   transcript's newest turn is the model's pending one and the blank wait has passed: `MainWatch.blankStallReady`). The gate allows it
///   only on the idle prompt: Claude's input box live and EMPTY (nobody typing), no select, prompt or dialog anywhere, and no working line (a
///   spinner is `.interrupt`'s case). One Escape per message: a second would open Claude Code's rewind menu (the sender never repeats it).
/// - `.usageLimit(binding)`: the usage-limit card's three keys, and nothing else on that screen. `.escape` only while the menu is up and is exactly
///   the one the card was made for (`PaneSelect` `bound`: model, reset and every row). `.typeModel` and `.enterModel` only after it, on the idle
///   prompt for the same limit (its headline still shows): the box live and empty for the typing, holding exactly `/model` for the Enter, no
///   select or dialog on the pane.
/// - And, independently, never a key while Claude Code's usage-limit menu is anywhere on the pane (`UsageLimitScreen`) except that `.escape`
///   above, nor when the pane cannot be read, nor with no intent stated.
public enum KeyGuard {
  public enum BoxHolds: String, Sendable { case empty, ours }

  /// The screens a key may be meant for. Linux has no computer-use dialog and no login-success or API-key key; the rest are the same names.
  public enum DialogKind: String, Sendable, CaseIterable {
    case trust
    case mcpConsent = "mcp_consent"
    case devChannels = "dev_channels"
    case computerUse = "computer_use"
    /// First-start screens that are only a look: one Enter, nothing else (`FirstStartScreens`; Linux's `theme` and `security_notes`).
    case theme
    case securityNotes = "security_notes"
    case loginSuccess = "login_success"
    /// The API-key question, answered from its card by a real click: an arrow toward the chosen row, then Enter (`ApiKeyCard`).
    case apiKey = "api_key"
    /// The Bypass Permissions disclaimer (`No, exit` / `Yes, I accept`): answered only from its card or popup, by the owner's own tap or click.
    case bypass
  }

  /// What the sender means to press: the screen must be exactly this.
  public enum Intent: Equatable, Sendable {
    case box(BoxHolds)
    case dialog(DialogKind)
    /// The development-channels warning with the cursor on exactly `highlighted` (one of its two rows) and exactly `channels` on its
    /// `Channels:` line: the key lands on the row the sender read, for the launch the sender checked (Main's auto-accept and its card).
    case devWarning(highlighted: String, channels: [String])
    /// A key for the tool permission or the agent's question (`PaneSelect`) that is exactly the screen the offer was made for: the live read must
    /// have the same `bound` (kind, tool, subject, every numbered row; not the cursor). `freeText` is the question's free-text row, whose label
    /// the owner's typing replaces.
    case pane(PaneBinding)
    /// A key of the usage-limit card's answer (`UsageBinding`).
    case usageLimit(UsageBinding)
    /// Escape for a stalled model request on Main (the box empty, the working line up, no dialog or select anywhere).
    case interrupt
    /// Escape for a frozen request with no working line on the pane: the idle prompt, box empty, no dialog (the sender checks the transcript and the wait).
    case interruptBlank

    /// For the audit: `box-empty`, `box-ours` or the dialog kind's name.
    public var name: String {
      switch self {
      case .box(let h): return "box-\(h.rawValue)"
      case .dialog(let k): return k.rawValue
      case .devWarning: return DialogKind.devChannels.rawValue
      case .pane(let b): return b.kind.rawValue
      case .usageLimit(let b): return "usage-limit-\(b.step.rawValue)"
      case .interrupt: return "interrupt"
      case .interruptBlank: return "interrupt-blank"
      }
    }
  }

  /// The three keys a usage-limit answer sends (`Intent.usageLimit`): Escape, the typed `/model`, and its Enter.
  public enum UsageStep: String, Sendable, CaseIterable {
    case escape, typeModel, enterModel
    /// The Backspaces that clear the `/model` Talos typed when its Enter was refused: only while the box holds exactly that.
    case clearModel
  }

  /// What a usage-limit key is tied to: the menu the card was made for (`PaneSelect.Screen.bound`), the limit it is about
  /// (`UsageLimitScreen.limitKey`), and which of the three keys this is.
  public struct UsageBinding: Equatable, Sendable {
    public var bound: String
    public var limit: String
    public var step: UsageStep
    /// The idle prompt's signature (`idleSignature`) from the read that saw the menu gone, just after the Escape: the later steps are tied to THAT
    /// screen, not only to a headline that stays on the pane. nil on the Escape itself.
    public var idle: String?
    public init(bound: String, limit: String, step: UsageStep, idle: String? = nil) {
      self.bound = bound
      self.limit = limit
      self.step = step
      self.idle = idle
    }
  }

  /// What a pane Select key is tied to (see `Intent.pane`).
  public struct PaneBinding: Equatable, Sendable {
    public var kind: PaneSelect.Kind
    public var bound: String
    public var freeText: Int?
    public init(kind: PaneSelect.Kind, bound: String, freeText: Int? = nil) {
      self.kind = kind
      self.bound = bound
      self.freeText = freeText
    }
  }

  /// Why a key was refused, for the audit: a short code (the Linux guard's codes), and the row under the box that is not a status row when
  /// that was it.
  public struct Refusal: Equatable, Sendable {
    public var why: String
    public var row: String?
    public init(_ why: String, row: String? = nil) {
      self.why = why
      self.row = row
    }
  }

  /// The intent a tap on a worker's dialog states, by the dialog's kind (login has no key: nil).
  public static func intent(for kind: DialogReader.Kind) -> Intent? {
    switch kind {
    case .trust: return .dialog(.trust)
    case .mcpConsent: return .dialog(.mcpConsent)
    case .devChannels: return .dialog(.devChannels)
    case .login: return nil
    // the two pane Selects state `.pane` with the offer's own binding (`PaneSelect`), never an intent by kind alone
    case .toolPermission, .agentQuestion, .usageLimit: return nil
    case .apiKey: return .dialog(.apiKey)
    case .bypass: return .dialog(.bypass)
    }
  }

  /// Why a key meant as `intent` may not go to a pane showing `escaped` (its rows, with their colours when the capture had them; nil: the
  /// pane could not be read), or nil: it may.
  public static func refusal(_ escaped: [String]?, intent: Intent?) -> Refusal? {
    guard let escaped else { return Refusal("unreadable") }
    guard let intent else { return Refusal("no_intent") }
    var all = escaped
    while let l = all.last, InputBoxAttributes.stripEscapes(l).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { all.removeLast() }
    let rows = all.map(InputBoxAttributes.stripEscapes)
    if UsageLimitScreen.read(rows) != nil {
      // the menu is up: only the card's Escape, for exactly this menu
      if case .usageLimit(let b) = intent, b.step == .escape, let s = PaneSelect.read(rows: rows), s.kind == .usageLimit,
        ExactText.equal(s.bound, b.bound), ExactText.equal(UsageLimitScreen.limitKey(s.limit ?? .init()), b.limit)
      {
        return nil
      }
      return Refusal("usage_limit")
    }
    switch intent {
    case .usageLimit(let b):
      // after Escape: the menu is gone (checked above), the same limit's headline is still on the pane, and it is the screen the menu-gone read saw
      guard b.step != .escape, let seen = UsageLimitScreen.lastLimit(rows), ExactText.equal(seen, b.limit),
        let idle = b.idle, let now = idleSignature(rows), ExactText.equal(now, idle)
      else { return Refusal("not_usage_limit") }
      switch b.step {
      case .typeModel: return boxRefusal(escaped: all, rows: rows, holds: .empty)
      case .enterModel: return boxRefusal(escaped: all, rows: rows, holds: .ours, text: UsageLimitScreen.modelCommand, slashList: true)
      // Backspaces delete only what Talos typed: the box holds exactly `/model` and nothing else is asked of the screen under it
      case .clearModel: return boxRefusal(escaped: all, rows: rows, holds: .ours, text: UsageLimitScreen.modelCommand, lenient: true)
      case .escape: return Refusal("not_usage_limit")
      }
    case .box(let holds): return boxRefusal(escaped: all, rows: rows, holds: holds)
    case .dialog(let kind):
      return dialogLive(rows, kind) ? nil : Refusal("not_\(kind.rawValue)")
    case .interrupt:
      if let r = boxRefusal(escaped: all, rows: rows, holds: .empty) { return r }
      if selectUp(rows) { return Refusal("prompt_on_pane") }
      return MainStall.hasWorkingLine(rows: rows) ? nil : Refusal("not_working")
    case .interruptBlank:
      if let r = boxRefusal(escaped: all, rows: rows, holds: .empty) { return r }
      if selectUp(rows) { return Refusal("prompt_on_pane") }
      return MainStall.hasWorkingLine(rows: rows) ? Refusal("working_line") : nil
    case .pane(let b):
      // the live screen read whole, and the same one the offer was made for
      guard let s = PaneSelect.read(rows: rows, freeTextAt: b.freeText), s.kind == b.kind,
        ExactText.equal(s.bound, b.bound)
      else { return Refusal("not_\(b.kind.rawValue)") }
      return nil
    case .devWarning(let highlighted, let channels):
      guard let d = devWarning(rows), ExactText.equal(d.highlighted ?? "", highlighted), d.channels == channels else {
        return Refusal("not_\(DialogKind.devChannels.rawValue)")
      }
      return nil
    }
  }

  /// Whether a key meant as `intent` may go to a pane showing `escaped`.
  public static func allows(_ escaped: [String]?, intent: Intent?) -> Bool { refusal(escaped, intent: intent) == nil }

  /// The live region: from the last solid rule down, or the whole pane when there is none (as the start screens are drawn).
  public static func liveRegion(_ rows: [String]) -> [String] {
    guard let rule = rows.lastIndex(where: DialogMatcher.isFrameRule) else { return rows }
    return Array(rows[rule...])
  }

  /// Claude's input box is what is live, empty or holding exactly Talos's line, with only status rows under it.
  /// `text`: what `.ours` means (Talos's pointer line, or `/model` for the usage-limit answer). `slashList`: the rows under the box may be the list of
  /// slash commands Claude Code draws for a typed `/…` (indented rows that all start with `/`), not only status rows. Anything else under the box refuses.
  static func boxRefusal(escaped: [String], rows: [String], holds: BoxHolds, text: String = PointerTyper.text, slashList: Bool = false, lenient: Bool = false) -> Refusal? {
    guard let box = PointerTyper.inputBox(rows: rows) else { return Refusal("no_input_box") }
    // Claude Code draws its box from column 0: its top rule, its pointer row and its bottom rule. A frame drawn indented (by a status
    // line, say) is never the box (the Linux guard's `boxAtColumn0`)
    let atColumn0 = { (i: Int) in rows[i].first.map { $0 != " " } == true }
    guard atColumn0(box.lowerBound - 1), atColumn0(box.lowerBound), atColumn0(box.upperBound) else { return Refusal("box_not_at_column_0") }
    // under the box only Claude Code's own status rows (a rule, a second frame, a menu: none of them is one)
    if !lenient, let strange = BoxFrame.strangeRowUnder(rows, bottomRule: box.upperBound), !(slashList && isSlashList(rows, below: box.upperBound)) {
      return Refusal("row_under_box", row: String(strange.prefix(120)))
    }
    let draft = InputBoxAttributes.draftPresent(escapedRows: escaped)
    switch holds {
    case .empty: return draft == false ? nil : Refusal("box_not_empty")
    case .ours:
      guard draft == true, BoxFrame.exactBoxText(rows, box: box) == text else { return Refusal("box_not_our_line") }
      // the Enter (and the Backspaces with it): also no select or dialog anywhere on the pane, read in this same capture, with nothing
      // awaited between this verdict and the key. A select drawn after this capture is the residual (docs/SECURITY.md); `EnterDetection`
      // looks for it after the Enter. The Linux guard's `prompt_on_pane`.
      // a slash list whose cursor is on exactly `/model` is the one thing under the box that may look like a select (its `❯` row): the prompt check
      // then reads the pane down to the box's bottom rule only
      let checked = slashList && isSlashList(rows, below: box.upperBound) ? Array(rows[...box.upperBound]) : rows
      return !lenient && selectUp(checked) ? Refusal("prompt_on_pane") : nil
    }
  }

  /// Claude's input box on `rows` holds exactly `text` (typed words drawn as Claude draws them), whatever is under it.
  public static func boxHolds(_ rows: [String], _ text: String) -> Bool {
    guard let box = PointerTyper.inputBox(rows: rows.map(InputBoxAttributes.stripEscapes)) else { return false }
    return BoxFrame.exactBoxText(rows.map(InputBoxAttributes.stripEscapes), box: box) == text
  }

  /// Every non-blank row under the box is one of the slash-command list's: indented, at most 8 of them, each starting with `/` (after an optional
  /// cursor mark), AND the Enter would run `/model`: Enter runs the HIGHLIGHTED row, so exactly one row carries the cursor mark and its command (the
  /// first word) is exactly `/model`; with no mark at all, the first row must be exactly `/model`. A cursor on `/memory`, on a project command such as
  /// `/model-x`, or on two rows refuses. Not captured from a real Claude Code yet: a list drawn otherwise refuses the Enter (`row_under_box`, whose
  /// shape is audited) and the typed `/model` is cleared (`UsageStep.clearModel`).
  static func isSlashList(_ rows: [String], below rule: Int) -> Bool {
    let under = rows[(rule + 1)...].filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    guard (1...8).contains(under.count) else { return false }
    var commands: [(word: String, marked: Bool)] = []
    for r in under {
      guard r.first == " " else { return false }
      var t = Substring(r.trimmingCharacters(in: .whitespaces))
      var marked = false
      if t.first == DialogMatcher.Strings.pointer {
        marked = true
        t = t.dropFirst().drop { $0 == " " }
      }
      guard t.first == "/" else { return false }
      commands.append((String(t.prefix { $0 != " " && $0 != "\u{00A0}" }), marked))
    }
    let marks = commands.filter(\.marked)
    if marks.count > 1 { return false }
    if let m = marks.first { return m.word == UsageLimitScreen.modelCommand }
    return commands.first?.word == UsageLimitScreen.modelCommand
  }

  /// The idle prompt as a screen generation: the last three non-blank rows above Claude's input box (its headline, the stopped turn), read after the
  /// menu went. Typing into the box changes nothing above it; a new answer, a new turn or another menu does, and then no key of the answer goes.
  public static func idleSignature(_ rows: [String]) -> String? {
    let plain = rows.map(InputBoxAttributes.stripEscapes)
    guard let box = PointerTyper.inputBox(rows: plain), box.lowerBound >= 1 else { return nil }
    let above = plain[..<(box.lowerBound - 1)].map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard !above.isEmpty else { return nil }
    return above.suffix(3).joined(separator: "\u{1F}")
  }

  /// The shapes of the status parts Talos does not know under Claude's input box on this pane (`BoxFrame.unknownShapes`), for the audit
  /// after a key went. Empty when there is no box or none.
  public static func unknownStatusShapes(_ escaped: [String]) -> [String] {
    let rows = escaped.map(InputBoxAttributes.stripEscapes)
    guard let box = PointerTyper.inputBox(rows: rows) else { return [] }
    return BoxFrame.unknownShapes(rows, bottomRule: box.upperBound)
  }

  /// The shapes of the status parts that refused rows under Claude's input box on this pane (`BoxFrame.refusedShapes`), for the audit
  /// after a key was refused. Empty when there is no box or none.
  public static func refusedStatusShapes(_ escaped: [String]) -> [String] {
    let rows = escaped.map(InputBoxAttributes.stripEscapes)
    guard let box = PointerTyper.inputBox(rows: rows) else { return [] }
    return BoxFrame.refusedShapes(rows, bottomRule: box.upperBound)
  }

  /// A select or dialog is live on the pane, by the whole-pane readers: a live dialog (`DialogMatcher.liveDialog`; the sign-in hint under
  /// a live box is not one an Enter could answer) or a prompt (`PromptDetector`). The usage-limit menu is one too.
  public static func selectUp(_ rows: [String]) -> Bool {
    switch DialogMatcher.liveDialog(rows) {
    case .none, .loginExpired: return PromptDetector.detect(rows) != nil
    default: return true
    }
  }

  /// The live region is exactly the screen `kind`, read by that kind's own exact reader on the region alone.
  static func dialogLive(_ rows: [String], _ kind: DialogKind) -> Bool {
    let region = liveRegion(rows)
    switch kind {
    case .trust: return DialogReader.read(rows: region)?.kind == .trust
    case .mcpConsent: return DialogReader.read(rows: region)?.kind == .mcpConsent
    case .bypass: return DialogReader.read(rows: region)?.kind == .bypass
    case .computerUse: return DialogMatcher.computerUseBlock(region) != nil
    case .devChannels: return devWarning(rows) != nil
    case .theme: return FirstStartScreens.read(region) == .theme
    case .securityNotes: return FirstStartScreens.read(region) == .securityNotes
    case .loginSuccess: return FirstStartScreens.read(region) == .loginSuccess
    case .apiKey: return FirstStartScreens.read(region) == .apiKey
    }
  }

  /// The development-channels warning live in the region, read exactly: one title, one `Channels:` line listing at least one channel and no
  /// empty entry, and the one cursor on one of the warning's own two rows ("I am using this for local development", "Exit"). Counts alone
  /// would let a key land on a row of some other wording. nil: not that warning.
  static func devWarning(_ rows: [String]) -> DialogMatcher.DevChannels? {
    let region = liveRegion(rows)
    guard DialogMatcher.liveDevChannels(region), case .devChannels(let d) = DialogMatcher.classify(region), d.titleCount == 1,
      d.channelLineCount == 1, let channels = d.channels, !channels.isEmpty, !channels.contains(where: \.isEmpty),
      let h = d.highlighted, [DialogMatcher.Strings.devConfirm, DialogMatcher.Strings.devExit].contains(where: { ExactText.equal($0, h) })
    else { return nil }
    return d
  }
}
