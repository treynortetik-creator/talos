import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop
import TalosTestSupport

// Create runs the installer ONCE; the scheduler (Chronos) is that run's business and the app only reads the marker it leaves
// (docs/SETUP.md, "When the scheduler could not be added"). The installer here is the scratch stub of AgentFolderGuiTests; the marker is
// put where the installer child's HOME / XDG_CONFIG_HOME say, which is also where the app looks. Runs only with TALOS_GUI_TESTS=1.

private func runs(_ w: World) -> Int {
  ((try? String(contentsOfFile: w.clone + "/runs.log", encoding: .utf8)) ?? "").split(separator: "\n").count
}

/// What kind of thing the marker is, so each way "present" can look is one case.
private enum Kind: CaseIterable { case file, empty, damaged, unreadable, folder, link, dangling }

private func plant(_ kind: Kind, at path: String) {
  let fm = FileManager.default
  try? fm.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  switch kind {
  case .file: fm.createFile(atPath: path, contents: Data(#"{"v":1,"reason":"launchctl","at":"2026-11-22T00:00:00Z"}"#.utf8))
  case .empty: fm.createFile(atPath: path, contents: Data())
  case .damaged: fm.createFile(atPath: path, contents: Data("{\"v\":".utf8))
  case .unreadable:
    fm.createFile(atPath: path, contents: Data("{}".utf8))
    chmod(path, 0o000)
  case .folder: try? fm.createDirectory(atPath: path, withIntermediateDirectories: true)
  case .link:
    fm.createFile(atPath: path + ".target", contents: Data("{}".utf8))
    try? fm.createSymbolicLink(atPath: path, withDestinationPath: path + ".target")
  case .dangling: try? fm.createSymbolicLink(atPath: path, withDestinationPath: path + ".nowhere")
  }
}

@MainActor
@Suite("Agent folder: one installer run, the scheduler line", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderSchedulerGuiTests {
  func marker(_ w: World) -> String { w.cfgHome + "/.config/talos/chronos-not-added.json" }

  @Test func createRunsTheInstallerExactlyOnceWhateverTheMarkerSays() async throws {
    for present in [false, true] {
      let w = try World()
      defer { w.cleanUp() }
      if present { plant(.file, at: marker(w)) }
      w.flow.path = w.agent("new")
      await w.flow.create()
      #expect(runs(w) == 1, "marker \(present): one run, not two")
      #expect(w.model.configured)
    }
  }

  @Test func noMarkerMeansAddedAndNothingIsSaid() async throws {
    let w = try World()
    defer { w.cleanUp() }
    w.flow.path = w.agent("new")
    await w.flow.create()
    #expect(w.flow.schedulerNote == nil)
    #expect(w.doneText?.contains("scheduler") == false)
  }

  @Test func anythingAtTheMarkerPathIsNotAddedAndTheFolderIsStillFine() async throws {
    for kind in Kind.allCases {
      let w = try World()
      defer { w.cleanUp() }
      plant(kind, at: marker(w))
      w.flow.path = w.agent("new")
      await w.flow.create()
      #expect(w.model.configured && w.disk != nil, "\(kind): the agent is set up")
      #expect(w.flow.schedulerNote == AgentFolderSetup.chronosLater, "\(kind)")
      #expect(w.doneText?.contains(AgentFolderSetup.chronosLater) == true, "\(kind): said once in the card")
      #expect(w.doneText?.components(separatedBy: "scheduler").count == 2, "\(kind): once, not twice")
      chmod(marker(w), 0o600)
    }
  }

  @Test func theAppNeverWritesOrRemovesTheMarkerAndNeverShowsItsCode() async throws {
    let w = try World()
    defer { w.cleanUp() }
    plant(.file, at: marker(w))
    let before = try FileManager.default.attributesOfItem(atPath: marker(w))
    let bytes = try Data(contentsOf: URL(fileURLWithPath: marker(w)))
    w.flow.path = w.agent("new")
    await w.flow.create()
    let after = try FileManager.default.attributesOfItem(atPath: marker(w))
    #expect(try Data(contentsOf: URL(fileURLWithPath: marker(w))) == bytes)
    #expect(before[.modificationDate] as? Date == after[.modificationDate] as? Date)
    #expect(before[.systemFileNumber] as? UInt64 == after[.systemFileNumber] as? UInt64)
    #expect(w.doneText?.contains("launchctl") == false, "the reason code is not shown")
  }

  @Test func aMarkerAnOlderRunLeftIsGoneAfterASuccessfulRunAndSaysNothing() async throws {
    let w = try World(mode: "cleared")  // the installer's own rule: a run that gets the scheduler in place removes the marker
    defer { w.cleanUp() }
    plant(.file, at: marker(w))
    w.flow.path = w.agent("new")
    await w.flow.create()
    #expect(w.model.configured)
    #expect(w.flow.schedulerNote == nil)
    #expect(w.doneText?.contains("scheduler") == false)
  }

  @Test func theMarkerIsLookedForWhereTheInstallerChildLooks() async throws {
    // XDG_CONFIG_HOME wins over HOME/.config, exactly as in the installer
    let xdg = TestTemp.base + "talos-onerun-" + UUID().uuidString
    defer { try? FileManager.default.removeItem(atPath: xdg) }
    let a = try World(xdg: xdg)
    defer { a.cleanUp() }
    plant(.file, at: a.cfgHome + "/.config/talos/chronos-not-added.json")  // under HOME, but XDG points elsewhere
    a.flow.path = a.agent("one")
    await a.flow.create()
    #expect(a.flow.schedulerNote == nil, "a marker under HOME is not the one when XDG_CONFIG_HOME is set")
    a.cleanUp()
    let b = try World(xdg: xdg)
    defer { b.cleanUp() }
    plant(.file, at: xdg + "/talos/chronos-not-added.json")
    b.flow.path = b.agent("two")
    await b.flow.create()
    #expect(b.flow.schedulerNote == AgentFolderSetup.chronosLater)
  }

  @Test func aNonzeroExitOnAFreshFolderIsAFailedAgentEvenWithAMarker() async throws {
    let w = try World(mode: "rerun")
    defer { w.cleanUp() }
    plant(.file, at: marker(w))
    w.flow.path = w.agent("fresh")  // not there before the run
    await w.flow.create()
    #expect(w.failedText != nil && !w.model.configured && w.disk == nil)
    #expect(w.flow.schedulerNote == nil)
  }

  /// A finished agent, as the folder an earlier Create left (stamped, its own CLAUDE.md, wired to Talos).
  func existing(_ w: World, mcp: Bool = true) -> String {
    let dir = w.agent("mine")
    write(dir + "/.talos-version", "2.0.0")
    write(dir + "/CLAUDE.md", "# the owner's own rules")
    if mcp { write(dir + "/.mcp.json", w.talosMcp) }
    return dir
  }

  @Test func aRerunOnAnExistingAgentWithTheSchedulerStillBrokenIsNotAFailedAgent() async throws {
    let w = try World(mode: "rerun")
    defer { w.cleanUp() }
    let dir = existing(w)
    plant(.file, at: marker(w))
    w.flow.path = dir
    w.flow.holdStart = true  // the setup screens' way in: ensureAgentFolder, the scheduler line goes to schedulerNote
    let ok = await w.flow.ensureAgentFolder()
    #expect(ok && w.model.configured, "the agent did not fail")
    #expect(w.failedText == nil)
    #expect(w.flow.schedulerNote == AgentFolderSetup.chronosLater)
    #expect(runs(w) == 1, "one installer run")
  }

  @Test func theCardsCarryTheSameLineForTheChecklistsCreate() async throws {
    let w = try World(mode: "rerun")
    defer { w.cleanUp() }
    plant(.file, at: marker(w))
    w.flow.path = existing(w)
    await w.flow.create()
    #expect(w.failedText == nil && w.model.configured)
    #expect(w.doneText?.contains(AgentFolderSetup.chronosLater) == true)
    #expect(w.doneText?.contains("exit 12") == false && w.doneText?.contains("scheduler step failed") == false)
  }

  @Test func aNonzeroExitOnAnExistingAgentIsStillAFailureWithoutAMarkerOrWiring() async throws {
    // no marker
    let a = try World(mode: "rerun")
    defer { a.cleanUp() }
    a.flow.path = existing(a)
    await a.flow.create()
    #expect(a.failedText != nil && !a.model.configured)
    a.cleanUp()
    // a half-made folder: no talos-app server in .mcp.json
    let b = try World(mode: "rerun")
    defer { b.cleanUp() }
    plant(.file, at: marker(b))
    b.flow.path = existing(b, mcp: false)
    await b.flow.create()
    #expect(b.failedText != nil && !b.model.configured)
    b.cleanUp()
    // the scheduler's own exit code, not the root installer's words
    let c = try World(mode: "rerun12")
    defer { c.cleanUp() }
    plant(.file, at: marker(c))
    c.flow.path = existing(c)
    await c.flow.create()
    #expect(c.failedText != nil && !c.model.configured)
  }

  @Test func theSourceHasNoSecondRunAndNoMarkerWrites() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    for f in ["Sources/TalosDesktop/AgentFolderFlow.swift", "Sources/TalosDesktop/OnboardingLive.swift", "Sources/TalosDesktopCore/AgentFolderSetup.swift"] {
      let text = try String(contentsOf: root.appendingPathComponent(f), encoding: .utf8)
      for word in ["ensureChronos", "chronosArguments", "--with-chronos", "--no-load"] { #expect(!text.contains(word), "\(f): \(word)") }
    }
    let flow = try String(contentsOf: root.appendingPathComponent("Sources/TalosDesktop/AgentFolderFlow.swift"), encoding: .utf8)
    #expect(flow.components(separatedBy: "installArguments(").count == 2, "one place runs the agent installer")
  }
}
