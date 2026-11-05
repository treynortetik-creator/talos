import Foundation
import Testing
@testable import TalosDesktopCore

/// The 2.1.312 DevChannelsDialog as it renders (title, body, Channels line, select). Boxed and unboxed variants.
func devDialog(channels: String = "server:talos-app", highlight: Int = 1, boxed: Bool = false, title: Int = 1) -> [String] {
  var rows: [String] = []
  for _ in 0..<title { rows.append(" WARNING: Loading development channels") }
  rows += [
    "",
    " --dangerously-load-development-channels is for local channel development only. Do not use this option to run channels you have downloaded off the internet.",
    "",
    " Please use --channels to run a list of approved channels.",
    "",
    " Channels: \(channels)",
    "",
    highlight == 1 ? " ❯ 1. I am using this for local development" : "   1. I am using this for local development",
    highlight == 2 ? " ❯ 2. Exit" : "   2. Exit",
    "",
    " Enter to confirm · Esc to cancel",
  ]
  return boxed ? rows.map { "│ \($0)   │" } : rows
}

@Suite("DialogMatcher")
struct DialogMatcherTests {
  @Test(arguments: [false, true])
  func readsTheDevDialog(boxed: Bool) {
    guard case .devChannels(let d) = DialogMatcher.classify(devDialog(boxed: boxed)) else {
      Issue.record("not a dev dialog")
      return
    }
    #expect(d.channels == ["server:talos-app"])
    #expect(d.highlighted == DialogMatcher.Strings.devConfirm)
    #expect(d.titleCount == 1)
  }

  @Test func aTitleLeftBehindWithoutTheSelectionIsNotTheDialog() {
    // What an answered dialog can leave on screen, or a line that only quotes it.
    let leftover = [" WARNING: Loading development channels", "", " Channels (experimental) messages from server:talos-app inject directly in this session"]
    #expect(DialogMatcher.classify(leftover) == .none)
    #expect(!DialogMatcher.classify(leftover).isDialog)
    #expect(DialogMatcher.classify(devDialog()).isDialog, "control: the whole dialog still is")
  }

  @Test func aPaneTooShortForTheTitleIsAnUnknownQuestionNeverTheDevDialog() {
    // The title and the Channels line have scrolled off the top; the highlighted confirm option is what is left. It could as well
    // be text that quotes the dialog, so it is reported as a question Talos does not know, and nothing is confirmed on it.
    let rows = Array(devDialog().suffix(4))
    #expect(DialogMatcher.classify(rows) == .unknownSelection)
    #expect(DialogMatcher.classify(rows).isDialog, "the owner is still told")
    #expect(AutoConfirmGuard.decide(AutoConfirmGuardTests().inputs(rows)) == .refuse(.noDialog))
  }

  @Test func aQuotedConfirmRowIsNeverTheDevDialogEvenWithTheNoticeOnScreen() {
    let notice = " Channels (experimental) messages from server:talos-app inject directly in this session · restart without --dangerously-load-development-channels to stop"
    for quote in ["❯ 1. I am using this for local development", "   ❯ 1. I am using this for local development", "│ ❯ 1. I am using this for local development │"] {
      let screen = DialogMatcher.classify([notice, "", " The agent wrote:", quote])
      if case .devChannels = screen { Issue.record("read as the dev dialog: \(quote)") }
    }
  }

  @Test func otherDialogs() {
    #expect(DialogMatcher.classify([" ❯ 1. Yes, I trust this folder", "   2. No, exit"]) == .trust)
    #expect(DialogMatcher.classify([" New MCP server found in this project: x"]) == .mcpConsent)
    #expect(DialogMatcher.classify([" WARNING: Claude Code running in Bypass Permissions mode"]) == .bypassDisclaimer)
    #expect(DialogMatcher.classify(["API Error: 401 · Please run /login"]) == .loginExpired)
    #expect(DialogMatcher.classify([" Something new?", " ❯ 1. Sure", "   2. No"]) == .unknownSelection)
    #expect(DialogMatcher.classify(["> hello", "some output"]) == .none)
    #expect(DialogMatcher.classify(["No session found with ID 1234"]) == .resumeMissing)
  }

  @Test func theNotice() {
    let n =
      " Channels (experimental) messages from server:talos-app inject directly in this session · restart without --dangerously-load-development-channels to stop"
    #expect(DialogMatcher.noticeSeen([n]))
    // Wrapped across two rows by a narrow pane.
    #expect(DialogMatcher.noticeSeen([" Channels (experimental) messages from server:talos-app inject", "directly in this session · …"]))
    #expect(!DialogMatcher.noticeSeen([" inject directly in this session", " Channels (experimental) messages from x"]))
  }

  @Test func versions() {
    #expect(CLIVersion.parse("2.1.312 (Claude Code)") == CLIVersion(2, 1, 312))
    #expect(CLIVersion.parse("garbage") == nil)
    // `claude --version` prints three numbers and a name; anything else is "unknown" and the guard refuses to answer for it
    #expect(CLIVersion.parse("2.1.312\n") == CLIVersion(2, 1, 312))
    #expect(CLIVersion.parse("2.1") == nil)
    #expect(CLIVersion.parse("2.1.312.4") == nil)
    #expect(CLIVersion.parse("2.1.x") == nil)
    #expect(CLIVersion.parse("") == nil)
  }
}

@Suite("AutoConfirmGuard")
struct AutoConfirmGuardTests {
  let id = "0f1e2d3c-4b5a-4968-8776-655443322110"

  func inputs(
    _ rows: [String] = devDialog(), kind: AutoConfirmGuard.StartKind = .supervisorRestart, resume: String? = nil,
    session: DesktopConfig.Session? = nil, version: String? = "2.1.312", sent: Int = 0, loop: CrashLoop = CrashLoop(),
    enabled: Bool = true
  ) -> AutoConfirmGuard.Inputs {
    AutoConfirmGuard.Inputs(
      enabled: enabled, startKind: kind, launchedResumeId: resume ?? id,
      session: session
        ?? DesktopConfig.Session(
          id: id, confirmedAt: "2026-10-30T00:00:00Z", confirmedCliVersion: "2.1.312",
          approvedDevChannels: ["server:talos-app"]),
      cliVersion: version, screen: DialogMatcher.classify(rows), confirmsThisStart: sent, loop: loop, now: 100)
  }

  @Test func confirmsOnlyTheExactRestartCase() {
    #expect(AutoConfirmGuard.decide(inputs()) == .confirm)
  }

  @Test func refusals() {
    let r = { (i: AutoConfirmGuard.Inputs) in AutoConfirmGuard.decide(i) }
    #expect(r(inputs(enabled: false)) == .refuse(.disabled))
    #expect(r(inputs(kind: .cold)) == .refuse(.coldStart))
    #expect(r(inputs(resume: "aaaaaaaa-4b5a-4968-8776-655443322110")) == .refuse(.idMismatch))
    #expect(r(inputs(session: DesktopConfig.Session(id: id, approvedDevChannels: ["server:talos-app"]))) == .refuse(.notHumanConfirmed))
    #expect(r(inputs(version: "2.1.313")) == .refuse(.versionChanged))
    #expect(r(inputs(version: nil)) == .refuse(.versionUnknown))
    #expect(r(inputs(sent: 1)) == .refuse(.alreadyConfirmedThisStart))
    #expect(r(inputs(["> working"])) == .refuse(.noDialog))
    #expect(r(inputs(devDialog(title: 2))) == .refuse(.ambiguousDialog), "the dialog printed twice")
    #expect(r(inputs(devDialog(highlight: 2))) == .refuse(.wrongHighlight))
    // the title gone with the Channels line and the confirm row still there: a different screen, never confirmed
    let noTitle = DialogMatcher.DevChannels(
      channels: ["server:talos-app"], highlighted: DialogMatcher.Strings.devConfirm, titleCount: 0, channelLineCount: 1)
    var i = inputs()
    i.screen = .devChannels(noTitle)
    #expect(r(i) == .refuse(.ambiguousDialog))
    var l = CrashLoop()
    for t in [10.0, 20, 30] { l.recordAutoConfirm(now: t) }
    #expect(r(inputs(loop: l)) == .refuse(.rateLimited))
  }

  @Test(arguments: [
    "server:talos-app, server:talos-app-evil", "server:talos-app-evil", "server:talos-app, server:talos-app",
    "server:talos-app,plugin:x@y", "Server:talos-app", "",
  ])
  func channelsMustMatchExactly(_ line: String) {
    #expect(AutoConfirmGuard.decide(inputs(devDialog(channels: line))) == .refuse(.channelsMismatch))
  }

  @Test func channelOrderDoesNotMatter() {
    var s = DesktopConfig.Session(
      id: id, confirmedAt: "x", confirmedCliVersion: "2.1.312", approvedDevChannels: ["server:b", "server:a"])
    #expect(AutoConfirmGuard.decide(inputs(devDialog(channels: "server:a, server:b"), session: s)) == .confirm)
    s.approvedDevChannels = []
    #expect(AutoConfirmGuard.decide(inputs(devDialog(channels: ""), session: s)) == .refuse(.channelsMismatch))
  }
}
