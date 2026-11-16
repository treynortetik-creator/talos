import Foundation
import TalosDesktopCore

/// Option C: parking and stopping a worker (after its turn, at once, and what was queued behind it). Split out of `WorkerManager`
/// to keep that file under the size limit; behaviour unchanged.
extension WorkerManager {
  /// Park after the current turn (spec 2.4, 6.3, section 8 row 13): `stopping` until the pane goes quiet.
  func requestPark(_ id: String, reason: String, byOwner: Bool) {
    guard let r = rt[id], !r.adoptPending, WorkersFile.liveStates.contains(r.entry.state) else { return }
    rt[id]?.entry.state = "stopping"
    rt[id]?.entry.stopping_since = ISOTime.string(now())  // on disk: a relaunch counts the turn's time from here
    rt[id]?.stopAdopted = false
    rt[id]?.parkReason = reason
    noteStopped(id, reason: reason)
    if byOwner { armStopLimit(id) }
    dirty = true
  }

  /// From the first tap: a second one doesn't buy the turn more time.
  func armStopLimit(_ id: String) {
    if rt[id]?.stopDeadline == nil { rt[id]?.stopDeadline = awake() + options.stopLimit }
  }

  /// SIGTERM now. Callers have checked the worker isn't mid-turn, or that the owner's stop limit has run out.
  func beginPark(_ id: String, reason: String) {
    guard let r = rt[id], r.pgid > 0 else { return }
    notePark(id, why: reason, bg: backgroundWork(id))  // read before the signal: the work it cuts is still there to count
    signaller.signal(r.pgid, SIGTERM)
    rt[id]?.entry.state = "parking"
    rt[id]?.stopDeadline = nil
    rt[id]?.stopAdopted = false
    rt[id]?.parkDeadline = awake() + options.parkGrace
    rt[id]?.parkReason = reason
    // the idle limit is its own reason; a stop already under way keeps the reason it was asked for (a tap's limit is still the tap)
    if reason == "idle" || rt[id]?.entry.stopped_why == nil { noteStopped(id, reason: reason) }
    dirty = true
  }

  func finishPark(_ id: String, settings: DedicatedSettings, now t: Double) {
    let reason = rt[id]?.parkReason ?? "idle"
    release(id)
    rt[id]?.entry.state = "parked"
    rt[id]?.entry.parked_at = ISOTime.string(t)
    rt[id]?.parkDeadline = nil
    rt[id]?.parkReason = nil
    dirty = true
    emit(.parked(thread: id, reason: reason))
    let after = rt[id]?.afterPark
    rt[id]?.afterPark = nil
    runQueued(id, after: after, settings: settings, now: t)
  }

  /// What arrived while a worker was on its way out, once it has gone, however it went.
  func runQueued(_ id: String, after: String?, settings: DedicatedSettings, now t: Double) {
    guard let s = settings.threads[id] else {
      rt[id]?.pendingPointer = false
      return
    }
    if let after {
      perform(after, reason: "control", id, s, settings, t)
    } else if rt[id]?.pendingPointer == true {
      perform("pointer", reason: "message", id, s, settings, t)
    }
  }

  /// Stops at once (a dialog, the cap on an idle worker, Quit): SIGTERM, a short wait, then SIGKILL, on our own group. `why` is the
  /// `stopped_why` it records (`WorkersFile.stoppedWhyValues`), required so no caller leaves it unrecorded.
  func stopNow(_ id: String, why: String) {
    guard let r = rt[id] else { return }
    // a worker already failed (its pane kept for the owner) is not parked by this, and one already parking had its line at
    // `beginPark`; any other is parked here, and its line is written first
    if r.entry.state != "failed", r.entry.state != "parking" { notePark(id, why: why, bg: backgroundWork(id)) }
    if r.pgid > 0 {
      signaller.signal(r.pgid, SIGTERM)
      let until = DispatchTime.now() + 2  // monotonic: a clock set back must not stretch this wait
      while signaller.alive(r.pgid), DispatchTime.now() < until { usleep(50_000) }
      if signaller.alive(r.pgid) { signaller.signal(r.pgid, SIGKILL) }
    }
    release(id)
    if rt[id]?.entry.state != "failed" {
      rt[id]?.entry.state = "parked"
      rt[id]?.entry.parked_at = ISOTime.string(now())
      rt[id]?.entry.stopped_why = why
    }
    dirty = true
  }
}
