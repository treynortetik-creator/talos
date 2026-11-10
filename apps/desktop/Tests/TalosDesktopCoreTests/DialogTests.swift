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
  /// What a Main start whose argv passed `--dangerously-load-development-channels server:talos-app` shows, one second after the spawn,
  /// with nobody typing. Nothing here says whether the start is a cold start or a restart: the guard no longer asks.
  func inputs(
    _ rows: [String] = devDialog(), enabled: Bool = true, isMain: Bool = true, launched: [String] = ["server:talos-app"],
    since: Double = 1, sent: Int = 0, typing: Bool = false, loop: CrashLoop = CrashLoop(), launchChanged: Bool = false
  ) -> AutoConfirmGuard.Inputs {
    AutoConfirmGuard.Inputs(
      enabled: enabled, isMain: isMain, launchedChannels: launched, screen: DialogMatcher.classify(rows),
      launchChanged: launchChanged, secondsSinceSpawn: since, confirmsThisStart: sent, clientsMayBeTyping: typing, loop: loop, now: 100)
  }

  @Test func confirmsTheExactDialog() {
    #expect(AutoConfirmGuard.decide(inputs()) == .confirm)
  }

  /// TG 24520 ("cold starts are always human") was retired by the owner on 2026-11-07. Nothing but the screen, the launch's own argv,
  /// the clock, the typing guard and the rate limit decides now.
  @Test func refusals() {
    let r = { (i: AutoConfirmGuard.Inputs) in AutoConfirmGuard.decide(i) }
    #expect(r(inputs(enabled: false)) == .refuse(.disabled))
    #expect(r(inputs(isMain: false)) == .refuse(.notMain), "a worker's screen is never answered")
    #expect(r(inputs(sent: 1)) == .refuse(.alreadyConfirmedThisStart))
    #expect(r(inputs(["> working"])) == .refuse(.noDialog))
    #expect(r(inputs(devDialog(title: 2))) == .refuse(.ambiguousDialog), "the dialog printed twice")
    #expect(r(inputs(devDialog(highlight: 2))) == .refuse(.wrongHighlight))
    #expect(r(inputs(since: 60.5)) == .refuse(.outsideWindow))
    #expect(r(inputs(typing: true)) == .refuse(.clientsMayBeTyping))
    #expect(r(inputs(launchChanged: true)) == .refuse(.launchChanged), "a launch the owner has not confirmed waits for him")
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

  @Test func theWindowIsSixtySecondsFromTheSpawn() {
    #expect(AutoConfirmGuard.window == 60)
    #expect(AutoConfirmGuard.decide(inputs(since: 60)) == .confirm, "inside, on the edge")
    #expect(AutoConfirmGuard.decide(inputs(since: 60.001)) == .refuse(.outsideWindow))
    #expect(AutoConfirmGuard.decide(inputs(since: 3600)) == .refuse(.outsideWindow))
  }

  /// The channels the screen shows must be exactly the Talos channel, nothing extra.
  @Test(arguments: [
    "server:talos-app, server:talos-app-evil", "server:talos-app-evil", "server:talos-app, server:talos-app",
    "server:talos-app,plugin:x@y", "Server:talos-app", "",
  ])
  func channelsMustMatchExactly(_ line: String) {
    #expect(AutoConfirmGuard.decide(inputs(devDialog(channels: line))) == .refuse(.channelsMismatch))
  }

  /// The launch command can be edited by whatever can write desktop.json: the argv agreeing with the screen is not enough.
  @Test func onlyTheTalosChannelIsEverAnswered() {
    let r = { (i: AutoConfirmGuard.Inputs) in AutoConfirmGuard.decide(i) }
    #expect(AutoConfirmGuard.talosChannel == "server:talos-app")
    #expect(r(inputs(devDialog(channels: "server:talos-app"), launched: ["server:talos-app"])) == .confirm)
    // argv with an extra channel, and the screen showing both
    #expect(r(inputs(devDialog(channels: "server:talos-app, server:evil"), launched: ["server:talos-app", "server:evil"])) == .refuse(.channelsMismatch))
    // argv and screen both name another channel
    #expect(r(inputs(devDialog(channels: "server:evil"), launched: ["server:evil"])) == .refuse(.channelsMismatch))
    // the screen is the Talos channel but the argv is not just that (another channel, none, the flag twice)
    #expect(r(inputs(devDialog(channels: "server:talos-app"), launched: ["server:talos-app", "server:evil"])) == .refuse(.channelsMismatch))
    #expect(r(inputs(devDialog(channels: "server:talos-app"), launched: ["server:evil"])) == .refuse(.channelsMismatch))
    #expect(r(inputs(devDialog(channels: "server:talos-app"), launched: [])) == .refuse(.channelsMismatch))
    #expect(r(inputs(devDialog(channels: "server:talos-app"), launched: ["server:talos-app", "server:talos-app"])) == .refuse(.channelsMismatch))
    // the argv is the Talos channel but the screen shows more or another
    #expect(r(inputs(devDialog(channels: "server:evil"), launched: ["server:talos-app"])) == .refuse(.channelsMismatch))
    #expect(r(inputs(devDialog(channels: "server:talos-app, server:evil"), launched: ["server:talos-app"])) == .refuse(.channelsMismatch))
    // a canonically-equal lookalike is different bytes
    #expect(r(inputs(devDialog(channels: "server:talos-app\u{0301}"), launched: ["server:talos-app"])) == .refuse(.channelsMismatch))
  }

  @Test func theChannelsAnArgvPassed() {
    let flag = "--dangerously-load-development-channels"
    #expect(AutoConfirmGuard.channels(inArgv: ["--dangerously-skip-permissions", flag, "server:talos-app"]) == ["server:talos-app"])
    #expect(AutoConfirmGuard.channels(inArgv: [flag, "server:a", "server:b", "--resume", "x"]) == ["server:a", "server:b"])
    #expect(AutoConfirmGuard.channels(inArgv: ["\(flag)=server:a"]) == ["server:a"])
    #expect(AutoConfirmGuard.channels(inArgv: [flag, "server:a", "--x", flag, "server:b"]) == ["server:a", "server:b"])
    #expect(AutoConfirmGuard.channels(inArgv: ["--channels", "plugin:x@y"]).isEmpty, "--channels is another flag")
    #expect(AutoConfirmGuard.channels(inArgv: ["--resume", "id"]).isEmpty)
    #expect(AutoConfirmGuard.channels(inArgv: [flag]).isEmpty)
  }
}
