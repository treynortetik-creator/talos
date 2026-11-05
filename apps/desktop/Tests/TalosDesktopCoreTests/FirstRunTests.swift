import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("FirstRun checklist")
struct FirstRunTests {
  let home = "/home/alex"
  func rows(_ i: FirstRun.Inputs) -> [String: FirstRun.State] { Dictionary(uniqueKeysWithValues: FirstRun.rows(i).map { ($0.id, $0.state) }) }

  @Test func everythingPresentIsGreen() {
    let r = FirstRun.rows(
      .init(
        claudeVersion: "2.1.312", authSignedIn: true, bunPath: "/x/bun", tmuxVersionOutput: "tmux 3.8", bridgeEnvPresent: true,
        agentDir: "~/talos-agent", agentDirTrusted: true, home: home))
    #expect(r.allSatisfy { $0.isOK }, "\(r)")
    #expect(r.map(\.id) == ["claude", "auth", "bun", "tmux", "bridge", "trust"])
  }

  @Test func noClaudeNoBunNoTmuxEachGetsAOneLineFix() {
    let r = rows(.init(home: home))
    for k in ["claude", "bun", "tmux", "bridge"] {
      guard case .fix(let msg) = r[k] else { Issue.record("\(k) should be a fix"); continue }
      #expect(!msg.contains("\n"))
    }
    guard case .fix(let tmux) = r["tmux"] else { return }
    #expect(tmux.contains("stop when Talos quits"), "the fallback warning")
  }

  @Test func tmuxOlderThanThreeTwoIsTheFallbackToo() {
    guard case .fix = rows(.init(tmuxVersionOutput: "tmux 3.1", home: home))["tmux"] else { Issue.record("3.1 is too old"); return }
    #expect(rows(.init(tmuxVersionOutput: "tmux 3.2", home: home))["tmux"] == .ok)
    #expect(rows(.init(tmuxVersionOutput: "tmux 3.5a", home: home))["tmux"] == .ok)
  }

  @Test func foundButUnreadableVersionAndOldTmuxAreNotReportedMissing() throws {
    guard case .unknown(let m)? = rows(.init(claudeVersion: "", home: home))["claude"] else { Issue.record("claude should be unknown"); return }
    #expect(!m.contains("Not found"))
    guard case .fix(let t)? = rows(.init(tmuxVersionOutput: "tmux 3.1c", home: home))["tmux"] else { Issue.record("old tmux is a fix"); return }
    #expect(!t.contains("Not found") && t.contains("older than 3.2") && t.contains("tmux 3.1c"))
  }

  @Test func unknownIsNotAFailure() {
    let r = rows(.init(authSignedIn: nil, agentDirTrusted: nil, home: home))
    guard case .unknown = r["auth"], case .unknown = r["trust"] else { Issue.record("expected unknown"); return }
  }

  @Test func aFolderUnderDesktopDocumentsOrDownloadsWarns() {
    for d in ["~/Desktop/agent", "/home/alex/Documents", "~/Downloads/x/y"] {
      #expect(rows(.init(agentDir: d, home: home))["folder"] != nil, "\(d)")
    }
    for d in ["~/talos-agent", "~/DesktopStuff", "~/Documents2/x", "/opt/agent"] {
      #expect(rows(.init(agentDir: d, home: home))["folder"] == nil, "\(d)")
    }
  }
}

@Suite("LoginItemPlan")
struct LoginItemPlanTests {
  @Test func outcomesFollowTheServiceStatus() {
    #expect(LoginItemPlan.outcome(afterRegister: .enabled) == .registered)
    #expect(LoginItemPlan.outcome(afterRegister: .requiresApproval) == .needsApproval(LoginItemPlan.approvalMessage))
    #expect(LoginItemPlan.outcome(afterRegister: .notFound) == .fellBackToLaunchAgent)
    #expect(LoginItemPlan.outcome(afterRegister: .notRegistered) == nil)
    #expect(LoginItemPlan.approvalMessage.contains("Login Items"))
  }

  @Test func theLaunchAgentRunsAtLoadAndNeverKeepsAlive() throws {
    let data = try #require(LoginItemPlan.launchAgentPlist(bundleId: "app.talos.desktop", executable: "/home/alex/Applications/Talos.app/Contents/MacOS/Talos"))
    let o = try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    #expect(o["RunAtLoad"] as? Bool == true)
    #expect(o["KeepAlive"] == nil)
    #expect(o["Label"] as? String == "app.talos.desktop")
    #expect((o["ProgramArguments"] as? [String])?.count == 1)
  }

  @Test func theLaunchAgentLivesInTheUsersLibrary() {
    #expect(LoginItemPlan.launchAgentPath(home: "/home/alex", bundleId: "app.talos.desktop") == "/home/alex/Library/LaunchAgents/app.talos.desktop.plist")
  }
}

final class StubService: LoginItemService {
  var status: LoginItemPlan.Service
  var afterRegister: LoginItemPlan.Service
  var throwOnRegister = false
  var registers = 0
  var unregisters = 0
  init(status: LoginItemPlan.Service = .notRegistered, afterRegister: LoginItemPlan.Service) {
    self.status = status
    self.afterRegister = afterRegister
  }
  func register() throws {
    registers += 1
    if throwOnRegister { throw NSError(domain: "stub", code: 1) }
    status = afterRegister
  }
  func unregister() throws {
    unregisters += 1
    status = .notRegistered
  }
}

final class StubFiles: LaunchAgentFiles {
  var files: [String: Data] = [:]
  func exists(_ path: String) -> Bool { files[path] != nil }
  func write(_ data: Data, to path: String) throws { files[path] = data }
  func remove(_ path: String) throws { files[path] = nil }
}

@Suite("LoginItemManager")
struct LoginItemManagerTests {
  func make(_ svc: StubService, _ files: StubFiles) -> LoginItemManager {
    LoginItemManager(service: svc, files: files, home: "/home/alex", bundleId: "app.talos.desktop", executable: "/home/alex/Applications/Talos.app/Contents/MacOS/Talos")
  }
  let path = "/home/alex/Library/LaunchAgents/app.talos.desktop.plist"

  @Test func aServiceThatRegistersWritesNoFile() {
    let s = StubService(afterRegister: .enabled), f = StubFiles()
    let m = make(s, f)
    #expect(m.turnOn() == .registered)
    #expect(f.files.isEmpty && m.isOn)
  }

  @Test func notFoundFallsBackToALaunchAgentWithRunAtLoadAndNoKeepAlive() throws {
    let s = StubService(afterRegister: .notFound), f = StubFiles()
    let m = make(s, f)
    #expect(m.turnOn() == .fellBackToLaunchAgent)
    let data = try #require(f.files[path])
    let obj = try PropertyListSerialization.propertyList(from: data, format: nil)
    let o = try #require(obj as? [String: Any])
    #expect(o["RunAtLoad"] as? Bool == true && o["KeepAlive"] == nil)
    #expect(m.isOn)
  }

  @Test func aThrowingRegisterFallsBackToo() {
    let s = StubService(afterRegister: .enabled), f = StubFiles()
    s.throwOnRegister = true
    #expect(make(s, f).turnOn() == .fellBackToLaunchAgent)
    #expect(f.exists(path))
  }

  @Test func requiresApprovalSaysWhereToApprove() {
    let s = StubService(afterRegister: .requiresApproval), f = StubFiles()
    #expect(make(s, f).turnOn() == .needsApproval(LoginItemPlan.approvalMessage))
    #expect(f.files.isEmpty)
  }

  @Test func turningOffRemovesWhicheverWasUsed() {
    let s1 = StubService(afterRegister: .enabled), f1 = StubFiles()
    let m1 = make(s1, f1)
    _ = m1.turnOn()
    #expect(m1.turnOff() == nil)
    #expect(s1.unregisters == 1 && !m1.isOn)

    let s2 = StubService(afterRegister: .notFound), f2 = StubFiles()
    let m2 = make(s2, f2)
    _ = m2.turnOn()
    #expect(m2.turnOff() == nil)
    #expect(f2.files.isEmpty && !m2.isOn)
  }

  @Test func turningOffWhenNothingWasOnDoesNothing() {
    let s = StubService(afterRegister: .enabled), f = StubFiles()
    #expect(make(s, f).turnOff() == nil)
    #expect(s.unregisters == 0)
  }
}
