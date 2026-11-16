import Foundation
import Testing

@testable import TalosDesktopCore
import TalosTestSupport

@Suite("Agent folder: Create, Adopt, Choose")
struct AgentFolderSetupTests {
  /// A scratch HOME that is removed when the test is done.
  final class Scratch {
    let root: String
    init(base: String = TestTemp.base) {
      root = base + "k7-" + UUID().uuidString
      try? FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }
    deinit { try? FileManager.default.removeItem(atPath: root) }
    @discardableResult func folder(_ name: String, files: [String: String] = [:]) -> String {
      let p = root + "/" + name
      try? FileManager.default.createDirectory(atPath: p, withIntermediateDirectories: true)
      for (f, text) in files {
        let path = p + "/" + f
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: Data(text.utf8))
      }
      return p
    }
  }
  /// The path as the file system names it: links resolved, no trailing slash.
  static func real(_ p: String) -> String {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    return realpath(p, &buf) == nil ? p : String(cString: buf)
  }
  static let talosMcp = #"{"mcpServers":{"talos-app":{"command":"bun","args":["run","--cwd","/x","--silent","start"]}}}"#

  // MARK: what Talos runs

  @Test func theLaunchFlagsAreTheModAndTheChannel() {
    #expect(
      AgentFolderSetup.launchArgs(repo: "/home/alex/talos-app") == [
        "--plugin-dir", "/home/alex/talos-app/plugins/talos-app-mod", "--dangerously-load-development-channels", "server:talos-app",
      ])
  }

  @Test func createRunsTheClonesInstallerWithoutTheAppStepOrAQuestion() {
    #expect(
      AgentFolderSetup.installArguments(repo: "/r", dir: "/h/a") == ["/r/install.sh", "--agent-dir", "/h/a", "--no-app", "--yes"])
    #expect(AgentFolderSetup.upgradeArguments(repo: "/r", dir: "/h/a") == ["/r/kit/scripts/upgrade.sh", "--into", "/h/a", "--dry-run"])
  }

  /// build-app.sh stamps the clone into Info.plist under the key the Create/Adopt/Choose flow reads it from.
  @Test func theBuildStampsTheCloneUnderTheKeyTheFlowReads() throws {
    let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let build = try String(contentsOf: desktop.appendingPathComponent("scripts/build-app.sh"), encoding: .utf8)
    let flow = try String(contentsOf: desktop.appendingPathComponent("Sources/TalosDesktop/AgentFolderFlow.swift"), encoding: .utf8)
    #expect(build.contains(#"plutil -replace TalosCheckout -string "$(cd "$REPO" && pwd -P)""#), "the physical path, not a link to it")
    #expect(flow.contains(#"forInfoDictionaryKey: "TalosCheckout""#))
  }

  // MARK: kit 1.x

  @Test func aKit1xFolderIsRecognizedByItsVersionStamp() {
    let s = Scratch()
    #expect(AgentFolderSetup.kit1Version(in: s.folder("a", files: [".talos-version": "1.2.0-cli\n"])) == "1.2.0-cli")
    #expect(AgentFolderSetup.kit1Version(in: s.folder("b", files: [".talos-version": "2.0.0\n"])) == nil)
    #expect(AgentFolderSetup.kit1Version(in: s.folder("c")) == nil)
    #expect(AgentFolderSetup.kit1Version(in: s.root + "/gone") == nil)
  }

  // MARK: Choose

  @Test func chooseTakesATalosAgentFolder() {
    let s = Scratch()
    let dir = s.folder("agent", files: [".mcp.json": Self.talosMcp])
    #expect(AgentFolderSetup.choose("~/agent", home: s.root, currentAgentDir: nil) == .ok(Self.real(dir)))
    #expect(AgentFolderSetup.choose(dir, home: s.root, currentAgentDir: dir) == .ok(Self.real(dir)), "the folder already named is fine")
  }

  @Test func chooseRefusesAFolderThatIsGoneUnreadableOrAFile() {
    let s = Scratch()
    guard case .refused(let gone) = AgentFolderSetup.choose(s.root + "/gone", home: s.root, currentAgentDir: nil) else {
      Issue.record("gone"); return
    }
    #expect(gone.contains("No folder at"))
    let file = s.folder("f", files: ["x": "1"]) + "/x"
    guard case .refused(let notDir) = AgentFolderSetup.choose(file, home: s.root, currentAgentDir: nil) else { Issue.record("file"); return }
    #expect(notDir.contains("is a file"))
    let locked = s.folder("locked", files: [".mcp.json": Self.talosMcp])
    chmod(locked, 0o000)
    defer { chmod(locked, 0o700) }
    guard case .refused(let denied) = AgentFolderSetup.choose(locked, home: s.root, currentAgentDir: nil) else {
      Issue.record("unreadable"); return
    }
    #expect(denied.contains("can't open"))
    guard case .refused(let empty) = AgentFolderSetup.choose("  ", home: s.root, currentAgentDir: nil) else { Issue.record("empty"); return }
    #expect(empty.contains("Choose a folder"))
  }

  @Test func chooseRefusesASymlinkedFolderAndNamesTheRealOne() throws {
    let s = Scratch()
    let real = s.folder("real", files: [".mcp.json": Self.talosMcp])
    let link = s.root + "/link"
    try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
    guard case .refused(let why) = AgentFolderSetup.choose(link, home: s.root, currentAgentDir: nil) else { Issue.record("link"); return }
    #expect(why.contains("is a link"))
  }

  @Test func chooseRefusesAFolderThatBelongsToTheAgentDesktopJsonNames() {
    let s = Scratch()
    let current = s.folder("agent", files: [".mcp.json": Self.talosMcp])
    let inside = s.folder("agent/sub", files: [".mcp.json": Self.talosMcp])
    for pick in [inside, s.root] {
      guard case .refused(let why) = AgentFolderSetup.choose(pick, home: s.root, currentAgentDir: current) else {
        Issue.record("\(pick) should belong to \(current)"); continue
      }
      #expect(why.contains("belongs to your current agent folder"))
    }
    let other = s.folder("other", files: [".mcp.json": Self.talosMcp])
    #expect(AgentFolderSetup.choose(other, home: s.root, currentAgentDir: current) == .ok(Self.real(other)), "an unrelated folder is a switch, allowed")
  }

  @Test func chooseComparesRealPathsNotText() throws {
    let s = Scratch()
    let current = s.folder("agent", files: [".mcp.json": Self.talosMcp])
    // a trailing slash is the same folder, not a folder that "belongs" to itself
    #expect(AgentFolderSetup.choose(current + "/", home: s.root, currentAgentDir: current) == .ok(Self.real(current)))
    #expect(AgentFolderSetup.choose(current, home: s.root, currentAgentDir: current + "/") == .ok(Self.real(current)))
    // a link in a parent folder leads to the same folder, so it is the same agent, and a folder under it still belongs to it
    let sub = s.folder("agent/sub", files: [".mcp.json": Self.talosMcp])
    try FileManager.default.createSymbolicLink(atPath: s.root + "/via", withDestinationPath: s.root)
    #expect(AgentFolderSetup.choose(s.root + "/via/agent", home: s.root, currentAgentDir: current) == .ok(Self.real(current)))
    guard case .refused(let why) = AgentFolderSetup.choose(s.root + "/via/agent/sub", home: s.root, currentAgentDir: current) else {
      Issue.record("\(sub) belongs through the link"); return
    }
    #expect(why.contains("belongs to your current agent folder"))
  }

  // MARK: the clone the app was built from

  /// A clone with everything Create, Adopt and Choose run.
  static func clone(_ s: Scratch, _ name: String = "clone", skip: String? = nil) -> String {
    let all = ["install.sh": "#!/bin/bash\n", "apps/bridge/src/cli.ts": "", "plugins/talos-app-mod/plugin.json": "{}"]
    return s.folder(name, files: all.filter { !$0.key.hasPrefix(skip ?? "\u{0}") })
  }

  @Test func aWholeCloneIsAccepted() {
    let s = Scratch()
    #expect(AgentFolderSetup.cloneProblem(Self.clone(s)) == nil)
  }

  @Test func aPartialMissingOrLinkedCloneIsRefusedInPlainWords() throws {
    let s = Scratch()
    for (skip, words) in [("install.sh", "install.sh"), ("apps/bridge", "bridge"), ("plugins/talos-app-mod", "Talos mod")] {
      let why = try #require(AgentFolderSetup.cloneProblem(Self.clone(s, "c-" + skip.prefix(4), skip: skip)), "\(skip)")
      #expect(why.contains(words) && why.contains("build"), "\(skip): \(why)")
      #expect(!why.contains("Module not found"))
    }
    let whole = Self.clone(s, "whole")
    try FileManager.default.createSymbolicLink(atPath: s.root + "/link", withDestinationPath: whole)
    #expect(AgentFolderSetup.cloneProblem(s.root + "/link")?.contains("link") == true)
    let file = s.folder("f", files: ["x": "1"]) + "/x"
    #expect(AgentFolderSetup.cloneProblem(file) != nil)
    #expect(AgentFolderSetup.cloneProblem(s.root + "/gone") != nil)
    #expect(AgentFolderSetup.cloneProblem("") != nil)
  }

  @Test func aCloneFromAnotherMacSaysWhereItWasBuiltAndToRebuild() throws {
    // build-app.sh stamps the builder's clone into Info.plist; an app copied from another Mac carries a path that isn't here
    // (a scratch path that was never made: one under /home can stall on macOS, where /home is an automount)
    let s = Scratch()
    let elsewhere = s.root + "/another-mac/talos-app"
    let why = try #require(AgentFolderSetup.cloneProblem(elsewhere))
    #expect(why.contains("built from \(elsewhere)"), "\(why)")
    #expect(why.contains("isn't on this Mac"), "\(why)")
    #expect(why.contains("your own clone") && why.contains("build-app.sh --release"), "\(why)")
    // a path that is there but is not a folder is a different problem, and keeps its own words
    let file = s.folder("f2", files: ["x": "1"]) + "/x"
    #expect(AgentFolderSetup.cloneProblem(file)?.contains("isn't on this Mac") == false)
  }

  // MARK: a prebuilt app (release-app.sh): no clone in Info.plist, install.sh records the one on this Mac

  @Test func aPrebuiltAppReadsTheCloneInstallShRecorded() throws {
    let s = Scratch()
    let support = s.folder("support")
    let clone = Self.clone(s, "her-clone")
    #expect(AgentFolderSetup.recordedCheckout(supportDir: support) == nil)
    let why = try #require(AgentFolderSetup.cloneProblem(""))
    #expect(why.contains("apps/desktop/scripts/install.sh") && why.contains("records the clone"), "\(why)")
    // what install.sh writes: the path and a newline
    FileManager.default.createFile(atPath: support + "/checkout", contents: Data((clone + "\n").utf8))
    #expect(AgentFolderSetup.recordedCheckout(supportDir: support) == clone)
    // an empty file is no clone (never "" passed on as a path)
    FileManager.default.createFile(atPath: support + "/checkout", contents: Data("\n".utf8))
    #expect(AgentFolderSetup.recordedCheckout(supportDir: support) == nil)
  }

  /// The record can be written by any program of the owner's, an agent session included: what it names gets the guard refresh's rules.
  @Test func aRecordedCloneInASessionFolderOrWithALinkOrLooseModesIsRefused() throws {
    let s = Scratch()
    let record = s.folder("support") + "/checkout"
    FileManager.default.createFile(atPath: record, contents: Data("x\n".utf8))
    let clone = Self.real(Self.clone(s, "good"))
    let agent = Self.real(s.folder("agent"))
    // control: a whole clone outside every session folder, owned by this user, writable by no one else
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [agent]) == nil)
    // in the agent folder (a session wrote the clone and the record)
    let inAgent = Self.real(Self.clone(s, "agent/clone"))
    #expect(AgentFolderSetup.recordedCloneProblem(inAgent, recordFile: record, unsafe: [agent])?.contains("agent sessions work in") == true)
    // under a temp root: a clone under /private/tmp itself, not the scratch folder: a CI runner's TMPDIR can be outside the
    // app's temp roots (Lemnos: ~/.cache/talos-ci/tmp), and the rule under test is "a clone in a temp folder is refused"
    let tmp = Scratch(base: "/private/tmp/")
    let underTmp = Self.real(Self.clone(tmp, "good"))
    #expect(AgentFolderSetup.recordedCloneProblem(underTmp, recordFile: record, unsafe: GuardsRefresh.tmpRoots)?.contains("agent sessions work in") == true)
    // a folder that holds a session folder (the clone is the home around the Talos home)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [clone + "/inner"]) != nil)
    // a link anywhere in the path, and a link at the clone itself
    try FileManager.default.createSymbolicLink(atPath: s.root + "/via", withDestinationPath: s.root)
    #expect(AgentFolderSetup.recordedCloneProblem(s.root + "/via/good", recordFile: record, unsafe: [agent])?.contains("link") == true)
    try FileManager.default.createSymbolicLink(atPath: s.root + "/linked", withDestinationPath: clone)
    #expect(AgentFolderSetup.recordedCloneProblem(Self.real(s.root) + "/linked", recordFile: record, unsafe: [agent])?.contains("link") == true)
    // a relative path, and one that is not there
    #expect(AgentFolderSetup.recordedCloneProblem("good", recordFile: record, unsafe: []) != nil)
    #expect(AgentFolderSetup.recordedCloneProblem(clone + "-gone", recordFile: record, unsafe: []) != nil)
    // modes: the folder or what Talos runs from it writable by others; a linked install.sh
    chmod(clone, 0o777)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [])?.contains("written by other users") == true)
    chmod(clone, 0o755)
    chmod(clone + "/install.sh", 0o664)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [])?.contains("install.sh") == true)
    chmod(clone + "/install.sh", 0o644)
    try FileManager.default.removeItem(atPath: clone + "/install.sh")
    let elsewhere = s.folder("x", files: ["install.sh": "#!/bin/bash\n"]) + "/install.sh"
    try FileManager.default.createSymbolicLink(atPath: clone + "/install.sh", withDestinationPath: elsewhere)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [])?.contains("is a link") == true)
    try FileManager.default.removeItem(atPath: clone + "/install.sh")
    FileManager.default.createFile(atPath: clone + "/install.sh", contents: Data("#!/bin/bash\n".utf8))
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: []) == nil)
    // another user's: the same clone judged for another uid
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [], uid: getuid() + 1)?.contains("another user") == true)
    // the record itself: writable by others, or a link
    chmod(record, 0o666)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: record, unsafe: [])?.contains("record of Talos's clone") == true)
    chmod(record, 0o644)
    let linkedRecord = s.root + "/record-link"
    try FileManager.default.createSymbolicLink(atPath: linkedRecord, withDestinationPath: record)
    #expect(AgentFolderSetup.recordedCloneProblem(clone, recordFile: linkedRecord, unsafe: [])?.contains("is a link") == true)
  }

  @Test func theFoldersARecordedCloneMayNotBeInAreTheSessionFoldersAndTempRoots() throws {
    let cfg = #"{"dedicated":{"enabled":true},"threads":[{"id":"trip","kind":"fixed","session":"dedicated","session_opts":{"cwd":"/home/alex/trip"}}]}"#
    let f = AgentFolderSetup.sessionFolders(
      talosHome: "/home/alex/.config/talos/app", agentDir: "/home/alex/agent", configJSON: Data(cfg.utf8),
      supportDir: "/home/alex/Library/Application Support/Talos")
    for want in ["/home/alex/.config/talos/app", "/home/alex/agent", "/home/alex/trip", "/home/alex/Library/Application Support/Talos"]
    { #expect(f.contains(want), "\(want)") }
    for root in GuardsRefresh.tmpRoots { #expect(f.contains(root), "\(root)") }
    // a config.json that cannot be read still leaves the rest
    #expect(AgentFolderSetup.sessionFolders(talosHome: "/h", agentDir: "", configJSON: Data("{".utf8), supportDir: "/s").contains("/h"))
  }

  @Test func installShWritesTheFileTheAppReads() throws {
    let desktop = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    let install = try String(contentsOf: desktop.appendingPathComponent("scripts/install.sh"), encoding: .utf8)
    let controller = try String(
      contentsOf: desktop.appendingPathComponent("Sources/TalosDesktop/SupervisorController.swift"), encoding: .utf8)
    let flow = try String(contentsOf: desktop.appendingPathComponent("Sources/TalosDesktop/AgentFolderFlow.swift"), encoding: .utf8)
    #expect(install.contains(#"SUPPORT="$HOME/Library/Application Support/Talos""#))
    #expect(install.contains(#"mv -f "$SUPPORT/.checkout.$$" "$SUPPORT/checkout""#))
    #expect(controller.contains(#"static let supportDir = NSHomeDirectory() + "/Library/Application Support/Talos""#))
    #expect(flow.contains("supportDir: SupervisorController.supportDir"))
  }

  @Test func chooseSendsAFolderWithoutTalosToAdopt() {
    let s = Scratch()
    let plain = s.folder("plain", files: ["CLAUDE.md": "mine"])
    let other = s.folder("other", files: [".mcp.json": #"{"mcpServers":{"x":{}}}"#])
    for d in [plain, other] {
      guard case .refused(let why) = AgentFolderSetup.choose(d, home: s.root, currentAgentDir: nil) else { Issue.record("\(d)"); continue }
      #expect(why.contains("Use Adopt"))
    }
  }

  // MARK: Create results

  @Test func createDoneIsExitZero() {
    #expect(AgentFolderSetup.createOutcome(status: 0, stderr: "") == .done)
  }

  @Test func createExplainsEachRefusalInTheInstallersWordsWithThisAppsButton() {
    func text(_ status: Int32, _ err: String) -> String {
      guard case .failed(let t) = AgentFolderSetup.createOutcome(status: status, stderr: err) else { return "NOT FAILED" }
      return t
    }
    // the installer's real words for each state (scripts/root-install.test.ts and the kit's own refusals)
    let notEmpty = text(1, "\nFAILED at \"2/7 Agent folder\": /h/a exists, is not empty and is not a Talos agent. Nothing was touched. Pick a new folder with --agent-dir.\nNothing had been changed yet.\nFix the problem and run ./install.sh again; finished steps are skipped.")
    #expect(notEmpty.contains("is not empty and is not a Talos agent") && notEmpty.contains("press Create again"))
    #expect(!notEmpty.contains("run ./install.sh again"))
    let synced = text(1, "refusing: /h/Dropbox/a looks like cloud-synced storage. Two processes editing memory/ mid-sync corrupts it.\nFAILED at \"4/7\": the kit installer failed before copying anything (its output is above).")
    #expect(synced.contains("cloud-synced storage"))
    let missing = text(3, "\nCannot continue. Missing:\n  - bun: install Bun 1.4.4 or newer: https://example.com/bun\n  - git: install git (macOS: xcode-select --install)\nInstall what is listed, then run ./install.sh again. Nothing was changed.")
    #expect(missing.contains("bun: install Bun") && missing.contains("git: install git") && missing.contains("press Create again"))
    #expect(missing.contains("Nothing was changed"))
    let partway = text(1, "\nFAILED at \"4/7\": The kit copy stopped part-way. /h/a now holds a partial copy. Move it aside (for example: mv /h/a /h/a.partial) and run ./install.sh again.")
    #expect(partway.contains("stopped part-way") && partway.contains("Move it aside") && partway.contains("press Create again"))
    #expect(text(1, "").contains("without saying why"))
    guard case .failed(let none) = AgentFolderSetup.createOutcome(status: nil, stderr: "") else { Issue.record("nil"); return }
    #expect(none.contains("couldn't run"))
  }

  /// The installer's own sentences, as the scripts print them. The next test pins them to the scripts.
  static let syncedText = "refusing: /h/Dropbox/a looks like cloud-synced storage. Two processes editing memory/ mid-sync corrupts it.\nPick a plain folder in your home directory (the default ~/talos-agent), or pass --allow-synced-folder if you know why.\nFAILED at \"4/7 The agent (kit, default CLAUDE.md, first commit)\": the kit installer failed before copying anything (its output is above). Fix that, then run ./install.sh again."
  static let otherCloneText = "FAILED at \"2/7 Agent folder\": this agent is set up from a different clone of the repo, or this installer cannot tell which (listed above). This clone is /h/me. Nothing was changed. To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at."
  static let notEmptyText = "FAILED at \"2/7 Agent folder\": /h/a exists, is not empty and is not a Talos agent. Nothing was touched. Pick a new folder with --agent-dir. If it is a partial copy from an earlier run of this script, move it aside (for example: mv /h/a /h/a.partial) and run ./install.sh again."

  @Test func createNeverShowsTerminalOnlyFlags() {
    for (name, text) in [("synced", Self.syncedText), ("other clone", Self.otherCloneText), ("not empty", Self.notEmptyText)] {
      guard case .failed(let t) = AgentFolderSetup.createOutcome(status: 1, stderr: text) else { Issue.record("\(name)"); continue }
      for flag in ["--agent-dir", "--allow-synced-folder", "--repoint", "./install.sh", "--yes", "--no-app"] {
        #expect(!t.contains(flag), "\(name): \(flag) in \(t)")
      }
    }
    guard case .failed(let synced) = AgentFolderSetup.createOutcome(status: 1, stderr: Self.syncedText) else { return }
    #expect(synced.contains("cloud-synced storage") && synced.contains("Pick a plain folder in your home directory"))
    guard case .failed(let other) = AgentFolderSetup.createOutcome(status: 1, stderr: Self.otherCloneText) else { return }
    #expect(other.contains("different clone") && other.contains("use Adopt"))
  }

  @Test func theInstallerTextsAboveAreTheScriptsOwn() throws {
    let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent().path
    let kit = try String(contentsOfFile: repo + "/kit/install.sh", encoding: .utf8)
    let root = try String(contentsOfFile: repo + "/install.sh", encoding: .utf8)
    #expect(kit.contains("looks like cloud-synced storage. Two processes editing memory/ mid-sync corrupts it."))
    #expect(kit.contains("Pick a plain folder in your home directory (the default ~/talos-agent), or pass --allow-synced-folder if you know why."))
    #expect(root.contains("To point the agent at this clone, run ./install.sh --repoint; otherwise run the install.sh in the clone it points at."))
    #expect(root.contains("Pick a new folder with --agent-dir."))
  }

  // MARK: Adopt results

  @Test func adoptReadsTheCommandsExitCode() {
    #expect(AgentFolderSetup.adoptOutcome(status: 0, output: "connected: /h/a") == .done)
    let foreign = "agent folder: /h/a\ntalos-app: /h/a/.mcp.json already has a talos-app server that runs /h/other, not this clone (/h/me). Nothing was changed. Run again with --repoint to point it here.\n"
    guard case .needsConfirm(let t) = AgentFolderSetup.adoptOutcome(status: 3, output: foreign) else { Issue.record("exit 3"); return }
    #expect(t.contains("runs /h/other") && !t.contains("--repoint") && !t.hasPrefix("talos-app:"))
    let bad = "talos-app: /h/a/.mcp.json is not valid JSON; fix it by hand first (nothing was changed)\n"
    #expect(AgentFolderSetup.adoptOutcome(status: 1, output: bad) == .failed("/h/a/.mcp.json is not valid JSON; fix it by hand first (nothing was changed)"))
    guard case .failed(let gate) = AgentFolderSetup.adoptOutcome(status: 1, output: "talos-app adopt only runs in Terminal, typed by you.\n") else { Issue.record("gate"); return }
    #expect(gate.contains("only runs in Terminal"))
    guard case .failed(let none) = AgentFolderSetup.adoptOutcome(status: nil, output: "") else { Issue.record("nil"); return }
    #expect(none.contains("couldn't run"))
  }
}
