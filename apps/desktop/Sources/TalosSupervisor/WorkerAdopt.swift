import Foundation
import TalosDesktopCore

/// After an app relaunch: reads workers.json back and decides, worker by worker, whether each pane is still ours and running.
extension WorkerManager {
  /// Entry by entry (WorkersFileRead.swift): one this build cannot read is kept as it was, and its thread is not started. false when
  /// the whole file cannot be read: then nothing is adopted and nothing is saved over it, and the next tick reads it again.
  func adopt(now t: Double) -> Bool {
    let f: WorkersFile
    switch WorkersFileRead.read(FileManager.default.contents(atPath: workersJson)) {
    case .none:
      fileRefused = false  // removed (or emptied) after a refusal: a fresh start, and saves again
      return true
    case .refused:
      if !fileRefused { emit(.fileUnreadable) }
      fileRefused = true
      return false
    case .read(let r):
      fileRefused = false
      unreadableKept = r.unreadable
      if !r.unreadable.isEmpty { emit(.recordsUnreadable(threads: r.unreadableThreadIds, others: r.unnamedCount)) }
      f = r.file
    }
    for (id, e) in f.threads {
      var r = Runtime(entry: e)
      r.restoreOwed()
      r.restartTimes = e.restarts.compactMap(ISOTime.parse)
      r.adoptPending = !WorkersFile.restingStates.contains(e.state)
      rt[id] = r
      if r.adoptPending { adoptOne(id, now: t) }
    }
    dirty = true
    return true
  }

  /// Decides one worker from the file. Anything that can't be read leaves it pending, untouched, for the next tick: a
  /// worker marked parked on a failed read would run on, unowned and outside the cap, with no way back from the app.
  func adoptOne(_ id: String, now t: Double) {
    guard var r = rt[id] else { return }
    let e = r.entry
    func notRunning() {
      r.adoptPending = false
      // mid-turn (or on its way out) when the app or the Mac went away: interrupted, not idle
      if e.state == "busy" || e.state == "stopping" || e.turn_started_at != nil { r.entry.stopped_why = "interrupted" }
      r.entry.turn_started_at = nil
      r.entry.state = "parked"
      r.entry.pane_pid = 0
      r.entry.parked_at = r.entry.parked_at ?? ISOTime.string(t)
      rt[id] = r
      dirty = true
    }
    let session = run(tmux(id).hasSession())
    guard session.ok else {
      if TmuxCommands.saysGone(status: session.status, stderr: session.err, timedOut: session.timedOut) { notRunning() }
      return
    }
    let read = run(tmux(id).paneState())
    guard read.ok, let ps = TmuxCommands.parsePaneState(read.out) else { return }
    if ps.dead { return notRunning() }
    guard let pid = ps.pid, let snap = probe.snapshot(pid) else { return }
    if snap.pgid == pid, WorkerSpec.argvLooksLikeMain(snap.argv) {
      // spec 4.4: channels on a worker pane's command line is a bug: stop it, whatever the file says
      signaller.own(pid, leaderStart: snap.startTime)
      rt[id]?.adoptPending = false
      rt[id]?.pgid = pid
      rt[id]?.paneId = ps.paneId
      stopNow(id, why: "crash")  // not a session Talos may run: ended by the supervisor, not by the owner, the cap or the idle limit
      return
    }
    // still ours: the pane pid the file names, its own group. Or a pid the file never got (the app went before `claimPane` read it,
    // or between `new-session` and the write after it) that is this thread's own worker: taken back, never left running unowned.
    let named = pid == e.pane_pid && e.pane_pid > 1 && snap.pgid == e.pane_pid
    guard named || isThreadsWorker(id, snap, pid: pid) else { return notRunning() }
    signaller.own(pid, leaderStart: snap.startTime)
    r.adoptPending = false
    r.pgid = pid
    r.entry.pane_pid = pid
    if !named, let sid = Self.sessionId(argv: snap.argv) { r.entry.session_id = sid }  // what it really runs
    r.paneId = ps.paneId
    r.startedAt = e.started_at.flatMap(ISOTime.parse) ?? t
    r.startedAwake = awake()
    r.readyAt = e.state == "starting" ? 0 : r.startedAt
    r.seenActivity = ps.activity
    // the clock carries on: a relaunch buys no extra idle time (spec 3.5). The file's times, never the pane's own output.
    let saved = e.last_active_at.flatMap(ISOTime.parse).map { min($0, t) }  // a time in the future is no later than now
    r.lastActive = min([saved, e.last_turn_at.flatMap(ISOTime.parse), r.startedAt].compactMap { $0 }.max() ?? t, t)
    // on the awake clock as the clocks read now: the time away counts as idle time, whatever the wall clock does from here
    r.activeAwake = WorkerClock.awakeTime(ofWall: r.lastActive, wall: t, awake: r.startedAwake)
    if e.state == "parking" { r.parkDeadline = awake() + options.parkGrace }
    if e.state == "stopping" {
      // The wait for the turn is not open-ended: whose stop it was is not in the file (an owner's had 15 min in the copy that took the
      // tap, the governor's none), so every adopted one gets `adoptedStopLimit` from when it was asked for. A time in the future is
      // no later than now; a file with no time (an older build's) counts from this relaunch; and however old the file says the stop
      // is, the turn gets `adoptedStopFloor` from here. `advance` cuts the turn and tells the thread.
      let since = min(e.stopping_since.flatMap(ISOTime.parse) ?? t, t)
      r.entry.stopping_since = ISOTime.string(since)
      r.stopDeadline = awake() + max(options.adoptedStopFloor, options.adoptedStopLimit - (t - since))
      r.stopAdopted = true
    }
    // a state this build doesn't know: it runs, and that is all that's known
    if !WorkersFile.liveStates.contains(e.state), e.state != "parking", e.state != "stopping" { r.entry.state = "live" }
    rt[id] = r
    dirty = true
  }
}
