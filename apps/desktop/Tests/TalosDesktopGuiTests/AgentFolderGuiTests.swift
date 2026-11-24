import AppKit
import CryptoKit
import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

@testable import TalosDesktop
import TalosTestSupport

// The checklist's Agent folder row, end to end with the real controller on a scratch HOME, real temp folders, and the real bridge
// CLI through the real pty for Adopt. Create runs a stub install.sh in a scratch clone (the real one is pinned by
// scripts/root-install.test.ts). Nothing starts a real claude: `beginSession` is a spy. Runs only with TALOS_GUI_TESTS=1.

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func bump() { lock.withLock { n += 1 } }
  var count: Int { lock.withLock { n } }
}

private func sha(_ url: URL) -> String { SHA256.hash(data: (try? Data(contentsOf: url)) ?? Data()).map { String(format: "%02x", $0) }.joined() }

/// Every file under `dir` with its hash, so "nothing else changed" is a comparison.
private func tree(_ dir: String) -> [String: String] {
  var out: [String: String] = [:]
  let base = URL(fileURLWithPath: dir).resolvingSymlinksInPath()
  guard let e = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isRegularFileKey]) else { return out }
  for case let u as URL in e where (try? u.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
    out[String(u.resolvingSymlinksInPath().path.dropFirst(base.path.count))] = sha(u)
  }
  return out
}

func write(_ path: String, _ text: String) {
  try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  FileManager.default.createFile(atPath: path, contents: Data(text.utf8))
}

/// The scratch clone Create runs. Its install.sh does what the real one's refusals and success do, chosen by STUB_MODE; the words
/// are the real ones (scripts/root-install.test.ts and kit/install.sh).
private let stubInstall = """
  #!/bin/bash
  echo "$@" > "$(dirname "$0")/args.log"
  echo "run" >> "$(dirname "$0")/runs.log"
  dir=""; while [ $# -gt 0 ]; do [ "$1" = --agent-dir ] && dir="$2"; shift; done
  marker="${XDG_CONFIG_HOME:-$HOME/.config}/talos/chronos-not-added.json"
  case "${STUB_MODE:-ok}" in
    cleared) rm -f "$marker"; mkdir -p "$dir/memory"; echo "2.0.0" > "$dir/.talos-version"; echo "# default" > "$dir/CLAUDE.md"
        echo '{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","/x","--silent","start"]}}}' > "$dir/.mcp.json"; exit 0 ;;
    rerun) echo "The scheduler step failed (the scheduler's installer stopped; exit 12). Its output is above. Nothing else was changed in the agent folder." >&2
           printf '\\nFAILED at "4/7 The agent (kit, default CLAUDE.md, first commit)": kit/install.sh --add-to-existing failed (its output is above). It does not copy or overwrite anything in the agent folder; fix the problem and run ./install.sh again with the same flags.\\n' >&2; exit 1 ;;
    rerun12) echo "The scheduler step failed (exit 12)." >&2; exit 12 ;;
    ok) mkdir -p "$dir/memory"; echo "2.0.0" > "$dir/.talos-version"; echo "# default" > "$dir/CLAUDE.md"
        echo '{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","/x","--silent","start"]}}}' > "$dir/.mcp.json"; exit 0 ;;
    notempty) echo "FAILED at \\"2/7 Agent folder\\": $dir exists, is not empty and is not a Talos agent. Nothing was touched." >&2; exit 1 ;;
    synced) echo "refusing: $dir looks like cloud-synced storage. Two processes editing memory/ mid-sync corrupts it." >&2
            echo "FAILED at \\"4/7\\": the kit installer failed before copying anything (its output is above)." >&2; exit 1 ;;
    prereq) printf 'Cannot continue. Missing:\\n  - bun: install Bun 1.4.4 or newer: https://example.com/bun\\nInstall what is listed, then run ./install.sh again. Nothing was changed.\\n' >&2; exit 3 ;;
    partway) mkdir -p "$dir"; echo half > "$dir/CLAUDE.md"
             echo "FAILED at \\"4/7\\": The kit copy stopped part-way. $dir now holds a partial copy. Move it aside (for example: mv $dir $dir.partial) and run ./install.sh again." >&2; exit 1 ;;
  esac
  """

@MainActor
final class World {
  let model: SupervisorController
  let flow: AgentFolderFlow
  fileprivate let started = Counter()
  let home: String
  let appHome: String
  let clone: String

  /// `realClone`: Adopt runs the real bridge CLI from this repo; otherwise a scratch clone with the stub installer.
  /// What the installer child's HOME is (a scratch folder, so no marker of the real Mac is ever looked at) and XDG_CONFIG_HOME (none
  /// unless `xdg` says); the app reads the marker from the same environment.
  let cfgHome: String

  init(store: SettingsStore = MemoryStore(), realClone: Bool = false, mode: String = "ok", xdg: String? = nil) throws {
    cannotTakeTheKeyboard()
    home = TmuxWorld.root
    TmuxWorld.hookBundle()
    try #require(SupervisorController.configPath.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    appHome = TestTemp.base + "k7-apphome-" + UUID().uuidString
    cfgHome = TestTemp.base + "talos-onerun-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: cfgHome, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: appHome, withIntermediateDirectories: true)
    if realClone {
      clone = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().path
    } else {
      clone = TestTemp.base + "k7-clone-" + UUID().uuidString
      write(clone + "/install.sh", stubInstall)
      write(clone + "/apps/bridge/src/cli.ts", "")
      write(clone + "/plugins/talos-app-mod/plugin.json", "{}")
    }
    try FileManager.default.createDirectory(atPath: home + "/agents", withIntermediateDirectories: true)
    model = SupervisorController(store: store)
    let started = self.started
    model.beginSession = { _ in started.bump(); return true }
    let (clone, appHome, modeBox, cfg, real) = (self.clone, self.appHome, mode, cfgHome, realClone)
    flow = AgentFolderFlow(
      model: model,
      deps: .init(
        repoRoot: { clone },
        environment: {
          var e = ProcessInfo.processInfo.environment
          e["TALOS_APP_HOME"] = appHome
          e["STUB_MODE"] = modeBox
          if !real {  // the real bridge CLI (Adopt) keeps the machine's own HOME
            e["HOME"] = cfg
            e["XDG_CONFIG_HOME"] = xdg
          }
          return e
        }))
    flow.signedIn = true
  }

  func cleanUp() {
    let dir = (SupervisorController.configPath as NSString).deletingLastPathComponent
    chmod(dir, 0o700)
    try? FileManager.default.removeItem(atPath: SupervisorController.configPath)
    try? FileManager.default.removeItem(atPath: appHome)
    chmod(cfgHome + "/.config/talos", 0o700)
    try? FileManager.default.removeItem(atPath: cfgHome)
    if clone.hasPrefix(TestTemp.base) { try? FileManager.default.removeItem(atPath: clone) }
    try? FileManager.default.removeItem(atPath: home + "/agents")
  }

  func agent(_ name: String) -> String { home + "/agents/" + name }
  /// A `.mcp.json` whose talos-app server is this clone's bridge on this app home: what Create and Adopt write.
  var talosMcp: String {
    #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","\#(clone)/apps/bridge","--silent","start"],"env":{"TALOS_APP_HOME":"\#(appHome)"}}}}"#
  }
  var disk: DesktopConfig? { (try? ConfigFile.load(SupervisorController.configPath)) ?? nil }
  var failedText: String? { if case .failed(let t) = flow.step { return t } else { return nil } }
  var doneText: String? { if case .done(let t) = flow.step { return t } else { return nil } }
}

@MainActor
@Suite("Agent folder: Create", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderCreateGuiTests {
  @Test func createRunsTheInstallerThenWritesDesktopJsonThenStarts() async throws {
    let w = try World()
    defer { w.cleanUp() }
    w.flow.path = w.agent("new")
    await w.flow.create()
    let args = try String(contentsOfFile: w.clone + "/args.log", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(args == "--agent-dir \(w.agent("new")) --no-app --yes")
    #expect(w.model.configured)
    let d = try #require(w.disk)
    #expect(d.agentDir == "~" + String(w.agent("new").dropFirst(w.home.count)))
    #expect(d.args == AgentFolderSetup.launchArgs(repo: w.clone))
    #expect(d.env["TALOS_APP_BRIDGE"] == "1", "the bridge variables are in a new setup")
    #expect(w.started.count == 1)
    #expect(w.doneText?.contains("starting") == true)
  }

  @Test func eachRefusalSaysWhyAndLeavesNothingBehindAndStartsNothing() async throws {
    for (mode, words) in [
      ("notempty", "is not empty and is not a Talos agent"), ("synced", "cloud-synced storage"),
      ("prereq", "bun: install Bun"), ("partway", "stopped part-way"),
    ] {
      let w = try World(mode: mode)
      defer { w.cleanUp() }
      let dir = w.agent("mine")
      write(dir + "/notes.txt", "the owner's own file")
      let before = tree(dir)
      w.flow.path = dir
      await w.flow.create()
      let why = try #require(w.failedText, "\(mode): a failure card")
      #expect(why.contains(words), "\(mode): \(why)")
      #expect(!why.contains("run ./install.sh again"), "\(mode): says this app's button")
      #expect(!w.model.configured && w.disk == nil, "\(mode): desktop.json is not written")
      #expect(w.started.count == 0, "\(mode): nothing started")
      if mode != "partway" { #expect(tree(dir) == before, "\(mode): the folder is as it was") }
      else { #expect(tree(dir)["/notes.txt"] == before["/notes.txt"], "a partial copy is never cleaned up for the owner") }
    }
  }

  @Test func theFlowNeverDeletesAnything() throws {
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop/AgentFolderFlow.swift")
    let text = try String(contentsOf: src, encoding: .utf8)
    for word in ["removeItem", "trashItem", "\"rm\"", "/bin/rm", "unlink("] { #expect(!text.contains(word), "\(word)") }
  }

  @Test func aFolderUnderDocumentsIsCreatedAndTheOwnerIsToldAboutMacOS() async throws {
    let w = try World()
    defer { w.cleanUp() }
    w.flow.path = w.home + "/Documents/talos-agent"
    await w.flow.create()
    #expect(w.model.configured)
    #expect(w.doneText?.contains("Documents") == true && w.doneText?.contains("macOS asks Talos once") == true)
    try? FileManager.default.removeItem(atPath: w.home + "/Documents")
  }

  @Test func aMissingCloneIsSaidPlainlyAndNothingIsChanged() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let gone = AgentFolderFlow(model: w.model, deps: .init(repoRoot: { w.clone + "/gone" }, environment: { [:] }))
    gone.path = w.agent("x")
    await gone.create()
    guard case .failed(let why) = gone.step else { Issue.record("a failure"); return }
    #expect(why.contains("built from"))
    #expect(!w.model.configured && w.started.count == 0)
    gone.path = ""
    await gone.create()
    guard case .failed(let empty) = gone.step else { Issue.record("a failure"); return }
    #expect(empty.contains("full path"))
  }

  @Test func claudeNotSignedInSetsUpButStartsNothingAndSaysWhatToDo() async throws {
    let w = try World()
    defer { w.cleanUp() }
    w.flow.signedIn = false
    w.flow.path = w.agent("new")
    await w.flow.create()
    #expect(w.model.configured && w.disk != nil, "the setup is made")
    #expect(w.started.count == 0)
    #expect(w.doneText?.contains("/login") == true && w.doneText?.contains("Start your agent") == true)
  }

  @Test func theAppQuittingMidStepLeavesARelaunchWithNothingToUndo() async throws {
    let store = MemoryStore()
    let w = try World(store: store, mode: "partway")
    defer { w.cleanUp() }
    w.flow.path = w.agent("half")
    await w.flow.create()
    let half = tree(w.agent("half"))
    // the relaunch: a new controller over the same scratch HOME and store
    let again = SupervisorController(store: store)
    #expect(!again.configured, "no desktop.json, so the checklist starts over at the Agent folder row")
    #expect(FirstRun.rows(.init(home: w.home, setupDone: again.configured)).first?.id == "agentfolder")
    #expect(tree(w.agent("half")) == half, "the partial copy is untouched, for the owner to move aside")
    // the owner moves it aside; Create runs again and finishes
    try FileManager.default.moveItem(atPath: w.agent("half"), toPath: w.agent("half") + ".partial")
    let ok = AgentFolderFlow(
      model: again,
      deps: .init(repoRoot: { w.clone }, environment: { ["STUB_MODE": "ok", "PATH": "/usr/bin:/bin"] }))
    again.beginSession = { _ in w.started.bump(); return true }
    ok.path = w.agent("half")
    await ok.create()
    #expect(again.configured && w.started.count == 1)
  }
}

@MainActor
@Suite("Agent folder: Adopt", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderAdoptGuiTests {
  /// A Claude Code folder the owner uses, with files in every Yours place.
  private func ownerFolder(_ w: World, _ name: String = "mine", extra: [String: String] = [:]) -> String {
    let d = w.agent(name)
    var files = [
      "CLAUDE.md": "# Mine\n", "memory/STATE.md": "state\n", "wiki/me.md": "me\n", ".claude/skills/mine/SKILL.md": "skill\n",
    ]
    files.merge(extra) { _, new in new }
    for (f, t) in files { write(d + "/" + f, t) }
    return d
  }

  @Test func adoptShowsACardThenConnectsThroughThePtyAndTouchesOnlyMcpJson() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w)
    let before = tree(dir)
    w.flow.path = dir
    await w.flow.adopt()
    guard case .confirmAdopt(let shown, let plan, _) = w.flow.step else { Issue.record("a card, got \(w.flow.step)"); return }
    #expect(shown == dir && plan.contains(".mcp.json"), "\(plan)")
    #expect(tree(dir) == before && !w.model.configured, "the card changes nothing: the owner can say no")
    await w.flow.confirm()
    #expect(w.model.configured && w.started.count == 1)
    let after = tree(dir)
    #expect(Set(after.keys).symmetricDifference(before.keys) == ["/.mcp.json"], "only .mcp.json is new")
    for (f, h) in before { #expect(after[f] == h, "\(f) is byte-identical") }
    #expect(w.disk?.args == AgentFolderSetup.launchArgs(repo: w.clone))
  }

  @Test func sayingNoWritesNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w)
    let before = tree(dir)
    w.flow.path = dir
    await w.flow.adopt()
    w.flow.cancel()
    #expect(w.flow.step == .idle && tree(dir) == before && !w.model.configured && w.started.count == 0)
  }

  @Test func otherServersAreKept() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w, extra: [".mcp.json": #"{"mcpServers":{"other":{"command":"npx","args":["x"]}}}"#])
    w.flow.path = dir
    await w.flow.adopt()
    await w.flow.confirm()
    let cfg = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: dir + "/.mcp.json"))) as? [String: Any])
    let servers = try #require(cfg["mcpServers"] as? [String: Any])
    #expect(servers["other"] != nil && servers["talos-app"] != nil)
  }

  @Test func invalidJsonIsRefusedAndChangesNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w, extra: [".mcp.json": "{ \"mcpServers\": "])
    let before = tree(dir)
    w.flow.path = dir
    await w.flow.adopt()
    #expect(w.failedText?.contains("not valid JSON") == true, "\(w.flow.step)")
    #expect(tree(dir) == before && !w.model.configured && w.started.count == 0)
  }

  @Test func aTalosAppEntryForAnotherCloneIsRefusedUntilTheOwnerConfirms() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let foreign = #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","/home/alex/other/apps/bridge","--silent","start"]}}}"#
    let dir = ownerFolder(w, extra: [".mcp.json": foreign])
    let before = tree(dir)
    w.flow.path = dir
    await w.flow.adopt()
    guard case .confirmRepoint(_, let why) = w.flow.step else { Issue.record("a confirm card, got \(w.flow.step)"); return }
    #expect(why.contains("/home/alex/other/apps/bridge"))
    #expect(tree(dir) == before && !w.model.configured, "nothing moves until the owner says so")
    w.flow.cancel()
    #expect(tree(dir) == before)
    await w.flow.adopt()
    await w.flow.confirm()
    #expect(w.model.configured)
    let text = try String(contentsOfFile: dir + "/.mcp.json", encoding: .utf8)
    #expect(text.contains(w.clone) && !text.contains("/home/alex/other"))
  }

  @Test func aKit1xFolderGetsTheUpdateCardWhichRunsOnlyOnYes() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w, extra: [".talos-version": "1.1.0\n"])
    w.flow.path = dir
    await w.flow.adopt()
    await w.flow.confirm()
    guard case .offerUpgrade(_, let version, let command, _) = w.flow.step else { Issue.record("an update card, got \(w.flow.step)"); return }
    #expect(version == "1.1.0" && command.contains("upgrade.sh") && command.contains("--dry-run") && command.contains(dir))
    let afterAdopt = tree(dir)
    w.flow.declineUpgrade()
    #expect(w.doneText != nil && tree(dir) == afterAdopt, "not now runs nothing")
    // yes: the preview runs, and it writes nothing
    await w.flow.adopt()
    await w.flow.confirm()
    await w.flow.showUpgrade()
    guard case .upgradePreview(let text, _, _) = w.flow.step else { Issue.record("a preview, got \(w.flow.step)"); return }
    #expect(text.contains("DRY RUN") && !text.contains("\u{1B}["))
    #expect(tree(dir) == afterAdopt, "the preview changes nothing")
  }

  @Test func aFolderThatIsNotAKit1xGetsNoUpdateCard() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w)
    w.flow.path = dir
    await w.flow.adopt()
    await w.flow.confirm()
    #expect(w.doneText != nil)
  }

  @Test func aGoneFolderIsRefusedBeforeAnythingRuns() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    w.flow.path = w.agent("gone")
    await w.flow.adopt()
    #expect(w.failedText?.contains("No folder at") == true)
  }

  @Test func claudeNotSignedInStillConnectsButStartsNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    w.flow.signedIn = false
    let dir = ownerFolder(w)
    w.flow.path = dir
    await w.flow.adopt()
    await w.flow.confirm()
    #expect(w.model.configured && w.started.count == 0 && w.doneText?.contains("/login") == true)
  }

  @Test func theAppQuittingAfterTheFolderIsConnectedButBeforeDesktopJsonFinishesOnRelaunch() async throws {
    let store = MemoryStore()
    let w = try World(store: store, realClone: true)
    defer { w.cleanUp() }
    let dir = ownerFolder(w)
    w.flow.path = dir
    await w.flow.adopt()
    // the quit lands here: the real run happens, desktop.json is never written
    let r = TalosAppCLIProbe.adoptNow(clone: w.clone, dir: dir, appHome: w.appHome)
    #expect(r == 0)
    let connected = tree(dir)
    let again = SupervisorController(store: store)
    #expect(!again.configured, "desktop.json is the last step, so a relaunch is back at the Agent folder row")
    again.beginSession = { _ in w.started.bump(); return true }
    let f = AgentFolderFlow(
      model: again,
      deps: .init(repoRoot: { w.clone }, environment: { var e = ProcessInfo.processInfo.environment; e["TALOS_APP_HOME"] = w.appHome; return e }))
    f.path = dir
    await f.adopt()
    guard case .confirmAdopt(_, let plan, _) = f.step else { Issue.record("a card, got \(f.step)"); return }
    #expect(plan.contains("already up to date"))
    await f.confirm()
    #expect(again.configured && w.started.count == 1 && tree(dir) == connected, "finishing changes no file")
  }
}

/// Runs `adopt` the way the flow does, for the test that simulates a quit between the folder step and desktop.json.
@MainActor
private enum TalosAppCLIProbe {
  static func adoptNow(clone: String, dir: String, appHome: String) -> Int32? {
    var e = ProcessInfo.processInfo.environment
    e["TALOS_APP_HOME"] = appHome
    guard let bun = TalosAppLocatorForTests.bun(e) else { return nil }
    return TalosAppCLI.run(.init(command: [bun, "--no-env-file", "run", clone + "/apps/bridge/src/cli.ts"], env: e), ["adopt", "--agent-dir", dir, "--yes"])?.status
  }
}

private enum TalosAppLocatorForTests {
  static func bun(_ e: [String: String]) -> String? {
    TalosAppLocator.findProgram("bun", searchPath: e["PATH"], home: NSHomeDirectory(), isExecutable: FileManager.default.isExecutableFile)
  }
}

@MainActor
@Suite("Agent folder: Choose", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderChooseGuiTests {
  @Test func chooseNamesTheFolderStartsAndNeedsNoInstaller() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let dir = w.agent("have")
    write(dir + "/.mcp.json", w.talosMcp)
    w.flow.path = dir
    await w.flow.choose()
    #expect(w.model.configured && w.started.count == 1, "\(w.flow.step)")
    #expect(w.disk?.agentDir.hasSuffix("/agents/have") == true && w.disk?.args == AgentFolderSetup.launchArgs(repo: w.clone))
  }

  @Test func chooseRefusesAGoneUnreadableOrSymlinkedFolderAndChangesNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let locked = w.agent("locked")
    write(locked + "/.mcp.json", w.talosMcp)
    chmod(locked, 0o000)
    defer { chmod(locked, 0o700) }
    let real = w.agent("real")
    write(real + "/.mcp.json", w.talosMcp)
    try FileManager.default.createSymbolicLink(atPath: w.agent("link"), withDestinationPath: real)
    for (name, words) in [("gone", "No folder at"), ("locked", "can't open"), ("link", "is a link")] {
      w.flow.path = w.agent(name)
      await w.flow.choose()
      #expect(w.failedText?.contains(words) == true, "\(name): \(w.flow.step)")
      #expect(!w.model.configured && w.disk == nil && w.started.count == 0)
    }
  }

  @Test func chooseRefusesAFolderThatBelongsToTheAgentAlreadyNamedAndKeepsTheConfig() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let current = w.agent("current")
    write(current + "/.mcp.json", w.talosMcp)
    write(current + "/sub/.mcp.json", w.talosMcp)
    w.flow.path = current
    await w.flow.choose()
    let before = w.disk
    #expect(w.model.configured)
    w.flow.path = current + "/sub"
    await w.flow.choose()
    #expect(w.failedText?.contains("belongs to your current agent folder") == true)
    #expect(w.disk == before)
  }

  @Test func chooseAfterSetupOnlyChangesTheFolderAndStartsNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let a = w.agent("a")
    let b = w.agent("b")
    write(a + "/.mcp.json", w.talosMcp)
    write(b + "/.mcp.json", w.talosMcp)
    w.flow.path = a
    await w.flow.choose()
    w.model.saveSetting { $0.args = ["--mine"] }
    w.flow.path = b
    await w.flow.choose()
    w.model.supervisor.drain()  // a folder change does not hold the main thread: the file has it once the supervisor's queue has run
    #expect(w.started.count == 1, "only the first choice started a session")
    #expect(w.disk?.agentDir.hasSuffix("/agents/b") == true && w.disk?.args == ["--mine"])
    #expect(w.doneText?.contains("next time the agent starts") == true)
  }

  @Test func aFolderWithoutTalosIsSentToAdopt() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    write(w.agent("plain") + "/CLAUDE.md", "mine")
    w.flow.path = w.agent("plain")
    await w.flow.choose()
    #expect(w.failedText?.contains("Use Adopt") == true && !w.model.configured)
  }

  @Test func aFolderWiredToAnotherCloneOrHomeIsSentToAdoptWhichAsksFirst() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    let other = #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","/home/alex/other/apps/bridge","--silent","start"]}}}"#
    let elsewhere = w.talosMcp.replacingOccurrences(of: w.appHome, with: "/home/alex/other-home")
    let noHome = #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","\#(w.clone)/apps/bridge","--silent","start"]}}}"#
    for (name, mcp) in [("otherclone", other), ("otherhome", elsewhere), ("nohome", noHome)] {
      write(w.agent(name) + "/.mcp.json", mcp)
      let before = tree(w.agent(name))
      w.flow.path = w.agent(name)
      await w.flow.choose()
      #expect(w.failedText?.contains("Use Adopt") == true, "\(name): \(w.flow.step)")
      #expect(!w.model.configured && w.disk == nil && w.started.count == 0 && tree(w.agent(name)) == before, "\(name)")
    }
  }

  @Test func claudeNotSignedInStillSetsUpButStartsNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    w.flow.signedIn = false
    write(w.agent("have") + "/.mcp.json", w.talosMcp)
    w.flow.path = w.agent("have")
    await w.flow.choose()
    #expect(w.model.configured && w.started.count == 0 && w.doneText?.contains("/login") == true)
  }

  @Test func aTrailingSlashOnTheCurrentFolderIsTheSameFolder() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    write(w.agent("a") + "/.mcp.json", w.talosMcp)
    w.flow.path = w.agent("a")
    await w.flow.choose()
    w.flow.path = w.agent("a") + "/"
    await w.flow.choose()
    #expect(w.doneText != nil, "\(w.flow.step)")
  }
}

@MainActor
@Suite("Agent folder: the clone and what setup keeps", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderCloneAndKeepGuiTests {
  private func flow(_ w: World, repo: String) -> AgentFolderFlow {
    let f = AgentFolderFlow(
      model: w.model,
      deps: .init(repoRoot: { repo }, environment: { var e = ProcessInfo.processInfo.environment; e["TALOS_APP_HOME"] = w.appHome; return e }))
    f.signedIn = true
    return f
  }

  @Test func aPartialOrLinkedCloneStopsAllThreeWaysWithPlainWordsAndChangesNothing() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    write(w.agent("mine") + "/CLAUDE.md", "mine")
    write(w.agent("have") + "/.mcp.json", w.talosMcp)
    let partial = TestTemp.base + "k7-partial-" + UUID().uuidString
    write(partial + "/install.sh", "#!/bin/bash\n")
    write(partial + "/plugins/talos-app-mod/plugin.json", "{}")  // no bridge
    let noMod = TestTemp.base + "k7-nomod-" + UUID().uuidString
    write(noMod + "/install.sh", "#!/bin/bash\n")
    write(noMod + "/apps/bridge/src/cli.ts", "")  // no mod
    let link = TestTemp.base + "k7-link-" + UUID().uuidString
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: w.clone)
    defer { for p in [partial, noMod, link] { try? FileManager.default.removeItem(atPath: p) } }
    for repo in [partial, noMod, link, w.agent("mine") + "/CLAUDE.md"] {
      let f = flow(w, repo: repo)
      let before = tree(w.agent("mine"))
      for way in 0..<3 {
        f.path = way == 2 ? w.agent("have") : w.agent(way == 0 ? "newone" : "mine")
        switch way {
        case 0: await f.create()
        case 1: await f.adopt()
        default: await f.choose()
        }
        guard case .failed(let why) = f.step else { Issue.record("\(repo) way \(way): \(f.step)"); continue }
        #expect(!why.contains("Module not found") && why.contains("built from"), "\(why)")
      }
      #expect(!w.model.configured && w.disk == nil && w.started.count == 0 && tree(w.agent("mine")) == before)
    }
  }

  @Test func settingsChangedBeforeSetupSurviveCreateAdoptAndChoose() async throws {
    for way in 0..<3 {
      let w = try World(realClone: way != 0)
      defer { w.cleanUp() }
      w.model.saveSetting { $0.keepAwakeOnAC = true; $0.notifyThread = "daily"; $0.autoRestart = false }
      let dir = w.agent("x")
      switch way {
      case 0:
        w.flow.path = dir
        await w.flow.create()
      case 1:
        write(dir + "/CLAUDE.md", "mine")
        w.flow.path = dir
        await w.flow.adopt()
        await w.flow.confirm()
      default:
        write(dir + "/.mcp.json", w.talosMcp)
        w.flow.path = dir
        await w.flow.choose()
      }
      let d = try #require(w.disk, "way \(way): \(w.flow.step)")
      #expect(d.keepAwakeOnAC && d.notifyThread == "daily" && !d.autoRestart, "way \(way): held settings joined the file")
    }
  }

  @Test func chooseIntoAnotherFolderDropsTheOldSessionAndConfirmationButTheSameFolderKeepsThem() async throws {
    let w = try World(realClone: true)
    defer { w.cleanUp() }
    write(w.agent("a") + "/.mcp.json", w.talosMcp)
    write(w.agent("b") + "/.mcp.json", w.talosMcp)
    w.flow.path = w.agent("a")
    await w.flow.choose()
    w.model.saveSetting {
      $0.session = DesktopConfig.Session(id: "11111111-2222-4333-8444-555555555555", confirmedAt: "2026-11-01T10:00:00Z")
    }
    w.flow.path = w.agent("a") + "/"
    await w.flow.choose()
    w.model.supervisor.drain()
    #expect(w.disk?.session.id != nil && w.disk?.session.confirmedAt != nil, "the same folder keeps them")
    w.flow.path = w.agent("b")
    await w.flow.choose()
    w.model.supervisor.drain()
    #expect(w.disk?.session.id == nil && w.disk?.session.confirmedAt == nil, "another folder starts clean")
  }
}

@MainActor
@Suite("Agent folder: Import starts the session", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ImportStartsGuiTests {
  @Test func importThatStartsSaysSoAndStartsOnce() throws {
    let w = try World()
    defer { w.cleanUp() }
    #expect(w.model.importCommand("claude --one", thenStart: true) == nil)
    #expect(w.started.count == 1 && w.model.importNote == SetupText.importSaved)
  }

  @Test func importThatDoesNotAskToStartStartsNothing() throws {
    let w = try World()
    defer { w.cleanUp() }
    #expect(w.model.importCommand("claude --one") == nil)
    #expect(w.started.count == 0 && w.model.importNote == SetupText.importSavedNotStarted)
  }

  @Test func aRefusedStartIsNotReportedAsStarting() throws {
    let w = try World()
    defer { w.cleanUp() }
    w.model.beginSession = { _ in false }
    #expect(w.model.importCommand("claude --one", thenStart: true) == nil)
    #expect(w.model.importNote == SetupText.importSavedNotStarted)
  }

  @Test func theAdvancedTabsImportButtonStartsTheAgent() throws {
    let src = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Sources/TalosDesktop/AdvancedSettingsView.swift")
    #expect(try String(contentsOf: src, encoding: .utf8).contains("model.importCommand(command, thenStart: true)"))
  }
}

/// A prebuilt app carries no clone of its own: `install.sh --from-release` records one in a file any program of the owner's can write.
/// A record a session wrote is refused when it names a folder sessions work in, and a good one is used only after the owner's yes on
/// the clone card, bound to the path the card showed.
@MainActor
@Suite("Agent folder: a prebuilt app's recorded clone", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct AgentFolderRecordedCloneGuiTests {
  /// The path with every link resolved (the scratch folder is reached through /var, a link): what install.sh records (pwd -P).
  static func real(_ p: String) -> String {
    guard let r = realpath(p, nil) else { return p }
    defer { free(r) }
    return String(cString: r)
  }

  final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var v: String?
    init(_ v: String?) { self.v = v }
    var value: String? {
      get { lock.withLock { v } }
      set { lock.withLock { v = newValue } }
    }
  }

  fileprivate func flow(_ w: World, recorded: Box, acceptance: MemoryCloneAcceptance, unsafe avoid: [String]?, stamped: String? = nil, home: String? = nil, adjust: ((inout AgentFolderFlow.Deps) -> Void)? = nil) -> AgentFolderFlow {
    let record = TestTemp.base + "k7-record-" + UUID().uuidString
    FileManager.default.createFile(atPath: record, contents: Data("x\n".utf8))
    let appHome = w.appHome
    var deps = AgentFolderFlow.Deps(repoRoot: { stamped })
    deps.recordedRoot = { recorded.value }
    if let home { deps.home = home }
    deps.recordFile = record
    deps.acceptance = acceptance
    if let list = avoid {
      let folders: @Sendable () -> [String] = { list }
      deps.unsafeFolders = folders
    }
    deps.environment = {
      var e = ProcessInfo.processInfo.environment
      e["TALOS_APP_HOME"] = appHome
      e["STUB_MODE"] = "ok"
      return e
    }
    adjust?(&deps)
    let f = AgentFolderFlow(model: w.model, deps: deps)
    f.signedIn = true
    return f
  }

  fileprivate func ran(_ w: World) -> Bool { FileManager.default.fileExists(atPath: w.clone + "/args.log") }

  @Test func aRecordNamingATempOrAgentFolderCloneIsRefusedAndNothingRuns() async throws {
    let w = try World()
    defer { w.cleanUp() }
    // the app's own list of session folders (the temp roots among them): the scratch clone is under the temp folder
    let f = flow(w, recorded: Box(Self.real(w.clone)), acceptance: MemoryCloneAcceptance(), unsafe: nil)
    f.path = w.agent("new")
    await f.create()
    let why = try #require(w.failedText(f), "a refusal")
    #expect(why.contains("agent sessions work in"), "\(why)")
    #expect(!ran(w) && !w.model.configured && w.started.count == 0)
    // a clone inside the agent folder
    let inAgent = Self.real(w.home) + "/agents/mine/clone"
    for (p, t) in ["install.sh": "#!/bin/bash\n", "apps/bridge/src/cli.ts": "", "plugins/talos-app-mod/plugin.json": "{}"] {
      write(inAgent + "/" + p, t)
    }
    let g = flow(w, recorded: Box(inAgent), acceptance: MemoryCloneAcceptance(), unsafe: [Self.real(w.home) + "/agents/mine"])
    g.path = w.agent("new")
    await g.create()
    #expect(w.failedText(g)?.contains("agent sessions work in") == true, "\(String(describing: w.failedText(g)))")
    #expect(!FileManager.default.fileExists(atPath: inAgent + "/args.log"))
    // already "accepted" changes nothing: the rules come first
    let h = flow(w, recorded: Box(inAgent), acceptance: MemoryCloneAcceptance(inAgent), unsafe: [Self.real(w.home) + "/agents/mine"])
    h.path = w.agent("new")
    await h.adopt()
    #expect(w.failedText(h) != nil && !w.model.configured)
  }

  @Test func aGoodRecordIsUsedOnlyAfterTheOwnersYesOnTheCard() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let accepted = MemoryCloneAcceptance()
    let f = flow(w, recorded: Box(Self.real(w.clone)), acceptance: accepted, unsafe: [Self.real(w.home) + "/agents"])
    f.path = w.agent("new")
    await f.create()
    #expect(f.step == .confirmClone(clone: Self.real(w.clone), then: .create))
    #expect(!ran(w), "nothing runs before the yes")
    f.cancel()
    #expect(f.step == .idle && !ran(w) && accepted.accepted() == nil)
    await f.create()
    await f.useClone()
    #expect(ran(w) && w.model.configured, "the yes runs what the owner pressed")
    #expect(accepted.accepted() == Self.real(w.clone))
    // the next time: no card
    try? FileManager.default.removeItem(atPath: w.clone + "/args.log")
    f.path = w.agent("second")
    await f.create()
    #expect(ran(w))
  }

  @Test func theYesBindsThePathTheCardShowed() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let recorded = Box(Self.real(w.clone))
    let accepted = MemoryCloneAcceptance()
    let f = flow(w, recorded: recorded, acceptance: accepted, unsafe: [Self.real(w.home) + "/agents"])
    f.path = w.agent("new")
    await f.create()
    #expect(f.step == .confirmClone(clone: Self.real(w.clone), then: .create))
    recorded.value = Self.real(w.clone) + "-other"  // a session rewrote the record while the card was open
    await f.useClone()
    #expect(w.failedText(f)?.contains("changed while this card was open") == true)
    #expect(!ran(w) && accepted.accepted() == nil && !w.model.configured)
  }

  @Test func aYesThatCannotBeRememberedRunsNothing() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let accepted = MemoryCloneAcceptance()
    accepted.failing = true
    let f = flow(w, recorded: Box(Self.real(w.clone)), acceptance: accepted, unsafe: [Self.real(w.home) + "/agents"])
    f.path = w.agent("new")
    await f.create()
    await f.useClone()
    #expect(w.failedText(f)?.contains("Keychain") == true)
    #expect(!ran(w) && !w.model.configured)
  }

  /// A scratch home laid out as a fresh Mac's: the app's own folder with the clone at its fixed place and the record naming it.
  fileprivate func ownHome(clone at: String? = nil) throws -> (home: String, clone: String) {
    let raw = TestTemp.base + "talos-allow-own-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: raw, withIntermediateDirectories: true)
    let home = Self.real(raw)
    let fixed = AutoSetup.cloneFolder(home: home)
    for dir in Set([fixed, at].compactMap { $0 }) {
      for f in ["install.sh", "plugins/talos-app-mod/x", "apps/bridge/src/cli.ts"] {
        try FileManager.default.createDirectory(atPath: ((dir + "/" + f) as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try Data("x\n".utf8).write(to: URL(fileURLWithPath: dir + "/" + f))
      }
    }
    try Data(((at ?? fixed) + "\n").utf8).write(to: URL(fileURLWithPath: AutoSetup.appFolder(home: home) + "/checkout"))
    return (home, fixed)
  }

  /// Onboarding's own clone: accepted without a click only when it is the app's own fixed-place clone and passes the checks.
  @Test func theOnboardingsOwnCloneCountsAsAcceptedAndAPlantedOneIsStillAsked() throws {
    let w = try World()
    defer { w.cleanUp() }
    let own = try ownHome()
    let f = flow(w, recorded: Box(own.clone), acceptance: MemoryCloneAcceptance(), unsafe: [], home: own.home)
    #expect(f.ownCloneAccepted(own.clone, madeHere: true), "the app's own clone, whole, in its fixed place")
    #expect(!f.ownCloneAccepted(own.home + "/elsewhere", madeHere: true), "a clone the record does not name there")
    // a clone someone recorded elsewhere: the record names it, it is whole, and it is still asked about
    let plantedDir = TestTemp.base + "talos-allow-planted-" + UUID().uuidString
    try FileManager.default.createDirectory(atPath: plantedDir, withIntermediateDirectories: true)
    let planted = try ownHome(clone: Self.real(plantedDir))
    let planter = try #require(AgentFolderSetup.recordedCheckout(in: AutoSetup.recordFolders(home: planted.home))?.clone)
    let g = flow(w, recorded: Box(planter), acceptance: MemoryCloneAcceptance(), unsafe: [], home: planted.home)
    #expect(!g.ownCloneAccepted(planter, madeHere: true), "not the fixed place: asked, never assumed")
    // a reused folder is never counted, whatever it looks like
    #expect(!f.ownCloneAccepted(own.clone, madeHere: false), "this run did not make it")
    // the fixed place, but made loose
    chmod(own.clone, 0o777)
    #expect(!f.ownCloneAccepted(own.clone, madeHere: true), "fails the same checks as a recorded clone")
  }

  /// `ensureCheckout` with a provisioner that answers .ok: a tree this run made is accepted; a reused folder at the same fixed place, whole
  /// and matching, is asked about (the panel is requested, the clone card is up, nothing is remembered).
  @Test func ensureCheckoutAcceptsAFreshCloneAndAsksAboutAReusedOne() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let center = CloneConfirmCenter.shared
    let (savedPresent, savedDismiss) = (center.present, center.dismiss)
    var presented: [String] = []
    center.present = { _, t in presented.append(t.clone) }
    center.dismiss = {}
    defer {
      center.clear()
      center.present = savedPresent
      center.dismiss = savedDismiss
    }
    for madeHere in [true, false] {
      center.clear()
      presented = []
      let own = try ownHome()
      let accepted = MemoryCloneAcceptance()
      let f = flow(w, recorded: Box(nil), acceptance: accepted, unsafe: [], home: own.home) { d in
        d.provision = {
          CloneProvisioner.Config(
            version: "0.1.5", destination: own.clone, recordFile: AutoSetup.appFolder(home: own.home) + "/checkout", git: nil, pnpm: nil, env: [:])
        }
        d.runProvisioner = { _, _ in (.ok(clone: own.clone), madeHere) }
      }
      let ok = await f.ensureCheckout()
      if madeHere {
        #expect(ok && accepted.accepted() == own.clone, "this run's own fresh clone counts as accepted")
        #expect(presented.isEmpty)
      } else {
        #expect(!ok && accepted.accepted() == nil, "a reused folder is not accepted")
        #expect(presented == [own.clone], "the owner is asked, with the panel")
        if case .confirmClone(let shown, _) = f.step { #expect(shown == own.clone) } else { Issue.record("the clone card is not up: \(f.step)") }
      }
    }
  }

  @Test func aStampedCloneNeedsNoCard() async throws {
    let w = try World()
    defer { w.cleanUp() }
    let f = flow(w, recorded: Box("/home/alex/elsewhere"), acceptance: MemoryCloneAcceptance(), unsafe: nil, stamped: w.clone)
    f.path = w.agent("new")
    await f.create()
    #expect(ran(w) && w.model.configured, "a local build's own clone is part of its signature")
  }
}

extension World {
  fileprivate func failedText(_ f: AgentFolderFlow) -> String? { if case .failed(let t) = f.step { return t } else { return nil } }
}
