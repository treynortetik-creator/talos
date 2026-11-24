import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

// What the app reads of the installer's "scheduler not added" marker (docs/SETUP.md, "When the scheduler could not be added"):
// where it is, whether anything is there (lstat, never parsed), and what one installer run's exit means for the folder.
@Suite("Scheduler marker: read, never written")
struct SchedulerMarkerTests {
  final class Dir {
    let root = TestTemp.base + "talos-onerun-" + UUID().uuidString
    init() { try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true) }
    deinit {
      chmod(root, 0o700)
      try? FileManager.default.removeItem(atPath: root)
    }
    func put(_ name: String, _ text: String = "") -> String {
      let p = root + "/" + name
      try? FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: p, contents: Data(text.utf8))
      return p
    }
  }

  @Test func theMarkerPathFollowsTheInstallersOwnRule() {
    let f = AgentFolderSetup.chronosMarkerPath
    #expect(f(["XDG_CONFIG_HOME": "/home/alex/cfg", "HOME": "/home/alex"], "/home/example") == "/home/alex/cfg/talos/chronos-not-added.json")
    #expect(f(["XDG_CONFIG_HOME": "", "HOME": "/home/alex"], "/home/example") == "/home/alex/.config/talos/chronos-not-added.json")
    #expect(f(["HOME": "/home/alex"], "/home/example") == "/home/alex/.config/talos/chronos-not-added.json")
    #expect(f([:], "/home/example") == "/home/example/.config/talos/chronos-not-added.json")
    #expect(f(["HOME": ""], "/home/example") == "/home/example/.config/talos/chronos-not-added.json")
  }

  @Test func anythingAtThePathIsPresentWithoutReadingIt() {
    let d = Dir()
    let present = AgentFolderSetup.chronosMarkerPresent
    #expect(present(d.put("file.json", #"{"v":1,"reason":"launchctl"}"#)))
    #expect(present(d.put("empty.json")))
    #expect(present(d.put("damaged.json", "{\"v\":")))
    let locked = d.put("locked.json", "{}")
    chmod(locked, 0o000)
    #expect(present(locked), "a file nobody can read")
    try? FileManager.default.createDirectory(atPath: d.root + "/folder.json", withIntermediateDirectories: true)
    #expect(present(d.root + "/folder.json"))
    try? FileManager.default.createSymbolicLink(atPath: d.root + "/link.json", withDestinationPath: d.root + "/file.json")
    #expect(present(d.root + "/link.json"))
    try? FileManager.default.createSymbolicLink(atPath: d.root + "/dangling.json", withDestinationPath: d.root + "/nowhere")
    #expect(present(d.root + "/dangling.json"), "a link that leads nowhere is still something at the path")
    chmod(locked, 0o600)
  }

  @Test func nothingThereIsAbsent() {
    let d = Dir()
    #expect(!AgentFolderSetup.chronosMarkerPresent(at: d.root + "/talos/chronos-not-added.json"))
    let f = d.put("plain-file")
    #expect(!AgentFolderSetup.chronosMarkerPresent(at: f + "/under-a-file"), "ENOTDIR")
  }

  @Test func aFolderThatCannotBeSearchedIsNotKnownToBeAbsent() {
    let d = Dir()
    _ = d.put("talos/chronos-not-added.json", "{}")
    chmod(d.root + "/talos", 0o000)
    defer { chmod(d.root + "/talos", 0o700) }
    if geteuid() != 0 { #expect(AgentFolderSetup.chronosMarkerPresent(at: d.root + "/talos/chronos-not-added.json")) }
  }

  /// The words the root installer says when the kit's add-only rerun fails.
  static let kitLine = AgentFolderSetup.kitAddFailedPhrase + " (its output is above)."

  func result(_ status: Int32?, _ err: String, existed: Bool, marker: Bool, connected: Bool = true) -> AgentFolderSetup.InstallResult {
    AgentFolderSetup.installResult(status: status, stderr: err, agentExisted: existed, markerPresent: marker, connected: connected)
  }

  @Test func oneRunsExitMeansWhatTheSpecSays() {
    // exit 0: fine, and the marker alone decides the scheduler line
    #expect(result(0, "", existed: false, marker: false) == .init(outcome: .done, schedulerLater: false))
    #expect(result(0, "", existed: false, marker: true) == .init(outcome: .done, schedulerLater: true))
    #expect(result(0, "", existed: true, marker: true) == .init(outcome: .done, schedulerLater: true))
    // nonzero on a fresh folder is the folder failing, marker or not, whatever it says
    #expect(result(1, "boom", existed: false, marker: false).outcome == .failed("boom"))
    #expect(result(1, Self.kitLine, existed: false, marker: true).schedulerLater == false)
    #expect(result(1, Self.kitLine, existed: false, marker: true).outcome != .done)
    // no exit status at all (the installer could not run) is never OK
    #expect(result(nil, Self.kitLine, existed: true, marker: true).outcome == .failed("Talos couldn't run the installer."))
  }

  @Test func aRerunWithTheSchedulerStillBrokenIsOnlyTheSchedulerLine() {
    #expect(result(1, "x\n" + Self.kitLine + "\n", existed: true, marker: true) == .init(outcome: .done, schedulerLater: true))
  }

  @Test func everyOtherNonzeroExitOnAnExistingAgentStaysAFailure() {
    let cases: [(String, Int32?, String, Bool, Bool, Bool)] = [
      // (name, status, stderr, existed, marker, connected)
      ("a talos-app server of another clone", 3, "talos-app: this folder's server runs another clone", true, true, true),
      ("exit 3 (a missing prerequisite)", 3, Self.kitLine, true, true, true),
      ("the packages failed (js_install)", 1, "FAILED at \"3/7 js_install\": bun install failed", true, true, true),
      ("exit 127 (a command not found)", 127, Self.kitLine, true, true, true),
      ("status 1 without the installer's words", 1, "something else stopped", true, true, true),
      ("the scheduler's own exit code", 12, Self.kitLine, true, true, true),
      ("no marker", 1, Self.kitLine, true, false, true),
      ("not a finished agent", 1, Self.kitLine, false, true, true),
      ("not connected to Talos (a half-made folder)", 1, Self.kitLine, true, true, false),
    ]
    for (name, status, err, existed, marker, connected) in cases {
      let r = result(status, err, existed: existed, marker: marker, connected: connected)
      #expect(r.schedulerLater == false, Comment(rawValue: name))
      guard case .failed = r.outcome else {
        Issue.record(Comment(rawValue: "\(name): not a failure"))
        continue
      }
    }
  }

  @Test func theInstallerPhraseIsStillWhatTheRootInstallerSays() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let text = try String(contentsOf: root.appendingPathComponent("install.sh"), encoding: .utf8)
    #expect(text.contains("fail 1 \"" + AgentFolderSetup.kitAddFailedPhrase + " (its output is above)"))
  }

  @Test func aFolderCountsAsAnExistingAgentOnlyWhenItIsFinished() {
    let d = Dir()
    let repo = d.root + "/repo"
    _ = d.put("repo/kit/CLAUDE.md", "# placeholder")
    func agent(_ name: String, version: Bool, claude: String?) -> String {
      let dir = d.root + "/" + name
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
      if version { _ = d.put(name + "/.talos-version", "2.0.0") }
      if let claude { _ = d.put(name + "/CLAUDE.md", claude) }
      return dir
    }
    #expect(AgentFolderSetup.agentExisted(dir: agent("done", version: true, claude: "# mine"), repo: repo))
    #expect(!AgentFolderSetup.agentExisted(dir: agent("fresh", version: false, claude: nil), repo: repo))
    #expect(!AgentFolderSetup.agentExisted(dir: agent("unfinished", version: true, claude: "# placeholder"), repo: repo), "CLAUDE.md is still the kit's")
    #expect(!AgentFolderSetup.agentExisted(dir: agent("nostamp", version: false, claude: "# mine"), repo: repo))
    #expect(!AgentFolderSetup.agentExisted(dir: d.root + "/absent", repo: repo))
    let linked = agent("linked", version: false, claude: "# mine")
    try? FileManager.default.createSymbolicLink(atPath: linked + "/.talos-version", withDestinationPath: d.root + "/done/.talos-version")
    #expect(!AgentFolderSetup.agentExisted(dir: linked, repo: repo), "a link is not a stamp")
  }

  @Test func theOwnersLineIsPlainWordsWithNoReasonCode() {
    let line = AgentFolderSetup.chronosLater
    for jargon in ["unfinished", "launchctl", "not-loaded", "plist", "python", "reason", "json", "marker", "exit "] {
      #expect(!line.lowercased().contains(jargon), Comment(rawValue: jargon))
    }
    #expect(line.contains("scheduler"))
  }
}
