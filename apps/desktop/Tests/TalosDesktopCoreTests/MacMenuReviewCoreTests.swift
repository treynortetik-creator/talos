import Foundation
import Testing

@testable import TalosDesktopCore

// Review fixes on fix/mac-settings-menu: drafts vs Adopt, the sign-in text, the Quit & Reopen rescue, the Dock policy.

@Suite("Settings drafts: commit, then Adopt")
struct SettingsDraftsCommitTests {
  func cfg(dir: String, relay: String = "https://relay.example.com") -> DesktopConfig {
    var c = DesktopConfig.defaults
    c.agentDir = dir
    c.relayUrl = relay
    return c
  }

  @Test func aFolderSavedWithReturnIsFollowedByALaterAdopt() {
    var d = SettingsDrafts(from: .defaults)
    d.dir = "/home/alex/x"  // typed, Return pressed: written to the config
    d.saved(cfg(dir: "/home/alex/x"))
    d.follow(cfg(dir: "/home/alex/real"))  // Adopt
    #expect(d.dir == "/home/alex/real", "a committed value is not unsaved typing")
    #expect(d.pending(against: cfg(dir: "/home/alex/real")).dir == nil, "closing Settings writes nothing")
  }

  @Test func aBoxLeftUnsavedAtAdoptTimeDoesNotOverwriteTheAdoptOnClose() {
    var d = SettingsDrafts(from: .defaults)
    d.dir = "/home/alex/half"  // typed, never saved
    d.follow(cfg(dir: "/home/alex/real"))  // Adopt
    #expect(d.dir == "/home/alex/half", "he is still typing: the box is left alone")
    #expect(d.pending(against: cfg(dir: "/home/alex/real")).dir == nil, "but closing does not undo the Adopt")
  }

  @Test func typingAgainAfterAnAdoptDoesSave() {
    var d = SettingsDrafts(from: .defaults)
    d.dir = "/home/alex/half"
    d.follow(cfg(dir: "/home/alex/real"))
    d.dir = "/home/alex/chosen"
    #expect(d.pending(against: cfg(dir: "/home/alex/real")).dir == "/home/alex/chosen")
  }

  @Test func anEditedBoxThatNothingOvertookIsSaved() {
    var d = SettingsDrafts(from: .defaults)
    d.relay = "https://relay.new.example.com"
    let p = d.pending(against: .defaults)
    #expect(p.relay == "https://relay.new.example.com" && p.dir == nil && p.cli == nil)
  }

  @Test func everyBoxFollowsAfterASaveAndAnImport() {
    var d = SettingsDrafts(from: .defaults)
    d.relay = "https://a.example.com"
    d.saved(cfg(dir: "~/talos-agent", relay: "https://a.example.com"))
    var c = cfg(dir: "/home/alex/agent", relay: "https://b.example.com")
    c.talosAppCommand = ["bun", "run", "/home/alex/cli.ts"]
    d.follow(c)
    #expect(d.dir == "/home/alex/agent" && d.relay == "https://b.example.com" && d.cli == "bun run /home/alex/cli.ts")
  }
}

@Suite("Sign-in text")
struct SignInTextTests {
  @Test func theByHandStepsPasteTheLinkIntoTheTalosWindowNotABrowser() {
    #expect(SignInHelp.how.contains("Talos window"))
    #expect(SignInHelp.how.contains("not a browser"))
    #expect(!SignInHelp.how.contains("Open the link"))
    #expect(!SignInHelp.how.contains("and four words"), "the command prints the words only after the device used the link")
  }

  @Test func aPathTypedInSettingsIsNotShortened() {
    #expect(SignInHelp.command(resolved: ["/opt/x/talos-app"]) == "/opt/x/talos-app enroll --label 'Mac app'")
  }

  @Test func aCustomHomeReachesThePastedCommand() {
    let c = SignInHelp.command(resolved: nil, env: ["TALOS_APP_HOME": "/home/alex/t app", "PATH": "/usr/bin", "SECRET_TOKEN": "x"])
    #expect(c == "TALOS_APP_HOME='/home/alex/t app' talos-app enroll --label 'Mac app'")
    #expect(!c.contains("SECRET_TOKEN") && !c.contains("/usr/bin"), "only the variable that picks the Talos is carried")
  }

  @Test func theExitMessageNeverOverwritesTheTwoLinksAnswer() {
    #expect(SignInHelp.exitMessage(sent: false, ambiguous: true, command: "c") == nil)
    #expect(SignInHelp.exitMessage(sent: false, ambiguous: false, command: "c")?.contains("ended before it showed a link") == true)
    #expect(SignInHelp.exitMessage(sent: true, ambiguous: false, command: "c")?.hasPrefix("Done.") == true)
  }
}

@Suite("Quit & Reopen rescue rules")
struct RescueRulesTests {
  @Test func aQuitFromTheDockIsDeliberateButMacOSsOwnAskIsNot() {
    #expect(RelaunchWatchdog.isDeliberateQuit(senderBundleId: "com.apple.dock"))
    #expect(RelaunchWatchdog.isDeliberateQuit(senderBundleId: "com.apple.ActivityMonitor"))
    #expect(!RelaunchWatchdog.isDeliberateQuit(senderBundleId: "com.apple.systempreferences"))
    #expect(!RelaunchWatchdog.isDeliberateQuit(senderBundleId: "com.apple.tccd"))
    #expect(!RelaunchWatchdog.isDeliberateQuit(senderBundleId: nil), "an unknown sender keeps the rescue")
  }

  @Test func aRescueRelaunchIsRecognised() {
    #expect(RelaunchWatchdog.isRelaunch(["/x/Talos", RelaunchWatchdog.relaunchFlag]))
    #expect(!RelaunchWatchdog.isRelaunch(["/x/Talos"]))
    #expect(RelaunchWatchdog.arguments(pid: 1, app: "/Applications/T.app", maxSeconds: 5, settleSeconds: "1", opener: "/usr/bin/open").contains(RelaunchWatchdog.relaunchFlag))
  }
}

@Suite("Dock policy follows the windows")
struct ActivationPolicyRuleTests {
  @Test func aWindowMakesTalosARegularAppSoTheTopMenuShows() {
    #expect(ActivationPolicyRule.policy(showDockIcon: false, hasOpenWindow: true) == .regular)
    #expect(ActivationPolicyRule.policy(showDockIcon: false, hasOpenWindow: false) == .accessory)
    #expect(ActivationPolicyRule.policy(showDockIcon: true, hasOpenWindow: false) == .regular)
  }
}

@Suite("Sign in is offered only when the page says signed out")
struct SignInOfferTests {
  @Test func notWhileLoadingOrDownOrSignedIn() {
    #expect(PageState.signedOut.offersSignIn)
    for s in [PageState.loading, .signedIn, .unreachable] { #expect(!s.offersSignIn) }
  }
}

@Suite("Sign-in panel offer")
struct SignInOfferPanelTests {
  @Test func theButtonOnlyAppearsWhenThePageSaidSignedOut() {
    #expect(SignInHelp.offer(hasRelay: true, page: .signedOut) == .button)
    #expect(SignInHelp.offer(hasRelay: true, page: .loading) == .connecting)
    #expect(SignInHelp.offer(hasRelay: true, page: .unreachable) == .unreachable)
    #expect(SignInHelp.offer(hasRelay: true, page: .signedIn) == .signedIn)
    #expect(SignInHelp.offer(hasRelay: false, page: .signedOut) == .needsRelay)
  }
}

@Suite("Settings wording")
struct SettingsWordingTests {
  @Test func theNotSetUpLineNamesTheRealButton() {
    #expect(BlockedText.notSetUpLine.contains(BlockedText.adoptButton))
    #expect(!BlockedText.notSetUpLine.contains("Adopt a session"))
  }
}

@Suite("The rescue helper: what only the source can show (source check)")
struct QuitPathSourceTests {
  /// Source of a file in Sources/, comment lines removed. These are the places with no seam a test can set: the Permissions
  /// view's lifetime, the process's own arguments, the notifications every observer in a process would get, and the Settings
  /// switch's refresh. The quits themselves are driven in QuitGuiTests: the menu's Quit and stop-and-quit through the real
  /// actions, and a Dock or Activity Monitor quit through the delegate with the sender set.
  func code(_ rel: String) throws -> String {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { url.deleteLastPathComponent() }
    let text = try String(contentsOf: url.appendingPathComponent("Sources/" + rel), encoding: .utf8)
    return text.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
  }

  /// The text between the braces of the first body after `marker`.
  func body(_ src: String, after marker: String) throws -> String {
    let at = try #require(src.range(of: marker), "no \(marker) in the source")
    let open = try #require(src[at.upperBound...].firstIndex(of: "{"))
    var depth = 0
    var i = open
    while i < src.endIndex {
      if src[i] == "{" { depth += 1 }
      if src[i] == "}" {
        depth -= 1
        if depth == 0 { return String(src[src.index(after: open)..<i]) }
      }
      i = src.index(after: i)
    }
    throw SourceError.unbalanced
  }

  enum SourceError: Error { case unbalanced }

  @Test func theGrantEndingCancelsItAndARescueNeverColdStarts() throws {
    #expect(try code("TalosDesktop/PermissionsView.swift").contains(".onDisappear { RelaunchGuard.shared.disarm() }"))
    #expect(
      try code("TalosDesktop/SupervisorController.swift").contains(
        "attachOrStart(allowColdStart: cfg.startSessionOnLaunch && !RelaunchWatchdog.isRelaunch(CommandLine.arguments))"))
  }

  /// Quit & Reopen asks politely, which posts willTerminate like any quit: a cancel there kills the very rescue it exists for.
  /// A test cannot post that notification (it would reach every observer in the test process), so the code is read: the guard
  /// observes nothing, and no file that observes willTerminate has anything to do with the guard.
  @Test func noQuitNotificationCancelsTheRescue() throws {
    #expect(!(try code("TalosDesktop/RelaunchGuard.swift")).lowercased().contains("willterminate"))
    var dir = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { dir.deleteLastPathComponent() }
    dir.appendPathComponent("Sources/TalosDesktop")
    let files = try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".swift") }
    #expect(files.contains("KeepAwake.swift"), "the observer this test is about is still looked at")
    for f in files {
      let text = try code("TalosDesktop/" + f)
      if text.lowercased().contains("willterminate") {  // applicationWillTerminate too
        #expect(!text.contains("RelaunchGuard") && !text.contains("deliberateQuit"), "\(f) observes willTerminate and names the guard")
      }
    }
  }

  /// The delegate asks the Apple event for who sent the quit. A seam that always said "nobody" would keep the rescue alive after a
  /// Dock quit, and the tests that set the sender would still pass, so the default is pinned.
  @Test func theDelegateReadsTheSenderFromTheAppleEventByDefault() throws {
    #expect(try code("TalosDesktop/AppMenuActions.swift").contains("var quitSender: () -> String? = { QuitSender.bundleId() }"))
  }

  /// A switch that waits for macOS approval says so on every look at Settings, not only right after it was pressed. The
  /// controller is launch code; this reads it: the manager is built from the system at each use, `refresh` turns the pending
  /// answer into the message, and Settings calls `refresh` when it opens.
  @Test func settingsReadsThePendingStateEachTimeItOpens() throws {
    let login = try code("TalosDesktop/LoginItem.swift")
    #expect(login.contains("private var manager: LoginItemManager {"), "computed on each use, not kept from the first look")
    let refresh = try body(login, after: "func refresh()")
    #expect(refresh.contains("let m = manager"))
    #expect(refresh.contains("if m.isPendingApproval {"))
    #expect(refresh.contains("message = MacSettingsText.loginPending"))
    #expect(try body(try code("TalosDesktop/SettingsView.swift"), after: ".onAppear").contains("login.refresh()"))
  }
}
