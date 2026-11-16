import Foundation
import Testing
@testable import TalosDesktopCore

/// The background-work look a thread session's park reads (BackgroundWorkFound.swift) and the cap's choice (`WorkerPolicy.victims`).
@Suite("Background work under a session")
struct BackgroundWorkFoundTests {
  typealias P = BackgroundWork.Proc

  /// A real thread session's process table, read with `ps -o pid,ppid,ucomm,command` on 2026-11-15 (Claude Code 2.1.325, native install):
  /// the kernel names claude for its version file, its argv[0] is the `claude` link. Its MCP servers (python, node, bun), caffeinate, and
  /// one Bash tool command left running in the background (a waiter: zsh, and the `sleep` it runs). Pids as read; the home folder
  /// is replaced with /home/alex and the waiter's file name shortened.
  static let claudeArgv = ["/home/alex/.local/bin/claude", "--settings", "{}", "--dangerously-skip-permissions"]
  static let waiterArgv = [
    "/bin/zsh", "-c",
    "source /home/alex/.claude/shell-snapshots/snapshot-zsh-1794747873637-5wm62e.sh 2>/dev/null || true && \\builtin setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL NO_BRACE_CCL NO_MAGIC_EQUAL_SUBST 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true && eval 'until grep -q \"h20 exit=\" /tmp/claude-501/tasks/bwd5h811r.output 2>/dev/null; do sleep 15; done; sed '\"'\"'s/x/y/'\"'\"' a' < /dev/null && pwd -P >| /tmp/claude-bdd8-cwd",
  ]
  static let real: [P] = [
    P(pid: 43682, ppid: 2326, name: "2.1.325", argv: claudeArgv),
    P(pid: 28796, ppid: 43682, name: "caffeinate"),
    P(pid: 43857, ppid: 43682, name: "python3.12"),
    P(pid: 43858, ppid: 43682, name: "node", argv: ["/home/alex/.nvm/versions/node/v24.22.2/bin/node", "/home/alex/.nvm/versions/node/v24.22.2/lib/node_modules/rea-agents/scripts/mcp.js"]),
    P(pid: 43859, ppid: 43682, name: "bun", argv: ["/opt/homebrew/bin/bun", "run", "--cwd", "/home/alex/talos/apps/bridge", "--silent", "src/server.ts"]),
  ]
  static let waiter: [P] = [P(pid: 12726, ppid: 43682, name: "zsh"), P(pid: 66235, ppid: 12726, name: "sleep")]

  /// The native install is claude: its servers and caffeinate are not work. Read as anything else, every server would be, and no
  /// session would ever park.
  @Test func theNativeInstallsServersAreNotWork() {
    #expect(BackgroundWork.isClaude(Self.real[0]))
    #expect(BackgroundWork.wantsArgv("2.1.325"))
    #expect(BackgroundWork.found(Self.real, pane: 43682, argv: { _ in nil }) == .none)
  }

  @Test func aBackgroundBashCommandIsWorkAndItsCommandIsShown() {
    let f = BackgroundWork.found(Self.real + Self.waiter, pane: 43682) { $0 == 12726 ? Self.waiterArgv : nil }
    #expect(f.count == 1, "the waiter, once, at the top of its tree")
    #expect(f.first == String("until grep -q \"h20 exit=\" /tmp/claude-501/tasks/bwd5h811r.output 2>/dev/null; do sleep 15; done".prefix(60)))
    #expect((f.first?.count ?? 0) == 60)
    #expect(BackgroundWork.cutLine(f) == "Parked while 1 background task(s) were running: \(f.first ?? "").")
  }

  /// A version-named process that is not claude (its argv[0] names something else, or it cannot be read) is not taken for one.
  @Test func aVersionNameAloneIsNotClaude() {
    #expect(!BackgroundWork.isClaude(P(pid: 5, ppid: 1, name: "2.1.325", argv: ["/opt/tool/2.1.325"])))
    #expect(!BackgroundWork.isClaude(P(pid: 5, ppid: 1, name: "2.1.325", argv: nil)))
    #expect(BackgroundWork.isClaude(P(pid: 5, ppid: 1, name: "2.1.325", argv: ["/home/alex/.local/share/claude/versions/2.1.325"])))
    for name in ["2", "2.", ".1", "2.x.3", "v2.1.3", "２.1"] { #expect(!BackgroundWork.isVersionName(name), "\(name)") }
  }

  @Test func theCommandLine() {
    // the eval'd text, with a quote inside single quotes put back
    #expect(BackgroundWork.evalCommand("source x || true && eval 'echo '\"'\"'hi'\"'\"'' < /dev/null") == "echo 'hi'")
    #expect(BackgroundWork.evalCommand("echo no eval here") == nil)
    // a plain `-c` script, an argv, nothing readable, and hostile text: one line, no control characters, at most the limit
    #expect(BackgroundWork.command(argv: ["/bin/bash", "-c", "make test"], name: "bash") == "make test")
    #expect(BackgroundWork.command(argv: ["/usr/bin/python3", "serve.py"], name: "python3") == "/usr/bin/python3 serve.py")
    #expect(BackgroundWork.command(argv: nil, name: "zsh") == "zsh")
    #expect(BackgroundWork.command(argv: ["/bin/sh", "-c", "a\nb\u{1b}[2Jc\td"], name: "sh") == "a b [2Jc d")
    #expect(BackgroundWork.command(argv: ["/bin/sh", "-c", String(repeating: "é", count: 200)], name: "sh").count == 60)
    #expect(BackgroundWork.command(argv: ["/bin/sh", "-c", "   "], name: "sh") == "sh")
  }

  // MARK: the cap's choice

  typealias L = WorkerPolicy.Live

  @Test func theCapTakesAQuietSessionWithNoBackgroundWorkFirst() {
    let live = [
      L(threadId: "a", busy: false, lastActive: 10, background: true),  // the longest idle, but its work is running
      L(threadId: "b", busy: false, lastActive: 50),
      L(threadId: "c", busy: true, lastActive: 1),
    ]
    #expect(WorkerPolicy.planStart(live: live, maxLive: 3) == .parkThenStart("b"))
    #expect(WorkerPolicy.victims(live).map(\.threadId) == ["b"])
  }

  @Test func whenEveryQuietSessionHasBackgroundWorkTheLongestIdleIsTaken() {
    let live = [
      L(threadId: "a", busy: false, lastActive: 30, background: true),
      L(threadId: "b", busy: false, lastActive: 20, background: true),
      L(threadId: "c", busy: true, lastActive: 1),
    ]
    #expect(WorkerPolicy.planStart(live: live, maxLive: 3) == .parkThenStart("b"))
    #expect(WorkerPolicy.victims(live).map(\.threadId) == ["b", "a"])
    // a busy one never, background or not
    let allBusy = live.map { L(threadId: $0.threadId, busy: true, lastActive: $0.lastActive, background: $0.background) }
    #expect(WorkerPolicy.planStart(live: allBusy, maxLive: 3) == .hold)
  }
}
