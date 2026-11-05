import Foundation
import Testing
@testable import TalosDesktopCore

/// Package F of the full-app audit (D7, D8, D41 to D46): the pure rules. Each test fails if its rule is broken.
@Suite("Mac audit package F: core")
struct MacAuditPackageFCoreTests {
  // MARK: D7 talos-app is a shell alias on a fresh checkout

  static let mcp = """
    {"mcpServers":{"other":{"command":"x"},"talos-app":{"command":"bun","args":["run","--cwd","/code/talos-app/apps/bridge","--silent","start"],"env":{"TALOS_APP_HOME":"/home/alex/.config/talos/app"}}}}
    """

  @Test func findsTheCliFromTheAgentFoldersMcpJson() {
    let f = TalosAppLocator.fromMcpJson(
      Data(Self.mcp.utf8), searchPath: "/usr/bin:/opt/bin", home: "/home/alex", isExecutable: { $0 == "/opt/bin/bun" },
      fileExists: { $0 == "/code/talos-app/apps/bridge/src/cli.ts" })
    #expect(f?.command == ["/opt/bin/bun", "run", "/code/talos-app/apps/bridge/src/cli.ts"])
    #expect(f?.env == ["TALOS_APP_HOME": "/home/alex/.config/talos/app"])
  }

  @Test func bunOffThePathIsFoundInTheUsualPlaces() {
    let f = TalosAppLocator.fromMcpJson(
      Data(Self.mcp.utf8), searchPath: "/usr/bin", home: "/home/alex", isExecutable: { $0 == "/home/alex/.bun/bin/bun" },
      fileExists: { _ in true })
    #expect(f?.command.first == "/home/alex/.bun/bin/bun")
  }

  @Test func nothingUsableIsNilNeverAGuess() {
    let ok: (String) -> Bool = { _ in true }
    #expect(TalosAppLocator.fromMcpJson(nil, searchPath: "/b", home: "/h", isExecutable: ok, fileExists: ok) == nil)
    #expect(TalosAppLocator.fromMcpJson(Data("not json".utf8), searchPath: "/b", home: "/h", isExecutable: ok, fileExists: ok) == nil)
    #expect(TalosAppLocator.fromMcpJson(Data(#"{"mcpServers":{}}"#.utf8), searchPath: "/b", home: "/h", isExecutable: ok, fileExists: ok) == nil)
    // no src/cli.ts there, or no bun to run it
    #expect(TalosAppLocator.fromMcpJson(Data(Self.mcp.utf8), searchPath: "/b", home: "/h", isExecutable: ok, fileExists: { _ in false }) == nil)
    #expect(TalosAppLocator.fromMcpJson(Data(Self.mcp.utf8), searchPath: "/b", home: "/h", isExecutable: { _ in false }, fileExists: ok) == nil)
    // an entry without --cwd names no folder to look in
    let noCwd = #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","x"]}}}"#
    #expect(TalosAppLocator.fromMcpJson(Data(noCwd.utf8), searchPath: "/b", home: "/h", isExecutable: ok, fileExists: ok) == nil)
  }

  @Test func theSettingsFieldRoundTripsAnArgumentList() {
    #expect(TalosAppLocator.parseCommandLine("bun run /a b/cli.ts") == ["bun", "run", "/a", "b/cli.ts"])
    let argv = ["bun", "run", "/home/alex/x y/talos/cli.ts"]
    #expect(TalosAppLocator.parseCommandLine(TalosAppLocator.formatCommandLine(argv)) == argv)
    #expect(TalosAppLocator.parseCommandLine("   ").isEmpty)
    #expect(TalosAppLocator.notFoundMessage.contains(MacSettingsText.connectionPath))
  }

  @Test func firstRunHasATalosAppRowOnlyWhenChecked() {
    let none = FirstRun.rows(.init(home: "/h")).map(\.id)
    #expect(!none.contains("talosapp"))
    let bad = FirstRun.rows(.init(home: "/h", talosAppFound: false)).first { $0.id == "talosapp" }
    guard case .fix(let m)? = bad?.state else { Issue.record("a missing command is a fix"); return }
    #expect(m.contains(MacSettingsText.connectionPath))
    #expect(FirstRun.rows(.init(home: "/h", talosAppFound: true)).first { $0.id == "talosapp" }?.isOK == true)
  }

  // MARK: D8 the pane opens for the notification

  @Test func theNeedsYouBannerOpensTheTerminalAndQuietOnesDoNot() {
    #expect(NotificationPolicy.notice(.needsYou, agent: "Talos").opensTerminal)
    #expect(NotificationPolicy.notice(.couldNotStart, agent: "Talos").opensTerminal)
    #expect(!NotificationPolicy.notice(.restartedAfterCrash, agent: "Talos").opensTerminal)
    #expect(NotificationPolicy.web(title: "t", body: "b", navigate: "/", tag: nil, windowIsKey: false)?.opensTerminal == false)
  }

  // MARK: D41 / D42

  @Test func everyStoppedAndBlockedStateRaisesABanner() {
    let notices = [
      SupervisorNotice.needsYou, SupervisorNotice.restarted, SupervisorNotice.stoppedRestarting, SupervisorNotice.resumeFailed,
      SupervisorNotice.confirmFailed, SupervisorNotice.blocked, SupervisorNotice.couldNotStart, SupervisorNotice.crashedNoRestart,
    ]
    for n in notices {
      let e = SupervisorNotice.event(for: n + ": detail")
      #expect(e != nil, "\(n)")
      if let e { #expect(NotificationPolicy.notice(e, agent: "Talos").body.contains("Talos"), "\(n)") }
    }
    #expect(SupervisorNotice.event(for: "") == nil)
  }

  @Test func aStaleInstructionGoesWhenTheSessionMovesOn() {
    let press = SupervisorNotice.needsYou + ": press Enter on the dev-channel warning in the pane"
    #expect(!SupervisorNotice.isStale(press, phase: .running, needsYou: true))
    #expect(SupervisorNotice.isStale(press, phase: .stopped, needsYou: true), "the session is gone")
    #expect(SupervisorNotice.isStale(press, phase: .running, needsYou: false), "nothing waits any more")
    let failed = SupervisorNotice.couldNotStart + ": x"
    #expect(!SupervisorNotice.isStale(failed, phase: .stopped, needsYou: false))
    #expect(SupervisorNotice.isStale(failed, phase: .starting, needsYou: false), "a new start is under way")
    #expect(!SupervisorNotice.isStale(SupervisorNotice.restarted, phase: .running, needsYou: false))
  }

  @Test func theNoLogYetNoticeGoesOnceTheLogExists() {
    let n = SupervisorNotice.noLogNotice(path: "/home/alex/bridge.log")
    #expect(n.hasPrefix(SupervisorNotice.noLogYet))
    #expect(!SupervisorNotice.isStale(n, phase: .stopped, needsYou: false, logExists: false), "still no log: keep saying so")
    #expect(SupervisorNotice.isStale(n, phase: .running, needsYou: false, logExists: true), "the log exists now")
    #expect(SupervisorNotice.event(for: n) == nil, "it raises no banner")
  }

  // MARK: D43

  @Test func aSessionInTmuxIsAttachedEvenWithoutALiveChild() {
    #expect(TerminalPane.choose(configured: true, hasLiveChild: false, sessionExists: true) == .attach)
    #expect(TerminalPane.choose(configured: true, hasLiveChild: true, sessionExists: false) == .attach)
    guard case .note(let m) = TerminalPane.choose(configured: true, hasLiveChild: false, sessionExists: false) else {
      Issue.record("nothing to attach to says why")
      return
    }
    #expect(m.contains("Start session"))
  }

  // MARK: D44

  @Test func theNotSetUpLineNamesOnlyRealControls() {
    #expect(!SupervisorNotice.notSetUp.contains("Session… →"), "there is no menu item called Session…")
    #expect(SupervisorNotice.notSetUp.contains("Find a running session"))
  }

  // MARK: D45

  @Test func importKeepsTheBridgeVariables() {
    #expect(BridgeEnv.merged([:]) == ["TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy"])
    let m = BridgeEnv.merged(["FOO": "1", "MCP_PROTOCOL_NEGOTIATION": "other"])
    #expect(m["FOO"] == "1")
    #expect(m["TALOS_APP_BRIDGE"] == "1")
    #expect(m["MCP_PROTOCOL_NEGOTIATION"] == "legacy")
  }

  // MARK: D46

  @Test func aDeadRelayIsNotSignedOut() {
    #expect(PageState.resolve(pageReady: false, signedIn: false, loadFailed: true) == .unreachable)
    #expect(PageState.resolve(pageReady: false, signedIn: false, loadFailed: false) == .loading)
    #expect(PageState.resolve(pageReady: true, signedIn: false, loadFailed: false) == .signedOut)
    #expect(PageState.resolve(pageReady: true, signedIn: true, loadFailed: false) == .signedIn)
    #expect(PageState.resolve(pageReady: false, signedIn: true, loadFailed: true) == .unreachable, "signed-in profile, relay down")
    #expect(!PageState.unreachable.offersSignIn)
    #expect(!PageState.loading.offersSignIn)
    #expect(PageState.signedOut.offersSignIn)
  }

  // MARK: D13 attachments download inside the app

  @Test func onlyTheRelaysAttachmentRouteIsAFileNotAnAgentPage() {
    let relay = RelayOrigin("https://relay.example.com")!
    func f(_ s: String) -> Bool { WebPolicy.isMediaFile(URL(string: s)!, relay: relay) }
    #expect(f("https://relay.example.com/media/m_01ABC"))
    #expect(f("https://relay.example.com/media/m_01ABC?x=1"))
    #expect(f("https://relay.example.com/%6dedia/m_01ABC"), "escaped spelling is the same path")
    #expect(!f("https://relay.example.com/media/m_01ABC/page"), "agent pages stay in the browser")
    #expect(!f("https://relay.example.com/media/m_01ABC/app"))
    #expect(!f("https://relay.example.com/media/a/../b/page"))
    #expect(!f("https://relay.example.com/media"))
    #expect(!f("https://evil.example/media/m_01ABC"), "another origin is never fetched with the app's session")
    #expect(!f("http://relay.example.com/media/m_01ABC"))
    #expect(!f("https://relay.example.com/other/m_01ABC"))
  }

  @Test func aRefusedDownloadIsSaidNotSavedAsAnErrorPage() {
    #expect(DownloadRules.verdict(status: 200, suggestedFilename: "report.pdf") == .save(filename: "report.pdf"))
    #expect(DownloadRules.verdict(status: nil, suggestedFilename: "a.zip") == .save(filename: "a.zip"))
    for code in [401, 403, 404, 410, 500] {
      guard case .fail(let why) = DownloadRules.verdict(status: code, suggestedFilename: "x") else {
        Issue.record("\(code) must not be saved")
        continue
      }
      #expect(!why.isEmpty)
    }
    guard case .fail(let why) = DownloadRules.verdict(status: 401, suggestedFilename: "x") else { return }
    #expect(why.contains("Sign in"))
  }

  @Test func aFilenameFromTheWireCannotChooseAFolderOrHideItself() {
    #expect(DownloadRules.safeFilename("../../etc/passwd") == "etcpasswd")
    #expect(DownloadRules.safeFilename(".hidden") == "hidden")
    #expect(DownloadRules.safeFilename("a\u{0}b\n.txt") == "ab.txt")
    #expect(DownloadRules.safeFilename("") == "download")
    #expect(DownloadRules.safeFilename("...") == "download")
    #expect(DownloadRules.safeFilename(String(repeating: "a", count: 500)).count == 120)
  }

  // MARK: review round: the typed command must be runnable

  @Test func aTypedCommandIsMadeRunnableNotLeftAsABareName() {
    let exec: (String) -> Bool = { $0 == "/opt/homebrew/bin/bun" || $0 == "/home/alex/code/cli.ts.bin" }
    // Process and execve do no PATH search: `bun` must come back as a path (it threw "bun doesn't exist").
    #expect(
      TalosAppLocator.runnable(["bun", "run", "~/code/cli.ts"], searchPath: "/usr/bin:/opt/homebrew/bin", home: "/home/alex", isExecutable: exec)
        == ["/opt/homebrew/bin/bun", "run", "/home/alex/code/cli.ts"])
    #expect(TalosAppLocator.runnable(["~/code/cli.ts.bin"], searchPath: "/usr/bin", home: "/home/alex", isExecutable: exec) == ["/home/alex/code/cli.ts.bin"])
    // not found is nil, so the row is not green and Sign in says so instead of failing at exec
    #expect(TalosAppLocator.runnable(["nope", "x"], searchPath: "/usr/bin", home: "/home/alex", isExecutable: exec) == nil)
    #expect(TalosAppLocator.runnable([], searchPath: "/usr/bin", home: "/home/alex", isExecutable: exec) == nil)
  }

  @Test func aServiceThatAnswersWithAnErrorIsDownNotLoading() {
    #expect(PageState.isServerDown(status: 502))
    #expect(PageState.isServerDown(status: 503))
    #expect(!PageState.isServerDown(status: 200))
    #expect(!PageState.isServerDown(status: 404))
    #expect(!PageState.isServerDown(status: nil))
  }

  @Test func adoptKeepsTheBridgeVariablesEvenWhenTheEnvironmentCantBeRead() {
    var plan = AdoptPlan(
      pid: 1, agentDir: "/home/alex/agent", claudePath: "auto", args: [], env: [:], sessionId: nil, envReadable: false)
    let applied = plan.applied(to: .defaults, home: "/home/alex")
    #expect(applied.env["TALOS_APP_BRIDGE"] == "1", "\(applied.env)")
    #expect(applied.env["MCP_PROTOCOL_NEGOTIATION"] == "legacy")
    plan.envReadable = true
    plan.env = ["FOO": "1"]
    let readable = plan.applied(to: .defaults, home: "/home/alex")
    #expect(readable.env["FOO"] == "1")
    #expect(readable.env["TALOS_APP_BRIDGE"] == "1")
  }
}
