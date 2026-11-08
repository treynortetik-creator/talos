import Foundation
import Testing
@testable import TalosDesktopCore

/// D48: the terminal window's Thread sessions list, the pure half.
@Suite("Thread sessions list")
struct ThreadSessionsListTests {
  func file(_ entries: [String: (String, String?, String?)]) -> WorkersFile {
    var f = WorkersFile(supervisor: .init(pid: 1, heartbeat_at: "2026-11-01T00:00:00Z", workers_supported: true, main_pane_pid: 2))
    for (id, v) in entries {
      var e = WorkersFile.Entry(threadId: id, cwd: "/home/alex/proj-\(id)")
      e.state = v.0
      if let code = v.1 { e.error = .init(code: code, detail: v.2, at: "2026-11-01T00:00:00Z") }
      f.threads[id] = e
    }
    return f
  }

  @Test func listsEveryThreadSortedWithPlainStates() {
    let rows = ThreadSessions.rows(from: file(["b": ("busy", nil, nil), "a": ("parked", nil, nil), "c": ("live", nil, nil)]))
    #expect(rows.map(\.threadId) == ["a", "b", "c"])
    #expect(rows.map(\.stateText) == ["Parked", "Working", "Live"])
    #expect(rows.map(\.canAttach) == [false, true, true])
  }

  @Test func needsMacShowsTheDialogLabelAndSaysItStopped() {
    let rows = ThreadSessions.rows(from: file(["q": ("failed", "needs_mac", "Do you trust the files in this folder?")]))
    let r = try! #require(rows.first)
    #expect(r.needsMac)
    #expect(r.dialogLabel == "Do you trust the files in this folder?")
    #expect(!r.canAttach)  // nothing is running behind it
    #expect(r.detail.contains("stopped"))
    #expect(r.detail.contains("only this Mac can answer"))
    #expect(!r.detail.contains("waiting"))
    // a message alone never restarts a failed worker (main answers instead): the line must point at Restart
    #expect(r.detail.contains("press Restart"))
    #expect(!r.detail.contains("send a message"))
  }

  @Test func parkingAndStoppingAreKnownStatesWithTheirOwnWords() {
    let rows = ThreadSessions.rows(from: file(["a": ("parking", nil, nil), "b": ("stopping", nil, nil)]))
    #expect(rows.map(\.stateText) == ["Parking", "Stopping"])
    #expect(!rows[0].detail.contains("doesn't know"))
    #expect(!rows[1].detail.contains("doesn't know"))
  }

  @Test func theHandOpenedClaudeHasBothChannelPluginsOffAndTheWorkersPermissionFlag() throws {
    let r = ThreadSessions.rows(from: file(["q": ("failed", "needs_mac", "trust")])).first!
    let inv = try #require(
      ThreadSessions.claudeInvocation(
        for: r, claudePath: "/usr/local/bin/claude", permissionFlag: "--dangerously-skip-permissions", talosHome: "/home/alex/.talos"))
    #expect(inv.args.first == "--dangerously-skip-permissions")
    let i = try #require(inv.args.firstIndex(of: "--settings"))
    let json = inv.args[i + 1]
    #expect(json.contains("\"\(WorkerSpec.telegramPlugin)\":false"))
    #expect(json.contains("\"\(WorkerSpec.imessagePlugin)\":false"))
    let none = ThreadSessions.claudeInvocation(for: r, claudePath: "claude", talosHome: "/home/alex/.talos")!
    #expect(!none.args.contains("--dangerously-skip-permissions"))
  }

  @Test func theHandOpenedClaudeCannotFindTheMainAgentsTelegramToken() {
    let env = ThreadSessions.claudeEnvironment(
      from: ["PATH": "/opt/homebrew/bin", "TELEGRAM_STATE_DIR": "/home/alex/.claude/channels/telegram", "HOME": "/home/alex"],
      talosHome: "/home/alex/.config/talos/app")
    #expect(env["TELEGRAM_STATE_DIR"] == "/home/alex/.config/talos/app/workers/_nochannel")
    #expect(env["IMESSAGE_STATE_DIR"] == "/home/alex/.config/talos/app/workers/_nochannel")
    #expect(env["PATH"] == "/opt/homebrew/bin")
  }

  @Test func otherFailuresGiveTheirOwnReason() {
    func detail(_ code: String) -> String {
      ThreadSessions.rows(from: file(["x": ("failed", code, nil)])).first!.detail
    }
    #expect(detail("crash_loop").contains("kept crashing"))
    #expect(detail("start_failed").contains("didn't start"))
    #expect(detail("resume_missing").contains("can't be resumed"))
    #expect(detail("folder_claimed").contains("Another thread session"))
    #expect(!detail("some_future_code").isEmpty)
    #expect(ThreadSessions.rows(from: file(["x": ("failed", "crash_loop", nil)])).first?.needsMac == false)
  }

  @Test func anUnknownStateMayBeRunningSoItCanBeAttached() {
    let r = ThreadSessions.rows(from: file(["x": ("hibernating", nil, nil)])).first!
    #expect(r.stateText == "Unknown")
    #expect(r.canAttach)
  }

  @Test func noFileMeansNoRows() {
    #expect(ThreadSessions.rows(from: nil).isEmpty)
  }

  @Test func claudeOpensInTheThreadsFolderOnlyForNeedsMacAndTypesNothing() {
    let r = ThreadSessions.rows(from: file(["q": ("failed", "needs_mac", "trust")])).first!
    let inv = ThreadSessions.claudeInvocation(for: r, claudePath: "/usr/local/bin/claude", talosHome: "/home/alex/.talos")
    #expect(inv?.executable == "/usr/local/bin/claude" && inv?.cwd == "/home/alex/proj-q")
    #expect(inv?.args.first == "--settings" && inv?.args.count == 2, "the settings are the only argument: nothing is typed or passed for the owner")
    let live = ThreadSessions.rows(from: file(["l": ("live", nil, nil)])).first!
    #expect(ThreadSessions.claudeInvocation(for: live, claudePath: "claude", talosHome: "/home/alex/.talos") == nil)
  }

  @Test func theHandOpenedClaudeNeverJoinsTalosAsAChannel() {
    let env = ThreadSessions.claudeEnvironment(from: [
      "PATH": "/usr/bin", "TALOS_APP_BRIDGE": "1", "MCP_PROTOCOL_NEGOTIATION": "legacy", "TELEGRAM_BOT_TOKEN": "x",
      "IMESSAGE_ACCESS": "y", "TMUX": "/tmp/t,1,0", "HOME": "/home/alex",
    ])
    #expect(env["TALOS_APP_BRIDGE"] == nil)
    #expect(env["MCP_PROTOCOL_NEGOTIATION"] == nil)
    #expect(env["TELEGRAM_BOT_TOKEN"] == nil)
    #expect(env["IMESSAGE_ACCESS"] == nil)
    #expect(env["TMUX"] == nil)
    #expect(env["PATH"] == "/usr/bin")
    #expect(env["TERM"] == "xterm-256color")
  }
}
