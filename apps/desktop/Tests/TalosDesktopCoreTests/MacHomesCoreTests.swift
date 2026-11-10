import Foundation
import Testing

@testable import TalosDesktopCore

// Mac settings get one home (SETTINGS-MAP 3.1, 3.2). Each suite below backs one claim of the PR.

private let home = "/home/alex"

private func configured() -> DesktopConfig {
  var c = DesktopConfig.defaults
  c.agentDir = "/home/alex/agent"
  c.claudePath = "auto"
  c.args = ["--dangerously-skip-permissions", "--channels", "plugin:telegram"]
  c.env = ["TALOS_APP_HOME": "/home/alex/.config/talos/app", "SECRET_TOKEN": "s3cr3t-value-123"]
  c.session = DesktopConfig.Session(
    id: "11111111-2222-4333-8444-555555555555", previousIds: ["aaaaaaaa-2222-4333-8444-555555555555"],
    confirmedAt: "2026-11-01T10:00:00Z", confirmedCliVersion: "2.1.0", approvedDevChannels: ["server:talos-app"])
  return c
}

// MARK: launch command (U4)

@Suite("Launch command edit")
struct LaunchEditTests {
  @Test func theBoxShowsProgramAndArgumentsOnly() {
    let line = LaunchEdit.line(for: configured())
    #expect(line == "claude --dangerously-skip-permissions --channels plugin:telegram")
    #expect(!line.contains("cd ") && !line.contains("--resume") && !line.contains("TALOS_APP_HOME"))
  }

  @Test func envValuesAreNeverRenderedOnlyNames() {
    let c = configured()
    let shown = LaunchEdit.line(for: c) + "\n" + LaunchEdit.envLine(c)
    #expect(!shown.contains("s3cr3t-value-123"))
    #expect(!shown.contains("/home/alex/.config/talos/app"))
    #expect(shown.contains("SECRET_TOKEN") && shown.contains("TALOS_APP_HOME"))
    #expect(LaunchEdit.envNames(c) == ["SECRET_TOKEN", "TALOS_APP_HOME"], "sorted, names only")
    #expect(LaunchEdit.envLine(.defaults).contains("No environment variables"))
  }

  @Test func theSameLineIsUnchanged() {
    let c = configured()
    #expect(LaunchEdit.evaluate(LaunchEdit.line(for: c), against: c, home: home) == .unchanged)
  }

  @Test func aChangedLineIsAccepted() {
    let c = configured()
    let o = LaunchEdit.evaluate("claude --model opus --channels plugin:telegram", against: c, home: home)
    #expect(o == .updated(claudePath: "auto", args: ["--model", "opus", "--channels", "plugin:telegram"]))
    let o2 = LaunchEdit.evaluate("/opt/bin/claude -x", against: c, home: home)
    #expect(o2 == .updated(claudePath: "/opt/bin/claude", args: ["-x"]))
  }

  @Test func aLineWithEnvAssignmentsIsRefusedAndPointsAtImport() {
    let c = configured()
    let o = LaunchEdit.evaluate("FOO=bar claude --x", against: c, home: home)
    #expect(o == .refused(LaunchEdit.envPointer))
    #expect(LaunchEdit.envPointer.contains("Import"))
  }

  @Test func aCdOrAResumeIdIsRefused() {
    let c = configured()
    #expect(LaunchEdit.evaluate("cd /home/alex/x && claude", against: c, home: home) == .refused(LaunchEdit.folderPointer))
    #expect(
      LaunchEdit.evaluate("claude --resume 99999999-2222-4333-8444-555555555555", against: c, home: home)
        == .refused(LaunchEdit.resumePointer))
  }

  @Test(arguments: [
    ("", "The command is empty."),
    ("claude; rm -rf /", "Talos runs claude without a shell, so `;` isn't supported."),
    ("claude $HOME", "Talos runs claude without a shell, so `$` (variables and $(…)) isn't supported."),
    ("bash -c x", "The command must run claude, not bash."),
    ("claude 'unclosed", "A quote is not closed."),
    ("claude -p hi", "-p runs claude headless; the live session must be interactive."),
    ("claude --resume nope", "--resume needs a session id (a UUID), not nope."),
  ])
  func aParseErrorKeepsTheOldValueAndGivesTheReason(line: String, reason: String) {
    let c = configured()
    #expect(LaunchEdit.evaluate(line, against: c, home: home) == .refused(reason))
  }

  @Test func theBoxUsesTheSameParserAsImport() throws {
    let c = configured()
    for line in ["claude --a --b c", "claude  --x='two words' y", "/usr/local/bin/claude --flag-from-the-future 1", "claude ~/notes"] {
      let spec = try LaunchSpec.parse(line, home: home)
      let o = LaunchEdit.evaluate(line, against: c, home: home)
      guard case .updated(let path, let args) = o else { Issue.record("\(line) should be accepted"); continue }
      #expect(args == spec.args)
      #expect(path == (spec.program == "claude" ? "auto" : spec.program))
    }
  }

  @Test func realTerminalCommandFromCopyIsRefusedBecauseItCarriesEnvironment() {
    // The "Copy Terminal command" output is the real rollback command: folder, env, program, args, resume id.
    let c = configured()
    let copied = LaunchSpec(
      agentDir: c.agentDir, env: c.env, program: "claude", args: c.args, resumeId: c.session.id
    ).render()
    guard case .refused(let all) = LaunchEdit.evaluate(copied, against: c, home: home) else { Issue.record("refused"); return }
    #expect(all.contains(LaunchEdit.folderPointer) && all.contains(LaunchEdit.envPointer) && all.contains(LaunchEdit.resumePointer))
    let onlyEnv = copied.replacingOccurrences(of: "cd /home/alex/agent && ", with: "")
      .replacingOccurrences(of: " --resume 11111111-2222-4333-8444-555555555555", with: "")
    #expect(LaunchEdit.evaluate(onlyEnv, against: c, home: home) == .refused(LaunchEdit.envPointer))
  }

  @Test func anAcceptedEditTouchesOnlyTheProgramAndArgs() {
    let c = configured()
    let n = LaunchEdit.applied(c, claudePath: "/x/claude", args: ["--y"])
    #expect(n.env == c.env, "env values are copied through untouched")
    #expect(n.session == c.session, "conversation ids are unchanged")
    #expect(n.agentDir == c.agentDir && n.hotkeys == c.hotkeys && n.relayUrl == c.relayUrl)
    #expect(n.claudePath == "/x/claude" && n.args == ["--y"])
  }

  @Test func aChangedCommandMakesTheNextStartCold() {
    let c = configured()
    let n = LaunchEdit.applied(c, claudePath: "auto", args: ["--other"])
    #expect(c.launchFingerprint(resolvedClaude: "/x/claude") != n.launchFingerprint(resolvedClaude: "/x/claude"))
    #expect(LaunchEdit.coldNote.contains("cold start") && LaunchEdit.coldNote.contains("Nothing restarts on its own"))
  }
}

// MARK: host and the file's tolerance

@Suite("Host choice and a tolerant file")
struct HostChoiceTests {
  @Test func threeChoicesInPlainWords() {
    #expect(HostChoice.all == [.auto, .tmux, .direct])
    let labels = HostChoice.all.map(HostChoice.label)
    #expect(Set(labels).count == 3)
    #expect(!labels.joined().contains("pty"), "engineer language (M31)")
    #expect(HostChoice.appliesNote.contains("next time Talos opens"))
  }

  @Test func disabledWhileASessionIsUp() {
    #expect(!HostChoice.canChange(sessionUp: true))
    #expect(HostChoice.canChange(sessionUp: false))
    #expect(HostChoice.lockedNote.contains("thread sessions") && HostChoice.lockedNote.contains("nothing watching"))
  }

  @Test func saysSoWhenTmuxWasChosenButIsMissing() {
    #expect(HostChoice.caveat(choice: .tmux, tmuxUsable: false) != nil)
    #expect(HostChoice.caveat(choice: .tmux, tmuxUsable: true) == nil)
    #expect(HostChoice.caveat(choice: .auto, tmuxUsable: false) == nil)
    #expect(HostChoice.runningLine(tmux: false).contains("own terminal"))
  }

  @Test func anUnknownHostValueDegradesOneItemNotTheWholeFile() throws {
    var c = configured()
    c.notifyThread = "daily"
    var obj = try #require(try JSONSerialization.jsonObject(with: c.encoded()) as? [String: Any])
    obj["host"] = "zellij"  // a newer build wrote a host this one has never heard of
    let data = try JSONSerialization.data(withJSONObject: obj)
    let back = try DesktopConfig.decode(data)
    #expect(back.host == .auto)
    #expect(back.session == c.session, "the conversation survives")
    #expect(back.env == c.env && back.args == c.args && back.notifyThread == "daily")
    #expect(HostChoice.parse("zellij") == nil && HostChoice.parse("tmux") == .tmux)
  }

  @Test func aWrongTypedNotifyThreadDegradesOneItemToo() throws {
    let c = configured()
    var obj = try #require(try JSONSerialization.jsonObject(with: c.encoded()) as? [String: Any])
    obj["notify_thread"] = 42
    let back = try DesktopConfig.decode(try JSONSerialization.data(withJSONObject: obj))
    #expect(back.notifyThread == nil)
    #expect(back.session == c.session)
  }
}

// MARK: start_at_login

/// What the build before this one decoded: every key optional, `start_at_login` among them.
private struct PreviousBuildConfig: Decodable {
  var v: Int
  var host: String
  var agentDir: String
  var startAtLogin: Bool
  var relayUrl: String
  var previousIds: [String]
  enum K: String, CodingKey {
    case v, host, session
    case agentDir = "agent_dir"
    case startAtLogin = "start_at_login"
    case relayUrl = "relay_url"
  }
  enum S: String, CodingKey { case previousIds = "previous_ids" }
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: K.self)
    v = try c.decodeIfPresent(Int.self, forKey: .v) ?? 1
    host = try c.decodeIfPresent(String.self, forKey: .host) ?? "auto"
    agentDir = try c.decodeIfPresent(String.self, forKey: .agentDir) ?? "~/talos-agent"
    startAtLogin = try c.decodeIfPresent(Bool.self, forKey: .startAtLogin) ?? false
    relayUrl = try c.decodeIfPresent(String.self, forKey: .relayUrl) ?? "https://relay.example.com"
    let s = try c.nestedContainer(keyedBy: S.self, forKey: .session)
    previousIds = try s.decodeIfPresent([String].self, forKey: .previousIds) ?? []
  }
}

@Suite("start_at_login is gone, both ways")
struct StartAtLoginTests {
  @Test func aBuildWithoutTheKeyReadsAnOldFileThatHasIt() throws {
    var obj = try #require(try JSONSerialization.jsonObject(with: configured().encoded()) as? [String: Any])
    obj["start_at_login"] = true
    let back = try DesktopConfig.decode(try JSONSerialization.data(withJSONObject: obj))
    #expect(back == configured(), "the old key is ignored, nothing else changes")
  }

  @Test func theNewFileHasNoSuchKey() throws {
    let text = String(decoding: try configured().encoded(), as: UTF8.self)
    #expect(!text.contains("start_at_login"))
  }

  @Test func anOlderBuildReadsAFileWrittenWithoutIt() throws {
    var c = configured()
    c.session.previousIds = ["aaaaaaaa-2222-4333-8444-555555555555", "bbbbbbbb-2222-4333-8444-555555555555"]
    let old = try JSONDecoder().decode(PreviousBuildConfig.self, from: c.encoded())
    #expect(old.agentDir == c.agentDir && old.relayUrl == c.relayUrl && old.host == "auto")
    #expect(old.startAtLogin == false, "the old build falls back to its default, as it always did for a hand-written file")
    #expect(old.previousIds == c.session.previousIds, "session.previous_ids is still written and read")
  }

  @Test func resavingAnOldFileKeepsEverythingElse() throws {
    var obj = try #require(try JSONSerialization.jsonObject(with: configured().encoded()) as? [String: Any])
    obj["start_at_login"] = true
    let c = try DesktopConfig.decode(try JSONSerialization.data(withJSONObject: obj))
    let again = try DesktopConfig.decode(c.encoded())
    #expect(again == c)
    #expect(again.session.previousIds == ["aaaaaaaa-2222-4333-8444-555555555555"])
  }
}

// MARK: threads (U5)

private func fixture(_ name: String) -> Data? {
  let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  return FileManager.default.contents(atPath: here.deletingLastPathComponent().appendingPathComponent("Fixtures/config/\(name)").path)
}

@Suite("Thread picker")
struct ThreadChoicesTests {
  @Test func readsTheRealConfigShape() throws {
    // Fixtures/config/config.json is the relay's DEFAULT_AGENT_CONFIG plus three threads, written by bun from the real source,
    // with a quiet window and Option C turned on.
    let l = ThreadChoices.read(try #require(fixture("config.json")))
    #expect(l.readable)
    #expect(l.defaultThread == "general")
    #expect(l.threads.map(\.id) == ["general", "daily", "trip"], "no inbox (system), no archived thread")
    #expect(l.threads.first { $0.id == "daily" }?.name == "Daily")
  }

  @Test func theConfigFixtureHasNoMirrorAndTheOldShapeStillReadsTheSame() throws {
    // Telegram left the app (5cf625a9): config.json no longer stores `mirror`. A file an older app wrote still has it, at the
    // top and on every thread, and every Swift reader of that file must take it as if it were not there.
    func text(_ d: Data) -> String { String(decoding: d, as: UTF8.self) }
    let now = try #require(fixture("config.json"))
    let old = try #require(fixture("config-with-mirror.json"))
    #expect(!text(now).contains("mirror"), "the current shape has no mirror")
    #expect(text(old).contains("\"mirror\""), "the tolerance fixture keeps the old shape")
    #expect(ThreadChoices.read(old).readable)
    #expect(ThreadChoices.read(old).defaultThread == ThreadChoices.read(now).defaultThread)
    #expect(ThreadChoices.read(old).threads.map(\.id) == ["general", "daily", "trip"])
    #expect(ThreadChoices.read(old).threads.map(\.id) == ThreadChoices.read(now).threads.map(\.id))
    #expect(CrashPost.readAppConfig(old).agentName == "Talos")
    #expect(CrashPost.readAppConfig(old).agentName == CrashPost.readAppConfig(now).agentName)
    #expect(CrashPost.readAppConfig(old).defaultThread == CrashPost.readAppConfig(now).defaultThread)
    // both set a quiet window and Option C, so these two readers compare real values, not nil with nil
    let q = try #require(QuietWindow.read(now))
    #expect(q.start == 22 * 60 && q.end == 7 * 60)
    #expect(QuietWindow.read(old) == q)
    let d = try #require(DedicatedSettings.readable(now))
    #expect(d.enabled && d.maxLive == 2 && Array(d.threads.keys) == ["trip"])
    #expect(DedicatedSettings.readable(old) == d)
  }

  @Test func theFirstChoiceIsTheDefaultThreadAndEmptyMeansDefault() throws {
    let l = ThreadChoices.read(try #require(fixture("config.json")))
    let o = ThreadChoices.options(l, current: nil)
    #expect(o.first?.value == nil)
    #expect(o.first?.label == "Default thread (General)")
    #expect(ThreadChoices.stored(nil) == nil && ThreadChoices.stored("") == nil && ThreadChoices.stored("daily") == "daily")
  }

  @Test func aSavedThreadTheFileNoLongerHasStaysSelectableAndNamed() throws {
    let l = ThreadChoices.read(try #require(fixture("config.json")))
    let o = ThreadChoices.options(l, current: "gone")
    #expect(o.contains { $0.value == "gone" && $0.label.contains("not found") }, "opening Mac settings never rewrites it")
    #expect(!ThreadChoices.options(l, current: "daily").contains { $0.label.contains("not found") })
  }

  @Test func aMissingOrDamagedFileIsSaidNotShownAsEmpty() {
    for data in [nil, Data("[]".utf8), Data("{\"threads\": ".utf8), Data()] as [Data?] {
      let l = ThreadChoices.read(data)
      #expect(!l.readable)
      #expect(ThreadChoices.note(l).contains("Couldn't read your threads"))
    }
    #expect(ThreadChoices.options(.unreadable, current: nil).count == 1)
    #expect(ThreadChoices.options(.unreadable, current: "daily").count == 2, "a saved choice is kept even when unreadable")
  }

  @Test func oneBadThreadCostsThatThreadOnly() {
    let json = #"{"default_thread":"a","threads":[{"id":"a","name":"A","kind":"fixed"},{"id":7},"x",{"name":"no id"},{"id":"b","kind":"agent","archived":"yes"},{"id":"c","kind":"future-kind","name":""}]}"#
    let l = ThreadChoices.read(Data(json.utf8))
    #expect(l.threads.map(\.id) == ["a", "b", "c"])
    #expect(l.threads.last?.name == "c", "an empty name falls back to the id")
  }

  @Test func readOnlyThePathFollowsTheSameHomeAsTheRestOfTheApp() {
    #expect(ThreadChoices.configPath(configEnv: ["TALOS_APP_HOME": "/home/alex/t"], processEnv: ["TALOS_APP_HOME": "/other"], home: home) == "/home/alex/t/config.json")
    #expect(ThreadChoices.configPath(configEnv: [:], processEnv: ["TALOS_APP_HOME": "/other"], home: home) == "/other/config.json")
    #expect(ThreadChoices.configPath(configEnv: ["TALOS_APP_HOME": ""], processEnv: [:], home: home) == "/home/alex/.config/talos/app/config.json")
    #expect(ThreadChoices.configPath(configEnv: ["TALOS_APP_HOME": "~/t"], processEnv: [:], home: home) == "/home/alex/t/config.json")
  }
}

// MARK: pre-setup (U8)

@Suite("Settings before setup")
struct PreSetupTests {
  @Test func valuesComeBackOnTheNextLaunchWithoutAFile() {
    let store = MemoryStore()
    var c = DesktopConfig.defaults
    c.autoRestart = false
    c.agentDir = "/home/alex/other"
    c.host = .tmux
    c.notifyThread = "daily"
    c.keepAwakeOnAC = true
    c.relayUrl = "https://relay.alex.example"
    c.talosAppCommand = ["bun", "run", "/home/alex/cli.ts"]
    PreSetup.record(c, in: store)
    // "a quit": a new process sees only the store.
    let next = PreSetup.startupConfig(file: nil, store: store)
    #expect(next == c)
  }

  @Test func aFileIsTheTruthAndHeldValuesAreStale() {
    let store = MemoryStore()
    var held = DesktopConfig.defaults
    held.autoRestart = false
    PreSetup.record(held, in: store)
    var file = DesktopConfig.defaults
    file.autoRestart = true
    #expect(PreSetup.startupConfig(file: file, store: store).autoRestart)
  }

  @Test func theDefaultThreadIsHeldAsAChoiceNotAsMissing() {
    let store = MemoryStore()
    var c = DesktopConfig.defaults
    c.notifyThread = "daily"
    PreSetup.record(c, in: store)
    c.notifyThread = nil  // he set it back to the default thread
    PreSetup.record(c, in: store)
    #expect(PreSetup.startupConfig(file: nil, store: store).notifyThread == nil)
  }

  @Test func theHotkeyKeyFromBeforeIsMergedToo() {
    let store = MemoryStore()
    store.setString("ctrl+opt+shift+k", forKey: PreSetup.hotkeyKey)
    #expect(PreSetup.startupConfig(file: nil, store: store).hotkeys.compose == "ctrl+opt+shift+k")
    PreSetup.record(.defaults, in: store)
    #expect(PreSetup.load(store)?.hotkey == "ctrl+opt+shift+k", "recording a Settings change keeps a held hotkey")
    #expect(PreSetup.merged(into: .defaults, store: store).hotkeys.compose == "ctrl+opt+shift+k", "it joins the file at Import or Adopt")
  }

  @Test func importAndAdoptMergeThenOnlyAFileThatExistsClearsTheStore() {
    let store = MemoryStore()
    var c = DesktopConfig.defaults
    c.keepAwakeOnAC = true
    PreSetup.record(c, in: store)
    let merged = PreSetup.merged(into: configured(), store: store)
    #expect(merged.keepAwakeOnAC)
    #expect(merged.args == configured().args && merged.env == configured().env, "the launch command is never part of it")
    #expect(merged.session == configured().session)
    PreSetup.finish(store: store, fileExists: false)  // the write failed
    #expect(PreSetup.load(store) != nil, "a failed write must not lose the held values")
    PreSetup.finish(store: store, fileExists: true)
    #expect(PreSetup.load(store) == nil)
  }

  @Test func aDamagedBlobIsIgnoredAndAnUnknownHostCostsOnlyItself() {
    let store = MemoryStore()
    store.set(Data("{not json".utf8), forKey: PreSetup.key)
    #expect(PreSetup.load(store) == nil)
    #expect(PreSetup.startupConfig(file: nil, store: store) == .defaults)
    store.set(Data(#"{"host":"zellij","auto_restart":false,"future_key":1}"#.utf8), forKey: PreSetup.key)
    let p = PreSetup.load(store)
    #expect(p?.host == nil && p?.autoRestart == false)
    let c = PreSetup.startupConfig(file: nil, store: store)
    #expect(c.host == .auto && !c.autoRestart)
  }

  @Test func twoThreadsRecordingAtOnceNeverLeaveAHalfWrittenBlob() async {
    let store = MemoryStore()
    await withTaskGroup(of: Void.self) { g in
      for i in 0..<40 {
        g.addTask {
          var c = DesktopConfig.defaults
          c.autoRestart = i % 2 == 0
          c.agentDir = "/home/alex/a\(i)"
          PreSetup.record(c, in: store)
        }
      }
    }
    let p = PreSetup.load(store)
    #expect(p?.agentDir?.hasPrefix("/home/alex/a") == true, "one whole snapshot won")
  }
}

// MARK: quitting (U9 remainder)

@Suite("One quit rule")
struct QuitPlanTests {
  typealias I = QuitPlan.Inputs

  @Test func ownedTerminalStopsFirstTmuxLetsTheAgentRun() {
    #expect(QuitPlan.decide(I(hostKeepsAgent: false, sessionActive: true)) == .stopThenTerminate)
    #expect(QuitPlan.decide(I(hostKeepsAgent: false, sessionActive: false)) == .terminateNow)
    #expect(QuitPlan.decide(I(hostKeepsAgent: true, sessionActive: true)) == .terminateNow)
  }

  @Test func quitAndStopStopsEvenWithTmux() {
    #expect(QuitPlan.decide(I(hostKeepsAgent: true, stopRequested: true, sessionActive: true)) == .stopThenTerminate)
  }

  @Test func aLogoutOrShutdownNeverWaits() {
    for keeps in [true, false] {
      for stop in [true, false] {
        for active in [true, false] {
          let d = QuitPlan.decide(I(systemPowerOff: true, hostKeepsAgent: keeps, stopRequested: stop, sessionActive: active))
          #expect(d != .stopThenTerminate, "keeps=\(keeps) stop=\(stop) active=\(active)")
        }
      }
    }
    #expect(QuitPlan.decide(I(systemPowerOff: true, hostKeepsAgent: false, sessionActive: true)) == .terminateNowAfterStopRequest)
    #expect(QuitPlan.decide(I(systemPowerOff: true, hostKeepsAgent: true, sessionActive: true)) == .terminateNow)
  }
}

@Suite("Quit driver")
struct QuitDriverTests {
  final class World: @unchecked Sendable {
    let lock = NSLock()
    var now = 1_000_000.0
    var stopCalls = 0
    var stopped = false
    var finishes: [Bool] = []
    func make(limit: Double = 15) -> QuitDriver {
      QuitDriver(
        limit: limit, uptime: { self.lock.withLock { self.now } },
        stop: { self.lock.withLock { self.stopCalls += 1 } },
        isStopped: { self.lock.withLock { self.stopped } },
        finish: { t in self.lock.withLock { self.finishes.append(t) } })
    }
    func advance(_ s: Double) { lock.withLock { now += s } }
    func setStopped() { lock.withLock { stopped = true } }
  }

  @Test func startsTheStopOnceAndEndsOnceWhenStopped() {
    let w = World()
    let d = w.make()
    #expect(d.begin())
    #expect(!d.begin(), "a second Quit joins the same stop")
    d.poll()
    #expect(w.finishes.isEmpty && d.isRunning)
    w.setStopped()
    d.poll(); d.poll(); d.poll()
    #expect(w.finishes == [false], "ended once, not timed out")
    #expect(w.stopCalls == 1)
    #expect(!d.begin(), "after the end, nothing restarts")
    #expect(d.isFinished)
  }

  @Test func neverHangsWhenTheAgentDoesNotStop() {
    let w = World()
    let d = w.make(limit: 15)
    d.begin()
    w.advance(14.9)
    d.poll()
    #expect(w.finishes.isEmpty)
    w.advance(0.2)
    d.poll()
    #expect(w.finishes == [true], "the limit passed: quit anyway")
  }

  @Test func theLimitIsCountedFromTheStopNotFromBoot() {
    let w = World()
    w.now = 5.0  // a Mac that has just booted
    let d = w.make(limit: 15)
    d.begin()
    w.advance(10)
    d.poll()
    #expect(w.finishes.isEmpty)
  }

  @Test func pollingBeforeBeginDoesNothing() {
    let w = World()
    let d = w.make()
    w.setStopped()
    d.poll()
    #expect(w.finishes.isEmpty && w.stopCalls == 0)
  }

  @Test func twoThreadsPollingAndBeginningOnlyFinishOnce() async {
    let w = World()
    let d = w.make()
    w.setStopped()
    await withTaskGroup(of: Void.self) { g in
      for _ in 0..<50 {
        g.addTask { d.begin(); d.poll() }
      }
    }
    #expect(w.finishes == [false] && w.stopCalls == 1)
  }
}

// MARK: Permissions row for notifications (M3, S1)

@Suite("Notifications permission row")
struct NotificationsRowTests {
  private func row(_ p: NotifyPermission?) -> PermissionsModel.Row {
    PermissionsModel.rows { $0 == .notifications ? PermissionsModel.state(forNotifications: p) : .granted }
      .first { $0.kind == .notifications }!
  }

  @Test func theRowIsThereWithAButtonToMacNotificationSettings() {
    let r = row(.granted)
    #expect(r.title == "Notifications")
    #expect(r.action == .openSettings(PermissionsModel.notificationsURL))
    #expect(PermissionsModel.notificationsURL.hasPrefix("x-apple.systempreferences:"))
    #expect(PermissionsModel.rows { _ in .granted }.first?.kind == .notifications, "first: it is the one he feels")
  }

  @Test func eachMacAnswerHasItsOwnState() {
    #expect(row(.granted).state == .granted && row(.granted).stateNote == nil)
    #expect(row(.denied).state == .missing)
    #expect(row(.notAsked).state == .askedOnFirstUse)
    #expect(row(nil).state == .unknown)
  }

  @Test func deniedNeverReadsAsSilentSuccess() {
    let r = row(.denied)
    let note = r.stateNote ?? ""
    #expect(note.hasPrefix("Denied."))
    #expect(note.contains("blocks every Talos banner"))
    #expect(note.contains("crash and health banners"))
    #expect(r.needsAttention)
    #expect(PermissionsModel.summary([r]).contains("1 to review"))
    #expect(r.button == .openSettings(PermissionsModel.notificationsURL))
    // a status macOS adds later reads as denied, not as granted
    #expect(NotifyPermission(authorizationStatusRaw: 99) == .denied)
  }

  @Test func theTextSaysWhichBannersObeyWhichRules() {
    let t = PermissionsModel.notificationsWhy
    #expect(t.contains("notification switch") && t.contains("quiet hours") && t.contains("thread"))
    #expect(t.contains("Health and crash banners") && t.contains("pass that switch"), "R3: the Mac matches the relay")
    #expect(t.contains("health alarms"))
  }

  @Test func notAskedAndUnknownAreWordedApart() {
    #expect(row(.notAsked).stateNote?.contains("Not asked yet") == true)
    #expect(row(nil).stateNote?.contains("Couldn't check") == true)
  }

  @Test func rowsWithNoPromptOfTheirOwnStillGetAFixButtonWhenDenied() {
    let rows = PermissionsModel.rows { $0 == .microphone ? .missing : .askedOnFirstUse }
    let mic = rows.first { $0.kind == .microphone }!
    #expect(mic.action == .none)
    #expect(mic.button == .openSettings(PermissionsModel.settingsBase + "Privacy_Microphone"))
    #expect(mic.stateNote?.hasPrefix("Denied.") == true, "M28: denied is not 'asked on first use'")
    let cam = rows.first { $0.kind == .camera }!
    #expect(cam.button == .none && cam.stateNote?.contains("macOS asks the first time") == true)
    let auto = rows.first { $0.kind == .automation }!
    #expect(auto.stateNote?.contains("Can't be checked from here") == true, "Automation can never turn green, and says so")
  }
}

// MARK: first run (U6, U7)

@Suite("First run")
struct FirstRunHomesTests {
  @Test func theAgentFolderIsTheNamedFirstStepAndOffersThreeWays() {
    let rows = FirstRun.rows(.init(home: home, setupDone: false))
    #expect(rows.first?.id == "agentfolder")
    #expect(rows.first?.title == "Agent folder")
    guard case .fix(let m)? = rows.first?.state else { Issue.record("a fix row"); return }
    #expect(m.contains("Create") && m.contains("Adopt") && m.contains("Choose") && m.contains("Nothing starts"))
    #expect(m.contains("Import") && m.contains(MacSettingsText.sessionPath), "Import stays, as the way for your own launch command")
    let done = FirstRun.rows(.init(agentDir: "~/talos-agent", home: home, setupDone: true)).first
    #expect(done?.id == "agentfolder" && done?.isOK == true && done?.title.contains("~/talos-agent") == true)
    #expect(!FirstRun.rows(.init(home: home)).contains { $0.id == "agentfolder" }, "not checked: no row")
  }

  @Test func aSetUpAgentFolderThatIsGoneIsAFixNotGreen() {
    let rows = FirstRun.rows(.init(home: home, setupDone: true, agentFolderProblem: "No folder at /home/alex/x. Talos will not create it."))
    guard case .fix(let m)? = rows.first(where: { $0.id == "agentfolder" })?.state else { Issue.record("a fix row"); return }
    #expect(m.contains("No folder at"))
  }

  @Test func noRowPointsAtAPaneThatCannotHelpYet() {
    let rows = FirstRun.rows(.init(claudeVersion: "2.1.0", authSignedIn: false, home: home, setupDone: false))
    for r in rows {
      switch r.state {
      case .fix(let m), .unknown(let m):
        #expect(!m.lowercased().contains("terminal pane") && !m.lowercased().contains(" pane."), "\(r.id): \(m)")
      case .ok: break
      }
    }
    let unchecked = FirstRun.rows(.init(authSignedIn: nil, home: home, setupDone: false)).first { $0.id == "auth" }
    if case .unknown(let m)? = unchecked?.state { #expect(!m.contains("pane")) } else { Issue.record("unknown row") }
  }

  @Test func theFirstStartConfirmedFixRowCanShowNow() {
    #expect(FirstRun.trust(setupDone: false, confirmedAt: nil) == nil)
    #expect(FirstRun.trust(setupDone: true, confirmedAt: nil) == false)
    #expect(FirstRun.trust(setupDone: true, confirmedAt: "2026-11-01T10:00:00Z") == true)
    let rows = FirstRun.rows(.init(agentDirTrusted: FirstRun.trust(setupDone: true, confirmedAt: nil), home: home, setupDone: true))
    guard case .fix(let fix)? = rows.first(where: { $0.id == "trust" })?.state else { Issue.record("fix row reachable"); return }
    #expect(fix.contains("Talos popup") && fix.contains("Start session"), "it names the real controls: \(fix)")
    let before = FirstRun.rows(.init(home: home, setupDone: false)).first { $0.id == "trust" }
    if case .unknown(let m)? = before?.state { #expect(m.contains("first step above")) } else { Issue.record("waits for setup") }
  }

  @Test func importSaysItSavedAndThatItIsStarting() {
    #expect(SetupText.importSaved.hasPrefix("Saved."))
    #expect(SetupText.importSaved.contains("Starting") && SetupText.importSaved.contains("Terminals…"))
    #expect(!SetupText.importSaved.contains("Nothing has started"))
    #expect(SetupText.importSavedNotStarted.contains("Nothing has started") && SetupText.importSavedNotStarted.contains("Start session"))
    #expect(SetupText.importNotSaved(path: "/home/alex/x/desktop.json").contains("Couldn't save"))
  }
}

// MARK: names and wording (M22 to M30, O6, M25)

@Suite("Names and wording")
struct WordingTests {
  /// Every Swift file the app is made of, so a leftover old name cannot hide in a view.
  private func sources() -> [(path: String, text: String)] {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources")
    var out: [(String, String)] = []
    if let e = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil) {
      for case let u as URL in e where u.pathExtension == "swift" {
        out.append((u.path, (try? String(contentsOf: u, encoding: .utf8)) ?? ""))
      }
    }
    return out
  }

  @Test func theWindowTabIsCalledConnectionEverywhere() {
    for (p, t) in sources() {
      #expect(!t.contains("Settings \\u{2192} Window"), "\(p)")
      #expect(!t.contains("Settings → Window"), "\(p)")
      #expect(!t.contains("Window tab"), "\(p)")
    }
    let texts = [
      HelpPage.noRelay, TalosAppLocator.notFoundMessage, FirstRun.setupStep, SupervisorNotice.notSetUp, MacSettingsText.noRelayYet,
    ]
    for t in texts { #expect(!t.contains("→ Window") && !t.contains("\u{2192} Window"), "\(t)") }
    #expect(HelpPage.noRelay.contains("Mac settings \u{2192} Connection"))
    let bad = FirstRun.rows(.init(home: home, talosAppFound: false)).first { $0.id == "talosapp" }
    if case .fix(let m)? = bad?.state { #expect(m.contains("Connection")) } else { Issue.record("fix row") }
    #expect(MacSettingsText.noRelayYet.contains("Connection"))
  }

  @Test func theCharacterIsTheCompanionAndTheWindowIsMacSettings() {
    #expect(MacSettingsText.windowTitle == "Mac settings" && MacSettingsText.companionName == "Companion")
    for (p, t) in sources() where !p.hasSuffix("CompanionController.swift") && !p.hasSuffix("CompanionPanels.swift") {
      #expect(!t.contains("Show Talos on screen"), "\(p)")
      #expect(!t.contains("Talos on screen: status"), "\(p)")
    }
    #expect(!HelpPage.noRelay.contains("Talos on screen"))
  }

  @Test func theOldPathsAndWindowsAreGone() {
    for (p, t) in sources() {
      #expect(!t.contains(#"openWindow(id: "session")"#) && !t.contains(#"openWindow(id: "permissions")"#) && !t.contains(#"openWindow(id: "hotkey")"#), "\(p)")
      #expect(!t.contains(#"Window("Session""#) && !t.contains(#"Window("Permissions""#) && !t.contains(#"Window("Compose hotkey""#), "\(p)")
    }
  }

  @Test func theReConfirmLabelNoLongerReadsBackwards() {
    #expect(MacSettingsText.autoConfirmTitle == "Press Enter for me on the development-channel dialog")
    #expect(MacSettingsText.autoConfirmHelp.contains("exactly the dialog for the channel Talos launched with"))
    for (p, t) in sources() { #expect(!t.contains("Re-confirm the development-channel dialog"), "\(p)") }
  }

  @Test func startOnOpenSaysOffStillJoinsARunningAgent() {
    #expect(MacSettingsText.startOnOpenHelp.contains("Off still reconnects to an agent that is already running"))
  }

  @Test func theRelayBoxShowsItsHintForThePlaceholder() {
    #expect(MacSettingsText.relayDraft(RelayConfig.placeholder) == "")
    #expect(MacSettingsText.relayDraft("https://relay.example.com/") == "")
    #expect(MacSettingsText.relayDraft("auto") == "")
    #expect(MacSettingsText.relayDraft("https://relay.alex.example") == "https://relay.alex.example")
    #expect(MacSettingsText.relayUsing(nil).contains("No relay address yet"))
    #expect(MacSettingsText.relayUsing("https://x.example") == "Using https://x.example")
    #expect(MacSettingsText.noRelayYet.contains("Mac settings") && !MacSettingsText.noRelayYet.contains("desktop.json"), "M24")
  }

  @Test func theRelayBoxDoesNotRewriteThePlaceholderOnClose() {
    var d = SettingsDrafts(from: .defaults)
    #expect(d.relay == "")
    #expect(d.pending(against: .defaults).relay == nil, "closing the window saves nothing")
    d.relay = "https://relay.alex.example"
    #expect(d.pending(against: .defaults).relay == "https://relay.alex.example")
    var real = DesktopConfig.defaults
    real.relayUrl = "https://relay.alex.example"
    var d2 = SettingsDrafts(from: real)
    #expect(d2.relay == "https://relay.alex.example")
    d2.relay = ""
    #expect(d2.pending(against: real).relay == "", "clearing a real address is a change")
  }

  @Test func snoozeEntryTellsYouItEndsTheSnooze() {
    #expect(MacSettingsText.snoozeEntry(until: "3:05 PM") == "End snooze (snoozed until 3:05 PM)")
  }

  @Test func startAtLoginPendingApprovalIsSaidAndItWaits() {
    final class Svc: LoginItemService {
      var status: LoginItemPlan.Service = .requiresApproval
      func register() throws {}
      func unregister() throws {}
    }
    final class Files: LaunchAgentFiles {
      func exists(_ path: String) -> Bool { false }
      func write(_ data: Data, to path: String) throws {}
      func remove(_ path: String) throws {}
    }
    let svc = Svc()
    func look() -> LoginItemManager {  // a manager is built from the system answer each time; none is kept
      LoginItemManager(service: svc, files: Files(), home: home, bundleId: "app.talos.test", executable: "/x")
    }
    #expect(look().isOn, "the switch is on")
    #expect(look().isPendingApproval, "but it is not working yet, and the screen can say so on every look")
    #expect(look().isPendingApproval, "a second look asks again and gets the same answer")
    #expect(MacSettingsText.loginPending.contains("will not start at login until you do"))
    svc.status = .enabled  // approved in System Settings
    #expect(look().isOn && !look().isPendingApproval, "once approved the waiting line goes")
  }
}

@Suite("When a setting applies")
struct AppliesTests {
  @Test func everyMacSettingStatesWhenItApplies() {
    for s in MacSettingsText.Setting.allCases {
      let t = MacSettingsText.applies(s)
      #expect(t.hasPrefix("Applies"), "\(s): \(t)")
    }
    let notNow = MacSettingsText.Setting.allCases.filter { !MacSettingsText.applies($0).contains("now") }
    for s in notNow { #expect(MacSettingsText.applies(s).contains("next") || MacSettingsText.applies(s).contains("when you"), "\(s)") }
    #expect(MacSettingsText.applies(.launchCommand).contains("cold start"))
    #expect(MacSettingsText.applies(.host).contains("next time Talos opens"))
  }

  @Test func everyCaseIsShownByTheScreenThatOwnsIt() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop")
    var all = ""
    for f in try FileManager.default.contentsOfDirectory(atPath: dir.path) where f.hasSuffix(".swift") {
      all += (try? String(contentsOfFile: dir.appendingPathComponent(f).path, encoding: .utf8)) ?? ""
    }
    for s in MacSettingsText.Setting.allCases {
      #expect(all.contains("AppliesNote(setting: .\(s.rawValue))"), "\(s) has no note on screen")
    }
  }
}

@Suite("Agent folder check and General")
struct FolderAndAboutTests {
  private func fs(_ map: [String: Bool]) -> (String) -> (exists: Bool, isDirectory: Bool) {
    { p in map[p].map { (true, $0) } ?? (false, false) }
  }

  @Test func eachFolderStateHasItsOwnWords() {
    let all = fs(["/home/alex/agent": true, "/home/alex/file": false, "/home/alex/Desktop/a": true])
    let ok = { (_: String) in true }
    #expect(AgentFolderCheck.check("~/agent", home: home, exists: all, readable: ok) == .ok)
    #expect(AgentFolderCheck.check("", home: home, exists: all, readable: ok) == .empty)
    #expect(AgentFolderCheck.check("~/nope", home: home, exists: all, readable: ok) == .missing("/home/alex/nope"))
    #expect(AgentFolderCheck.check("~/file", home: home, exists: all, readable: ok) == .notAFolder("/home/alex/file"))
    #expect(AgentFolderCheck.check("~/agent", home: home, exists: all, readable: { _ in false }) == .notAccessible("/home/alex/agent"))
    #expect(AgentFolderCheck.check("~/Desktop/a", home: home, exists: all, readable: ok) == .okProtected("Desktop"))
    for r in [AgentFolderCheck.Result.missing("/x"), .notAFolder("/x"), .notAccessible("/x"), .empty] { #expect(r.isProblem && !r.text.isEmpty) }
    #expect(AgentFolderCheck.Result.okProtected("Desktop").text.contains("macOS asks Talos once"))
  }

  @Test func theRealFileSystemAnswersToo() throws {
    let dir = NSTemporaryDirectory() + "talos-folder-\(UUID().uuidString.prefix(6))"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(atPath: dir) }
    #expect(AgentFolderCheck.check(dir, home: home) == .ok)
    #expect(AgentFolderCheck.check(dir + "/missing", home: home) == .missing(dir + "/missing"))
    FileManager.default.createFile(atPath: dir + "/f", contents: Data())
    #expect(AgentFolderCheck.check(dir + "/f", home: home) == .notAFolder(dir + "/f"))
  }

  @Test func versionAndBuild() {
    #expect(MacAbout.versionLine(version: "1.4", build: "87") == "Version 1.4 (build 87)")
    #expect(MacAbout.versionLine(version: "1.4", build: nil) == "Version 1.4")
    #expect(MacAbout.versionLine(version: "1.4", build: "") == "Version 1.4")
    #expect(MacAbout.versionLine(version: "dev", build: "dev") == "Version dev")
  }

  @Test func revealingAMissingFileSaysSoInsteadOfDoingNothing() {
    #expect(MacAbout.reveal(path: "/x/desktop.json", exists: true, what: "desktop.json", madeBy: "m") == .show("/x/desktop.json"))
    guard case .missing(let m) = MacAbout.reveal(path: "/x/desktop.json", exists: false, what: "desktop.json", madeBy: MacAbout.configMissing) else {
      Issue.record("missing"); return
    }
    #expect(m.hasPrefix("No desktop.json yet.") && m.contains("Import"))
  }
}

@Suite("Notifications policy after loginExpires")
struct NoLoginExpiresTests {
  @Test func everyRemainingNoticeStillHasAFixedPhraseAndATag() {
    let all: [NotificationPolicy.Supervisor] = [
      .needsYou, .restartedAfterCrash, .stoppedRestarting, .resumeFailed, .confirmFailed, .blocked, .couldNotStart, .crashedNoRestart,
      .autoRestored, .restoreFailed,
    ]
    let tags = all.map { NotificationPolicy.notice($0, agent: "Talos").tag }
    #expect(Set(tags).count == all.count)
    #expect(!tags.contains("sup:login"))
  }
}

// MARK: review of #139

@Suite("Review of #139: host lock, launch box, held values, import note")
struct Review139CoreTests {
  @Test func aThreadSessionRunningInTmuxLocksTheHostPickerToo() {
    #expect(!HostChoice.canChange(sessionUp: false, workersRunning: true), "main stopped, a thread's agent still alive")
    #expect(!HostChoice.canChange(sessionUp: true, workersRunning: false))
    #expect(HostChoice.canChange(sessionUp: false, workersRunning: false))
  }

  @Test func workersFileSaysWhenAnAgentMayStillBeRunning() {
    func file(_ states: [String]) -> WorkersFile {
      var f = WorkersFile(
        supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 0), threads: [:])
      for (i, s) in states.enumerated() {
        var e = WorkersFile.Entry(threadId: "t\(i)", cwd: "/home/alex/agent")
        e.state = s
        f.threads["t\(i)"] = e
      }
      return f
    }
    #expect(!file([]).anyMayBeRunning)
    #expect(!file(["off", "parked", "failed"]).anyMayBeRunning)
    for s in ["starting", "live", "busy", "parking", "stopping", "a-state-from-a-newer-copy"] {
      #expect(file(["off", s]).anyMayBeRunning, "\(s) may have a process behind it")
    }
  }

  @Test func aSavedHostThatDiffersFromTheRunningOneBlocksStart() {
    // running on Talos's own terminal; the owner picked tmux (or automatic) and tmux is usable: the agent would start here and be
    // left alive under tmux at the next launch
    for c in [DesktopConfig.Host.tmux, .auto] {
      #expect(HostChoice.startBlock(saved: c, runningTmux: false, tmuxUsable: true) != nil)
    }
    // running on tmux; the owner picked Talos's own terminal
    #expect(HostChoice.startBlock(saved: .direct, runningTmux: true, tmuxUsable: true) != nil)
    // no mismatch
    #expect(HostChoice.startBlock(saved: .auto, runningTmux: true, tmuxUsable: true) == nil)
    #expect(HostChoice.startBlock(saved: .direct, runningTmux: false, tmuxUsable: true) == nil)
    #expect(HostChoice.startBlock(saved: .tmux, runningTmux: false, tmuxUsable: false) == nil, "no tmux: both mean the own terminal")
    #expect(HostChoice.startBlock(saved: .auto, runningTmux: false, tmuxUsable: false) == nil)
  }

  @Test(arguments: ["claude -c", "claude --continue", "claude --fork-session", "claude --a -c --b", "claude --model opus --continue"])
  func conversationFlagsAreRefusedNotSilentlyDropped(line: String) {
    var c = configured()
    c.args = ["--a"]
    #expect(LaunchEdit.evaluate(line, against: c, home: "/home/alex") == .refused(LaunchEdit.resumePointer), "\(line)")
    #expect(LaunchEdit.resumePointer.contains("--continue") && LaunchEdit.resumePointer.contains("--fork-session"))
    // a value that merely looks like one stays fine
    #expect(LaunchEdit.evaluate("claude --name my-c --x", against: c, home: "/home/alex") != .refused(LaunchEdit.resumePointer))
  }

  @Test func theBoxReloadsOnlyWhenTheConfigLineReallyChanged() {
    #expect(!LaunchEdit.shouldReload(draft: "claude --y", loaded: "claude --y", current: "claude --y"), "our own save: keep the note")
    #expect(LaunchEdit.shouldReload(draft: "claude --x", loaded: "claude --x", current: "claude --y"), "Import rewrote it")
    #expect(!LaunchEdit.shouldReload(draft: "claude --typing", loaded: "claude --x", current: "claude --y"), "not while he is typing")
  }

  @Test func heldValuesAreOnlyLaidOverWhileThereIsNoFile() {
    let store = MemoryStore()
    var held = DesktopConfig.defaults
    held.relayUrl = "https://old.example.com"
    held.agentDir = "/home/alex/old"
    PreSetup.record(held, in: store)
    store.setString("ctrl+opt+Space", forKey: PreSetup.hotkeyKey)
    var live = DesktopConfig.defaults
    live.relayUrl = "https://new.example.com"
    live.agentDir = "/home/alex/new"
    live.hotkeys.compose = "cmd+shift+K"
    let before = PreSetup.base(for: live, configured: false, store: store)
    #expect(before.relayUrl == "https://old.example.com" && before.hotkeys.compose == "ctrl+opt+Space", "setup: held values win")
    let after = PreSetup.base(for: live, configured: true, store: store)
    #expect(after == live, "with a file, nothing held is laid over it")
  }

  @Test func importWhileARunningSessionDoesNotSayItIsStarting() {
    #expect(SetupText.importSaved.contains("Starting"))
    #expect(!SetupText.importSavedRunning.contains("Starting"))
    #expect(SetupText.importSavedRunning.contains("keeps its old command"))
  }
}
