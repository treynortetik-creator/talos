import AppKit
import Foundation
import Testing
import TalosDesktopCore

@testable import TalosDesktop

// The real controller on a desktop.json that is there and cannot be read: the menu's own lines say why, and none of the doors the
// windows use saves or starts. Runs only with TALOS_GUI_TESTS=1, on the scratch HOME `TmuxWorld.root` sets; nothing activates the app.

@MainActor
@Suite("Mac: an unreadable desktop.json", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct UnreadableConfigGuiTests {
  @Test func theMenuSaysWhyAndNoDoorSavesOrStarts() async throws {
    cannotTakeTheKeyboard()
    _ = TmuxWorld.root
    TmuxWorld.hookBundle()
    let path = SupervisorController.configPath
    try #require(path.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    let bytes = Data("{\"agent_dir\": 5, \"relay_url\": \"wss://relay.example\"}".utf8)
    try bytes.write(to: URL(fileURLWithPath: path))
    defer { try? FileManager.default.removeItem(atPath: path) }

    let start = SupervisorController.startupConfig(store: MemoryStore())
    #expect(start.unreadable && start.hasFile && start.config == .defaults)

    let store = MemoryStore()
    PreSetup.record(.defaults, in: store)
    let m = SupervisorController(store: store)
    var begun = 0
    m.beginSession = { _ in begun += 1; return false }

    // what the menu and the Session window show
    #expect(m.status.configUnreadable && m.configured)
    #expect(m.liveNotice == SupervisorNotice.configUnreadable, "\(m.liveNotice)")
    #expect(m.statusLine == SupervisorNotice.configUnreadableStatus, "\(m.statusLine)")
    #expect(SupervisorNotice.event(for: m.liveNotice) == .couldNotStart, "and it raises a banner")
    #expect(PreSetup.load(store) != nil, "nothing held from before setup is dropped while the setup is in doubt")
    #expect(m.status.childPid == nil && m.status.phase == .idle, "the launch started nothing: \(m.status.phase)")

    // every door a window uses
    m.saveSetting { $0.autoRestart = false; $0.agentDir = "/home/alex/elsewhere" }
    #expect(m.supervisor.currentConfig().autoRestart && m.supervisor.currentConfig().agentDir != "/home/alex/elsewhere")
    #expect(m.importCommand("claude --one", thenStart: true) == SetupText.importNotSaved(path: path), "Import says it was not saved")
    #expect(m.importNote.isEmpty)
    #expect(m.useAgentFolder("/home/alex/agent", launchArgs: []) == SupervisorNotice.configUnreadable)
    #expect(m.editLaunchLine("claude --a") == .refused(SupervisorNotice.configUnreadable))
    m.start()
    m.restart()
    m.startNewConversation()
    m.supervisor.drain()
    #expect(m.supervisor.status.childPid == nil, "Start, Restart and a new conversation started nothing")
    m.stop()  // the owner's Stop clears `notice`; the line must not go with it
    m.supervisor.drain()
    for _ in 0..<20 { await Task.yield() }
    try await Task.sleep(nanoseconds: 300_000_000)
    m.status = m.supervisor.status
    #expect(m.liveNotice == SupervisorNotice.configUnreadable, "still said after a Stop: \(m.liveNotice)")
    #expect(begun == 0)
    #expect(FileManager.default.contents(atPath: path) == bytes, "the file keeps every byte")
    #expect(FileManager.default.fileExists(atPath: SupervisorController.auditPath) == false || !((try? String(contentsOfFile: SupervisorController.auditPath, encoding: .utf8)) ?? "").contains(" start kind="))
  }

  /// The control: with no file the controller is simply not set up (the old line), and Import still creates the file.
  @Test func withNoFileItIsNotSetUpAndImportStillWorks() throws {
    cannotTakeTheKeyboard()
    _ = TmuxWorld.root
    TmuxWorld.hookBundle()
    let path = SupervisorController.configPath
    try #require(path.hasPrefix(TmuxWorld.root), "refusing to build a controller on the real config")
    try? FileManager.default.removeItem(atPath: path)
    defer { try? FileManager.default.removeItem(atPath: path) }
    let m = SupervisorController(store: MemoryStore())
    m.beginSession = { _ in false }
    #expect(!m.status.configUnreadable && !m.configured && m.statusLine == SupervisorNotice.notSetUp)
    #expect(m.importCommand("claude --one") == nil)
    #expect(ConfigFile.read(path) != .missing && ConfigFile.read(path) != .unreadable)
  }
}
