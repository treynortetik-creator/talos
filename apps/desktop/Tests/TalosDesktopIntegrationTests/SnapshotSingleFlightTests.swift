import Foundation
import Testing
import TalosDesktopCore
import TalosSupervisor

/// No read the app makes on a timer may wait for a tick. The app polls `snapshot()` every second off the main thread, and the
/// Terminals window reads `snapshot()` and `needsYou()` every 1.5 s on the main thread; the status poll reads the supervisor's
/// config every 5 s on it. A tick waiting on a slow tmux holds its queue for up to 10 s per call, so each read used to wait for
/// it: the per-second poll piled one blocked thread per second onto the cooperative pool until the pool was gone, and the main
/// thread stalled with it. The tmux here is a shim that holds a read verb until released. Private tmux sockets and the fake
/// claude only. Each read runs on its own plain thread (a stand-in for the main thread, or for a pool thread), so a read that
/// blocks fails at its deadline instead of hanging the test.
private final class Count: @unchecked Sendable {
  private let lock = NSLock()
  private var _n = 0
  var n: Int { lock.withLock { _n } }
  func bump() { lock.withLock { _n += 1 } }
  func next() -> Int { lock.withLock { _n += 1; return _n } }
}

/// The real tmux, except that while `hold` exists a read verb waits (until `release`, at most 15 s, so past the 10 s timeout) and
/// says so in `entered`.
private struct TmuxHold {
  let dir: String
  let path: String
  init(root: String) {
    dir = root + "/hold"
    path = root + "/tmux-hold"
  }

  func writeShim() throws -> String {
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try """
    #!/bin/bash
    d='\(dir)'
    for a in "$@"; do
      case "$a" in
        display-message|capture-pane|list-clients|has-session)
          if [ -f "$d/hold" ]; then
            echo "$a" >> "$d/entered"
            i=0
            while [ ! -f "$d/release" ] && [ $i -lt 75 ]; do sleep 0.2; i=$((i+1)); done
          fi ;;
      esac
    done
    exec '\(Rig.tmuxPath!)' "$@"
    """.write(toFile: path, atomically: true, encoding: .utf8)
    chmod(path, 0o755)
    return path
  }

  func hold() { FileManager.default.createFile(atPath: dir + "/hold", contents: Data()) }
  func release() { FileManager.default.createFile(atPath: dir + "/release", contents: Data()) }
  var entered: Bool { FileManager.default.fileExists(atPath: dir + "/entered") }
}

extension WorkerRig {
  /// A live worker, then a tick stuck in tmux: the workers' queue is held from here on.
  fileprivate func holdTheQueue() throws {
    let h = TmuxHold(root: root)
    manager(tmux: try h.writeShim())
    mgr.startTicking()
    try wake("trip")
    #expect(wait(15) { fileOnDisk?.threads["trip"].map { ["live", "busy"].contains($0.state) } ?? false }, "no live worker: \(why("trip"))")
    h.hold()
    #expect(wait(10) { h.entered }, "no tick reached the held tmux verb")
  }
}

/// Runs `read` on its own thread; true when it came back within `seconds`.
private func returns(within seconds: Double, _ read: @escaping @Sendable () -> Void) -> Bool {
  let done = Count()
  Thread {
    read()
    done.bump()
  }.start()
  let until = Date().addingTimeInterval(seconds)
  while Date() < until, done.n == 0 { usleep(10_000) }
  return done.n == 1
}

@Suite("Reads with a tick holding the queue (Starvation)", .serialized, .enabled(if: Rig.hasTmux))
struct SnapshotSingleFlightTests {
  /// The app's per-second poll, run as it runs it (`WorkersRunningPoll.poll`) more times than the pool has threads, with the
  /// queue held. Every poll must come back at once. (One per tenth of a second instead of per second: the old cost was one
  /// thread per poll, so only the count mattered.)
  @Test func everyPollComesBackWhileATickIsSlow() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    defer { TmuxHold(root: r.root).release() }  // first: lets the held tick end, so teardown does not wait out the timeouts
    try r.holdTheQueue()
    let m = try #require(r.mgr)
    let started = Count()
    let answered = Count()
    for _ in 0..<(ProcessInfo.processInfo.activeProcessorCount + 4) {
      started.bump()
      Thread { WorkersRunningPoll.poll(m) { _ in answered.bump() } }.start()
      usleep(100_000)
    }
    usleep(500_000)  // the deadline of the last poll
    #expect(answered.n == started.n, "\(started.n - answered.n) of \(started.n) polls were still blocked in the workers' queue")
  }

  /// The Terminals window reads these every 1.5 s on the main thread. Neither may wait for a tick. (A plain thread stands in for it.)
  @Test(arguments: ["snapshot", "needsYou"])
  func aReadFromAnotherThreadDoesNotWaitForATick(read: String) throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    defer { TmuxHold(root: r.root).release() }
    try r.holdTheQueue()
    let m = try #require(r.mgr)
    #expect(returns(within: 1) { if read == "snapshot" { _ = m.snapshot() } else { _ = m.needsYou() } }, "\(read)() waited behind the tick")
  }

  /// The Terminals window reads `options` on the main thread while the tick rewrites the launch fields on the queue. A reader
  /// must never see one launch source's folder with another's claude path.
  @Test func theLaunchFieldsAreNeverReadHalfWritten() throws {
    let r = try WorkerRig()
    defer { r.teardown() }
    let m = r.manager()
    m.tune { $0.tick = 0.001 }
    let flips = Count()
    m.launchSource = {
      let k = flips.next() % 2 + 1
      return .init(agentDir: "/a\(k)", claudePath: "/c\(k)", permissionFlag: "--f\(k)")
    }
    m.startTicking()
    var seen = 0
    var torn = 0
    let until = Date().addingTimeInterval(3)
    while Date() < until {
      let o = m.options
      guard o.agentDir.hasPrefix("/a") else { continue }  // before the first tick it is the rig's own
      seen += 1
      let k = o.agentDir.suffix(1)
      if !o.claudePath.hasSuffix(k) || !(o.permissionFlag ?? "").hasSuffix(k) { torn += 1 }
    }
    #expect(seen > 0, "no tick ran")
    #expect(torn == 0, "\(torn) of \(seen) reads saw a half-written launch source")
  }

  /// Main's supervisor shares the tmux server with the workers, and its tick holds its own queue through `capture-pane`. Its config
  /// is read on the main thread every 5 s (the status poll) and by the workers' tick (`launchSource`).
  @Test func currentConfigDoesNotWaitForTheSupervisorsTick() throws {
    let r = try Rig(.tmux, scenario: "dev-dialog.sh", configure: { $0.autoConfirmRestart = false })
    defer { r.teardown() }
    let h = TmuxHold(root: r.root)
    defer { h.release() }
    r.tmuxBin = try h.writeShim()
    r.makeSupervisor()
    r.start()
    #expect(r.wait(30) { r.screenContains(DialogMatcher.Strings.devTitle) }, "dialog shown")
    h.hold()
    #expect(r.wait(15) { h.entered }, "no supervisor tick reached the held tmux verb")
    let sup = try #require(r.sup)
    #expect(returns(within: 1) { _ = sup.currentConfig() }, "currentConfig() waited behind the supervisor's tick")
  }
}
