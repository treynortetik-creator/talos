import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// The supervisor half of "Mac settings get one home". No tmux, no claude: the supervisor is built as SupervisorController
/// builds it and never started.
@Suite("Mac settings: config edits")
struct MacHomesConfigTests {
  private func world() throws -> (root: String, path: String, sup: Supervisor) {
    let root = NSTemporaryDirectory() + "talos-mh-\(UUID().uuidString)"
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    let path = root + "/desktop.json"
    let sup = Supervisor(
      options: .init(name: "agent", configPath: path, home: root), host: SwiftTermPtyHost(), probe: LiveSystem(loginEnv: { [:] }))
    return (root, path, sup)
  }

  // A session id and a first-start confirmation belong to one folder (Claude Code keys sessions by project folder).
  private func confirmedIn(_ w: (root: String, path: String, sup: Supervisor), _ dir: String) {
    w.sup.mutateConfig(createFile: true) {
      $0.agentDir = dir
      $0.session = DesktopConfig.Session(id: "11111111-2222-4333-8444-555555555555", confirmedAt: "2026-11-01T10:00:00Z")
    }
    w.sup.drain()
  }

  @Test func aDifferentAgentFolderDropsTheSessionIdAndTheConfirmation() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    confirmedIn(w, w.root + "/old")
    w.sup.mutateConfig { $0.agentDir = w.root + "/new" }  // the Settings path
    w.sup.drain()
    #expect(w.sup.currentConfig().session.id == nil && w.sup.currentConfig().session.confirmedAt == nil)
    confirmedIn(w, w.root + "/old")
    var c = w.sup.currentConfig()
    c.agentDir = "~/elsewhere"
    w.sup.updateConfig(c)  // and every other path
    w.sup.drain()
    #expect(w.sup.currentConfig().session.id == nil && w.sup.currentConfig().session.confirmedAt == nil)
    let onDisk = try #require(try ConfigFile.load(w.path))
    #expect(onDisk.session.id == nil && onDisk.session.confirmedAt == nil, "and the file says so")
  }

  @Test func theSameFolderKeepsThem() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    confirmedIn(w, w.root + "/old")
    for same in [w.root + "/old", w.root + "/old/", w.root + "/./old"] {
      w.sup.mutateConfig { $0.agentDir = same }
      w.sup.drain()
      #expect(w.sup.currentConfig().session.id == "11111111-2222-4333-8444-555555555555", "\(same)")
      #expect(w.sup.currentConfig().session.confirmedAt != nil, "\(same)")
    }
  }

  @Test func aNewFolderWithItsOwnSessionIdKeepsTheIdItCameWith() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    confirmedIn(w, w.root + "/old")
    w.sup.mutateConfig {
      $0.agentDir = w.root + "/new"
      $0.session = DesktopConfig.Session(id: "99999999-2222-4333-8444-555555555555")  // Import or Adopt a session
    }
    w.sup.drain()
    #expect(w.sup.currentConfig().session.id == "99999999-2222-4333-8444-555555555555")
  }

  @Test func aSettingChangedBeforeSetupDoesNotCreateTheFile() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    w.sup.mutateConfig { $0.host = .tmux; $0.notifyThread = "daily" }
    w.sup.drain()  // `currentConfig()` is the config as of the last applied edit, not a wait for the queue
    // a hotkey rebind goes in through `updateConfig` instead, which used to write the defaults to disk
    var rebound = w.sup.currentConfig()
    rebound.hotkeys.compose = "ctrl+opt+shift+k"
    w.sup.updateConfig(rebound)
    w.sup.drain()
    #expect(!FileManager.default.fileExists(atPath: w.path), "the file's existence is what makes the next launch start a session")
    #expect(w.sup.currentConfig().host == .tmux, "but the running app sees it")
    #expect(w.sup.currentConfig().hotkeys.compose == "ctrl+opt+shift+k")
  }

  @Test func theSetupWritesWhatWasHeld() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    let store = MemoryStore()
    var c = w.sup.currentConfig()
    c.autoRestart = false
    c.host = .direct
    PreSetup.record(c, in: store)
    // "quit", relaunch: a new supervisor starts from defaults and is handed the held values
    w.sup.updateConfig(PreSetup.startupConfig(file: nil, store: store))
    var imported = PreSetup.merged(into: w.sup.currentConfig(), store: store)
    imported.args = ["--x"]
    w.sup.updateConfig(imported, createFile: true)
    w.sup.drain()
    PreSetup.finish(store: store, fileExists: FileManager.default.fileExists(atPath: w.path))
    let onDisk = try #require(try ConfigFile.load(w.path))
    #expect(!onDisk.autoRestart && onDisk.host == .direct && onDisk.args == ["--x"])
    #expect(PreSetup.load(store) == nil)
  }

  @Test func twoCallersEditingAtOnceBothKeepTheirEdit() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    w.sup.updateConfig(w.sup.currentConfig(), createFile: true)
    w.sup.drain()
    let n = 60
    DispatchQueue.concurrentPerform(iterations: n) { i in
      w.sup.mutateConfig { $0.args.append("--a\(i)") }
    }
    w.sup.drain()
    let args = w.sup.currentConfig().args
    #expect(args.count == n && Set(args).count == n, "no edit was lost")
    let disk = try #require(try ConfigFile.load(w.path))
    #expect(disk.args.count == n, "and the file agrees")
  }

  @Test func anEditNeverUndoesAConversationIdSetMeanwhile() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    var c = w.sup.currentConfig()
    c.session = DesktopConfig.Session(id: "11111111-2222-4333-8444-555555555555", previousIds: ["old"], confirmedAt: "t")
    w.sup.updateConfig(c, createFile: true)
    w.sup.drain()
    // the "read, edit, write back" way loses what changed between the read and the write:
    let stale = w.sup.currentConfig()
    w.sup.mutateConfig { $0.session.id = "22222222-2222-4333-8444-555555555555" }
    var staleEdit = stale
    staleEdit.args = ["--stale"]
    w.sup.updateConfig(staleEdit)
    w.sup.drain()
    #expect(w.sup.currentConfig().session.id == "11111111-2222-4333-8444-555555555555", "(the old way: the new id is gone)")
    // the way Mac settings saves: the edit runs on the supervisor's own queue against what is current
    w.sup.mutateConfig { $0.session.id = "33333333-2222-4333-8444-555555555555" }
    w.sup.mutateConfig { $0.args = ["--fresh"] }
    w.sup.drain()
    let now = w.sup.currentConfig()
    #expect(now.session.id == "33333333-2222-4333-8444-555555555555" && now.args == ["--fresh"])
    #expect(now.session.previousIds == ["old"])
  }

  @Test func theLaunchEditKeepsEnvValuesAndSessionIds() throws {
    let w = try world()
    defer { try? FileManager.default.removeItem(atPath: w.root) }
    var c = w.sup.currentConfig()
    c.env = ["TOKEN": "keep-me"]
    c.session = DesktopConfig.Session(id: "11111111-2222-4333-8444-555555555555", previousIds: ["p1", "p2"], confirmedAt: "t")
    w.sup.updateConfig(c, createFile: true)
    w.sup.drain()
    guard case .updated(let path, let args) = LaunchEdit.evaluate("claude --new-flag 1", against: w.sup.currentConfig(), home: w.root) else {
      Issue.record("accepted"); return
    }
    w.sup.mutateConfig { $0.claudePath = path; $0.args = args }
    w.sup.drain()
    let disk = try #require(try ConfigFile.load(w.path))
    #expect(disk.args == ["--new-flag", "1"])
    #expect(disk.env == ["TOKEN": "keep-me"])
    #expect(disk.session.id == c.session.id && disk.session.previousIds == ["p1", "p2"] && disk.session.confirmedAt == "t")
    // a refused edit changes nothing on disk
    let before = try Data(contentsOf: URL(fileURLWithPath: w.path))
    if case .refused = LaunchEdit.evaluate("FOO=1 claude", against: disk, home: w.root) {} else { Issue.record("refused") }
    #expect(try Data(contentsOf: URL(fileURLWithPath: w.path)) == before)
  }
}

/// Review of #139: a launch edit that changes only the program must make the next start cold, as an args edit does.
@Suite("Mac settings: a new program is a cold start (real pty)", .serialized)
struct MacHomesProgramEditTests {
  private func newProgram(_ r: Rig) throws -> String {
    let p = r.home + "/other-claude"
    try "#!/bin/bash\nexec \(Rig.fixtures)/claude \"$@\"\n".write(toFile: p, atomically: true, encoding: .utf8)
    chmod(p, 0o755)
    return p
  }

  private func crashAfterEdit(_ edit: @escaping @Sendable (inout DesktopConfig, String) -> Void) throws -> (audit: String, needs: Supervisor.NeedsYou?) {
    let r = try Rig(.direct, scenario: "crash-after.sh", env: ["FAKE_CRASH_SECONDS": "3"])
    defer { r.teardown() }
    try coldStartConfirmed(r)
    let other = try newProgram(r)
    r.sup.mutateConfig { edit(&$0, other) }
    #expect(r.wait(20) { r.starts.count >= 2 }, "restarted after the crash")
    #expect(r.wait(10) { r.audit.contains(" restart ") }, "\(r.audit)")
    usleep(1_500_000)
    return (r.audit, r.sup.status.needsYou)
  }

  /// Was "NeverAutoPressesEnter" until 2026-11-07, when the owner retired the rule that cold starts are always human. A changed program
  /// is a changed launch: the next start is cold and its warning waits for the owner (`launchChanged`), whose Enter then confirms it.
  @Test func aProgramOnlyEditMakesTheNextStartColdAndItWaitsForTheOwner() throws {
    let out = try crashAfterEdit { c, other in c.claudePath = other }
    #expect(out.audit.contains(" restart attempt=0 kind=cold"), "\(out.audit)")
    #expect(out.audit.components(separatedBy: " auto_confirm ").count - 1 == 1, "only the first start's: \(out.audit)")
    #expect(out.audit.contains("auto_confirm_refused kind=cold reason=launchChanged"), "\(out.audit)")
    #expect(out.needs == .confirmColdStart, "\(String(describing: out.needs))")
  }

  @Test func anArgsEditControlWaitsForTheOwnerToo() throws {
    let out = try crashAfterEdit { c, _ in c.args.append("--extra") }
    #expect(out.audit.contains(" restart attempt=0 kind=cold"), "\(out.audit)")
    #expect(out.audit.contains("auto_confirm_refused kind=cold reason=launchChanged"), "\(out.audit)")
    #expect(out.needs == .confirmColdStart)
  }

  /// An edit that makes the launch pass a channel the screen will not show: the channel check comes first, so that is the reason.
  @Test func anArgsEditThatAddsAChannelTheScreenDoesNotShowIsNotAccepted() throws {
    let out = try crashAfterEdit { c, _ in c.args += ["--dangerously-load-development-channels", "server:other"] }
    #expect(out.audit.contains(" restart attempt=0 kind=cold"), "\(out.audit)")
    #expect(out.audit.components(separatedBy: " auto_confirm ").count - 1 == 1, "only the first start's: \(out.audit)")
    #expect(out.audit.contains("auto_confirm_refused kind=cold reason=channelsMismatch"), "\(out.audit)")
    #expect(out.needs == .confirmColdStart, "\(String(describing: out.needs))")
  }
}
