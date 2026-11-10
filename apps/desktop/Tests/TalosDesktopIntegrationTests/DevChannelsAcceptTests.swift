import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// Main accepts the development-channels warning at every start (owner decision 2026-11-07, retiring TG 24520 "cold starts are always
/// human"): the exact real screen is answered on a cold start, on a supervisor restart and after a CLI version change, and anything else
/// stays at Needs you. Real pty, real private tmux server, the fake-claude dev-dialog fixtures.
private func count(_ needle: String, in s: String) -> Int { s.components(separatedBy: needle).count - 1 }

private func kindsOf(_ audit: String) -> [String] {
  audit.split(separator: "\n").filter { $0.contains(" auto_confirm ") }.map(String.init)
}

/// An attached tmux client with a tty (`script`), the way a Terminals window is one. Its activity time is the attach.
private func attachClient(_ r: Rig) throws -> Process {
  let client = Process()
  client.executableURL = URL(fileURLWithPath: "/usr/bin/script")
  client.arguments = ["-q", "/dev/null", Rig.tmuxPath!, "-L", r.socket, "-f", Rig.tmuxConf, "attach-session", "-t", "=agent"]
  client.environment = ["TERM": "xterm-256color", "PATH": "/usr/bin:/bin", "HOME": r.home]
  client.standardInput = Pipe()
  client.standardOutput = FileHandle.nullDevice
  client.standardError = FileHandle.nullDevice
  try client.run()
  let listed = {
    !ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "list-clients", "-t", "=agent", "-F", "#{client_activity}"], env: ["PATH": "/usr/bin:/bin"]).out
      .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }
  #expect(r.wait(10, listed), "the client attached")
  return client
}

extension Rig {
  /// The dialog appears now (`dev-dialog-wait.sh`).
  func showDialog() { FileManager.default.createFile(atPath: stateDir + "/show", contents: Data()) }

  /// A cold start whose dialog is refused: the question is raised, nothing is pressed, and the dialog is still there a while later.
  func expectHeldAtNeedsYou(
    _ why: String, question: Supervisor.NeedsYou = .confirmColdStart, answeredBefore: Int = 0, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(wait(cap) { screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown", sourceLocation: sourceLocation)
    #expect(
      wait(20) { sup.tickNow(); return sup.status.needsYou == question },
      "needsYou \(String(describing: sup.status.needsYou)), audit: \(audit)", sourceLocation: sourceLocation)
    for _ in 0..<8 {
      usleep(200_000)
      sup.tickNow()
    }
    #expect(screenContains(DialogMatcher.Strings.devTitle), "no keypress: the dialog is still up", sourceLocation: sourceLocation)
    #expect(phase() == .starting, "\(phase())", sourceLocation: sourceLocation)
    #expect(kindsOf(audit).count == answeredBefore, "audit: \(audit)", sourceLocation: sourceLocation)
    #expect(audit.contains("auto_confirm_refused kind=cold reason=\(why)"), "audit: \(audit)", sourceLocation: sourceLocation)
  }
}

@Suite("Main accepts the development-channels warning", .serialized)
struct DevChannelsAcceptTests {
  // MARK: accepted

  /// The exact real screen on a COLD start: no human Enter, one Enter in all, one log line with the time, the start kind, the channels and
  /// the CLI version, and no menu note (no `autoConfirmed` event, which is what makes "restarted after a crash" show).
  @Test(arguments: bothHosts)
  func theExactScreenOnAColdStartIsAccepted(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "running with no human Enter: \(r.phase()), audit: \(r.audit)")
    let lines = kindsOf(r.audit)
    #expect(lines.count == 1, "one auto-accept line: \(lines)")
    let line = lines.first ?? ""
    #expect(line.contains(" kind=cold"), "\(line)")
    #expect(line.contains(" channels=server:talos-app"), "\(line)")
    #expect(line.contains(" cli=2.1.312"), "\(line)")
    #expect(line.range(of: #"^\d{4}-\d\d-\d\dT[\d:]+Z "#, options: .regularExpression) != nil, "the line starts with the time: \(line)")
    #expect(r.sup.status.needsYou == nil)
    #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } }, "never told to press Enter")
    #expect(!r.allEvents.contains { if case .autoConfirmed = $0 { return true } else { return false } }, "no menu note for a cold start")
    #expect(!r.allEvents.contains(.openTerminal))
    #expect(r.phonePosts.isEmpty, "\(r.phonePosts)")
    #expect(r.starts.count == 1)
    // the first-start row of the checklist is satisfied by a start that got through the warning
    #expect(r.wait(5) { r.config.session.confirmedAt != nil })
    #expect(!r.audit.contains("human_confirm"))
    // an auto-accept never stores the launch fingerprint (only the owner's own Enter does): it stays what the rig stored before the start
    #expect(r.config.confirmedLaunch == r.seededLaunch, "\(String(describing: r.config.confirmedLaunch))")
  }

  /// A supervisor restart is accepted too (and keeps its quiet menu note).
  @Test(arguments: bothHosts)
  func aSupervisorRestartIsAccepted(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "1"])
    defer { r.teardown() }
    r.start()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count >= 2 && isRunning(r.phase()) }, "restarted and running: \(r.phase()), audit: \(r.audit)")
    let lines = kindsOf(r.audit)
    #expect(lines.count == 2, "\(lines)")
    #expect(lines.first?.contains(" kind=cold") == true && lines.last?.contains(" kind=supervisorRestart") == true, "\(lines)")
    #expect(r.allEvents.filter { if case .autoConfirmed = $0 { return true } else { return false } }.count == 1, "the restart's note only")
    #expect(!r.allEvents.contains { if case .needsYou = $0 { return true } else { return false } })
  }

  /// After a CLI version change: a cold start of a conversation a human once confirmed under another version.
  @Test(arguments: bothHosts)
  func aColdStartAfterACliVersionChangeIsAccepted(kind: HostKind) throws {
    let s = DesktopConfig.Session(id: Rig.sessionId, confirmedAt: "2026-10-30T00:00:00Z", confirmedCliVersion: "2.1.312", approvedDevChannels: ["server:talos-app"])
    let r = try Rig(kind, scenario: "dev-dialog.sh", env: ["FAKE_CLI_VERSION": "2.1.313"], session: s)
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    #expect(kindsOf(r.audit).first?.contains(" cli=2.1.313") == true, "\(kindsOf(r.audit))")
    #expect(r.starts.first?.contains("--resume \(Rig.sessionId)") == true)
  }

  /// ... and a restart of a running one whose CLI changed in between (the native installer moved `claude`).
  @Test(arguments: bothHosts)
  func aRestartAfterACliVersionChangeIsAccepted(kind: HostKind) throws {
    let versionFile = NSTemporaryDirectory() + "talos-devch-ver-\(UUID().uuidString.prefix(6))"
    defer { try? FileManager.default.removeItem(atPath: versionFile) }
    let r = try Rig(kind, scenario: "crash-after.sh", env: ["FAKE_CLI_VERSION_FILE": versionFile, "FAKE_CRASH_SECONDS": "4"])
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    try "2.1.313".write(toFile: versionFile, atomically: true, encoding: .utf8)
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count >= 2 && isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    let lines = kindsOf(r.audit)
    #expect(lines.count == 2 && lines.last?.contains(" cli=2.1.313") == true && lines.last?.contains(" kind=supervisorRestart") == true, "\(lines)")
  }

  /// Inside the window the dialog is accepted whenever it appears; the window is counted on the awake clock from the spawn.
  @Test(arguments: [(59.0, true), (61.0, false)])
  func theWindowIsSixtySecondsFromTheSpawn(awake: Double, accepted: Bool) throws {
    let r = try Rig(.direct, scenario: "dev-dialog-wait.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    r.clock.advance(awake)  // awake time spent before the dialog showed
    r.showDialog()
    if accepted {
      #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
      #expect(kindsOf(r.audit).count == 1)
    } else {
      r.expectHeldAtNeedsYou("outsideWindow")
    }
  }

  /// The Mac asleep does not use the window: only the awake clock counts.
  @Test func timeAsleepDoesNotCountTowardsTheWindow() throws {
    let r = try Rig(.direct, scenario: "dev-dialog-wait.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.status.childPid != nil })
    r.clock.sleep(3600)
    r.showDialog()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
  }

  // MARK: refused (the cold start stays at Needs you, as before)

  enum Refuse: String, CaseIterable, Sendable {
    case extraChannel, differentChannel, wrongHighlight, twoTitles, evilInArgvAndOnScreen, extraInArgvAndOnScreen
  }

  @Test(arguments: bothHosts, Refuse.allCases)
  func aDialogThatIsNotExactlyTheLaunchesIsRefused(kind: HostKind, why: Refuse) throws {
    var env: [String: String] = [:]
    var session: DesktopConfig.Session?
    var configure: @Sendable (inout DesktopConfig) -> Void = { _ in }
    let scenario: String
    let reason: String
    switch why {
    case .extraChannel:
      scenario = "dev-dialog.sh"
      env = ["FAKE_CHANNELS": "server:talos-app, server:talos-app-evil"]
      reason = "channelsMismatch"
    case .differentChannel:
      // desktop.json lists the channel the screen shows: the argv of THIS launch is what counts, and an agent can edit that file
      scenario = "dev-dialog.sh"
      env = ["FAKE_CHANNELS": "server:other"]
      session = DesktopConfig.Session(id: Rig.sessionId, confirmedAt: "2026-10-30T00:00:00Z", confirmedCliVersion: "2.1.312", approvedDevChannels: ["server:other"])
      reason = "channelsMismatch"
    case .evilInArgvAndOnScreen:
      // an edited launch command passes another channel and the screen shows exactly that: only the Talos channel is ever answered
      scenario = "dev-dialog.sh"
      env = ["FAKE_CHANNELS": "server:evil"]
      configure = { $0.args = ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:evil"] }
      reason = "channelsMismatch"
    case .extraInArgvAndOnScreen:
      scenario = "dev-dialog.sh"
      env = ["FAKE_CHANNELS": "server:talos-app, server:evil"]
      configure = { $0.args = ["--dangerously-skip-permissions", "--dangerously-load-development-channels", "server:talos-app", "server:evil"] }
      reason = "channelsMismatch"
    case .wrongHighlight:
      scenario = "dev-dialog-wrong-highlight.sh"
      reason = "wrongHighlight"
    case .twoTitles:
      scenario = "dev-dialog-two-titles.sh"
      reason = "ambiguousDialog"
    }
    let r = try Rig(kind, scenario: scenario, env: env, session: session, configure: configure)
    defer { r.teardown() }
    r.start()
    r.expectHeldAtNeedsYou(reason)
    // the human at the Mac can still answer it
    r.humanEnter()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
  }

  /// A log line that quotes the warning is not a dialog: nothing is asked, nothing pressed.
  @Test(arguments: bothHosts)
  func aLogLineQuotingTheWarningIsNeverAnswered(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-quoted.sh")
    defer { r.teardown() }
    r.start()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.screenContains("An earlier run printed this") })
    for _ in 0..<10 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.screenContains(DialogMatcher.Strings.devTitle), "no keypress")
    #expect(r.phase() == .starting)
    #expect(kindsOf(r.audit).isEmpty, "audit: \(r.audit)")
    #expect(!r.audit.contains("auto_confirm_refused"), "it was never a dialog: \(r.audit)")
  }

  /// A second appearance in the same start: one Enter in all.
  @Test(arguments: bothHosts)
  func aSecondAppearanceInTheSameStartIsNeverAnswered(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog-twice.sh")
    defer { r.teardown() }
    r.start()
    #expect(
      r.wait(30) { r.sup.tickNow(); return r.sup.status.needsYou == .restartNotConfirmed(.alreadyConfirmedThisStart) },
      "needsYou \(String(describing: r.sup.status.needsYou)), audit: \(r.audit)")
    for _ in 0..<8 {
      usleep(200_000)
      r.sup.tickNow()
    }
    #expect(r.screenContains(DialogMatcher.Strings.devTitle), "the second appearance is still up")
    #expect(kindsOf(r.audit).count == 1, "\(kindsOf(r.audit))")
    #expect(r.phase() == .starting)
  }

  /// An attached client typed lately: the owner may be at the keys. A quiet one does not hold it.
  @Test(.enabled(if: Rig.hasTmux), arguments: [(600.0, false), (0.001, true)])
  func anAttachedClientThatTypedLatelyHoldsTheEnter(quiet: Double, accepted: Bool) throws {
    var t = Supervisor.Timings()
    t.tick = 0.2
    t.agentsPoll = 0.5
    t.dialogStall = 600
    t.devDialogClientQuiet = quiet
    let r = try Rig(.tmux, scenario: "dev-dialog-wait.sh", timings: t)
    defer { r.teardown() }
    r.start()
    #expect(r.wait(30) { r.sup.status.childPid != nil })
    let client = try attachClient(r)
    defer {
      if client.isRunning { client.terminate() }
      client.waitUntilExit()
    }
    r.showDialog()
    if accepted {
      #expect(r.wait(30) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase()), audit: \(r.audit)")
    } else {
      r.expectHeldAtNeedsYou("clientsMayBeTyping")
    }
  }

  /// tmux, except that `list-clients` fails: the clients cannot be read, which counts as typing.
  @Test(.enabled(if: Rig.hasTmux))
  func clientsThatCannotBeReadCountAsTyping() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let shim = r.root + "/tmux-clients-shim"
    try """
    #!/bin/bash
    for a in "$@"; do
      if [ "$a" = list-clients ]; then echo 'list-clients: broken' >&2; exit 1; fi
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    r.start()
    r.expectHeldAtNeedsYou("clientsMayBeTyping")
  }

  /// tmux, except that once the supervisor has looked at the clients (its decision), the pane reads as another screen: the Enter is not sent.
  @Test(.enabled(if: Rig.hasTmux))
  func aScreenThatChangedBetweenTheDecisionAndTheEnterGetsNoEnter() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    let shim = r.root + "/tmux-changed-shim"
    let flag = r.root + "/changed"
    let sends = r.root + "/sends"
    try """
    #!/bin/bash
    for a in "$@"; do
      case "$a" in
        list-clients) : > '\(flag)' ;;
        send-keys) echo x >> '\(sends)' ;;
        capture-pane) if [ -e '\(flag)' ]; then printf ' > working\\n'; exit 0; fi ;;
      esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: shim, atomically: true, encoding: .utf8)
    chmod(shim, 0o755)
    r.tmuxBin = shim
    r.makeSupervisor()
    r.start()
    #expect(r.wait(30) { r.sup.tickNow(); return r.audit.contains("auto_confirm_refused kind=cold reason=screenChanged") }, "audit: \(r.audit)")
    for _ in 0..<5 { r.sup.tickNow() }
    #expect(!FileManager.default.fileExists(atPath: sends), "no key was sent")
    #expect(kindsOf(r.audit).isEmpty, "audit: \(r.audit)")
    // the dialog is still there on the real pane
    let real = ProcessRunner.run([Rig.tmuxPath!, "-L", r.socket, "capture-pane", "-p", "-t", "=agent:"], env: r.loginEnv).out
    #expect(real.contains(DialogMatcher.Strings.devTitle), "\(real)")
  }

  // MARK: the launch checkpoint

  /// A first-ever start has no stored launch fingerprint, so it counts as changed: the owner confirms it. A plain Enter in the pane (anyone with
  /// tmux can press one) confirms THIS start only: nothing is stored or sealed and no key is made, so the next start is refused again. Only a
  /// verified tap on the card seals (DevChannelsCardTests).
  @Test(arguments: bothHosts)
  func aPaneEnterConfirmsOnlyThatStartAndSealsNothing(kind: HostKind) throws {
    let r = try Rig(kind, scenario: "dev-dialog.sh", launchConfirmed: false)
    defer { r.teardown() }
    r.start()
    r.expectHeldAtNeedsYou("launchChanged")
    #expect(r.config.confirmedLaunch == nil)
    r.humanEnter()
    let cap: Double = kind == .tmux ? 30 : 10
    #expect(r.wait(cap) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
    #expect(r.wait(cap) { r.audit.contains("human_confirm") }, "the start itself is confirmed: \(r.audit)")
    #expect(r.config.confirmedLaunch == nil && r.config.confirmedLaunchMac == nil && r.config.confirmedLaunchParts == nil)
    #expect(!r.trust.hasKey, "a pane Enter makes no key")
    r.sup.restartCold()
    #expect(r.wait(60) { r.sup.tickNow(); return r.starts.count == 2 && r.offer != nil }, "\(r.phase()), audit: \(r.audit)")
    #expect(r.autoConfirms == 0, "the second start is refused again: \(r.audit)")
    #expect(r.audit.components(separatedBy: "reason=launchChanged").count - 1 >= 2, "audit: \(r.audit)")
  }

  enum Change: String, CaseIterable, Sendable { case program, envVar, nonChannelArg }

  /// A changed program, env var or flag (other than a channel) is a changed launch: the cold start that follows waits for the owner.
  @Test(arguments: Change.allCases)
  func aChangedLaunchWaitsForTheOwner(change: Change) throws {
    let r = try Rig(.direct, scenario: "dev-dialog.sh")
    defer { r.teardown() }
    r.start()
    #expect(r.wait(10) { r.sup.tickNow(); return isRunning(r.phase()) }, "\(r.phase())")
    let other = r.home + "/other-claude"
    try "#!/bin/bash\nexec \(Rig.fixtures)/claude \"$@\"\n".write(toFile: other, atomically: true, encoding: .utf8)
    chmod(other, 0o755)
    r.sup.mutateConfig { c in
      switch change {
      case .program: c.claudePath = other
      case .envVar: c.env["SOME_NEW_VARIABLE"] = "1"
      case .nonChannelArg: c.args.append("--some-new-flag")
      }
    }
    r.sup.restartCold()
    #expect(r.wait(30) { r.starts.count == 2 })
    r.expectHeldAtNeedsYou("launchChanged", answeredBefore: 1)
  }
}
