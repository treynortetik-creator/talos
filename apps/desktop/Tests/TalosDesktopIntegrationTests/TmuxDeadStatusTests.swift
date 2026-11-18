import Foundation
import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// A dead pane that tmux has not read an exit status for (it missed the process's SIGCHLD) must be nudged and read again, not
/// reported as an exit with no code. A fake tmux stands in: no real tmux server is started and no real signal is sent.
final class FakeRacingTmux: @unchecked Sendable {
  private let lock = NSLock()
  private var dead = false
  private var livePid: Int32 = 1234
  private var dieAfterLiveRead = false
  private var servedPid: [Int32] = []
  private var emptyReads: Int
  private var finalRow: String
  private(set) var signals: [(pid: Int32, sig: Int32)] = []
  private(set) var deadReads = 0
  static let serverPid: Int32 = 424_242

  /// `emptyReads`: dead-pane reads that show no status before `finalRow` (the real status) is shown.
  init(emptyReads: Int, finalRow: String) {
    self.emptyReads = emptyReads
    self.finalRow = finalRow
  }

  func die() { lock.withLock { dead = true } }
  /// A new live pane with `pid` replaces the dead one; the read that shows it live is the last before it dies again, so no poll
  /// can see it live in between (its own live read would reset the count and hide the bug).
  func replaceWithPaneThatDiesAfterOneRead(pid: Int32) {
    lock.withLock {
      livePid = pid
      dead = false
      dieAfterLiveRead = true
    }
  }
  var sent: [(pid: Int32, sig: Int32)] { lock.withLock { signals } }
  var reads: Int { lock.withLock { deadReads } }

  func run(_ argv: [String]) -> RunResult {
    func ok(_ s: String) -> RunResult { RunResult(status: 0, stdout: Data(s.utf8), stderr: Data(), timedOut: false) }
    if argv.contains("has-session") { return ok("") }
    if argv.contains("show-options") { return ok("%1\n") }
    if argv.contains("#{pid}") { return ok("\(Self.serverPid)\n") }
    if argv.contains(where: { $0.contains("#{pane_dead_status}") }) {
      return lock.withLock {
        guard dead else {
          if dieAfterLiveRead {
            dieAfterLiveRead = false
            dead = true
          }
          return ok("\(livePid)|0|||1700000000|1700000000|%1\n")
        }
        deadReads += 1
        if emptyReads > 0 {
          emptyReads -= 1
          return ok("|1|||1700000000|1700000000|%1\n")
        }
        return ok(finalRow)
      }
    }
    if argv.contains("capture-pane") { return ok("last line\n") }
    return ok("")
  }

  func record(_ pid: Int32, _ sig: Int32) { lock.withLock { signals.append((pid, sig)) } }
}

@Suite("tmux host: a dead pane with no exit status", .serialized)
struct TmuxDeadStatusTests {
  @Test func leftoverEmptyReadsFromAnOldPidDoNotShortenTheNewPanesBudget() {
    let fake = FakeRacingTmux(emptyReads: 1000, finalRow: "")
    let cmds = TmuxCommands(tmux: "/home/alex/fake-tmux", socket: "talos-test-fake", configPath: "/home/alex/t.conf", session: "agent")
    let host = TmuxPtyHost(
      commands: cmds, launchDir: "/home/alex/launch", baseEnv: [:], pollInterval: 0.2,
      runner: { argv, _, _ in fake.run(argv) }, sendSignal: { pid, sig in fake.record(pid, sig) })
    let got = DispatchSemaphore(value: 0)
    let box = ExitBox()
    host.onExit = { info in
      box.set(info)
      got.signal()
    }
    #expect(host.attachIfRunning())
    fake.die()
    // two empty reads of the old pane count against it, then it is replaced (a restart or re-adoption) before its budget is spent
    var spins = 0
    while fake.sent.count < 2, spins < 5000 {
      usleep(1_000)
      spins += 1
    }
    #expect(fake.sent.count == 2, "the old pane was read twice")
    guard fake.sent.count == 2 else { host.detach(); return }  // the setup missed its window: already a failure above
    fake.replaceWithPaneThatDiesAfterOneRead(pid: 5678)
    #expect(host.attachIfRunning())
    let timedOut = got.wait(timeout: .now() + 20) == .timedOut
    host.detach()
    #expect(!timedOut)
    #expect(box.value?.pid == 5678)
    #expect(fake.sent.count == 2 + TmuxPtyHost.deadStatusPolls, "the new pane gets its full budget, not what the old one left")
  }

  private func exitOf(emptyReads: Int, finalRow: String) -> (ExitInfo?, FakeRacingTmux) {
    let fake = FakeRacingTmux(emptyReads: emptyReads, finalRow: finalRow)
    let cmds = TmuxCommands(tmux: "/home/alex/fake-tmux", socket: "talos-test-fake", configPath: "/home/alex/t.conf", session: "agent")
    let host = TmuxPtyHost(
      commands: cmds, launchDir: "/home/alex/launch", baseEnv: [:], pollInterval: 0.01,
      runner: { argv, _, _ in fake.run(argv) }, sendSignal: { pid, sig in fake.record(pid, sig) })
    let got = DispatchSemaphore(value: 0)
    let box = ExitBox()
    host.onExit = { info in
      box.set(info)
      got.signal()
    }
    #expect(host.attachIfRunning())
    fake.die()
    let timedOut = got.wait(timeout: .now() + 20) == .timedOut
    host.detach()
    return (timedOut ? nil : box.value, fake)
  }

  @Test func theReapedStatusIsUsedAfterEmptyReadsAndTheServerGotSigchld() {
    let (info, fake) = exitOf(emptyReads: 3, finalRow: "|1|7||1700000000|1700000000|%1\n")
    #expect(info?.code == 7)
    #expect(info?.signal == nil)
    #expect(info?.hostLost == false)
    #expect(fake.sent.count == 3, "one SIGCHLD per empty read")
    #expect(fake.sent.allSatisfy { $0.pid == FakeRacingTmux.serverPid && $0.sig == SIGCHLD })
  }

  @Test func aCleanExitIsNotReportedAsACrashOnceReaped() {
    let (info, _) = exitOf(emptyReads: 1, finalRow: "|1|0||1700000000|1700000000|%1\n")
    #expect(info?.code == 0)
  }

  @Test func afterFiveEmptyReadsItGivesUpAndReportsAsBefore() {
    let (info, fake) = exitOf(emptyReads: 1000, finalRow: "")
    #expect(info != nil, "the exit is still reported, never hangs")
    #expect(info?.code == nil && info?.signal == nil && info?.hostLost == false)
    #expect(fake.sent.count == TmuxPtyHost.deadStatusPolls)
    #expect(fake.reads == TmuxPtyHost.deadStatusPolls + 1)
  }

  @Test func aPaneThatShowsItsStatusAtOnceGetsNoSignal() {
    let (info, fake) = exitOf(emptyReads: 0, finalRow: "|1|3||1700000000|1700000000|%1\n")
    #expect(info?.code == 3)
    #expect(fake.sent.isEmpty)
  }
}

private final class ExitBox: @unchecked Sendable {
  private let lock = NSLock()
  private var v: ExitInfo?
  func set(_ i: ExitInfo) { lock.withLock { v = i } }
  var value: ExitInfo? { lock.withLock { v } }
}
