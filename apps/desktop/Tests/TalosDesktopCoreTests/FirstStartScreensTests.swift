import Foundation
import Testing

@testable import TalosDesktopCore

/// The first-start screens Claude Code shows before its input box (Linux's first-start.ts, now on the Mac): read from the real 2.1.322
/// captures, answered only where the answer is a look (theme, security notes, login success), never where it is the owner's (login method,
/// the paste-code screen, the API-key question).
@Suite("FirstStartScreens")
struct FirstStartScreensTests {
  static let real = "real-first-start-2.1.322"
  static func rows(_ n: String) throws -> [String] { try RealScreens.rows(n, in: real) }
  static func synth(_ n: String) throws -> [String] { try RealScreens.rows(n, in: "synthetic") }

  @Test func theTwoRealScreensThatNeedOnlyAnEnterAreRead() throws {
    #expect(FirstStartScreens.read(try Self.rows("theme")) == .theme)
    #expect(FirstStartScreens.read(try Self.rows("security-notes")) == .securityNotes)
  }

  @Test func theSignInScreensAreNamedAndTheApiKeyQuestionToo() throws {
    #expect(FirstStartScreens.read(try Self.rows("login-method")) == .loginMethod)
    #expect(FirstStartScreens.read(try Self.rows("api-key")) == .apiKey)
    #expect(FirstStartScreens.read(try Self.synth("first-start-oauth-paste")) == .oauthPaste)
    #expect(FirstStartScreens.read(try Self.synth("first-start-login-success")) == .loginSuccess)
  }

  @Test func screensThatAreNotFirstStartAreNone() throws {
    for n in ["trust", "mcp-consent", "not-logged-in", "ready-auto-notice", "token-refused-401"] {
      #expect(FirstStartScreens.read(try Self.rows(n)) == .none, "\(n)")
    }
  }

  @Test func onlyTheLooksAreAutoAnswered() {
    #expect(FirstStartScreens.autoEnter(.theme) && FirstStartScreens.autoEnter(.securityNotes) && FirstStartScreens.autoEnter(.loginSuccess))
    for s: FirstStartScreens.Screen in [.loginMethod, .oauthPaste, .apiKey, .none] { #expect(!FirstStartScreens.autoEnter(s), "\(s)") }
  }

  @Test func theSecurityNotesAreAnsweredOnlyWhenExactlyThatScreen() throws {
    let notes = try Self.rows("security-notes")
    // a question, a word about terms or accepting, or a cursor: the owner reads it
    for extra in ["Do you accept the new terms?", "You agree to the Terms of Service", "❯ 1. Continue"] {
      let altered = notes.dropLast(3) + [" " + extra, " Press Enter to continue…"]
      #expect(FirstStartScreens.read(Array(altered)) != .securityNotes, Comment(rawValue: extra))
    }
    // the same words in a transcript above a live input box are conversation
    let box = [String(repeating: "─", count: 60), "❯ ", String(repeating: "─", count: 60)]
    #expect(FirstStartScreens.read(notes + box) == .none)
  }

  @Test func loginSuccessIsOnlyTheExactScreen() throws {
    #expect(FirstStartScreens.read([" Login successful. Press Enter to continue…"]) == .loginSuccess)
    #expect(FirstStartScreens.read(["Login successful. Do you want to share usage data?", "Press Enter to continue…"]) != .loginSuccess)
    #expect(FirstStartScreens.read(["Login successful", "and then some other text"]) == .none)
    #expect(FirstStartScreens.read(["❯ Login successful. Press Enter to continue…"]) != .loginSuccess)
  }

  @Test func theNotLoggedInHintIsOnlyTheRowAboveTheLiveBox() throws {
    #expect(FirstStartScreens.notLoggedInHint(try Self.rows("not-logged-in")), "the real 2.1.322 capture")
    for n in ["ready-auto-notice", "trust", "login-method", "token-refused-401"] {
      #expect(!FirstStartScreens.notLoggedInHint(try Self.rows(n)), Comment(rawValue: n))
    }
    let box = [String(repeating: "─", count: 60), "❯ ", String(repeating: "─", count: 60)]
    // the same words in a conversation, left-aligned or in a tool's output above a signed-in box
    #expect(!FirstStartScreens.notLoggedInHint([" ● It printed: Not logged in · Run /login", ""] + box))
    #expect(!FirstStartScreens.notLoggedInHint(["  ● Please run /login · API Error: 401", ""] + box))
    #expect(!FirstStartScreens.notLoggedInHint(["Not logged in · Run /login", ""] + box))
    // right-aligned, but no box under it
    #expect(!FirstStartScreens.notLoggedInHint([String(repeating: " ", count: 60) + "Not logged in · Run /login", "", "plain text"]))
  }

  @Test func theKeyGuardAllowsTheEnterOnlyOnItsOwnScreen() throws {
    let theme = try Self.rows("theme")
    let notes = try Self.rows("security-notes")
    let success = try Self.synth("first-start-login-success")
    #expect(KeyGuard.allows(theme, intent: .dialog(.theme)))
    #expect(KeyGuard.allows(notes, intent: .dialog(.securityNotes)))
    #expect(KeyGuard.allows(success, intent: .dialog(.loginSuccess)))
    #expect(!KeyGuard.allows(notes, intent: .dialog(.theme)))
    #expect(!KeyGuard.allows(theme, intent: .dialog(.loginSuccess)))
    for n in ["login-method", "api-key", "trust", "mcp-consent", "not-logged-in"] {
      for k in [KeyGuard.DialogKind.theme, .securityNotes, .loginSuccess] {
        #expect(!KeyGuard.allows(try Self.rows(n), intent: .dialog(k)), "\(n) \(k)")
      }
    }
  }
}

/// The API-key question: a card with Use / Don't use that only a real human click answers.
@Suite("ApiKeyCard")
struct ApiKeyCardTests {
  static func rows() -> [String] { try! FirstStartScreensTests.rows("api-key") }

  @Test func theNextKeyIsOneArrowTowardTheChosenRowAndEnterOnlyThere() throws {
    // the cursor starts on "No (recommended)", Claude Code's own default: "Don't use it" is Enter, "Use this key" is one arrow up first
    #expect(ApiKeyCard.step(.dontUse, rows: Self.rows()) == .key(.enter))
    #expect(ApiKeyCard.step(.use, rows: Self.rows()) == .key(.up))
    var moved = Self.rows()
    let i = moved.firstIndex { $0.contains("Yes") }!, j = moved.firstIndex { $0.contains("No (recommended)") }!
    moved[i] = moved[i].replacingOccurrences(of: "    Yes", with: "  ❯ Yes")
    moved[j] = moved[j].replacingOccurrences(of: "❯ No", with: "  No")
    #expect(ApiKeyCard.step(.use, rows: moved) == .key(.enter))
    #expect(ApiKeyCard.step(.dontUse, rows: moved) == .key(.down))
  }

  @Test func noKeysWhenTheScreenIsNotTheQuestionAnyMore() throws {
    let other = try FirstStartScreensTests.rows("login-method")
    #expect(ApiKeyCard.step(.use, rows: other) == .refused(.screenChanged))
    #expect(ApiKeyCard.step(.use, rows: []) == .refused(.screenChanged))
    // two cursors, or none: never a guess
    var two = Self.rows()
    two = two.map { $0.replacingOccurrences(of: "    Yes", with: "  ❯ Yes") }
    #expect(ApiKeyCard.step(.use, rows: two) == .refused(.screenChanged))
  }

  @Test func theCardNamesTheKeyAsTheScreenShowsItAndNothingMore() throws {
    let card = try #require(ApiKeyCard.card(rows: Self.rows()))
    #expect(card.title == "Use the API key from your environment?")
    #expect(card.buttons == ["Use this key", "Don't use it"])
    #expect(card.subject == "ANTHROPIC_API_KEY: sk-ant-...00000000000000000000")
    #expect(ApiKeyCard.card(rows: try FirstStartScreensTests.rows("login-method")) == nil)
  }
}
