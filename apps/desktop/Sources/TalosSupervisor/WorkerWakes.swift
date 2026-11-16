import Foundation
import TalosDesktopCore

/// Option C: the wake files the hub writes for a thread (`workers/<id>/wake`) and what each one asks of the worker. Split out of
/// `WorkerManager` to keep that file under the size limit; behaviour unchanged.
extension WorkerManager {
  func takeWakes(settings: DedicatedSettings, now t: Double) {
    let base = options.talosHome + "/workers"
    guard let ids = try? FileManager.default.contentsOfDirectory(atPath: base) else { return }
    // a thread whose saved entry could not be read is never started under a new id: its wake waits for the file to be fixed
    for id in ids.sorted() where WorkerSpec.isThreadId(id) && rt[id]?.adoptPending != true && unreadableKept[id] == nil {
      let wake = base + "/" + id + "/wake"
      let taken = wake + ".taken"
      guard rename(wake, taken) == 0 else { continue }  // taken atomically: a rewrite by the hub lands in a new file
      let data = FileManager.default.contents(atPath: taken)
      unlink(taken)
      guard let data, let w = WakeFile.decode(data), w.thread_id == id else { continue }
      guard let s = settings.threads[id] else { continue }  // not dedicated (any more): the hub won't route to it
      if rt[id] == nil { rt[id] = Runtime(entry: .init(threadId: id, cwd: s.cwd ?? options.agentDir, model: s.model)) }
      perform(w.action, reason: w.reason, id, s, settings, t, wakeAt: ISOTime.parse(w.at))
    }
  }

  func perform(
    _ action: String, reason: String, _ id: String, _ s: ThreadSessionSettings, _ settings: DedicatedSettings, _ t: Double,
    wakeAt: Double? = nil
  ) {
    let state = rt[id]?.entry.state ?? "off"
    let resting = state == "off" || state == "parked"
    let leaving = state == "parking" || state == "stopping"
    let resume = rt[id]?.entry.session_id != nil
    switch action {
    case "pointer":
      if state == "failed" { return }  // main answers; [Start fresh] or the settings sheet clears it
      let cold = state != "live" && state != "busy"
      // a wake that waited longer than any message waits for its claim (the app was closed): the hub has given every message it names
      // back to main, so nothing starts. Not the 90/120 s deadline: a hand-off waits 15 minutes, and the wake does not say which it holds.
      if let at = wakeAt, t - at > PointerTyper.longestClaim { return }
      oweFromWake(id, cold: cold, now: t, wakeAt: wakeAt)
      if resting { requestStart(id, s, resume: resume, settings, t) }
    case "park":
      if WorkersFile.liveStates.contains(state) {
        requestPark(id, reason: reason == "governor" ? "governor" : "control", byOwner: reason == "control")
      } else if state == "stopping", reason == "control" {
        armStopLimit(id)  // a tap can rescue a governor's stop
      }
    case "resume":
      if leaving { rt[id]?.afterPark = action } else if resting { requestStart(id, s, resume: resume, settings, t) }
    case "restart", "fresh":
      // "park, then resume" (spec 6.4): never through a running turn
      if WorkersFile.liveStates.contains(state) {
        rt[id]?.afterPark = action
        requestPark(id, reason: "control", byOwner: true)
      } else if leaving {
        rt[id]?.afterPark = action
        if state == "stopping" { armStopLimit(id) }
      } else {
        if action == "fresh", var r = rt[id] {
          r.entry.retireSessionId()
          r.entry.state = "off"
          r.restartTimes = []
          r.entry.restarts = []
          rt[id] = r
        }
        rt[id]?.entry.error = nil
        if rt[id]?.entry.state == "failed" { rt[id]?.entry.state = "parked" }
        requestStart(id, s, resume: action == "restart" && resume, settings, t)
      }
    default:
      return
    }
    dirty = true
  }
}
