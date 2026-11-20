import Foundation
import Testing
import TalosDesktopCore
@testable import TalosSupervisor
import TalosTestSupport

/// Main's first start on the Mac, against a fake `claude` that draws the REAL 2.1.322 first-start captures (theme, security notes) and a
/// hand-written login-success screen, and logs every key it gets. The three looks each get exactly one Enter; a sign-in screen gets nothing
/// and raises "sign in" (the app's own window, never a terminal); the API-key question gets a key only through the popup's click path.
final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var v: PopupAnswerResult?
  var value: PopupAnswerResult? {
    get { lock.withLock { v } }
    set { lock.withLock { v = newValue } }
  }
}

@Suite("Main first-start screens", .serialized, .enabled(if: Rig.hasTmux))
struct MainFirstStartTests {
  @Test func theThreeLooksEachGetOneEnterAndNothingElse() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "main-first-start.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_FS_END": "ready"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(25) { keys.keys == ["ENTER", "ENTER", "ENTER"] }, "keys: \(keys.keys) audit: \(r.audit)")
    for screen in ["theme", "security_notes", "login_success"] {
      #expect(r.audit.contains("first_start_enter"), "audit: \(r.audit)")
      #expect(r.audit.contains("screen=\(screen)"), "\(screen) audit: \(r.audit)")
    }
    Thread.sleep(forTimeInterval: 1.5)
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER"], "no second Enter for any of them: \(keys.keys)")
  }

  @Test func aSignInScreenGetsNoKeyAndRaisesSignInNotTerminals() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "main-first-start.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_FS_END": "login-method"])
    defer { r.teardown() }
    r.start()
    let label = Supervisor.signInLabel
    #expect(r.wait(25) { r.sup.status.needsYou == .dialog(label) }, "\(String(describing: r.sup.status.needsYou)) audit: \(r.audit)")
    #expect(r.allEvents.contains(.openSignIn))
    Thread.sleep(forTimeInterval: 1.0)
    #expect(!r.allEvents.contains(.openTerminal), "the sign-in is the app's own window: \(r.allEvents)")
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER"], "only the three looks before it, nothing on the sign-in screen: \(keys.keys)")
    #expect(FirstStartCheck.state(r.sup.status) == .signIn)
  }

  /// The sign-in card is for the real signed-out screen only: Claude's hint under its live box opens it (shown, never started), and a
  /// conversation that quotes "Run /login" does not.
  @Test func theSignInCardOpensForTheRealHintAndNotForQuotedWords() throws {
    var t = Rig.defaultTimings()
    t.dialogStall = 0
    for (mode, want) in [("login-hint", true), ("quote", false)] {
      let keys = KeyLog()
      defer { keys.remove() }
      let r = try Rig(.tmux, scenario: "main-first-start.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_FS_END": mode], timings: t)
      defer { r.teardown() }
      r.start()
      #expect(r.wait(25) { keys.keys == ["ENTER", "ENTER", "ENTER"] }, "\(mode) keys: \(keys.keys)")
      if want {
        #expect(r.wait(20) { r.allEvents.contains(.openSignIn) }, "\(mode) events: \(r.allEvents) audit: \(r.audit)")
      } else {
        Thread.sleep(forTimeInterval: 4)
        #expect(!r.allEvents.contains(.openSignIn), "quoted words opened the card: \(r.allEvents)")
      }
      #expect(!r.allEvents.contains(.openTerminal), "\(mode)")
    }
  }

  @Test func theApiKeyQuestionIsAPopupAndOnlyItsClickPressesAnything() throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(.tmux, scenario: "main-first-start.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_FS_END": "api-key"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(25) { r.sup.apiKeyPopupItem() != nil }, "audit: \(r.audit)")
    let item = try #require(r.sup.apiKeyPopupItem())
    let content = NeedsYouPopupContent.make(item)
    #expect(content.title == "Use the API key from your environment?")
    #expect(content.buttons.map(\.text) == ["Use this key", "Don't use it"])
    #expect(FirstStartCheck.state(r.sup.status) == .apiKeyQuestion)
    Thread.sleep(forTimeInterval: 1.5)
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER"], "nothing is pressed on the question by itself: \(keys.keys)")
    #expect(!r.allEvents.contains(.openTerminal))
    // a click that names another label (the screen or the offer changed) presses nothing
    let box = ResultBox()
    r.sup.popupAnswerMain(dialogId: item.dialog.id, action: .choose(0, label: "Yes")) { box.value = $0 }
    #expect(r.wait(5) { box.value != nil })
    #expect(box.value == .nothing(.screenChanged))
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER"])
    // "Use this key": one arrow up to Yes, read again, then Enter, once
    box.value = nil
    r.sup.popupAnswerMain(dialogId: item.dialog.id, action: .choose(0, label: "Use this key")) { box.value = $0 }
    #expect(r.wait(10) { box.value != nil })
    #expect(box.value == .pressed(choice: 0, label: "Use this key"), "\(String(describing: box.value)) audit: \(r.audit)")
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER", "UP", "ENTER"], "\(keys.keys)")
    #expect(FileManager.default.fileExists(atPath: r.stateDir + "/api-answered-yes"))
    // the same offer answered again presses nothing
    box.value = nil
    r.sup.popupAnswerMain(dialogId: item.dialog.id, action: .choose(1, label: "Don't use it")) { box.value = $0 }
    #expect(r.wait(5) { box.value != nil })
    #expect(box.value == .nothing(.notOffered), "\(String(describing: box.value))")
    #expect(keys.keys == ["ENTER", "ENTER", "ENTER", "UP", "ENTER"], "\(keys.keys)")
  }
}
