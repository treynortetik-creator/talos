import Foundation
import TalosDesktopCore

/// Option C: a thread session's background work and its parks (docs/OPTION-C.md, "Idle"). A session whose turn has ended may still
/// have work running under it: a Bash tool command in the background, a `sleep` that is its own waker. The idle park waits for it;
/// the cap takes a session with none, and never one with some (the new session starts over the limit instead). Every park writes one line in the app's log, and a park that cut background work (the owner's stop, an update, the governor) says so in its thread.
///
/// A crash is logged with `bg=unknown`: Claude Code starts each Bash tool shell detached (its own process group and session, an empty
/// environment; measured on 2.1.325), so once claude has gone nothing ties its shells to it but their parent, which is gone too.
extension WorkerManager {
  /// The background work under this worker's pane now (`BackgroundWork.found`); nil when the process table could not be read, which
  /// is never read as "none". A worker with no process has none.
  func backgroundWork(_ id: String) -> BackgroundWork.Found? {
    guard let r = rt[id], r.pgid > 0 else { return BackgroundWork.Found.none }
    guard let table = procTable() else { return nil }
    return BackgroundWork.found(table, pane: r.pgid, argv: procArgv)
  }

  /// The idle park's last check: true when nothing runs in the background. Held by background work (or by a table that could not be
  /// read), it says so in the log once per hold.
  func idleFreeOfBackgroundWork(_ id: String) -> Bool {
    let found = backgroundWork(id)
    let held = (found?.count ?? 1) > 0
    if held, rt[id]?.bgHeld == false { audit("worker_idle_held thread=\(id) bg=\(Self.bgCount(found))") }
    rt[id]?.bgHeld = held
    return !held
  }

  static func bgCount(_ f: BackgroundWork.Found?) -> String { f.map { String($0.count) } ?? "unknown" }

  /// One line in the app's log for every park, at the moment it is decided (before any signal), and the thread's line when it cuts
  /// background work. `idle_s` is the awake time since the session's last activity. A count that could not be read is `unknown`,
  /// and says nothing in the thread.
  func notePark(_ id: String, why: String, bg: BackgroundWork.Found?) {
    guard let r = rt[id] else { return }
    let idle = r.activeAwake > 0 ? max(0, Int((awake() - r.activeAwake).rounded(.down))) : 0
    audit("worker_parked thread=\(id) why=\(why) idle_s=\(idle) bg=\(Self.bgCount(bg))")
    rt[id]?.bgHeld = false
    guard let bg, bg.count > 0 else { return }
    // a new cut is a new line: the last one's record must not hold it back for the debounce window
    forgetNoticeRecord(id, kind: BackgroundWork.cutKind)
    rt[id]?.bgCutNote.reset()
    rt[id]?.bgCutLine = BackgroundWork.cutLine(bg)
    tellBackgroundCut(id)
  }

  /// The line about cut background work: sent, and tried again each tick while a clear failure leaves it unsent.
  func tellBackgroundCut(_ id: String) {
    guard let line = rt[id]?.bgCutLine else { return }
    sendNotice(id, \.bgCutNote, kind: BackgroundWork.cutKind, text: line)
    if rt[id]?.bgCutNote.sent == true { rt[id]?.bgCutLine = nil }
  }
}
