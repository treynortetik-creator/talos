import AppKit
import Foundation
import Testing
import TalosDesktopCore
@testable import TalosDesktop

/// D48: the Thread sessions tab. No SupervisorController, no tmux server of ours: the pane is handed rows and commands.
/// Needs TALOS_GUI_TESTS=1.
@MainActor
@Suite("Thread sessions pane", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled))
struct ThreadSessionsPaneGuiTests {
  func scratch() -> String {
    let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("talos-tsp-\(UUID().uuidString.prefix(8))")
    try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true)
    return d
  }

  func row(_ id: String, state: String, code: String? = nil, label: String? = nil, cwd: String = "/home/alex/proj") -> ThreadSessionRow {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    var e = WorkersFile.Entry(threadId: id, cwd: cwd)
    e.state = state
    if let code { e.error = .init(code: code, detail: label, at: "2026-11-01T00:00:00Z") }
    f.threads[id] = e
    return ThreadSessions.rows(from: f)[0]
  }

  func waitFor(_ cond: () -> Bool, seconds: Double = 8) async {
    let end = Date().addingTimeInterval(seconds)
    while !cond(), Date() < end { try? await Task.sleep(nanoseconds: 50_000_000) }
  }

  @Test func listsTheThreadWithStateAndReasonAndOffersClaudeOnlyForNeedsMac() {
    let pane = ThreadSessionsPane()
    var rows = [row("trip", state: "failed", code: "needs_mac", label: "Do you trust this folder?")]
    pane.source = .init(rows: { rows }, attachArgv: { _ in nil }, claudePath: { nil })
    pane.refresh()
    #expect(pane.pickerTitlesForTest == ["trip: Needs attention"])
    #expect(pane.statusTextForTest.contains("stopped at a question only this Mac can answer"))
    #expect(pane.statusTextForTest.contains("The dialog said: Do you trust this folder?"))
    #expect(pane.openClaudeVisibleForTest)
    #expect(!pane.attachEnabledForTest, "nothing runs behind a stopped worker")
    rows = [row("trip", state: "busy")]
    pane.refresh()
    #expect(pane.statusTextForTest.hasPrefix("Working."))
    #expect(!pane.openClaudeVisibleForTest)
    #expect(pane.attachEnabledForTest)
  }

  @Test func attachRunsTheTmuxAttachCommandForALiveWorkerAndNothingForAParkedOne() async {
    let dir = scratch()
    let out = dir + "/attached.txt"
    let pane = ThreadSessionsPane()
    var rows = [row("trip", state: "parked")]
    pane.source = .init(
      rows: { rows },
      attachArgv: { r in ["/bin/sh", "-c", "echo \(r.tmuxSession) > '\(out)'; sleep 3"] }, claudePath: { nil })
    pane.refresh()
    pane.attach()
    #expect(!pane.hasTerminalForTest, "a parked worker has no pane to attach to")
    rows = [row("trip", state: "live")]
    pane.refresh()
    pane.attach()
    #expect(pane.hasTerminalForTest)
    await waitFor { FileManager.default.fileExists(atPath: out) }
    #expect((try? String(contentsOfFile: out, encoding: .utf8)) == "t-trip\n")
    pane.stopTerminal()
    #expect(!pane.hasTerminalForTest)
  }

  @Test func openClaudeRunsInThatFolderWithoutTalosChannelsAndTypesNothing() async {
    let dir = scratch()
    let folder = scratch()
    let out = dir + "/claude-ran.txt"
    let fake = dir + "/claude"
    // records its folder, its arguments, the Talos env, and anything typed at it in the next second
    try? """
      #!/bin/sh
      { pwd -P; echo "first=$1"; echo "second=$2"; echo "count=$#"; echo "bridge=${TALOS_APP_BRIDGE:-unset}"; } > '\(out)'
      if read -t 1 line; then echo "typed=$line" >> '\(out)'; else echo "typed=nothing" >> '\(out)'; fi
      """.write(toFile: fake, atomically: true, encoding: .utf8)
    chmod(fake, 0o755)
    setenv("TALOS_APP_BRIDGE", "1", 1)
    defer { unsetenv("TALOS_APP_BRIDGE") }
    let pane = ThreadSessionsPane()
    let rows = [row("trip", state: "failed", code: "needs_mac", label: "trust", cwd: folder)]
    pane.source = .init(rows: { rows }, attachArgv: { _ in nil }, claudePath: { fake })
    pane.refresh()
    pane.openClaude()
    await waitFor { (try? String(contentsOfFile: out, encoding: .utf8))?.contains("typed=") == true }
    let text = (try? String(contentsOfFile: out, encoding: .utf8)) ?? ""
    #expect(text.hasPrefix(String(cString: realpath(folder, nil)) + "\n"), "ran in the wrong folder: \(text)")
    // Exactly one inline settings argument that turns the two channel plugins off, and nothing else (no permission flag here).
    #expect(text.contains("first=--settings\n"), "args: \(text)")
    #expect(text.contains("count=2\n"))
    #expect(text.contains("enabledPlugins") && text.contains("false"), "the plugins are switched off for this one session: \(text)")
    #expect(text.contains("bridge=unset"), "it joined Talos as a channel session")
    #expect(text.contains("typed=nothing"), "Talos typed into the dialog")
    pane.stopTerminal()
  }

  @Test func openClaudeDoesNothingForAThreadThatIsNotWaitingOnTheMac() {
    let pane = ThreadSessionsPane()
    let rows = [row("trip", state: "live")]
    pane.source = .init(rows: { rows }, attachArgv: { _ in nil }, claudePath: { "/bin/echo" })
    pane.refresh()
    pane.openClaude()
    #expect(!pane.hasTerminalForTest)
  }

  @Test func theTabShowsAnEmptyNoteWhenThereAreNoThreads() {
    let pane = ThreadSessionsPane()
    pane.source = .init(rows: { [] }, attachArgv: { _ in nil }, claudePath: { nil })
    pane.refresh()
    #expect(pane.pickerTitlesForTest.isEmpty)
  }
}
