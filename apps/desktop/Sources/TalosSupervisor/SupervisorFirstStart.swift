import Foundation
import TalosDesktopCore

/// Main's first start: the screens a fresh Claude Code shows before its input box (`FirstStartScreens`, the Mac twin of Linux's first-start.ts).
///
/// - Theme, security notes and "Login successful. Press Enter to continue": a look, nothing more. ONE Enter per kind per start, through the key
///   guard (`sendKey(.dialog(kind))`: the live screen must be exactly that screen), never while a client may be typing, never on the usage-limit
///   screen. A screen that wants more than an Enter (a question, a word about terms or accepting) is not read as one of these.
/// - Login method and the paste-code screen are a sign-in: they raise the "sign in" needs-you (the Sign in to Claude again window answers it,
///   `SignInCardController`). Nothing is typed there by this file.
/// - The API-key question is a Mac popup, "Use this key" / "Don't use it" (`apiKeyOffer`). Only a real human click on its buttons reaches
///   `apiKeyClick` (`NeedsYouPopupView.isRealClick` drops every other press before the controller hears of it), so no agent or synthetic input
///   answers it; the key goes through the same guard, one arrow at a time from a fresh read.
extension Supervisor {
  public static let signInLabel = "sign in"
  public static let apiKeyLabel = "api key"
  static let apiKeyLifetime: Double = 900

  /// The pane shows the real sign-in: a first-start login screen, or Claude's own `Not logged in · Run /login` hint under its live input box
  /// (`DialogMatcher.liveDialog`: the row below the last rule, not a word anywhere). A transcript that quotes it is not this.
  func signInIsLive() -> Bool {
    guard let rows = host.visibleRows() else { return false }
    let first = FirstStartScreens.read(rows)
    return first == .loginMethod || first == .oauthPaste || FirstStartScreens.notLoggedInHint(rows) || DialogMatcher.liveDialog(rows) == .loginExpired
  }

  func mainFirstStart(_ rows: [String], launch l: inout Launch) {
    guard phase == .starting else { return }
    let s = FirstStartScreens.read(rows)
    if s != .apiKey, l.apiKeyOffer != nil { endApiKeyOffer(&l) }
    switch s {
    case .none:
      return
    case .theme, .securityNotes, .loginSuccess:
      guard FirstStartScreens.autoEnter(s), !l.firstStartEntered.contains(s.rawValue) else { return }
      // a key goes into a screen: "I could not look" is not "nobody is typing"
      guard !clientsMayBeTyping(), !DialogMatcher.takesNoKeys(rows) else { return }
      let kind: KeyGuard.DialogKind = s == .theme ? .theme : s == .securityNotes ? .securityNotes : .loginSuccess
      switch sendKey(.dialog(kind), { $0.send(keys: [0x0d]) }) {
      case .refused: return  // the live screen was not exactly it: the next look decides again
      case .failed:
        audit("first_start_send_failed", ["session": l.sessionId, "screen": s.rawValue])  // nothing arrived: not counted
      default:
        l.firstStartEntered.insert(s.rawValue)  // a timeout may have been delivered: never twice
        audit("first_start_enter", ["session": l.sessionId, "screen": s.rawValue])
      }
    case .loginMethod, .oauthPaste:
      raiseNeedsYou(.dialog(Self.signInLabel), key: "first-start:sign-in", launch: &l)
    case .apiKey:
      raiseNeedsYou(.dialog(Self.apiKeyLabel), key: "first-start:api-key", launch: &l)
      offerApiKey(rows, launch: &l)
    }
  }

  private func offerApiKey(_ rows: [String], launch l: inout Launch) {
    let seen = options.wallClock() / 1000
    if let o = l.apiKeyOffer, let expires = ISOTime.parse(o.expires_at), seen < expires { return }
    guard let card = ApiKeyCard.card(rows: rows) else { return }
    let o = DialogOffer(
      id: DialogOffer.newId(), kind: .apiKey, subject: card.subject.map { String($0.prefix(500)) }, options: card.buttons, cursor: nil,
      seen_at: ISOTime.string(seen), expires_at: ISOTime.string(seen + Self.apiKeyLifetime))
    guard o.isValid else { return }
    l.apiKeyOffer = o
    l.apiKeyPressedFor = nil
    audit("api_key_card_offered", ["session": l.sessionId])
  }

  func endApiKeyOffer(_ l: inout Launch) {
    l.apiKeyOffer = nil
    if case .dialog(let n)? = needsYou, n == Self.apiKeyLabel { needsYou = nil }
  }

  /// The popup item for the API-key question, while it is offered and not past its time.
  func apiKeyPopupItem() -> NeedsYouPopupItem? {
    guard let d = status.apiKeyDialog, d.isValid, (ISOTime.parse(d.expires_at) ?? 0) > options.wallClock() / 1000 else { return nil }
    return NeedsYouPopupItem(thread: Self.mainPopupThread, threadName: "Main", dialog: d, phoneTold: false, first: true)
  }

  /// A click on "Use this key" (0) or "Don't use it" (1), after the popup layer has checked it was the owner's own hand. One key per
  /// sighting: the arrow toward the chosen row from a fresh read, then Enter once it is the highlighted row; anything else sends nothing more.
  func apiKeyClick(_ choiceIndex: Int, label: String, offer: DialogOffer, launch l: inout Launch) -> PopupAnswerResult {
    guard offer.kind == .apiKey, offer.options.indices.contains(choiceIndex), ExactText.equal(offer.options[choiceIndex], label) else {
      return .nothing(.screenChanged)
    }
    guard l.apiKeyPressedFor != offer.id else { return .nothing(.alreadyAnswered(by: nil)) }
    guard !clientsMayBeTyping() else { return .nothing(.typing) }
    let choice: ApiKeyCard.Choice = choiceIndex == 0 ? .use : .dontUse
    for _ in 0..<4 {
      guard let rows = host.visibleRows(), !DialogMatcher.takesNoKeys(rows) else { return .nothing(.couldNotCheck) }
      guard case .key(let k) = ApiKeyCard.step(choice, rows: rows) else { return .nothing(.screenChanged) }
      let dk: DialogKey = k == .enter ? .enter : k == .up ? .up : .down
      let sent = sendKey(.dialog(.apiKey)) { $0.sendDialogKey(dk) }
      if sent == .refused { return .nothing(.screenChanged) }
      if sent == .failed { return .nothing(.screenChanged) }
      if k == .enter {
        l.apiKeyPressedFor = offer.id
        audit("api_key_answered", ["session": l.sessionId, "choice": choice == .use ? "use" : "dont_use"])
        l.apiKeyOffer = nil
        return .pressed(choice: choiceIndex, label: label)
      }
      usleep(150_000)  // the arrow shows on the next draw; the loop reads the screen again before any further key
    }
    return .nothing(.screenChanged)
  }
}
