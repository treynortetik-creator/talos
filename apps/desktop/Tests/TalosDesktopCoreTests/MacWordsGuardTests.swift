import Foundation
import Testing

@testable import TalosDesktopCore

/// The words guard for the Mac screens (owner-approved "Plain words" board, 2026-11-20): outside Advanced, nothing the owner reads in
/// the menu bar menu, the top menu or Mac settings may say relay, bridge, tmux, session, Terminal, token, MCP or launch command.
/// It reads the strings the code builds AND every quoted literal in the screens' own source, so a sentence typed straight into a
/// view is caught too. Advanced is allowlisted: `AdvancedSettingsView.swift` and `AdvancedMenu.swift`.
@Suite("Mac words guard")
struct MacWordsGuardTests {
  static var desktop: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
  }
  static var sources: URL { desktop.appendingPathComponent("Sources/TalosDesktop") }

  /// The screens outside Advanced: the menu bar menu (App.swift), the top menu's glue, and every Mac settings tab.
  static let guarded = [
    "App.swift", "StatusMenu.swift", "AppMenu.swift", "AppMenuActions.swift", "SettingsView.swift", "SettingsStyle.swift", "SettingsAgentTab.swift",
    "SettingsPhoneTab.swift", "SettingsGeneralTab.swift", "PermissionsView.swift", "ScreenAllowedAppsSection.swift",
    "CompanionSettingsView.swift", "HotkeyView.swift",
  ]
  /// Literals that are data, not words the owner reads: the name and bundle id of the macOS app Talos may ask for Automation of
  /// (`PermissionChecks.automationBundleIds`). The list shows no such name; the row says "Work in other apps".
  static let dataLiterals: Set<String> = ["Terminal", "com.apple.Terminal"]
  /// The Core string tables the guarded views show (R1-7). A sentence here reaches the owner outside Advanced unless it is allowlisted.
  static let coreGuarded = ["MacSettingsText.swift", "BlockedText.swift", "HostChoice.swift", "SupervisorNotice.swift"]
  /// Sentences in those tables that only Advanced (or a thread's own Terminal window) shows, so engineer words are fine in them.
  /// Each entry is a prefix of the sentence. Adding one is a decision: say who shows it.
  static let coreAdvancedOnly: [String] = [
    // Advanced, "Terminal host": the picker's choices and its notes
    "Automatic (tmux if it is installed)", "tmux (the agent keeps running when Talos quits)", "Talos's own terminal (the agent stops",
    "Right now: tmux.", "Right now: Talos's own terminal.", "tmux 3.2 or newer was not found",
    "Stop the session, and any thread sessions, to change this.", "Applies the next time Talos opens.",
    // Advanced: Import, Take over, the launch box, the server address, the log and settings files
    "Saved. Your launch command is now your setup.", "Saved. The session that is running keeps its old command",
    "Applies the next time the agent starts, and that start is a cold start.", "Applies to the next Sign in or Forget this Mac.",
    "Applies when you press Return", "auto (from bridge.env)", "No address yet. Type one here, or run talos-app init",
    "Using ", "The Mac app writes it the first time", "It is created when you set up the agent folder",
    "Couldn't save the setup file", "No \\(what) yet.",
    // posted into the thread itself (web and phone words, not a Mac screen), and prompt names the Mac matches against Claude's screen
    "This thread's session is", "approve a project MCP server", "bypass permissions", "development channels",
    // the engineer's own wording inside a Terminal window or a log line, never a menu or settings line
    "The saved conversation id", "Talos couldn't start: its settings file",
  ]

  /// The only screens where the engineer's words are allowed.
  static let advancedAllowlist = ["AdvancedSettingsView.swift", "AdvancedMenu.swift"]

  // MARK: the guard itself

  @Test func theGuardCatchesEachForbiddenWord() {
    for w in [
      "Open Terminal and run", "the bridge is up", "Relay address", "tmux attach", "launch command", "Start session", "your sessions",
      "a token", "an MCP server", "Terminals\u{2026}",
    ] {
      #expect(!MacWords.forbiddenWords(in: w).isEmpty, Comment(rawValue: w))
    }
    // whole words only: these contain a forbidden word's letters but are other words
    #expect(MacWords.forbiddenWords(in: "sessionless terminally relayed").isEmpty)
    #expect(MacWords.forbiddenWords(in: "Your agent is running").isEmpty)
  }

  // MARK: what the code builds

  @Test func noFixedStringOutsideAdvancedUsesAnEngineerWord() {
    for s in MacWords.outsideAdvanced {
      #expect(MacWords.forbiddenWords(in: s).isEmpty, Comment(rawValue: "\u{201C}" + s + "\u{201D} says " + MacWords.forbiddenWords(in: s).joined(separator: ", ")))
    }
    #expect(MacWords.outsideAdvanced.count > 40, "the list is not empty by accident")
  }

  @Test func theTopMenuHasNoEngineerWord() {
    for m in AppMenuSpec.all {
      for i in m.items.compactMap({ $0 }) {
        #expect(MacWords.forbiddenWords(in: i.title).isEmpty, Comment(rawValue: i.title))
      }
    }
    let titles = AppMenuSpec.windowMenu.items.compactMap { $0?.title }
    #expect(titles.contains(MacWords.showAgentScreen) && titles.contains(MacWords.quickMessage) && titles.contains(MacWords.privacyAndAccess))
  }

  /// Every state of the three status lines, in the shared words: "Agent", "Talos server", "Your Mac".
  @Test func theStatusLinesUseTheSharedWordsInEveryState() {
    let sessions: [HealthModel.Session] = [
      .notConfigured, .notStarted, .starting, .running(activity: nil), .running(activity: "busy"), .restarting, .stopping,
      .stopped("anything went wrong"), .blocked,
    ]
    var seen = Set<String>()
    for s in sessions {
      for b in [nil, BridgeStatus.Health.healthy, .relayDown, .stale, .dead, .superseded, .headless] {
        for r in [nil, true, false] as [Bool?] {
          for configured in [true, false] {
            let lines = HealthModel.summarize(.init(session: s, bridge: b, relayReachable: r, relayConfigured: configured, host: "tmux")).lines
            #expect(lines.count == 3 && lines[0].hasPrefix("Agent: ") && lines[1].hasPrefix("Talos server: ") && lines[2].hasPrefix("Your Mac: "), "\(lines)")
            for l in lines {
              #expect(MacWords.forbiddenWords(in: l).isEmpty, Comment(rawValue: l))
              seen.insert(l)
            }
          }
        }
      }
    }
    // the words the owner asked for are all reachable
    for want in [
      "Agent: running", "Agent: not running", "Agent: starting", "Talos server: connected", "Talos server: can't reach",
      "Talos server: not set up", "Your Mac: connected", "Your Mac: not connected",
    ] { #expect(seen.contains(want), Comment(rawValue: want)) }
    // a second line of its own for the owner who needs a count
    #expect(HealthModel.summarize(.init(session: .running(activity: nil), badge: 2)).lines.last == "Needs you: 2")
  }

  @Test func theStatusWordsFollowTheRealState() {
    func lines(_ s: HealthModel.Session, _ b: BridgeStatus.Health?, _ r: Bool?, configured: Bool = true) -> [String] {
      HealthModel.summarize(.init(session: s, bridge: b, relayReachable: r, relayConfigured: configured)).lines
    }
    #expect(lines(.running(activity: nil), .healthy, true) == ["Agent: running", "Talos server: connected", "Your Mac: connected"])
    #expect(lines(.notStarted, .dead, false) == ["Agent: not running", "Talos server: can't reach", "Your Mac: not connected"])
    #expect(lines(.starting, nil, nil, configured: false) == ["Agent: starting", "Talos server: not set up", "Your Mac: checking"])
    #expect(lines(.notStarted, nil, nil)[2] == "Your Mac: not connected", "nothing is running, so nothing is connected")
    #expect(lines(.running(activity: nil), .relayDown, false)[1] == "Talos server: can't reach")
    #expect(lines(.blocked, nil, true)[0] == "Agent: not running")
  }

  @Test func theAgentHeadlineIsOrangeUntilBothAreWell() {
    func h(_ s: HealthModel.Session, _ r: Bool?) -> HealthSummary.Headline {
      HealthModel.summarize(.init(session: s, bridge: .healthy, relayReachable: r)).headline
    }
    #expect(h(.running(activity: "busy"), true) == .init(text: "Working \u{00B7} Talos server connected", ok: true))
    #expect(h(.running(activity: nil), true).text == "Running \u{00B7} Talos server connected")
    #expect(h(.running(activity: nil), false) == .init(text: "Running \u{00B7} Talos server can't reach", ok: false))
    #expect(h(.notStarted, true) == .init(text: "Not running", ok: false))
    #expect(h(.notConfigured, nil).text == "Not set up yet")
  }

  /// "Another session holds the channels" and the notices on the board, in plain words.
  @Test func theNoticesAreInPlainWords() {
    #expect(SupervisorNotice.blocked == "Another agent is already using this account")
    #expect(SupervisorNotice.restarted == "Your agent stopped and was restarted. It carried on.")
    #expect(SupervisorNotice.stoppedRestarting == "Your agent keeps stopping, so Talos paused it. Open Talos to look.")
    #expect(SupervisorNotice.bridgeNotLive(nil) == "Your agent is running but Talos on your Mac didn't start")
    #expect(SupervisorNotice.relayUnreachable(closeCode: nil).hasPrefix("Talos on your Mac can't reach the Talos server"))
    // a thread's notices, as the menu shows them
    for line in [
      ThreadNotices.waitingLine(name: "Sales", prompt: "trust this folder"), ThreadNotices.waitingLine(name: "Sales", prompt: "Bash command"),
      ThreadNotices.waitingLine(name: "Sales", prompt: "development channels"), ThreadNotices.untoldLine(name: "Sales"),
      ThreadNotices.failedLine(name: "Sales", code: "crash_loop"), ThreadNotices.failedLine(name: "Sales", code: "start_failed"),
      ThreadNotices.failedLine(name: "Sales", code: "needs_mac"), ThreadNotices.failedLine(name: "Sales", code: "resume_missing"),
      ThreadNotices.failedLine(name: "Sales", code: "folder_claimed"), ThreadNotices.failedLine(name: "Sales", code: "mode_escalation_denied"),
      ThreadNotices.failedLine(name: "Sales", code: "other"), SupervisorNotice.notSetUp, SupervisorNotice.confirmFailed,
      SupervisorNotice.sessionIdInvalid,
    ] { #expect(MacWords.forbiddenWords(in: line).isEmpty, Comment(rawValue: line)) }
  }

  @Test func theWhereToLookPointersNameRealControls() {
    // the Advanced item's own name is what the notices say, so a rename cannot leave them pointing at nothing
    #expect(MacWords.showAgentScreen == MacWords.agentScreenName + "\u{2026}")
    #expect(ThreadNotices.failedLine(name: "Sales", code: "other").contains(MacWords.agentScreenName))
    #expect(AppMenuSpec.windowMenu.items.contains { $0?.title == MacWords.showAgentScreen })
  }

  // MARK: the screens' own source

  @Test func noLiteralInAnyGuardedScreenUsesAnEngineerWord() throws {
    var checked = 0
    for f in Self.guarded {
      let text = try String(contentsOf: Self.sources.appendingPathComponent(f), encoding: .utf8)
      for lit in Self.literals(in: text) where Self.isShownText(lit) && !Self.dataLiterals.contains(lit.text) {
        checked += 1
        #expect(MacWords.forbiddenWords(in: lit.text).isEmpty, Comment(rawValue: "\(f): \u{201C}\(lit.text)\u{201D} says \(MacWords.forbiddenWords(in: lit.text).joined(separator: ", "))"))
      }
    }
    #expect(checked > 120, "the scan really read the screens (\(checked) literals)")
  }

  /// R1-7: the Core tables the views draw from. A sentence typed into one of them is shown outside Advanced unless it is allowlisted.
  @Test func noSentenceInTheCoreTablesTheViewsShowUsesAnEngineerWord() throws {
    let core = Self.desktop.appendingPathComponent("Sources/TalosDesktopCore")
    var checked = 0
    var bad: [String] = []
    for f in Self.coreGuarded {
      let text = try String(contentsOf: core.appendingPathComponent(f), encoding: .utf8)
      for lit in Self.literals(in: text) where Self.isShownText(lit) {
        guard lit.text.contains(" ") else { continue }
        checked += 1
        if Self.coreAdvancedOnly.contains(where: { lit.text.hasPrefix($0) }) { continue }
        if !MacWords.forbiddenWords(in: lit.text).isEmpty { bad.append("\(f): \(lit.text)") }
      }
    }
    #expect(bad.isEmpty, Comment(rawValue: bad.joined(separator: "\n")))
    #expect(checked > 60, "the scan really read the tables (\(checked) sentences)")
  }

  @Test func theAllowlistIsExactlyTheTwoAdvancedFilesAndTheyAreNotGuarded() throws {
    #expect(Set(Self.advancedAllowlist).isDisjoint(with: Self.guarded))
    for f in Self.advancedAllowlist {
      #expect(FileManager.default.fileExists(atPath: Self.sources.appendingPathComponent(f).path), Comment(rawValue: f))
    }
    // and Advanced really is where the engineer words are: dropping the allowlist would make the scan fail
    var found = Set<String>()
    for f in Self.advancedAllowlist {
      let text = try String(contentsOf: Self.sources.appendingPathComponent(f), encoding: .utf8)
      for lit in Self.literals(in: text) where Self.isShownText(lit) { found.formUnion(MacWords.forbiddenWords(in: lit.text)) }
    }
    #expect(found.isSuperset(of: ["tmux", "Terminal"]), "Advanced keeps its technical words: \(found)")
  }

  /// A word typed into a view that is not allowlisted is caught (the guard must go red when the code breaks).
  @Test func theScanFindsAnEngineerWordTypedStraightIntoAView() {
    let bad = """
      struct V: View { var body: some View { Button("Copy tmux attach command") {}; Text("Relay: \\(x ? "a" : "b")") } }
      """
    let found = Self.literals(in: bad).filter(Self.isShownText).flatMap { MacWords.forbiddenWords(in: $0.text) }
    #expect(Set(found) == ["tmux", "relay"], "\(found)")
  }

  @Test func theScannerReadsStringsCommentsAndInterpolationRight() {
    let src = """
      // "not a literal"
      let a = "plain" /* "also not" */
      let b = "x \\(f("inner")) y"
      let c = Text("a // not a comment")
      """
    let got = Self.literals(in: src).map(\.text)
    #expect(got.contains("plain") && got.contains("inner") && got.contains("a // not a comment"), "\(got)")
    #expect(!got.contains("not a literal") && !got.contains("also not"))
  }

  // MARK: where moved settings live

  @Test func everyTabHasItsMockNameAndTheOldOnesAreGone() {
    #expect(MacWords.tabNames == ["Your agent", "Phone & Mac", "Privacy & access", "General", "Advanced"])
  }

  @Test func keepItWorkingIsTheHostChoiceInPlainWords() {
    #expect(KeepWorking.isOn(choice: .auto, tmuxUsable: true))
    #expect(!KeepWorking.isOn(choice: .auto, tmuxUsable: false), "without the helper the agent cannot outlive Talos, so it does not say it will")
    #expect(!KeepWorking.isOn(choice: .direct, tmuxUsable: true))
    #expect(KeepWorking.isOn(choice: .tmux, tmuxUsable: true))
    #expect(KeepWorking.choice(turningOn: true) == .auto && KeepWorking.choice(turningOn: false) == .direct)
    #expect(KeepWorking.lockNote(sessionUp: false, workersRunning: false, helperAvailable: true) == nil)
    #expect(KeepWorking.lockNote(sessionUp: true, workersRunning: false, helperAvailable: true) == "Stop your agent to change this.")
    #expect(KeepWorking.lockNote(sessionUp: false, workersRunning: true, helperAvailable: true) == "Stop your thread agents to change this.")
    #expect(
      KeepWorking.lockNote(sessionUp: true, workersRunning: true, helperAvailable: true)
        == "Stop your agent and your thread agents to change this.", "R1-3: thread agents are named")
    #expect(KeepWorking.lockNote(sessionUp: false, workersRunning: false, helperAvailable: false) != nil)
    for n in [
      KeepWorking.lockNote(sessionUp: true, workersRunning: true, helperAvailable: true),
      KeepWorking.lockNote(sessionUp: false, workersRunning: true, helperAvailable: true),
      KeepWorking.lockNote(sessionUp: false, workersRunning: false, helperAvailable: false),
    ] { #expect(MacWords.forbiddenWords(in: n ?? "").isEmpty) }
    // the note and the host picker's own lock agree on when the switch is locked
    for (s, w) in [(false, false), (true, false), (false, true), (true, true)] {
      #expect((KeepWorking.lockNote(sessionUp: s, workersRunning: w, helperAvailable: true) == nil) == HostChoice.canChange(sessionUp: s, workersRunning: w))
    }
  }

  /// R1-1: "this Mac is connected" on Phone & Mac is the menu's "Your Mac:" word, not the web window's sign-in.
  @Test func thePhoneCardAnswersWithTheSameWordAsTheMenusYourMacLine() throws {
    for b in [nil, BridgeStatus.Health.healthy, .relayDown, .stale, .dead] {
      for s in [HealthModel.Session.running(activity: nil), .notStarted, .starting] {
        let sum = HealthModel.summarize(.init(session: s, bridge: b, relayReachable: true))
        #expect(sum.lines[2] == "Your Mac: " + sum.macConnection, "\(sum.lines)")
      }
    }
    let src = try String(contentsOf: Self.sources.appendingPathComponent("SettingsPhoneTab.swift"), encoding: .utf8)
    #expect(src.contains("status.summary.macConnection"))
    #expect(!src.contains("\"Connected\"") && !src.contains("\"Not connected\""), "the sign-in state is not called Connected")
    #expect(MacWords.thisMacSignedIn == "This Mac's Talos window is signed in")
    #expect(!MacWords.signOutBody.contains("phone keeps") && MacWords.signOutBody.contains("does not change your agent, your phone or your Claude account"))
  }

  /// R1-2: every door to signing out asks first.
  @Test func noDoorSignsOutWithoutTheConfirmation() throws {
    for f in ["StatusMenu.swift", "SettingsPhoneTab.swift", "AppMenuActions.swift"] {
      let src = try String(contentsOf: Self.sources.appendingPathComponent(f), encoding: .utf8)
      #expect(!src.contains("web.signOut()"), Comment(rawValue: "\(f) signs out without asking"))
      #expect(src.contains("SignOutAction.run(web: web)"), Comment(rawValue: f))
    }
    #expect(MacWords.signOutWindow != MacWords.tabPhone && !MacWords.signOutWindow.contains("Claude"))
    #expect(AppMenuSpec.windowMenu.items.contains { $0?.title == MacWords.signOutWindow })
  }

  /// R1-6 and R1-8: a locked switch cannot be toggled by an accessibility action, and a permission row's buttons stay separate controls.
  @Test func accessibilityActionsRespectTheLockAndButtonsStaySeparate() throws {
    let style = try String(contentsOf: Self.sources.appendingPathComponent("SettingsStyle.swift"), encoding: .utf8)
    #expect(style.contains("accessibilityAction { if enabled { isOn.toggle() } }"))
    let perm = try String(contentsOf: Self.sources.appendingPathComponent("PermissionsView.swift"), encoding: .utf8)
    let row = try #require(perm.range(of: "private func row(_ r: PermissionsModel.Row)"))
    let body = String(perm[row.lowerBound...].prefix(1800))
    #expect(body.contains(".accessibilityElement(children: .contain)"))
    #expect(!body.components(separatedBy: "buttons(r)")[1].contains(".accessibilityElement(children: .combine)"), "nothing combines over the buttons")
  }

  /// The coordinator's screenshot review: exact labels, and where each one sits.
  @Test func theReviewedLabelsAreExactAndInThePlacesTheMockPutsThem() throws {
    #expect(MacWords.needsServerAddress == "Needs the Talos server address first.")
    #expect(MacWords.shortcutNotSet == "Not set" && MacWords.setShortcut == "Set shortcut" && MacWords.changeShortcut == "Change shortcut")
    #expect(MacWords.appsItMayUse(3) == "Apps it may use (3)" && MacWords.screenRowTitle == "See and use the screen")
    func read(_ f: String) throws -> String { try String(contentsOf: Self.sources.appendingPathComponent(f), encoding: .utf8) }
    let adv = try read("AdvancedSettingsView.swift")
    #expect(adv.contains("SignInPanel(model: model, beforeSignIn: { commitDrafts() }, showButton: false)"), "Advanced has no second Sign in button")
    #expect(!adv.contains("Button(BlockedText.adoptButton)"), "one take-over control, the row with Look for one")
    #expect(adv.components(separatedBy: "findSessionToAdopt()").count - 1 == 1)
    let phone = try read("SettingsPhoneTab.swift")
    let card = try #require(phone.range(of: "private var macCard"))
    let body = String(phone[card.lowerBound...].prefix(900))
    #expect(body.contains("VStack(alignment: .leading, spacing: 12)") && body.contains("macButtons.lineLimit(1).fixedSize()"), "buttons under the text, one line each")
    let hot = try read("HotkeyView.swift")
    #expect(hot.contains("MacWords.shortcutNotSet") && hot.contains("hot.spec == nil ? MacWords.setShortcut : MacWords.changeShortcut"))
    let perm = try read("PermissionsView.swift")
    #expect(perm.contains("MacWords.appsItMayUse(appsCount)") && perm.contains("if showApps { screenSection }"))
    // the status line the take-over section shows says Agent, not Session
    let sup = try String(contentsOf: Self.desktop.appendingPathComponent("Sources/TalosDesktop/SupervisorController.swift"), encoding: .utf8)
    #expect(sup.contains(#""Agent: not started · \(host)""#) && !sup.contains(#""Session: not started"#))
    // there is no way to add a phone after setup, so the Phone & Mac tab does not pretend to (the phone step lives only in setup)
    #expect(!phone.contains("Button(\"Add a phone"))
  }

  @Test func theTwoScreenPermissionsAreOneRowThatIsAllowedOnlyWhenBothAre() {
    typealias S = PermissionsModel.State
    #expect(PermissionsModel.screenState(accessibility: .granted, screenRecording: .granted) == .granted)
    #expect(PermissionsModel.screenState(accessibility: .granted, screenRecording: .missing) == .missing)
    #expect(PermissionsModel.screenState(accessibility: .missing, screenRecording: .unknown) == .missing)
    #expect(PermissionsModel.screenState(accessibility: .unknown, screenRecording: .granted) == .unknown)
    #expect(PermissionsModel.screenState(accessibility: .askedOnFirstUse, screenRecording: .granted) == .askedOnFirstUse)
  }

  @Test func privacyRowsSitInTheGroupTheirStateSays() {
    #expect(PermissionsModel.group(.granted) == .allowed)
    #expect(PermissionsModel.group(.missing) == .saidNo)
    #expect(PermissionsModel.group(.askedOnFirstUse) == .notAskedYet)
    #expect(PermissionsModel.group(.unknown) == .notAskedYet)
    // every permission there is lands in exactly one group
    for r in PermissionsModel.rows(check: { _ in .missing }) { #expect(PermissionsModel.group(r.state) == .saidNo) }
  }

  @Test func theThreeModesCarryTheMocksWords() {
    #expect(PermissionMode.allCases.map(\.settingsName) == ["Auto", "Ask me", "Bypass"])
    #expect(PermissionMode.auto.settingsBlurb == "Does everyday work on its own; asks you about anything risky.")
    #expect(PermissionMode.ask.settingsBlurb == "Checks with you before it changes anything.")
    #expect(PermissionMode.bypass.settingsBlurb == "Never asks. Only for an agent you fully trust.")
    #expect(PermissionModeSetting.title == "How much your agent asks before it acts")
  }

  // MARK: a small Swift string-literal reader

  struct Literal {
    var text: String
    /// What came just before the opening quote on its line, to tell a shown label from an identifier or a key.
    var before: String
  }

  static func literals(in src: String) -> [Literal] {
    let chars = Array(src)
    var out: [Literal] = []
    func before(_ i: Int) -> String {
      var j = i
      var s = ""
      while j > 0, chars[j - 1] != "\n", s.count < 48 { j -= 1; s.insert(chars[j], at: s.startIndex) }
      return s
    }
    /// `i` is just after an opening quote; returns the index after the closing one.
    func string(from start: Int, openedAt: Int) -> Int {
      var j = start
      var cur = ""
      while j < chars.count {
        let c = chars[j]
        if c == "\\", j + 1 < chars.count {
          if chars[j + 1] == "(" {
            var depth = 1
            j += 2
            while j < chars.count, depth > 0 {
              if chars[j] == "\"" { j = string(from: j + 1, openedAt: j); continue }
              if chars[j] == "(" { depth += 1 } else if chars[j] == ")" { depth -= 1 }
              j += 1
            }
            continue
          }
          cur.append(chars[j + 1])
          j += 2
          continue
        }
        if c == "\"" {
          out.append(Literal(text: cur, before: before(openedAt)))
          return j + 1
        }
        cur.append(c)
        j += 1
      }
      return j
    }
    var i = 0
    while i < chars.count {
      let c = chars[i]
      if c == "/", i + 1 < chars.count, chars[i + 1] == "/" {
        while i < chars.count, chars[i] != "\n" { i += 1 }
        continue
      }
      if c == "/", i + 1 < chars.count, chars[i + 1] == "*" {
        i += 2
        while i + 1 < chars.count, !(chars[i] == "*" && chars[i + 1] == "/") { i += 1 }
        i += 2
        continue
      }
      if c == "\"", i + 2 < chars.count, chars[i + 1] == "\"", chars[i + 2] == "\"" {
        // a multi-line string: its whole body is one literal
        var j = i + 3
        var cur = ""
        while j + 2 < chars.count, !(chars[j] == "\"" && chars[j + 1] == "\"" && chars[j + 2] == "\"") { cur.append(chars[j]); j += 1 }
        out.append(Literal(text: cur, before: before(i)))
        i = j + 3
        continue
      }
      if c == "\"" {
        i = string(from: i + 1, openedAt: i)
        continue
      }
      i += 1
    }
    return out
  }

  /// A literal the owner reads: not an identifier, a key, a symbol name, a font or a log label.
  static func isShownText(_ l: Literal) -> Bool {
    let skip = [
      "accessibilityIdentifier(", "systemName: ", "forKey: ", "id: ", "AppStorage(", "Logger(", "subsystem: ", "category: ", ".custom(",
      "family: ", "key: ", "UserDefaults", "contains(", "hasPrefix(", "hasSuffix(", "Notification.Name(", "dispatchPrecondition",
    ]
    if skip.contains(where: { l.before.contains($0) }) { return false }
    // identifier-like: lower-case letters, digits and . _ - : only, no spaces ("settings-tab-", "x-apple.systempreferences")
    if l.text.range(of: "^[a-z0-9._:/#?=&+-]*$", options: .regularExpression) != nil { return false }
    return !l.text.isEmpty
  }
}
