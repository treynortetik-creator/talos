import Foundation
import TalosDesktopCore

/// Option C: what resets a worker's idle clock. Split out of `WorkerManager` to keep that file under the size limit.
extension WorkerManager.Runtime {
  /// What `workers.json` keeps of the idle clock: the last real activity while the worker has a pane (a relaunched app seeds from it),
  /// nothing once it is parked, failed or off.
  var savedActivity: String? {
    let hasPane = WorkersFile.liveStates.contains(entry.state) || entry.state == "parking" || entry.state == "stopping"
    return hasPane && lastActive > 0 ? ISOTime.string(lastActive) : nil
  }

  /// A new pane starts a new watch of the screen: the last pane's text is not what this one is compared with, and a dialog on it has
  /// not been on screen for as long as the old screen was.
  mutating func forgetScreen() {
    body = nil
    screenText = nil
    screenSameSince = 0
  }
}

extension WorkerManager.Runtime {
  /// Activity now, on both clocks. Neither goes back.
  mutating func markActive(wall t: Double, awake w: Double) {
    lastActive = max(lastActive, t)
    activeAwake = max(activeAwake, w)
  }
}

extension WorkerManager {
  /// The screen above the input box's lower rule is not what it was at the last tick: the session drew something (a turn, a typed
  /// key). Output that leaves it as it was, such as the status line repainting, is not activity. The first look at a pane counts for
  /// nothing: it is the baseline.
  func noteScreen(_ r: inout Runtime, rows: [String], now t: Double) {
    let body = WorkerActivity.body(rows: rows)
    if let before = r.body, before != body { r.markActive(wall: t, awake: awake()) }
    r.body = body
  }

  /// Each tick, and again where the clients' keys are read. Idle time is measured on the awake clock, so a wall clock that is set
  /// or jumps changes nothing by itself. Only the key times tmux reports are wall times, and one reported before a jump would read
  /// as older (or newer) than it is: when a jump is seen every session counts as active now, so none is parked within a whole idle
  /// time of it. True when one was seen. Busy is read against the awake clock already (`readsBusy`).
  @discardableResult
  func noteClock() -> Bool {
    let t = now()
    let w = awake()
    let j = WorkerClock.jump(previousOffset: wallOffset, wall: t, awake: w)
    wallOffset = j.offset
    guard j.moved != 0 else { return false }
    for id in rt.keys where (rt[id]?.lastActive ?? 0) > 0 { rt[id]?.markActive(wall: t, awake: w) }
    dirty = true
    audit("wall_clock_jump seconds=\(Int(j.moved.rounded()))")
    return true
  }

  /// The idle limit has passed on the awake clock; true when it still has once the owner's keys are counted. A key typed in an attached tmux
  /// client may change nothing on the screen, so the clients' activity times are read here, only when a park is due. A list that can't
  /// be read says no: unread is not "nobody is typing". The keys are tmux's wall times: a jump since this tick's look (a wake during
  /// the tmux call) is caught here, and says no; otherwise each is put on the awake clock as the clocks read now.
  func idleLimitPassed(_ id: String, idle: Double) -> Bool {
    let clients = run(tmux(id).listClientsActivity())
    guard clients.ok, let typed = TmuxCommands.parseClientActivity(clients.out) else { return false }
    if noteClock() { return false }
    let t = now()
    let w = awake()
    if let last = typed.max() { rt[id]?.markActive(wall: min(last, t), awake: WorkerClock.awakeTime(ofWall: last, wall: t, awake: w)) }
    return w - (rt[id]?.activeAwake ?? w) >= idle
  }
}
