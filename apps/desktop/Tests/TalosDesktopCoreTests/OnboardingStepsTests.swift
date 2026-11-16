import Foundation
import Testing
@testable import TalosDesktopCore
import TalosTestSupport

@Suite("Onboarding: tools, sign-in wording, owner rules")
struct OnboardingStepsTests {
  // MARK: tools

  @Test func versionsReadFromEachToolsOwnOutput() {
    #expect(PrereqPlan.version("claude", output: "2.1.312 (Claude Code)\n") == "2.1.312")
    #expect(PrereqPlan.version("bun", output: "1.4.4\n") == "1.4.4")
    #expect(PrereqPlan.version("tmux", output: "tmux 3.5a") == "3.5a")
    #expect(PrereqPlan.version("tmux", output: "tmux next-3.6") == nil)
    #expect(PrereqPlan.version("bun", output: "") == nil)
    #expect(PrereqPlan.version("bun", output: "error: nope") == nil)
  }

  @Test func eachMissingToolGetsTheSafeFix() {
    #expect(PrereqPlan.fix(for: "claude", brew: nil) == .openPage(label: OnboardingText.openClaudePage, url: "https://claude.com/claude-code"))
    #expect(PrereqPlan.fix(for: "bun", brew: "/opt/homebrew/bin/brew") == .openPage(label: OnboardingText.openBunPage, url: "https://bun.sh"))
    #expect(PrereqPlan.fix(for: "tmux", brew: "/opt/homebrew/bin/brew") == .brewInstall(label: OnboardingText.installTmuxWithBrew, brew: "/opt/homebrew/bin/brew", formula: "tmux"))
    #expect(PrereqPlan.fix(for: "tmux", brew: nil) == .openPage(label: OnboardingText.openBrewPage, url: "https://brew.sh"))
    #expect(PrereqPlan.fix(for: "bridge", brew: nil) == nil)
  }

  @Test func theOnlyCommandRunIsBrewInstallAsTheOwnerNeverRoot() {
    let f = PrereqPlan.Fix.brewInstall(label: "x", brew: "/opt/homebrew/bin/brew", formula: "tmux")
    #expect(PrereqPlan.argv(for: f, uid: 501) == .argv(["/opt/homebrew/bin/brew", "install", "tmux"]))
    #expect(PrereqPlan.argv(for: f, uid: 0) == .refused(OnboardingText.brewRefusedRoot))
    #expect(PrereqPlan.argv(for: .brewInstall(label: "x", brew: "brew", formula: "tmux"), uid: 501) == .refused(OnboardingText.brewFailed))
    #expect(PrereqPlan.argv(for: .brewInstall(label: "x", brew: "/b/brew", formula: "tmux; rm -rf ~"), uid: 501) == .refused(OnboardingText.brewFailed))
    #expect(PrereqPlan.argv(for: .openPage(label: "x", url: "https://bun.sh"), uid: 501) == .refused("not a command"))
  }

  @Test func rowsShowVersionsAndPathsAndNoLongerSendTheOwnerToTerminalToSignIn() {
    let rows = FirstRun.rows(
      .init(
        claudeVersion: "2.1.312", authSignedIn: false, bunPath: "/u/.bun/bin/bun", tmuxVersionOutput: "tmux 3.5a", bridgeEnvPresent: true,
        agentDirTrusted: true, home: "/u", paths: ["claude": "/u/.local/bin/claude", "bun": "/u/.bun/bin/bun", "tmux": "/opt/homebrew/bin/tmux"],
        bunVersion: "1.4.4"))
    let by = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    #expect(by["bun"]?.title == "bun 1.4.4" && by["bun"]?.detail == "/u/.bun/bin/bun")
    #expect(by["claude"]?.detail == "/u/.local/bin/claude" && by["tmux"]?.detail == "/opt/homebrew/bin/tmux")
    guard case .fix(let m)? = by["auth"]?.state else { Issue.record("auth should be a fix"); return }
    #expect(m.contains("Sign in to Claude") && m.contains("claude auth login"), "a way out when the button keeps failing")
    #expect(by["auth"]?.detail == nil, "a row that needs a fix shows no path")
  }

  // MARK: sign-in wording

  @Test func statusExitCodesMeanYesNoOrUnknown() {
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: false) == .signedIn)
    #expect(ClaudeSignInPlan.check(status: 1, timedOut: false) == .notSignedIn)
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: true) == .unknown)
    #expect(ClaudeSignInPlan.check(status: nil, timedOut: false) == .unknown)
  }

  @Test func everyFailureHasAMessageAndOnlyTheTwoSuccessesAreSuccess() {
    let all: [ClaudeSignInPlan.Outcome] = [
      .alreadySignedIn, .signedIn, .cancelled, .timedOut, .loginEndedNotSignedIn, .couldNotRun, .statusUnknown, .noClaude,
    ]
    for o in all { #expect(!o.message.isEmpty) }
    #expect(all.filter(\.isSuccess) == [.alreadySignedIn, .signedIn])
    #expect(ClaudeSignInPlan.timeoutOutcome(everAnswered: true) == .timedOut)
    #expect(ClaudeSignInPlan.timeoutOutcome(everAnswered: false) == .statusUnknown)
  }

  // MARK: owner rules

  private func folder() throws -> String {
    let d = TestTemp.base + "owner-rules-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  @Test func theShippedDefaultIsNoFile() throws {
    let d = try folder()
    defer { try? FileManager.default.removeItem(atPath: d) }
    #expect(!FileManager.default.fileExists(atPath: OwnerRules.path(agentDir: d)))
    #expect(OwnerRules.load(agentDir: d) == "")
    #expect(OwnerRules.save("", agentDir: d) == .nothingToSave)
    #expect(!FileManager.default.fileExists(atPath: d + "/.claude"), "saving nothing creates nothing")
  }

  @Test func savedTextLandsInTheRulesFolderAndComesBack() throws {
    let d = try folder()
    defer { try? FileManager.default.removeItem(atPath: d) }
    let text = "Never include patient names or health details.\nAsk before you send anything."
    #expect(OwnerRules.save("  " + text + "  \n\n", agentDir: d) == .saved)
    #expect(OwnerRules.path(agentDir: d) == d + "/.claude/rules/owner-rules.md")
    let raw = try String(contentsOfFile: OwnerRules.path(agentDir: d), encoding: .utf8)
    #expect(raw.hasPrefix(OwnerRules.header) && raw.hasSuffix(text + "\n"))
    #expect(OwnerRules.load(agentDir: d) == text)
    #expect(!FileManager.default.fileExists(atPath: d + "/.claude/rules/talos-defaults.md"), "the shipped file is never touched")
  }

  @Test func emptyTextRemovesOnlyTheFileTalosWrote() throws {
    let d = try folder()
    defer { try? FileManager.default.removeItem(atPath: d) }
    #expect(OwnerRules.save("a rule", agentDir: d) == .saved)
    #expect(OwnerRules.save("   \n", agentDir: d) == .removed)
    #expect(!FileManager.default.fileExists(atPath: OwnerRules.path(agentDir: d)))
  }

  @Test func aFileTalosDidNotWriteIsNeverReplacedOrRemoved() throws {
    let d = try folder()
    defer { try? FileManager.default.removeItem(atPath: d) }
    try FileManager.default.createDirectory(atPath: d + "/.claude/rules", withIntermediateDirectories: true)
    let mine = "my own rules, written by hand\n"
    try mine.write(toFile: OwnerRules.path(agentDir: d), atomically: true, encoding: .utf8)
    guard case .refused = OwnerRules.save("new", agentDir: d) else { Issue.record("should refuse"); return }
    guard case .refused = OwnerRules.save("", agentDir: d) else { Issue.record("should refuse to remove"); return }
    #expect(try String(contentsOfFile: OwnerRules.path(agentDir: d), encoding: .utf8) == mine)
    #expect(OwnerRules.load(agentDir: d) == "", "the box does not show text that is not Talos's")
  }

  @Test func refusesAMissingFolderALinkAndTooMuchText() throws {
    guard case .refused = OwnerRules.save("x", agentDir: "/nonexistent-\(UUID().uuidString)") else { Issue.record("missing folder"); return }
    let d = try folder()
    defer { try? FileManager.default.removeItem(atPath: d) }
    guard case .refused = OwnerRules.save(String(repeating: "a", count: OwnerRules.maxLength + 1), agentDir: d) else { Issue.record("too long"); return }
    let elsewhere = try folder()
    defer { try? FileManager.default.removeItem(atPath: elsewhere) }
    try FileManager.default.createSymbolicLink(atPath: d + "/.claude", withDestinationPath: elsewhere)
    guard case .refused = OwnerRules.save("x", agentDir: d) else { Issue.record("link"); return }
    #expect(!FileManager.default.fileExists(atPath: elsewhere + "/rules"), "nothing was written through the link")
  }

  @Test func controlCharactersAreDroppedAndNewlinesKept() {
    #expect(OwnerRules.clean("a\u{0007}b\u{202E}\u{0085}c  \nd\t\n\n") == "abc\nd")
  }

  // MARK: the login screen

  @Test func theLoginScreenYieldsAnAllowedUrlAndThePastePrompt() {
    let url = "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=SECRETSTATE"
    let s = ClaudeLoginScreen.parse(rows: ["Opening browser to sign in...", "If the browser did not open, visit:", url, "", "Paste code here if prompted > "])
    #expect(s.url == url && s.wantsCode)
    #expect(!"\(s)".contains("SECRETSTATE") && !"\(s)".contains("client_id"), "description never carries the query")
    #expect(ClaudeLoginScreen.parse(rows: ["Opening browser..."]) == ClaudeLoginScreen())
    #expect(ClaudeLoginScreen.parse(rows: [url + "."]).url == url, "trailing punctuation is not part of the link")
    #expect(ClaudeLoginScreen.parse(rows: ["Visit https://console.anthropic.com/oauth/authorize?x=1"]).url != nil)
  }

  @Test func onlyOfficialHttpsHostsAreOffered() {
    for bad in ["http://claude.ai/x", "https://evil.example/claude.ai", "https://claude.ai.evil.example/x", "https://u" + String(UnicodeScalar(64)) + "evil.example/", "file:///etc/passwd",
      "https://evil.example%2fx.claude.ai/a", "https://evil.example%2Eclaude.ai/a", "https://claude.ai%40evil.example/"] {
      #expect(ClaudeLoginScreen.parse(rows: ["visit " + bad]).url == nil, "\(bad)")
    }
  }

  @Test func statusJsonSaysYesOnlyForLoggedInTrue() {
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: false, json: Data("{\"loggedIn\":true}".utf8)) == .signedIn)
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: false, json: Data("{\"loggedIn\":false}".utf8)) == .notSignedIn)
    #expect(ClaudeSignInPlan.check(status: 1, timedOut: false, json: Data("{\"loggedIn\":false}".utf8)) == .notSignedIn)
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: false, json: Data("not json".utf8)) == .signedIn, "no JSON: the exit code decides")
    #expect(ClaudeSignInPlan.check(status: 0, timedOut: true, json: Data()) == .unknown)
  }

  @Test func theTerminalWayOutIsInEveryErrorThatCanRepeat() {
    for o: ClaudeSignInPlan.Outcome in [.timedOut, .loginEndedNotSignedIn, .couldNotRun] {
      #expect(o.message.contains("claude auth login"), "\(o)")
    }
  }

  @Test func theSignInButtonNeverShowsOnceSignedIn() {
    #expect(!ClaudeSignInPlan.showsButton(authSignedIn: true, outcome: nil, running: false))
    #expect(!ClaudeSignInPlan.showsButton(authSignedIn: false, outcome: .alreadySignedIn, running: false))
    #expect(!ClaudeSignInPlan.showsButton(authSignedIn: nil, outcome: .signedIn, running: false))
    #expect(!ClaudeSignInPlan.showsButton(authSignedIn: false, outcome: nil, running: true))
    #expect(ClaudeSignInPlan.showsButton(authSignedIn: false, outcome: nil, running: false))
    #expect(ClaudeSignInPlan.showsButton(authSignedIn: nil, outcome: .timedOut, running: false))
  }

  @Test func aKeptOutcomeTheLatestCheckContradictsIsDropped() {
    #expect(ClaudeSignInPlan.isStale(outcome: .signedIn, authSignedIn: false), "signed in earlier, signed out now")
    #expect(ClaudeSignInPlan.isStale(outcome: .alreadySignedIn, authSignedIn: false))
    #expect(ClaudeSignInPlan.isStale(outcome: .timedOut, authSignedIn: true), "an error, then signed in by other means")
    #expect(!ClaudeSignInPlan.isStale(outcome: .signedIn, authSignedIn: true))
    #expect(!ClaudeSignInPlan.isStale(outcome: .timedOut, authSignedIn: false))
    #expect(!ClaudeSignInPlan.isStale(outcome: .signedIn, authSignedIn: nil), "no answer from the check changes nothing")
    #expect(!ClaudeSignInPlan.isStale(outcome: nil, authSignedIn: false))
  }

  @Test func tmuxThatIsAlreadyThereIsNeverInstalledOver() {
    #expect(PrereqPlan.fix(for: "tmux", brew: "/opt/homebrew/bin/brew", existingPath: "/usr/local/bin/tmux") == nil)
    #expect(PrereqPlan.fix(for: "tmux", brew: "/opt/homebrew/bin/brew", existingPath: nil) != nil)
  }

  @Test func zeroWidthTagAndSeparatorCharactersAreHandled() {
    #expect(OwnerRules.clean("a\u{200B}b\u{200C}c\u{200D}d\u{2060}e\u{FEFF}f") == "abcdef")
    #expect(OwnerRules.clean("x\u{E0041}\u{E007F}y") == "xy", "Unicode tag characters hide text")
    #expect(OwnerRules.clean("one\u{2028}two\u{2029}three") == "one\ntwo\nthree")
  }

  @Test func aLinkedRulesFolderOrFileIsRefusedAndNothingIsWrittenThroughIt() throws {
    let fm = FileManager.default
    let d = try folder()
    let elsewhere = try folder()
    defer { try? fm.removeItem(atPath: d); try? fm.removeItem(atPath: elsewhere) }
    try fm.createDirectory(atPath: d + "/.claude", withIntermediateDirectories: true)
    try fm.createSymbolicLink(atPath: d + "/.claude/rules", withDestinationPath: elsewhere)
    guard case .refused(let why) = OwnerRules.save("x", agentDir: d) else { Issue.record("rules folder link"); return }
    #expect(why == OnboardingText.rulesLink(d + "/.claude/rules"))
    #expect(try fm.contentsOfDirectory(atPath: elsewhere).isEmpty)
    try fm.removeItem(atPath: d + "/.claude/rules")
    try fm.createDirectory(atPath: d + "/.claude/rules", withIntermediateDirectories: true)
    try "mine".write(toFile: elsewhere + "/target.md", atomically: true, encoding: .utf8)
    try fm.createSymbolicLink(atPath: OwnerRules.path(agentDir: d), withDestinationPath: elsewhere + "/target.md")
    guard case .refused = OwnerRules.save("x", agentDir: d) else { Issue.record("file link"); return }
    guard case .refused = OwnerRules.save("", agentDir: d) else { Issue.record("file link, remove"); return }
    #expect(try String(contentsOfFile: elsewhere + "/target.md", encoding: .utf8) == "mine")
  }
}
