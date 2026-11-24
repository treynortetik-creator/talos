import Foundation
import TalosDesktopCore

/// The deaf-thread alarm on the Mac (`DeafWatch`): a thread's pane shows something Talos does not type into, so its messages, scheduled
/// runs and card taps go to Main. Every tick the pane is read for each worker (`advance`); a screen the typing guard would refuse for
/// its own sake, held for `options.deafAfter.notice` seconds, gets one plain line in its thread; held for `.needsYou` seconds it shows as
/// Needs you (the phone and the thread list read `waitingOn`); when it clears, one line says typing works again and what Main handled
/// meanwhile (the bridge's `main-handled.json`). It is read whether or not anything wants to type: a thread that only gets scheduled runs
/// is as deaf as one that gets messages. `deaf-threads.json` carries it to `talos-app doctor`, the Health page and `workers.status`.
struct DeafState {
  var watch = DeafWatch()
  /// The notice that the thread cannot be typed into, and the line after it clears (sent once each, a clear failure retried).
  var note = WorkerManager.NoticeState()
  var back = WorkerManager.NoticeState()
  /// When the run that ended began (wall clock): the "can message again" line is worked out from it when it is posted, so its counts are
  /// the latest (a restart or park does not lose it).
  var backSince: Double?
  /// The guard's reason for the last key it refused for this pane (`guardRead`).
  var lastWhy: String?
  /// This run's notice was held back by the debounce (a thread that flaps is told once in `noticeDebounce`): so its clearing is not told either.
  var silent = false
}

extension WorkerManager {
  /// One look at the worker's pane. A pane that repaints (a sub-agent's row ticking) is still a pane that cannot be typed into, so
  /// "a turn is running" does not stop the look: only a screen with no input box is let go while one runs (a turn can hide the box).
  func noteDeafScreen(_ id: String, rows: [String], busy: Bool) {
    guard let r = rt[id] else { return }
    defer { tellDeafBack(id) }
    // a real dialog or prompt is up (it has its own card and line), or the owner scrolled back: no evidence either way
    if r.needsYouPrompt != nil || r.promptWatch.current != nil || r.copyHold.since != nil { return }
    if DialogMatcher.liveScreen(rows).isDialog || PromptDetector.detect(rows) != nil { return }
    var look = DeafWatch.look(rows)
    // a box at column 0 holding text under a row Talos does not know says nothing: the colours tell (one more read, only when it looked deaf)
    if case .deaf = look { look = DeafWatch.look(rows, escaped: paneRows(id)) }
    switch look {
    case .none: return
    case .clear: deafLook(id, deaf: false)
    case .deaf(let why):
      // a turn can hide the box: a screen with no box is let go while one runs
      if busy, why == "no_input_box" { return }
      // the owner's own typing in an attached window is the owner's, not a screen Talos does not know
      if ownerIsTyping(id) { return }
      deafLook(id, deaf: true)
    }
  }

  /// One look, from the screen read or from a key the guard refused for the screen's own sake: what became due is told or flagged.
  func deafLook(_ id: String, deaf: Bool) {
    guard var w = rt[id]?.deaf.watch else { return }
    w.noticeAfter = options.deafAfter.notice
    w.needsYouAfter = options.deafAfter.needsYou
    w.recoverAfter = options.deafAfter.recover
    let steps = w.observe(deaf: deaf, awake: awake(), wall: now())
    rt[id]?.deaf.watch = w
    for step in steps {
      switch step {
      case .notice:
        audit("deaf_thread thread=\(id) step=notice")
        rt[id]?.deaf.silent = noticeSuppressed(id, kind: WorkerNotice.refusedKind, at: now())
        forgetNoticeRecord(id, kind: WorkerNotice.deafBackKind)  // this run's recovery is told (when its notice was)
      case .needsYou:
        audit("deaf_thread thread=\(id) step=needs_you")
        dirty = true  // `needs_you` reaches workers.json (Runtime.persisted), from when the refusals began
        publish()  // what a reader of the event asks for is already there
        emit(.needsYou(thread: id, prompt: WorkerNotice.refusedKind))
      case .recovered(let sinceWall):
        audit("deaf_thread thread=\(id) step=recovered")
        recoverDeaf(id, sinceWall: sinceWall)
      }
    }
    // told once; a post that clearly failed is tried again on a later look. A run whose notice the debounce held back is not silent for
    // its whole length: once the window has passed it is told (it was never marked sent)
    if rt[id]?.deaf.watch.noticed == true {
      if rt[id]?.deaf.silent == true, !noticeSuppressed(id, kind: WorkerNotice.refusedKind, at: now()) { rt[id]?.deaf.silent = false }
      if rt[id]?.deaf.silent != true {
        sendNotice(id, \.deaf.note, kind: WorkerNotice.refusedKind, text: WorkerNotice.deafLine(name: threadName(id), id: id))
      }
    }
  }

  /// A key meant for this pane was refused: its reason is kept, and for the screen's own sake it is counted (per hour, for the doctor and
  /// the Health page).
  func countDeafRefusal(_ id: String, why: String) {
    rt[id]?.deaf.lastWhy = why
    guard DeafWatch.isDeaf(why: why) else { return }
    rt[id]?.deaf.watch.countRefusal(wall: now())
  }

  /// A refused pointer is a look too, whatever the pane is doing (`noteHeldPointer(.refused)`).
  func noteRefusedPointer(_ id: String) {
    if DeafWatch.isDeaf(why: rt[id]?.deaf.lastWhy) { deafLook(id, deaf: true) }
  }

  /// A thread that was running deaf when its pane went away (a restart, a park, an exit): its run ends here and its recovery is said when
  /// the next pane is up, as one that cleared on its own is (`resetHolds`).
  func endDeafRun(_ id: String) {
    guard rt[id]?.deaf.watch.noticed == true, let since = rt[id]?.deaf.watch.sinceWall else { return }
    recoverDeaf(id, sinceWall: since)
  }

  /// A thread told about is found again after a relaunch: its run goes on from when it was told (the open notice record), so it is not
  /// told a second time and its Needs you comes at the same time it would have.
  func restoreDeaf(_ id: String) {
    guard let rec = readNotices(id)[WorkerNotice.refusedKind], rec.open else { return }
    rt[id]?.deaf.watch.restore(sinceWall: rec.at, wall: now())
  }

  /// Typing works again after the thread was told: the record is CLOSED, not forgotten, so a thread that flaps is told once in
  /// `noticeDebounce` (Needs you and the doctor stay live meanwhile), and the line that says what Main handled while it could not be
  /// reached is worked out now. A run whose notice was held back by that debounce says nothing about clearing either.
  private func recoverDeaf(_ id: String, sinceWall: Double) {
    closeNoticeRecord(id, kind: WorkerNotice.refusedKind)
    rt[id]?.deaf.note.reset()
    dirty = true
    if rt[id]?.deaf.silent == true {
      rt[id]?.deaf.silent = false
      return
    }
    rt[id]?.deaf.backSince = sinceWall
    rt[id]?.deaf.back.reset()
  }

  /// Only while the pane reads fine now: a restart into another deaf screen must not say typing is back. The line is worked out now, from
  /// what Main has handled since the run began (a little before its first refusal: a message routed just then reached Main only at its deadline).
  private func tellDeafBack(_ id: String) {
    guard let since = rt[id]?.deaf.backSince, rt[id]?.deaf.watch.sinceWall == nil else { return }
    let handled = MainHandledCounts.read(
      FileManager.default.contents(atPath: options.talosHome + "/" + "main-handled.json"), thread: id, sinceMs: (since - 120) * 1000)
    sendNotice(
      id, \.deaf.back, kind: WorkerNotice.deafBackKind, text: WorkerNotice.deafBackLine(name: threadName(id), id: id, handled: handled))
    if rt[id]?.deaf.back.sent == true { rt[id]?.deaf.backSince = nil }
  }

  /// `deaf-threads.json`: the threads past the notice wait, with since when and the hour's refusals. Written when the set changes and
  /// every `DEAF_FILE_WRITE_MS` while any is listed; an empty one once the last is gone, so nothing stale reads as now.
  func refreshDeafFile() {
    let wall = now()
    var listed: [String: (sinceMs: Double, refusals1h: Int)] = [:]
    for (id, r) in rt where r.deaf.watch.noticed && Self.offerStates.contains(r.entry.state) {
      guard let since = r.deaf.watch.sinceWall else { continue }
      listed[id] = (since * 1000, r.deaf.watch.refusalsInLastHour(wall: wall))
    }
    let sig = listed.keys.sorted().joined(separator: ",")
    if sig.isEmpty && deafFile.sig.isEmpty { return }
    if sig == deafFile.sig && awake() - deafFile.at < 15 { return }
    let bytes = DeafThreadsFile.encode(at: wall * 1000, threads: listed)
    do {
      try AtomicFile.write(bytes, to: options.talosHome + "/" + DeafThreadsFile.name, mode: 0o600)
    } catch {
      audit("deaf_file_not_written error=\"\(WorkerNotice.logValue("\(error)"))\"")
    }
    deafFile = (awake(), sig)
  }
}
