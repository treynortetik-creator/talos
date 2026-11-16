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
///   region (from the last solid rule down, or the whole pane when there is none): `DialogReader` for folder trust and MCP consent (the tap
///   answerer), the live warning for the development channels, the exact block for the computer-use permission dialog (its one Escape).
///   A phrase on screen never names anything by itself.
/// - `.devWarning(highlighted, channels)`: Main's auto-accept and its card and popup. The development-channels warning, with the cursor on
///   exactly the row the sender read and exactly the channel list it checked (`devWarning`): counts alone never name the row a key lands on.
/// - And, independently, never a key while Claude Code's usage-limit menu is anywhere on the pane (`UsageLimitScreen`), nor when the pane
///   cannot be read, nor with no intent stated.
public enum KeyGuard {
  public enum BoxHolds: String, Sendable { case empty, ours }

  /// The screens a key may be meant for. The Mac has no first-start answerer (Linux's theme and security notes) and Linux has no
  /// computer-use dialog; the rest are the same names.
  public enum DialogKind: String, Sendable, CaseIterable {
    case trust
    case mcpConsent = "mcp_consent"
    case devChannels = "dev_channels"
    case computerUse = "computer_use"
  }

  /// What the sender means to press: the screen must be exactly this.
  public enum Intent: Equatable, Sendable {
    case box(BoxHolds)
    case dialog(DialogKind)
    /// The development-channels warning with the cursor on exactly `highlighted` (one of its two rows) and exactly `channels` on its
    /// `Channels:` line: the key lands on the row the sender read, for the launch the sender checked (Main's auto-accept and its card).
    case devWarning(highlighted: String, channels: [String])

    /// For the audit: `box-empty`, `box-ours` or the dialog kind's name.
    public var name: String {
      switch self {
      case .box(let h): return "box-\(h.rawValue)"
      case .dialog(let k): return k.rawValue
      case .devWarning: return DialogKind.devChannels.rawValue
      }
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
    if UsageLimitScreen.read(rows) != nil { return Refusal("usage_limit") }
    switch intent {
    case .box(let holds): return boxRefusal(escaped: all, rows: rows, holds: holds)
    case .dialog(let kind):
      return dialogLive(rows, kind) ? nil : Refusal("not_\(kind.rawValue)")
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
  static func boxRefusal(escaped: [String], rows: [String], holds: BoxHolds) -> Refusal? {
    guard let box = PointerTyper.inputBox(rows: rows) else { return Refusal("no_input_box") }
    // Claude Code draws its box from column 0: its top rule, its pointer row and its bottom rule. A frame drawn indented (by a status
    // line, say) is never the box (the Linux guard's `boxAtColumn0`)
    let atColumn0 = { (i: Int) in rows[i].first.map { $0 != " " } == true }
    guard atColumn0(box.lowerBound - 1), atColumn0(box.lowerBound), atColumn0(box.upperBound) else { return Refusal("box_not_at_column_0") }
    // under the box only Claude Code's own status rows (a rule, a second frame, a menu: none of them is one)
    if let strange = BoxFrame.strangeRowUnder(rows, bottomRule: box.upperBound) {
      return Refusal("row_under_box", row: String(strange.prefix(120)))
    }
    let draft = InputBoxAttributes.draftPresent(escapedRows: escaped)
    switch holds {
    case .empty: return draft == false ? nil : Refusal("box_not_empty")
    case .ours:
      guard draft == true, BoxFrame.exactBoxText(rows, box: box) == PointerTyper.text else { return Refusal("box_not_our_line") }
      // the Enter (and the Backspaces with it): also no select or dialog anywhere on the pane, read in this same capture, with nothing
      // awaited between this verdict and the key. A select drawn after this capture is the residual (docs/SECURITY.md); `EnterDetection`
      // looks for it after the Enter. The Linux guard's `prompt_on_pane`.
      return selectUp(rows) ? Refusal("prompt_on_pane") : nil
    }
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
    case .computerUse: return DialogMatcher.computerUseBlock(region) != nil
    case .devChannels: return devWarning(rows) != nil
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
