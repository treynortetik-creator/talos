import Foundation

/// The screens a fresh Claude Code shows before its input box, read the way Linux's first-start.ts reads them (the two share the captures in
/// Tests/Fixtures/real-first-start-2.1.322). A look is answered with Enter by Talos (`autoEnter`: the theme, the security notes, "Login
/// successful"); a sign-in or a question about a key is the owner's: the login method and the paste-code screen go into the Sign in to Claude
/// flow (`ClaudeLoginSession`), and the API-key question is a card with Use / Don't use that only a real click answers (`ApiKeyCard`).
/// Anything not read exactly is `.none`, never answered.
public enum FirstStartScreens {
  public enum Screen: String, Equatable, Sendable {
    case theme
    case securityNotes = "security_notes"
    case loginSuccess = "login_success"
    case loginMethod = "login_method"
    case oauthPaste = "oauth_paste"
    case apiKey = "api_key"
    case none
  }

  public enum Strings {
    public static let themeTitle = "Choose the text style that looks best with your terminal"
    public static let themeHint = "To change this later, run /theme"
    public static let themeOptions = [
      "Auto (match terminal)", "Dark mode", "Light mode", "Dark mode (colorblind-friendly)", "Light mode (colorblind-friendly)",
      "Dark mode (ANSI colors only)", "Light mode (ANSI colors only)",
    ]
    public static let notesTitle = "Security notes:"
    public static let notesContinue = "Press Enter to continue\u{2026}"
    public static let loginMethod = "Select login method:"
    public static let oauth = ["Paste code here if prompted", "Browser didn't open? Use the url below to sign in"]
    public static let apiKey = ["Detected a custom API key in your environment", "Do you want to use this API key?"]
    public static let loginSuccess = "Login successful"
  }

  /// Whether Talos presses Enter on this screen itself (it is a look, nothing more).
  public static func autoEnter(_ s: Screen) -> Bool { s == .theme || s == .securityNotes || s == .loginSuccess }

  private static func highlighted(_ r: String) -> Bool { r.first == DialogMatcher.Strings.pointer }

  /// A row's option label: the cursor, a `1. ` index and the check mark of the current choice removed.
  static func label(_ r: String) -> String {
    var s = Substring(highlighted(r) ? String(r.dropFirst()) : r).trimmingCharacters(in: .whitespaces)
    if let dot = s.firstIndex(of: "."), !s[..<dot].isEmpty, s[..<dot].allSatisfy(\.isNumber) {
      s = String(s[s.index(after: dot)...]).trimmingCharacters(in: .whitespaces)
    }
    if s.hasPrefix("\u{2714} ") { s = String(s.dropFirst(2)) }
    return s.trimmingCharacters(in: .whitespaces)
  }

  /// The first-start screen on `rows` (the whole visible pane).
  public static func read(_ rows: [String]) -> Screen {
    // these screens come before the input box: with one up, any such words are the conversation's
    if PointerTyper.inputBox(rows: rows) != nil { return .none }
    let cleaned = rows.map(DialogMatcher.clean).filter { !$0.isEmpty }
    guard !cleaned.isEmpty else { return .none }
    let cursors = cleaned.filter(highlighted).count
    // the notes: the title, and the continue line as the last row with text; no cursor, no question, no word about agreeing to anything
    if let n = cleaned.firstIndex(of: Strings.notesTitle), cleaned.last == Strings.notesContinue {
      let asks = cleaned[n...].contains { r in
        highlighted(r) || r.contains("?")
          || ["terms", "permission", "accept", "agree", "consent"].contains { r.lowercased().contains($0) }
      }
      return asks ? .none : .securityNotes
    }
    // "Login successful. Press Enter to continue…": that row alone (or it with the title row above it), no cursor, no question
    if cursors == 0, cleaned.count <= 2, cleaned.last?.hasSuffix("Press Enter to continue\u{2026}") == true,
      cleaned.contains(where: { $0.hasPrefix(Strings.loginSuccess) }), !cleaned.contains(where: { $0.contains("?") }),
      cleaned.allSatisfy({ $0.hasPrefix(Strings.loginSuccess) || $0 == Strings.notesContinue })
    {
      return .loginSuccess
    }
    if cleaned.contains(where: { r in Strings.oauth.contains { r.hasPrefix($0) } }) { return .oauthPaste }
    if cleaned.contains(Strings.loginMethod) { return .loginMethod }
    if Strings.apiKey.allSatisfy(cleaned.contains), cursors == 1 { return .apiKey }
    if let t = cleaned.firstIndex(of: Strings.themeTitle), t + 1 < cleaned.count, cleaned[t + 1] == Strings.themeHint, cursors == 1 {
      let start = t + 2
      guard let h = cleaned.firstIndex(where: highlighted), h >= start, h < start + Strings.themeOptions.count,
        cleaned.count >= start + Strings.themeOptions.count
      else { return .none }
      let options = cleaned[start..<(start + Strings.themeOptions.count)].map(label)
      return options == Strings.themeOptions ? .theme : .none
    }
    return .none
  }

  /// Claude Code says it is not signed in (2.1.322, Tests/Fixtures/real-first-start-2.1.322/not-logged-in.txt): its input box is up, with at
  /// most its footer under it, and the row just above the box's top rule is right-aligned and ends with `Not logged in · Run /login`. Only
  /// that row counts, never the same words in a conversation or a tool's output (the Linux twin is `notLoggedIn` in oauth-token.ts).
  public static func notLoggedInHint(_ rows: [String]) -> Bool {
    guard DialogMatcher.liveDialog(rows) == .none, let box = PointerTyper.inputBox(rows: rows), box.lowerBound >= 2 else { return false }
    guard rows[(box.upperBound + 1)...].filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty }).count <= 3 else { return false }
    let above = rows[box.lowerBound - 2]
    guard above.hasPrefix(String(repeating: " ", count: 20)) else { return false }
    return above.trimmingCharacters(in: .whitespaces).hasSuffix("Not logged in \u{00B7} Run /login")
  }

  /// The key that brings the cursor to the row labelled `wanted` (Enter once it is there), or nil when that row, or the cursor, is not
  /// exactly one row on screen.
  public static func keyToward(_ rows: [String], wanted: (String) -> Bool) -> Key? {
    let cleaned = rows.map(DialogMatcher.clean).filter { !$0.isEmpty }
    let h = cleaned.indices.filter { highlighted(cleaned[$0]) }
    let w = cleaned.indices.filter { wanted(label(cleaned[$0])) }
    guard h.count == 1, w.count == 1 else { return nil }
    return h[0] == w[0] ? .enter : w[0] > h[0] ? .down : .up
  }

  public enum Key: Equatable, Sendable { case up, down, enter }
}

/// The API-key question ("Detected a custom API key in your environment. Do you want to use this API key?") as a card. Its only buttons are
/// the Needs-you popup's (`NeedsYouPopupView`), whose action runs only for a real human click (`PopupClickCheck.isRealClick`: an Accessibility
/// press, a posted event, a stale click or one off the button is dropped there), so no agent answers it. This file picks the keys: one arrow at
/// a time toward the chosen row from a fresh read, Enter only when it is the highlighted one. Claude Code's own default is "No (recommended)",
/// so Talos never presses "Yes" except for the owner's click.
public enum ApiKeyCard {
  public enum Choice: Equatable, Sendable { case use, dontUse }
  public enum Refusal: Equatable, Sendable { case screenChanged }
  public enum Step: Equatable, Sendable {
    case key(FirstStartScreens.Key)
    case refused(Refusal)
  }

  public struct Card: Equatable, Sendable {
    public var title: String
    public var subject: String?
    public var buttons: [String]
  }

  public static let title = "Use the API key from your environment?"
  public static let buttons = ["Use this key", "Don't use it"]

  /// The card for the screen, or nil when the question is not on it. The subject is the row naming the variable and the key as Claude Code
  /// itself abbreviates it (never more of the key than the screen shows).
  public static func card(rows: [String]) -> Card? {
    guard FirstStartScreens.read(rows) == .apiKey else { return nil }
    let cleaned = rows.map(DialogMatcher.clean)
    let subject = cleaned.first { $0.hasPrefix("ANTHROPIC_API_KEY") || $0.contains("_API_KEY:") }
    return Card(title: title, subject: subject, buttons: buttons)
  }

  private static func wanted(_ c: Choice) -> (String) -> Bool {
    switch c {
    case .use: return { $0 == "Yes" }
    case .dontUse: return { $0.hasPrefix("No") }
    }
  }

  /// The next key toward the chosen row, from a fresh read (an arrow is only ever followed by Enter once the wanted row is the highlighted one).
  public static func step(_ c: Choice, rows: [String]) -> Step {
    guard FirstStartScreens.read(rows) == .apiKey, let k = FirstStartScreens.keyToward(rows, wanted: wanted(c)) else {
      return .refused(.screenChanged)
    }
    return .key(k)
  }
}
