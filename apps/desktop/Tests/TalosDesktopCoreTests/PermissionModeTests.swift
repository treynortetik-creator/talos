import Foundation
import Testing
import TalosTestSupport
@testable import TalosDesktopCore

@Suite("Permission mode picker")
struct PermissionModeTests {
  let channels = ["--plugin-dir", "/x/plugin", "--dangerously-load-development-channels", "server:talos-app"]

  // MARK: reading the mode from the launch arguments

  @Test func noFlagIsAutoBecauseThatIsClaudeCodesOwnDefault() {
    #expect(PermissionModeSetting.read([]) == .mode(.auto))
    #expect(PermissionModeSetting.read(channels) == .mode(.auto))
  }

  @Test func eachDocumentedFormIsRead() {
    #expect(PermissionModeSetting.read(["--permission-mode", "auto"]) == .mode(.auto))
    #expect(PermissionModeSetting.read(["--permission-mode=auto"]) == .mode(.auto))
    #expect(PermissionModeSetting.read(["--permission-mode", "default"]) == .mode(.ask))
    #expect(PermissionModeSetting.read(["--permission-mode=manual"]) == .mode(.ask))
    #expect(PermissionModeSetting.read(["--dangerously-skip-permissions"]) == .mode(.bypass))
    #expect(PermissionModeSetting.read(["--permission-mode", "bypassPermissions"]) == .mode(.bypass))
    #expect(PermissionModeSetting.read(["--permission-mode=bypassPermissions"]) == .mode(.bypass))
  }

  @Test func anImportedCommandShowsItsRealMode() throws {
    let spec = try LaunchSpec.parse(
      "cd ~/agent && claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels server:talos-app",
      home: "/home/example")
    #expect(PermissionModeSetting.read(spec.args) == .mode(.bypass))
  }

  @Test func anythingElseIsCustom() {
    for args in [
      ["--permission-mode", "plan"], ["--permission-mode=acceptEdits"], ["--permission-mode", "dontAsk"], ["--permission-mode", "nonsense"],
      ["--permission-mode"], ["--allow-dangerously-skip-permissions"],
      ["--allow-dangerously-skip-permissions", "--permission-mode", "plan"],
      // two flags that disagree: not one mode
      ["--dangerously-skip-permissions", "--permission-mode", "default"],
      ["--permission-mode", "auto", "--permission-mode", "default"],
    ] {
      #expect(PermissionModeSetting.read(args) == .custom, "\(args)")
    }
  }

  @Test func twoFlagsThatAgreeAreOneMode() {
    #expect(PermissionModeSetting.read(["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"]) == .mode(.bypass))
  }

  @Test func aFlagThatIsAnotherFlagsValueOrAfterTheDashesIsNotRead() {
    #expect(PermissionModeSetting.read(["--append-system-prompt", "--dangerously-skip-permissions"]) == .mode(.auto))
    #expect(PermissionModeSetting.read(["--", "--dangerously-skip-permissions"]) == .mode(.auto))
    #expect(PermissionModeSetting.read(["--name", "--permission-mode"]) == .mode(.auto))
  }

  // MARK: rewriting

  @Test func eachModeWritesItsOwnFlag() {
    #expect(PermissionModeSetting.flags(for: .auto) == ["--permission-mode", "auto"])
    #expect(PermissionModeSetting.flags(for: .ask) == ["--permission-mode", "default"])
    #expect(PermissionModeSetting.flags(for: .bypass) == ["--dangerously-skip-permissions"])
  }

  @Test func withNoFlagTheNewOneGoesFirstAndTheRestIsKept() {
    #expect(PermissionModeSetting.applying(.ask, to: channels) == ["--permission-mode", "default"] + channels)
    #expect(PermissionModeSetting.applying(.bypass, to: []) == ["--dangerously-skip-permissions"])
  }

  @Test func anExistingFlagIsReplacedInPlaceNeverDuplicated() {
    let before = ["--dangerously-skip-permissions"] + channels
    #expect(PermissionModeSetting.applying(.ask, to: before) == ["--permission-mode", "default"] + channels)
    let mid = ["--plugin-dir", "/x", "--permission-mode", "default", "--name", "main"]
    #expect(PermissionModeSetting.applying(.bypass, to: mid) == ["--plugin-dir", "/x", "--dangerously-skip-permissions", "--name", "main"])
    #expect(PermissionModeSetting.applying(.auto, to: ["--permission-mode=bypassPermissions", "--name", "m"]) == ["--permission-mode", "auto", "--name", "m"])
  }

  @Test func everyPermissionFlagGoesAndExactlyOneComesBack() {
    let messy = ["--dangerously-skip-permissions", "--name", "m", "--permission-mode", "plan", "--allow-dangerously-skip-permissions", "--permission-mode=auto"]
    for mode in PermissionMode.allCases {
      let out = PermissionModeSetting.applying(mode, to: messy)
      #expect(PermissionModeSetting.read(out) == .mode(mode), "\(mode): \(out)")
      #expect(out.filter { $0 == "--name" }.count == 1 && out.contains("m"))
      #expect(!out.contains("--allow-dangerously-skip-permissions") && !out.contains("plan") && !out.contains("--permission-mode=auto"))
      #expect(out.filter { $0.hasPrefix("--permission-mode") || $0 == "--dangerously-skip-permissions" }.count == 1)
    }
  }

  @Test func aFlagAfterTheDashesOrAnotherFlagsValueIsLeftAlone() {
    let args = ["--append-system-prompt", "--dangerously-skip-permissions", "--", "--permission-mode", "plan"]
    let out = PermissionModeSetting.applying(.ask, to: args)
    #expect(out == ["--permission-mode", "default"] + args)
  }

  @Test func theNewFlagIsNeverSwallowedByAFlagBeforeIt() {
    // a flag that waits for its value last: the new flag goes first, so it can never become that value
    let out = PermissionModeSetting.applying(.auto, to: ["--name"])
    #expect(out == ["--permission-mode", "auto", "--name"])
    #expect(PermissionModeSetting.read(out) == .mode(.auto))
  }

  @Test func aPermissionModeWithNoValueLeftAtTheEndGoesWithoutOverrunning() {
    #expect(PermissionModeSetting.applying(.bypass, to: ["--name", "m", "--permission-mode"]) == ["--name", "m", "--dangerously-skip-permissions"])
  }

  // MARK: against the saved config

  private func cfg(_ args: [String]) -> DesktopConfig {
    var c = DesktopConfig.defaults
    c.args = args
    c.env = ["KEEP": "me"]
    return c
  }

  @Test func theSameModeAsSavedChangesNothing() {
    #expect(PermissionModeSetting.evaluate(.bypass, against: cfg(["--dangerously-skip-permissions"])) == .unchanged)
    #expect(PermissionModeSetting.evaluate(.auto, against: cfg(channels)) == .unchanged)
    #expect(PermissionModeSetting.evaluate(.ask, against: cfg(["--permission-mode=manual"])) == .unchanged)
  }

  @Test func aDifferentModeIsSavedAndKeepsEverythingElse() {
    let c = cfg(["--dangerously-skip-permissions"] + channels)
    guard case .updated(let args) = PermissionModeSetting.evaluate(.ask, against: c) else {
      Issue.record("not updated")
      return
    }
    #expect(args == ["--permission-mode", "default"] + channels)
    #expect(PermissionModeSetting.applied(c, args: args).env == ["KEEP": "me"])
    #expect(PermissionModeSetting.applied(c, args: args).claudePath == c.claudePath)
  }

  @Test func aCustomCombinationIsNeverRewrittenUnlessAModeIsChosen() {
    let c = cfg(["--permission-mode", "plan"])
    #expect(PermissionModeSetting.read(c.args) == .custom)
    // choosing a mode is the owner's explicit act: it replaces the custom flag
    guard case .updated(let args) = PermissionModeSetting.evaluate(.ask, against: c) else {
      Issue.record("not updated")
      return
    }
    #expect(args == ["--permission-mode", "default"])
  }

  // MARK: the cold restart

  @Test func aRunningAgentIsRestartedForYouAndAnIdleOneJustSaved() {
    #expect(PermissionModeSetting.followUp(sessionUp: true, turnRunning: false) == .restartNow)
    #expect(PermissionModeSetting.followUp(sessionUp: false, turnRunning: false) == .saveOnly)
    #expect(PermissionModeSetting.followUp(sessionUp: false, turnRunning: true) == .saveOnly)
  }

  @Test func aTurnInProgressAsksFirst() {
    #expect(PermissionModeSetting.followUp(sessionUp: true, turnRunning: true) == .askFirst)
  }

  @Test func aBusyActivityIsATurnRunning() {
    #expect(PermissionModeSetting.turnRunning(agentActivity: "busy"))
    #expect(!PermissionModeSetting.turnRunning(agentActivity: "idle"))
    #expect(!PermissionModeSetting.turnRunning(agentActivity: nil))
  }

  // MARK: words

  @Test func theWordsAreThePlainOnes() {
    #expect(PermissionMode.auto.label == "Auto (recommended)")
    #expect(PermissionMode.ask.label == "Ask me")
    #expect(PermissionMode.bypass.label == "Bypass all")
    #expect(PermissionModeSetting.bypassLine == "Bypass never asks you, on this Mac or on your phone.")
    #expect(PermissionModeSetting.customLabel == "Custom (set in Advanced)")
    #expect(MacSettingsText.applies(.permissionMode).hasPrefix("Applies"))
  }
}

@Suite("Permission mode request from the agent")
struct PermissionModeRequestTests {
  let now: Double = 1_800_000_000_000

  private func data(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }
  private var good: [String: Any] { ["v": 1, "action": "set_permission_mode", "mode": "ask", "control_id": "pm-1", "ts": now] }

  @Test func aWellFormedRequestIsRead() {
    let r = PermissionModeRequest.parse(data(good))
    #expect(r == PermissionModeRequest(mode: .ask, controlId: "pm-1", ts: now))
  }

  @Test func eachModeNameIsRead() {
    for (name, mode) in [("auto", PermissionMode.auto), ("ask", .ask), ("bypass", .bypass)] {
      var o = good
      o["mode"] = name
      #expect(PermissionModeRequest.parse(data(o))?.mode == mode)
    }
  }

  @Test func anythingElseIsNotARequest() {
    for patch: [String: Any] in [
      ["mode": "plan"], ["mode": "bypassPermissions"], ["mode": 1], ["action": "restart"], ["v": 2], ["control_id": "a b"],
      ["control_id": ""], ["ts": "now"], ["ts": true],
    ] {
      var o = good
      for (k, v) in patch { o[k] = v }
      #expect(PermissionModeRequest.parse(data(o)) == nil, "\(patch)")
    }
    #expect(PermissionModeRequest.parse(Data("not json".utf8)) == nil)
    var missing = good
    missing.removeValue(forKey: "mode")
    #expect(PermissionModeRequest.parse(data(missing)) == nil)
  }

  @Test func staleOrFutureRequestsAreDiscarded() {
    let r = PermissionModeRequest(mode: .ask, controlId: "x", ts: now)
    #expect(PermissionModeRequest.decide(r, nowMs: now + 1000, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: false) == .apply)
    #expect(PermissionModeRequest.decide(r, nowMs: now + 301_000, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: false) == .discard)
    #expect(PermissionModeRequest.decide(r, nowMs: now - 61_000, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: false) == .discard)
  }

  @Test func oneWrittenBeforeThisLaunchOrAlreadyHandledIsDiscarded() {
    let r = PermissionModeRequest(mode: .ask, controlId: "x", ts: now)
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: nil, launchedAtMs: now + 1, locked: false, ownerStopped: false) == .discard)
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: "x", launchedAtMs: 0, locked: false, ownerStopped: false) == .discard)
  }

  @Test func theLockRefusesWhateverElseIsTrue() {
    let r = PermissionModeRequest(mode: .bypass, controlId: "x", ts: now)
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: nil, launchedAtMs: 0, locked: true, ownerStopped: false) == .refuse(.locked))
  }

  @Test func anUnreadableLockStateRefuses() {
    #expect(PermissionModeRequest.isLocked(configJson: nil))
    #expect(PermissionModeRequest.isLocked(configJson: Data("{".utf8)))
    #expect(PermissionModeRequest.isLocked(configJson: Data(#"{"settings_lock":true}"#.utf8)))
    #expect(PermissionModeRequest.isLocked(configJson: Data(#"{"settings_lock":"yes"}"#.utf8)))
    #expect(!PermissionModeRequest.isLocked(configJson: Data(#"{"settings_lock":false}"#.utf8)))
    #expect(!PermissionModeRequest.isLocked(configJson: Data(#"{"rev":3}"#.utf8)))
  }

  @Test func thePhoneIsToldWhatTheAgentDidAndBypassIsAVisibleRowWithTheWayBack() {
    let bypass = PermissionModeSetting.changedLine(.bypass, restarting: true)
    #expect(bypass.hasPrefix("Your agent switched itself to Bypass all."))
    #expect(bypass.contains("No permission cards reach your phone") && bypass.contains("If you did not ask for this, change it back"))
    #expect(bypass.contains("\"Start with Bypass all?\""), "the dialog it waits at is named")
    let ask = PermissionModeSetting.changedLine(.ask, restarting: true)
    #expect(ask.hasPrefix("The agent asked to switch the permission mode to Ask me."))
    #expect(!ask.contains("as you asked"))
    #expect(PermissionModeSetting.refusedLine(.custom).contains("own custom setting"))
  }

  @Test func theMacPopupNamesTheModeTheChangedLaunchStartsIn() {
    let offer = DialogOffer(
      id: "d1", kind: .devChannels, subject: "server:talos-app", options: ["1. I am using this for local development", "2. Exit"], cursor: 0,
      launch_changed: ["flags"], seen_at: "2026-11-19T15:00:00Z", expires_at: "2026-11-19T15:15:00Z")
    let named = NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "supervisor:main", threadName: "Main", dialog: offer, first: true, startMode: "Bypass all"))
    #expect(named.title == "Start with Bypass all?")
    #expect(named.sentence.hasSuffix("Main starts with the permission mode Bypass all."))
    let plain = NeedsYouPopupContent.make(NeedsYouPopupItem(thread: "supervisor:main", threadName: "Main", dialog: offer, first: true))
    #expect(plain.title == "Allow Talos's development channel?", "the shared wording is untouched when no mode is named")
    #expect(!plain.sentence.contains("permission mode"))
  }

  @Test func theOwnersStopStands() {
    let r = PermissionModeRequest(mode: .ask, controlId: "x", ts: now)
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: true) == .refuse(.ownerStopped))
  }
}

@Suite("Permission mode request file")
struct PermissionModeRequestFileTests {
  let now: Double = 1_800_000_000_000

  @Test func aSecondRequestSoonAfterTheFirstIsRefused() {
    let r = PermissionModeRequest(mode: .ask, controlId: "x", ts: now)
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: false, sinceLastRequest: 30) == .refuse(.tooSoon))
    #expect(PermissionModeRequest.decide(r, nowMs: now, lastHandledId: nil, launchedAtMs: 0, locked: false, ownerStopped: false, sinceLastRequest: 500) == .apply)
  }

  @Test func theFileIsReadAndClearedOnlyIfStillTheSameOne() throws {
    let dir = TestTemp.base + "/talos-d1-\("pm")-\(UUID().uuidString.prefix(8))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let path = dir + "/" + PermissionModeRequest.fileName
    #expect(PermissionModeRequestFile.read(path: path) == .absent)
    func write(_ id: String, _ mode: String = "ask") throws {
      try #"{"v":1,"action":"set_permission_mode","mode":"\#(mode)","control_id":"\#(id)","ts":\#(Int(now))}"#.write(toFile: path, atomically: true, encoding: .utf8)
    }
    try write("a")
    let seen = PermissionModeRequestFile.read(path: path)
    #expect(seen == .request(PermissionModeRequest(mode: .ask, controlId: "a", ts: now)))
    try write("b")  // a newer one arrives after the read
    #expect(!PermissionModeRequestFile.clear(path: path, ifStill: seen))
    #expect(FileManager.default.fileExists(atPath: path))
    #expect(PermissionModeRequestFile.clear(path: path, ifStill: PermissionModeRequestFile.read(path: path)))
    #expect(PermissionModeRequestFile.read(path: path) == .absent)
    try "{}".write(toFile: path, atomically: true, encoding: .utf8)
    #expect(PermissionModeRequestFile.read(path: path) == .invalid)
    try? FileManager.default.removeItem(atPath: path)
    try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: "/etc/hosts")
    #expect(PermissionModeRequestFile.read(path: path) == .invalid, "a link is never read")
  }
}

@Suite("Restart to apply")
struct LaunchPendingTests {
  private func parts(_ c: DesktopConfig) -> [String: String] { c.launchParts(resolvedClaude: "/x/claude") }

  @Test func theLaunchTheAgentRunsWithIsNotPendingWhileTheSavedOneMatches() {
    var c = DesktopConfig.defaults
    c.args = ["--dangerously-skip-permissions"]
    #expect(!LaunchPending.isPending(running: parts(c), saved: c))
  }

  @Test func aChangedFlagFolderOrEnvironmentIsPending() {
    var c = DesktopConfig.defaults
    c.args = ["--dangerously-skip-permissions"]
    let running = parts(c)
    var flags = c
    flags.args = ["--permission-mode", "default"]
    #expect(LaunchPending.isPending(running: running, saved: flags))
    var folder = c
    folder.agentDir = "/home/alex/other"
    #expect(LaunchPending.isPending(running: running, saved: folder))
    var env = c
    env.env = ["A": "b"]
    #expect(LaunchPending.isPending(running: running, saved: env))
  }

  @Test func theProgramIsNotComparedBecauseItIsResolvedAtStart() {
    var c = DesktopConfig.defaults
    c.args = ["--x"]
    var running = parts(c)
    running["program"] = "something-else"
    #expect(!LaunchPending.isPending(running: running, saved: c))
  }

  @Test func aSessionWhoseLaunchIsNotKnownIsPendingBecauseItWasNotStartedFromThisCommand() {
    #expect(LaunchPending.isPending(running: [:], saved: DesktopConfig.defaults))
  }

  @Test func threadSessionsAreHeldToWhatTheAgentRunsWithWhileAChangeWaits() {
    let saved = ["--dangerously-skip-permissions"]
    let running = ["--permission-mode", "default"]
    #expect(LaunchPending.holdsThreads(saved: saved, running: running, confirmedSaved: false))
    #expect(!LaunchPending.holdsThreads(saved: saved, running: saved, confirmedSaved: false))
    #expect(LaunchPending.holdsThreads(saved: saved, running: nil, confirmedSaved: false), "no launch got through yet and none confirmed: held")
    #expect(!LaunchPending.holdsThreads(saved: saved, running: nil, confirmedSaved: true), "the owner confirmed exactly this launch: the app just opened, or Main is stopped")
    #expect(!LaunchPending.holdsThreads(saved: saved, running: running, confirmedSaved: true))
    #expect(LaunchPending.argsForThreads(saved: saved, running: running, pending: true) == running, "a saved Bypass is not passed on before Main runs in it")
    #expect(LaunchPending.argsForThreads(saved: saved, running: running, pending: false) == saved)
    #expect(LaunchPending.argsForThreads(saved: saved, running: nil, pending: true) == [], "not known: no permission flag at all")
    #expect(PermissionModeSetting.read(LaunchPending.argsForThreads(saved: saved, running: nil, pending: true)) == .mode(.auto))
  }

  @Test func theWordsAreOneButton() {
    #expect(LaunchPending.button == "Restart to apply")
    #expect(!LaunchPending.line.isEmpty)
  }
}

@Suite("Your agent tab layout")
struct SessionTabLayoutTests {
  /// An imported or adopted agent has a `desktop.json`, so `configured` is true for it; nothing else hides a section. Your agent
  /// draws the three modes first, then the four rows, then the one caption, in one column; the launch command, the folder and the
  /// host picker moved to Advanced.
  @Test func yourAgentDrawsTheModesTheFourRowsAndTheCaptionInOrder() throws {
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop/SettingsAgentTab.swift")
    let t = try String(contentsOf: src, encoding: .utf8)
    let start = try #require(t.range(of: "var agentTab: some View"))
    let end = try #require(t.range(of: "// MARK: how much it asks"))
    let body = String(t[start.lowerBound..<end.lowerBound])
    var last = body.startIndex
    for name in ["modeSection", "startOnOpenTitle", "keepWorkingTitle", "restartIfStopsTitle", "problemsRow", "applyCaption"] {
      let r = try #require(body.range(of: name, range: last..<body.endIndex), "\(name) is on Your agent, in this order")
      last = r.upperBound
    }
    #expect(!body.contains("launchSection") && !body.contains("hostSection"), "start-up command and host picker are in Advanced")
  }

  @Test func anImportedCommandThatBypassesShowsTheBypassChoice() throws {
    let spec = try LaunchSpec.parse("cd ~/agent && claude --dangerously-skip-permissions --x", home: "/home/example")
    #expect(PermissionModeSetting.read(spec.args) == .mode(.bypass))
  }
}
