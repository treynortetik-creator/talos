import CoreGraphics
import Foundation
import Testing
@testable import TalosDesktopCore

/// The lock screen, the screen saver and the system's password prompts are never offered to an agent: not on the list, not asked
/// about, and while the Mac is locked every screen verb answers in words and does nothing.
@Suite("Screen: a locked Mac and the system security apps")
struct ScreenLockedTests {
  static let lockedText = "The Mac is locked (or the screen saver is on); Talos does nothing until the owner unlocks it. Nothing was done."

  static func system(_ id: String, name: String) -> [String: Any] {
    ["bundle_id": id, "team_id": NSNull(), "requirement": "anchor apple and identifier \"\(id)\"", "name": name, "signer": "apple"]
  }

  // MARK: the deny list

  @Test func theDenyListHoldsTheIdsReadOnThisMac() {
    for id in [
      "com.apple.loginwindow", "com.apple.SecurityAgent", "com.apple.ScreenSaver.Engine", "com.apple.LocalAuthentication.UIAgent",
      "com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent", "com.apple.accessibility.universalAccessAuthWarn",
    ] { #expect(ScreenDenied.contains(id), "\(id)") }
    #expect(ScreenDenied.contains(" COM.APPLE.LOGINWINDOW "))
    #expect(!ScreenDenied.contains("com.example.notes") && !ScreenDenied.contains(nil) && !ScreenDenied.contains(""))
  }

  @Test(arguments: ["com.apple.loginwindow", "com.apple.SecurityAgent"])
  func theAllowStoreRefusesAnOwnerTapForASystemApp(id: String) {
    let app = Self.system(id, name: "System")
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    #expect(s.add(ProofKit.proof(app: app)) == .failure(.proof(.denied)))
    #expect(s.allowedApps().isEmpty)
    #expect(!FileManager.default.fileExists(atPath: h.listPath), "nothing written")
  }

  /// An entry that is in the file anyway (a signed tap that was valid when an older build took it): never read back as allowed.
  @Test func anEntryForASystemAppThatIsSomehowInTheFileIsNotUsed() throws {
    let h = TempHome()
    defer { h.cleanup() }
    let s = h.store()
    _ = try s.add(ProofKit.proof()).get()
    var f = s.read()
    let bad = ProofKit.proof(app: Self.system("com.apple.loginwindow", name: "loginwindow"), cardId: "c_screen2")
    f.entries.append(["bundle_id": "com.apple.loginwindow", "added_at": ISOTime.string(Date().timeIntervalSince1970), "proof": bad.json])
    #expect(s.commit(f, removing: []) == nil)
    let snap = s.snapshot()
    #expect(snap.apps.map(\.bundleID) == ["com.example.notes"])
    #expect(snap.unverified == 1)
  }

  @Test func aListHoldingASystemAppStillDoesNotAllowIt() {
    let signing = FakeSigning()
    let list = ScreenAllowed(
      apps: ["com.apple.loginwindow", "com.apple.SecurityAgent", "com.example.notes"].map { ScreenAllowedApp(bundleID: $0) },
      signing: signing)
    #expect(!list.allows(bundleID: "com.apple.loginwindow", pid: 1))
    #expect(!list.allows(bundleID: "com.apple.SecurityAgent", pid: 2))
    #expect(!list.allowsInstalled(bundleID: "com.apple.loginwindow", appPath: "/Apps/x.app"))
    #expect(list.allows(bundleID: "com.example.notes", pid: 3), "a control: an ordinary entry still works")
  }

  @Test(arguments: ["com.apple.loginwindow", "com.apple.SecurityAgent"])
  func theMacMakesNoConsentRequestForASystemApp(id: String) async throws {
    let signing = FakeSigning()
    let path = "/Apps/\(id).app"
    signing.pathLookups[path] = .signed(
      ScreenCodeIdentity(bundleID: id, teamID: nil, requirement: "anchor apple", name: "System", signer: .apple))
    signing.pathLookups["/Apps/com.example.notes.app"] = .signed(
      ScreenCodeIdentity(bundleID: "com.example.notes", teamID: "ABCDE12345", requirement: "r", name: "Notes Example", signer: .developer))
    let p = ScreenProtocol(service: Fx.core(), allowList: EmptyScreenAllowList(), signing: signing)
    let o = try await answer(p, #"{"op":"open_app","bundle_id":"\#(id)"}"#)
    let e = o["error"] as? [String: Any]
    #expect(e?["code"] as? String == "app_not_allowable")
    #expect(e?["ask"] == nil, "no ask id, so the bridge makes no card")
    // control: an ordinary app off the list does get one
    let c = try await answer(p, #"{"op":"open_app","bundle_id":"com.example.notes"}"#)
    #expect((c["error"] as? [String: Any])?["ask"] is String)
  }

  // MARK: the lock

  /// The dictionary `CGSessionCopyCurrentDictionary()` gave on this Mac while it was locked (macOS 26), user fields left out.
  nonisolated(unsafe) static let realLocked: [String: Any] = [
    "kCGSSessionUserIDKey": 501, "CGSSessionScreenIsLocked": 1, "kCGSSessionLoginwindowSafeLogin": 0, "kCGSSessionGroupIDKey": 20,
    "kCGSessionLoginDoneKey": 1, "kCGSSessionOnConsoleKey": 1, "CGSSessionScreenLockedTime": 1_794_977_115, "kCGSSessionSystemSafeBoot": 0,
  ]

  @Test func theSessionDictionaryDecidesAndFailsClosed() {
    #expect(ScreenLockState.isLocked(session: Self.realLocked))
    var open = Self.realLocked
    open.removeValue(forKey: "CGSSessionScreenIsLocked")
    #expect(!ScreenLockState.isLocked(session: open), "the same session unlocked")
    open["CGSSessionScreenIsLocked"] = 0
    #expect(!ScreenLockState.isLocked(session: open))
    #expect(ScreenLockState.isLocked(session: nil), "unreadable")
    #expect(ScreenLockState.isLocked(session: [:]), "no console key")
    var away = open
    away["kCGSSessionOnConsoleKey"] = 0
    #expect(ScreenLockState.isLocked(session: away), "another user has the console")
    var login = open
    login["kCGSessionLoginDoneKey"] = 0
    #expect(ScreenLockState.isLocked(session: login), "still logging in")
  }

  /// Class 7: one refusal, driven through every verb of the socket, on the real core with fake backends.
  static let verbs: [String] = [
    #"{"op":"shot"}"#, #"{"op":"click","x":10,"y":10}"#, #"{"op":"type","text":"hi"}"#, #"{"op":"key","keys":"cmd+r"}"#,
    #"{"op":"scroll","x":10,"y":10,"dy":-3}"#, #"{"op":"open_app","bundle_id":"com.example.notes"}"#, #"{"op":"apps"}"#,
  ]

  enum Why: CaseIterable { case sessionLocked, loginwindowInFront, screenSaverInFront }

  @Test(arguments: Why.allCases)
  func everyVerbAnswersLockedAndDoesNothing(why: Why) async throws {
    let front: ScreenApp
    switch why {
    case .sessionLocked: front = Fx.notes
    case .loginwindowInFront: front = ScreenApp(bundleID: "com.apple.loginwindow", pid: 88, name: "loginwindow")
    case .screenSaverInFront: front = ScreenApp(bundleID: "com.apple.ScreenSaver.Engine", pid: 89, name: "ScreenSaverEngine")
    }
    let input = FakeInput()
    let capture = FakeCapture(Fx.content(), colours: Fx.colours)
    let apps = FakeApps(front: front)
    var core = Fx.core(capture: capture, input: input, apps: apps)
    core.isLocked = { why == .sessionLocked }
    // everything is allowed, even the system app in front: the answer must not depend on the list
    let list = FixedAllowList(apps: [front.bundleID!, "com.example.notes"].map { ScreenAllowedApp(bundleID: $0) })
    let signing = FakeSigning()
    signing.lookups[front.pid] = .signed(
      ScreenCodeIdentity(bundleID: front.bundleID!, teamID: nil, requirement: "r", name: front.name, signer: .apple))
    let p = ScreenProtocol(service: core, allowList: list, signing: signing)
    for line in Self.verbs {
      let o = try await answer(p, line)
      let e = errorOf(o)
      #expect(o["ok"] as? Bool == false, "\(line)")
      #expect(e.code == "screen_locked", "\(line)")
      #expect(e.text == Self.lockedText, "\(line)")
      #expect(e.text?.contains("Asked") == false)
    }
    #expect(input.posted.isEmpty, "no input posted")
    #expect(capture.plans.isEmpty && capture.contentCalls == 0, "no screen read")
    #expect(apps.opened.isEmpty, "nothing opened")
  }

  /// An unlocked Mac with a system prompt in front: its own code and words, still nothing done, on every verb.
  @Test(arguments: ["com.apple.SecurityAgent", "com.apple.UserNotificationCenter", "com.apple.coreservices.uiagent",
    "com.apple.accessibility.universalAccessAuthWarn"])
  func aSystemPromptInFrontOnAnUnlockedMacIsNotCalledALock(id: String) async throws {
    let front = ScreenApp(bundleID: id, pid: 90, name: "Prompt")
    let input = FakeInput()
    let capture = FakeCapture(Fx.content(), colours: Fx.colours)
    let apps = FakeApps(front: front)
    let core = Fx.core(capture: capture, input: input, apps: apps)  // isLocked = false
    let p = ScreenProtocol(service: core, allowList: EmptyScreenAllowList(), signing: FakeSigning())
    for line in Self.verbs {
      let e = errorOf(try await answer(p, line))
      // open_app and apps run before any app is in front for the gate; they too are refused while the prompt is up
      #expect(e.code == "system_prompt", "\(line)")
      #expect(e.text == "A system prompt (Prompt) is in front; Talos won't act on it. The owner answers it.", "\(line)")
      #expect(e.text?.contains("locked") == false)
    }
    #expect(input.posted.isEmpty && capture.contentCalls == 0 && apps.opened.isEmpty)
  }

  @Test func theSameVerbsWorkWhenTheMacIsUnlocked() async throws {
    let input = FakeInput()
    let apps = FakeApps(front: Fx.notes)
    apps.under = { _ in Fx.notes }
    let core = Fx.core(input: input, apps: apps)  // isLocked = false
    let p = ScreenProtocol(service: core, allowList: FixedAllowList(apps: [ScreenAllowedApp(bundleID: "com.example.notes")]), signing: FakeSigning())
    for line in [Self.verbs[0], Self.verbs[1], Self.verbs[5], Self.verbs[6]] {
      #expect(try await answer(p, line)["ok"] as? Bool == true, "\(line)")
    }
    #expect(!input.posted.isEmpty && apps.opened == ["com.example.notes"])
  }

  /// The lock comes down in the middle of typing: the rest is not sent.
  @Test func aLockThatComesDownMidTypingStopsTheRest() throws {
    let input = FakeInput()
    var core = Fx.core(input: input)
    let count = Locked()
    input.after = { _ in count.lock() }
    core.isLocked = { count.isLocked }
    #expect(throws: ScreenRefusal.screenLocked) { try core.perform(.type(String(repeating: "a", count: 40)), allowedBundleIDs: ["com.example.notes"]) }
    #expect(input.posted.count == 1)
  }
}

private final class Locked: @unchecked Sendable {
  private let l = NSLock()
  private var v = false
  var isLocked: Bool { l.withLock { v } }
  func lock() { l.withLock { v = true } }
}
