import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Main must start with its Talos bridge, and the Mac must notice when it does not (the 2026-11-09 outage: Main launched with a bare PATH and a
/// thread session's identity, so `bun` was not found, the bridge never ran, and nothing said so).
///   1. Main's env: the login shell's env plus `desktop.json` `env`, PATH included, never a thread session's identity; an unreadable login
///      env falls back to the app's own environment with `desktop.json` on top, and says so in the log.
///   2. The success signal is the bridge being live (`status.json` written by the live bridge after this start), not a channels notice. A
///      missing notice is never a stop; the `noNotice` stop is only for a warning still on screen (NoNoticeRunningTests).
///   3. Main running without a live bridge after `bridgeWait`: Needs you, with the reason from Claude Code's MCP log when it can be read.
///   4. Only the Talos popup for Main's warning: no terminal opens beside it.
private func envLines(_ path: String) -> [String: String] {
  var out: [String: String] = [:]
  for l in ((try? String(contentsOfFile: path, encoding: .utf8)) ?? "").split(separator: "\n") {
    guard let eq = l.firstIndex(of: "=") else { continue }
    out[String(l[..<eq])] = String(l[l.index(after: eq)...])
  }
  return out
}

private let desktopPath = "/opt/talos/bin:/usr/bin:/bin"

extension Rig {
  var envLog: String { stateDir + "/env.log" }
  /// What the live bridge writes (`BridgeStatus`), stamped by the test's wall clock.
  /// `pid` is a process of Main's group by default (this start's bridge is Main's child).
  func writeBridgeStatus(mode: String = "live", ageSeconds: Double = 0, pid: Int32? = nil) throws {
    let pid = pid ?? sup.status.childPid ?? getpid()
    let at = ISOTime.string(clock.wallMs() / 1000 - ageSeconds)
    let json = "{\"v\":1,\"pid\":\(pid),\"mode\":\"\(mode)\",\"relay\":{\"connected\":true},\"queue_depth\":0,\"updated_at\":\"\(at)\"}"
    try json.write(toFile: talosHome + "/status.json", atomically: true, encoding: .utf8)
  }
  /// Claude Code's MCP log for the talos-app server of this agent folder.
  func writeMcpLog(_ lines: [String]) throws {
    let slug = agentDir.map { $0.isASCIILetterOrDigit ? String($0) : "-" }.joined()
    let dir = home + "/Library/Caches/claude-cli-nodejs/\(slug)/mcp-logs-talos-app"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try (lines.joined(separator: "\n") + "\n").write(toFile: dir + "/2026-11-09T12-00-00-000Z.jsonl", atomically: true, encoding: .utf8)
  }
  /// The Enter has been answered (auto-accept), the warning is gone, and the answered settle is over.
  func answeredAndSettled() {
    #expect(wait(30) { sup.tickNow(); return autoConfirms == 1 })
    clock.advance(20)
    for _ in 0..<5 { sup.tickNow() }
  }
}

private extension Character { var isASCIILetterOrDigit: Bool { isASCII && (isLetter || isNumber) } }

@Suite("Main starts with its bridge, and the Mac notices when it does not", .serialized)
struct MainBridgeHealthTests {
  // MARK: 1. Main's environment

  @Test(arguments: bothHosts)
  func mainGetsTheLoginEnvPlusDesktopJsonEnvAndNoThreadIdentity(kind: HostKind) throws {
    let r = try Rig(
      kind, scenario: "env-log.sh", env: ["PATH": desktopPath],
      loginExtra: [
        "MY_LOGIN_VAR": "from-login", "TALOS_APP_WORKER_THREAD": "talos", "TALOS_SESSION_ROLE": "worker",
        "TALOS_APP_WORKER_NONCE": "0123abcd", "CLAUDE_CODE_WORKER_THING": "1",
        "TELEGRAM_STATE_DIR": "/t/workers/_nochannel", "IMESSAGE_STATE_DIR": "/t/workers/_nochannel",
        "ENABLE_CLAUDEAI_MCP_SERVERS": "false",
      ])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return !envLines(r.envLog).isEmpty }, "audit: \(r.audit)")
    let e = envLines(r.envLog)
    #expect(e["PATH"] == desktopPath, "desktop.json env wins: \(String(describing: e["PATH"]))")
    #expect(e["MY_LOGIN_VAR"] == "from-login", "the login env is the base")
    for k in [
      "TALOS_APP_WORKER_THREAD", "TALOS_SESSION_ROLE", "TALOS_APP_WORKER_NONCE", "CLAUDE_CODE_WORKER_THING", "TELEGRAM_STATE_DIR",
      "IMESSAGE_STATE_DIR", "ENABLE_CLAUDEAI_MCP_SERVERS",
    ] {
      #expect(e[k] == nil, "\(k) leaked into Main")
    }
  }

  @Test(arguments: bothHosts)
  func anUnreadableLoginEnvStillCarriesDesktopJsonsPathAndIsSaid(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "env-log.sh", env: ["PATH": desktopPath], loginReadable: false)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return !envLines(r.envLog).isEmpty }, "audit: \(r.audit)")
    #expect(envLines(r.envLog)["PATH"] == desktopPath, "never the bare launchd PATH when desktop.json has one")
    #expect(r.audit.contains(" login_env_unreadable"), "the fallback is in the log: \(r.audit)")
  }

  // MARK: 2. The success signal is the bridge, a missing notice is never a stop

  /// A pane Enter (the owner's own, nothing sent by the app) on a resumed session: the warning goes, Claude's input box is up and no notice comes. Running at once.
  @Test(arguments: bothHosts)
  func aHumanEnterOnAResumedSessionIsRunningWithoutANotice(kind: HostKind) throws {
    let keys = KeyLog()
    defer { keys.remove() }
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_DLG_KEYLOG": keys.path, "FAKE_RESUMED": "1"], launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    // the Enter comes once the supervisor has seen the warning (it asks the owner), as a person's would: one pressed the moment the
    // warning is drawn can beat the supervisor's next look at the screen, and then this start never showed it the warning
    #expect(r.wait(30) {
      r.sup.tickNow()
      return r.screenContains(DialogMatcher.Strings.devTitle) && r.sup.status.needsYou == .confirmColdStart
    }, "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    r.humanEnter()
    #expect(r.wait(30) { r.sup.tickNow(); return !r.screenContains(DialogMatcher.Strings.devTitle) })
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.wait(10) { r.audit.contains("human_confirm") }, "audit: \(r.audit)")
  }

  /// After the Enter the screen is blank: not the warning, so never a stop for a missing notice. The start deadline warns instead.
  @Test(arguments: bothHosts)
  func aMissingNoticeIsNeverAStop(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_BLANK": "1"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "audit: \(r.audit)")
    r.clock.advance(20)
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(stopReason(r.phase()) == nil, "\(r.phase()), audit: \(r.audit)")
    #expect(!r.allEvents.contains(.confirmFailed) && !r.audit.contains("auto_confirm_no_notice"), "audit: \(r.audit)")
  }

  /// A start that never showed the warning (the flag is in the argv but this run did not ask): running once Claude's input box is up and
  /// `noticeWait` has passed. A live bridge alone is not enough: it is up at MCP init, while the warning may still be on its way.
  @Test func aStartThatNeverShowedTheWarningIsRunningOnceReady() throws {
    let r = try Rig(.direct, scenario: "ready-no-dialog.sh", checksBridge: true)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return r.screenContains("input") || r.sup.status.childPid != nil })
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.phase() == .starting, "not before noticeWait: \(r.phase())")
    r.clock.advance(20)
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.audit.contains("ready_without_dialog"), "audit: \(r.audit)")
  }

  // MARK: 3. A running Main with no live bridge

  @Test(arguments: bothHosts)
  func theBridgeNotLiveInTheWindowIsNeedsYouWithTheReasonFromTheMcpLog(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    #expect(isRunning(r.phase()), "\(r.phase()), audit: \(r.audit)")
    #expect(r.sup.status.needsYou == nil, "inside the window nothing is said yet: \(String(describing: r.sup.status.needsYou))")
    let sid = try #require(r.sup.status.sessionId)
    try r.writeMcpLog([
      "{\"debug\":\"Starting connection\",\"sessionId\":\"\(sid)\"}",
      "{\"error\":\"Executable not found in $PATH: \\\"bun\\\"\",\"sessionId\":\"\(sid)\"}",
      "{\"debug\":\"another session\",\"sessionId\":\"00000000-0000-4000-8000-000000000000\"}",
    ])
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(
      r.sup.status.needsYou == .bridgeNotLive("Executable not found in $PATH: \"bun\""),
      "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    #expect(isRunning(r.phase()), "Main is not stopped for it")
    #expect(!r.allEvents.contains(.openTerminal), "the pane tells nothing the line does not")
    #expect(r.audit.contains("needs_you why=bridge"), "audit: \(r.audit)")
  }

  @Test func noReadableLogStillRaisesItWithoutAReason() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive(nil), "\(String(describing: r.sup.status.needsYou))")
  }

  @Test(arguments: bothHosts)
  func aLiveBridgeMeansNoNeedsYouAndRunning(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    try r.writeBridgeStatus()
    r.clock.advance(70)
    try r.writeBridgeStatus()
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(isRunning(r.phase()) && r.sup.status.needsYou == nil, "\(r.phase()) \(String(describing: r.sup.status.needsYou))")
    #expect(!r.audit.contains("why=bridge"), "audit: \(r.audit)")
  }

  /// The bridge going live late clears the line.
  @Test func theLineClearsWhenTheBridgeGoesLive() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive(nil))
    try r.writeBridgeStatus()
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == nil, "\(String(describing: r.sup.status.needsYou))")
  }

  /// A status file written before this start (the previous run's, still fresh by its stamp) is not this start's bridge.
  @Test func aStatusFromBeforeThisStartIsNotTheBridge() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    try r.writeBridgeStatus(ageSeconds: 30)
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    try r.writeBridgeStatus(ageSeconds: 100)  // stamped before the start, and stale
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive(nil), "\(String(describing: r.sup.status.needsYou))")
  }

  // MARK: review fixes

  /// The bridge writes a live status at MCP init, while the warning may still be on its way: the warning is still answered.
  @Test func aLiveBridgeBeforeTheWarningDoesNotSkipTheAutoConfirm() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-wait.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.status.childPid != nil })
    try r.writeBridgeStatus()
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(r.phase() == .starting, "the bridge alone does not make a start running while the warning can still come: \(r.phase())")
    FileManager.default.createFile(atPath: r.stateDir + "/show", contents: Data())
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "the warning is still auto-confirmed: \(r.audit)")
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
  }

  /// A resumed transcript that quotes dialog wording is conversation, not a dialog: the input box makes it ready, and a quoted warning
  /// cannot stop a healthy Main.
  @Test(arguments: bothHosts)
  func aTranscriptQuotingDialogWordsIsStillReadyAndNeverStopped(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1", "FAKE_QUOTES": "1"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.autoConfirms == 1 }, "audit: \(r.audit)")
    #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    r.clock.advance(20)
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(isRunning(r.phase()) && !r.audit.contains("auto_confirm_no_notice"), "\(r.phase()), audit: \(r.audit)")
  }

  /// A bridge from outside Main's process group (an old one still running) is not this start's.
  @Test func aBridgeOutsideMainsGroupIsNotLive() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    try r.writeBridgeStatus(pid: getpid())
    r.clock.advance(70)
    try r.writeBridgeStatus(pid: getpid())
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive(nil), "\(String(describing: r.sup.status.needsYou))")
  }

  /// The newest error line is the reason, not the debug lines after it, and a resume that changed the session id does not hide it.
  @Test func theReasonIsTheNewestErrorLineWhateverTheSession() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-keys.sh", env: ["FAKE_RESUMED": "1"], checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    try r.writeMcpLog([
      "{\"error\":\"old failure\",\"sessionId\":\"00000000-0000-4000-8000-000000000001\"}",
      "{\"error\":\"Executable not found in $PATH: \\\"bun\\\"\",\"sessionId\":\"00000000-0000-4000-8000-000000000002\"}",
      "{\"debug\":\"Connection failed\",\"sessionId\":\"00000000-0000-4000-8000-000000000002\"}",
      "{\"debug\":\"Closing\",\"sessionId\":\"00000000-0000-4000-8000-000000000002\"}",
    ])
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive("Executable not found in $PATH: \"bun\""), "\(String(describing: r.sup.status.needsYou))")
  }

  /// A dialog that takes the slot does not end the bridge alarm: when it is answered, the alarm is back.
  @Test func theBridgeAlarmComesBackAfterADialogThatTookTheSlot() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-login-later.sh", checksBridge: true)
    defer { r.teardown() }
    r.start()
    r.answeredAndSettled()
    r.clock.advance(70)
    for _ in 0..<3 { r.sup.tickNow() }
    #expect(r.sup.status.needsYou == .bridgeNotLive(nil))
    r.humanEnter()
    #expect(r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .dialog("login expired") }, "\(String(describing: r.sup.status.needsYou))")
    r.humanEnter()
    #expect(
      r.wait(20) { r.sup.tickNow(); return r.sup.status.needsYou == .bridgeNotLive(nil) },
      "\(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
  }

  // MARK: 4. Only the popup

  @Test(arguments: bothHosts)
  func mainsWarningOpensNoTerminalBesideThePopup(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh", configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.status.needsYou == .confirmColdStart })
    #expect(r.wait(10) { r.sup.tickNow(); return r.sup.mainPopupItem() != nil }, "the popup is offered")
    usleep(500_000)
    #expect(!r.allEvents.contains(.openTerminal), "no terminal beside the popup")
  }
}
