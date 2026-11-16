import Foundation
import TalosDesktopCore

/// What the workers' tick is doing right now, readable from any thread: the step it is on, the child process it waits for, and when it last
/// wrote the heartbeat. Only the tick writes it; the watchdog (WorkerWatchdog.swift) reads it. Step and command names only: never an
/// argument, a thread id or screen text. Times are on the manager's awake clock.
final class TickWatch: @unchecked Sendable {
  struct Child: Equatable {
    var pid: Int32
    var what: String
    var since: Double
    var cancelled = false
  }

  struct View: Equatable {
    /// Ticking, not stopped, and (as of the last tick) this copy holds `workers.lock`. A passive copy writes no heartbeat.
    var supervising = false
    var inTick = false
    var step = "idle"
    var stepSince: Double = 0
    var child: Child?
    var lastBeat: Double = 0
    /// Why the last `workers.json` write failed; nil after one that worked.
    var writeError: String?
  }

  private let lock = NSLock()
  private var v = View()
  /// The child went before its start was recorded (a very short command): it must not be recorded as running.
  private var exitedEarly = false
  /// The watchdog killed the current call's child.
  private var cancelledCall = false

  func view() -> View { lock.withLock { v } }

  func startSupervising(at t: Double) {
    lock.withLock {
      v.supervising = true
      v.lastBeat = t  // a loop that just started is not late
    }
  }

  func stopSupervising() { lock.withLock { v.supervising = false } }

  func beginTick(at t: Double) {
    lock.withLock {
      v.inTick = true
      v.step = "start"
      v.stepSince = t
    }
  }

  func step(_ s: String, at t: Double) {
    lock.withLock {
      v.step = s
      v.stepSince = t
    }
  }

  func endTick(supervising: Bool, at t: Double) {
    lock.withLock {
      v.inTick = false
      v.supervising = supervising
      v.step = "idle"
      v.stepSince = t
    }
  }

  func wrote(at t: Double, error: String?) {
    lock.withLock {
      v.writeError = error
      if error == nil { v.lastBeat = t }
    }
  }

  func childStarted(_ pid: Int32, what: String, at t: Double) {
    lock.withLock {
      if exitedEarly {
        exitedEarly = false
        return
      }
      v.child = Child(pid: pid, what: what, since: t)
    }
  }

  func childExited() {
    lock.withLock {
      if v.child == nil { exitedEarly = true }
      v.child = nil
    }
  }

  /// After the call returned: true when the watchdog cancelled it. Its answer is then "timed out": like a timeout, it may have been
  /// delivered, so a key it sent is counted and never sent again.
  func callEnded() -> Bool {
    lock.withLock {
      defer {
        v.child = nil
        exitedEarly = false
        cancelledCall = false
      }
      return cancelledCall
    }
  }

  /// Kills the child the tick has waited on for `limit` seconds or more, once. Only a pid the tick registered and that has not exited
  /// (`childExited` clears it before the pid can be reused): the runner's own child, as `ProcessRunner` itself would on its timeout.
  func cancelChild(olderThan limit: Double, at t: Double) -> Child? {
    lock.withLock {
      guard let c = v.child, !c.cancelled, c.pid > 1, t - c.since >= limit else { return nil }
      v.child?.cancelled = true
      cancelledCall = true
      kill(c.pid, SIGKILL)
      return c
    }
  }

  /// The program and, for tmux, its command (`tmux capture-pane`): never an argument that could carry a name or text.
  static func what(_ argv: [String]) -> String {
    let program = argv.first.map { ($0 as NSString).lastPathComponent } ?? "?"
    if program == "tmux", let i = argv.indices.dropFirst().first(where: { k in
      !argv[k].hasPrefix("-") && !["-L", "-f", "-S"].contains(argv[k - 1])
    }) {
      return "tmux " + argv[i]
    }
    return program
  }
}

extension WorkerManager {
  public func startTicking() {
    queue.async {
      self.stopped = false
      self.napGuard.hold()
      guard self.timer == nil else { return }  // already ticking: a stall going on is not hidden by a second start
      self.watch.startSupervising(at: self.awake())
      self.armTimer()
    }
    watchdog.start()
  }

  /// A new timer for the loop, on the queue. The old one is cancelled first, so there is never more than one loop.
  func armTimer() {
    timer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: options.tick)
    t.setEventHandler { [weak self] in self?.tickLocked() }
    timer = t
    t.resume()
  }

  /// The watchdog found the heartbeat late with no tick running: the loop's timer is re-made. On the queue, so a tick that is in fact
  /// running finishes first, and nothing happens after a stop.
  func restartTicking() {
    queue.async {
      guard !self.stopped, self.timer != nil else { return }
      self.armTimer()
    }
  }

  /// Stops ticking. Workers keep running in tmux; the next launch re-adopts them from workers.json.
  public func detach() {
    queue.sync {
      endSupervision()
      releaseLock()
    }
  }

  /// No timer, no watchdog, and the app may nap again. On the queue.
  func endSupervision() {
    timer?.cancel()
    timer = nil
    watch.stopSupervising()
    watchdog.stop()
    napGuard.release()
  }

  /// One tmux command for the tick, with its child recorded for the watchdog. tmux runs with the plain basics only: a worker start
  /// that starts the shared server must not make the login env its global env.
  func run(_ argv: [String]) -> RunResult {
    let what = TickWatch.what(argv)
    var r = ProcessRunner.run(
      argv, env: LaunchFile.serverBasics(baseEnv()), timeout: options.callTimeout,
      started: { [watch, awake] pid in watch.childStarted(pid, what: what, at: awake()) }, exited: { [watch] in watch.childExited() })
    if watch.callEnded() { r.timedOut = true }
    return r
  }

  /// Never over a file that could not be read, and never without the entries that could not be (WorkersFileRead.swift).
  func writeFile() {
    guard !fileRefused else { return }
    do {
      try AtomicFile.write(try WorkersFileRead.encoded(fileModel(), keeping: unreadableKept), to: workersJson, mode: 0o600)
      watch.wrote(at: awake(), error: nil)
    } catch {
      // the next tick tries again; the hub reads a stale heartbeat as "supervisor down" and main answers meanwhile, and the watchdog says so
      watch.wrote(at: awake(), error: String(describing: error).prefix(120).description)
    }
  }
}
