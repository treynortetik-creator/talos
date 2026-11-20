import Foundation
import TalosDesktopCore

/// Option C: what happens when a worker's pane has gone (an exit, a crash, a start that failed), and giving up what it held.
/// Split out of `WorkerManager` to keep that file under the size limit; behaviour unchanged.
extension WorkerManager {
  /// tmux or the kernel said so: never reached on a failed read.
  func exited(_ id: String, rows: [String], settings: DedicatedSettings, now t: Double) {
    guard var r = rt[id] else { return }
    let wasStarting = r.entry.state == "starting"
    let wasStopping = r.entry.state == "stopping"
    let madeNothing = wasStarting && r.pgid == 0 && r.paneId == nil  // `new-session` timed out, and tmux has no session
    // what the owner asked for on its way out still happens, and doesn't stay armed for some later park
    let after = r.afterPark
    r.afterPark = nil
    rt[id] = r
    if r.pgid > 0, signaller.alive(r.pgid) { signaller.signal(r.pgid, SIGKILL) }  // the children of a crashed worker
    release(id)
    r = rt[id] ?? r
    if r.offer.declinedTrust {  // the owner's own "No, exit" on the trust question: failed with its own words, never a crash or a retry
      rt[id]?.offer.declinedTrust = false
      fail(id, "start_failed", Self.declinedTrustText)
      return runQueued(id, after: after, settings: settings, now: t)
    }
    if let kind = r.offer.declinedExit {  // the same for the bypass disclaimer's "No, exit" and the development channel's "Exit"
      rt[id]?.offer.declinedExit = nil
      fail(id, "start_failed", Self.declinedExitText(kind))
      return runQueued(id, after: after, settings: settings, now: t)
    }
    if wasStarting, sessionTrouble(id, rows: rows) {
      // a start the next one mends is not a crash: nothing is counted, and what was waiting (a message, a tap) still happens
      notePark(id, why: "start_retry", bg: BackgroundWork.Found.none)
      rt[id]?.entry.state = "parked"
      rt[id]?.entry.parked_at = ISOTime.string(t)
      rt[id]?.parkReason = nil
      dirty = true
      if after != nil { return runQueued(id, after: after, settings: settings, now: t) }
      guard let s = settings.threads[id] else {  // switched off meanwhile: it stays parked
        rt[id]?.pendingPointer = false
        return
      }
      return requestStart(id, s, resume: rt[id]?.entry.session_id != nil, settings, t)
    }
    if wasStarting, DialogMatcher.resumeMissing(rows) {
      // the id is kept; [Start fresh] moves it to previous_ids (OPTION-C 2.5). Never a new id on our own for a real conversation.
      fail(id, "resume_missing", "No session found with ID")
      return runQueued(id, after: after, settings: settings, now: t)
    }
    // only a crash counts toward crash_loop: an exit from live or busy that nobody asked for. A start that failed and an exit on
    // the way to a park are not crashes.
    let crashed = !wasStarting && !wasStopping
    if crashed {
      r.restartTimes.append(t)
      r.entry.restarts = Array((r.entry.restarts + [ISOTime.string(t)]).suffix(10))
      rt[id] = r
    }
    if crashed, WorkerPolicy.crashLooping(restarts: r.restartTimes, now: t) {
      fail(id, "crash_loop", "the session crashed 5 times in 15 minutes")
    } else if wasStarting {
      fail(id, "start_failed", madeNothing ? "tmux made no session (new-session timed out)" : "the session exited while starting")
    } else {
      // a crash: parked; the transcript is on disk and the next message resumes it. An exit while it was stopping was the park the
      // stop asked for, logged under that stop's reason. Its background work cannot be counted any more (WorkerBackground.swift).
      notePark(id, why: wasStopping ? rt[id]?.parkReason ?? "exited" : "crash", bg: nil)
      rt[id]?.entry.state = "parked"
      rt[id]?.entry.parked_at = ISOTime.string(t)
      if !wasStopping { rt[id]?.entry.stopped_why = "crash" }
      dirty = true
      emit(.parked(thread: id, reason: wasStopping ? rt[id]?.parkReason ?? "exited" : "exited"))
    }
    rt[id]?.parkReason = nil
    runQueued(id, after: after, settings: settings, now: t)
  }

  /// The two session errors of the CLI the next start can mend (Main's rule, `Supervisor.sessionTrouble`), read from the last
  /// screen of a start that exited:
  ///   - `--session-id` refused as already in use: the session is saved after all (the look missed it), so the id is resumed,
  ///     now and from then on;
  ///   - `--resume` of a file that holds no conversation (an /exit before anything was typed): it can never be resumed, so the id
  ///     moves to `previous_ids` and the next start makes a new one. Once: a second such refusal before any start has gone live
  ///     is not mended.
  /// True when the next start is mended. Anything else is not (a real conversation whose resume fails still ends `resume_missing`).
  func sessionTrouble(_ id: String, rows: [String]) -> Bool {
    guard let r = rt[id], let sid = r.entry.session_id else { return false }
    if r.startedAsResume != true, r.resumeAnyway != sid, SessionTranscript.sessionInUse(rows) {
      rt[id]?.resumeAnyway = sid
      audit("\(SessionTranscript.inUseResumeEvent) thread=\(id) session=\(sid)")
      return true
    }
    let claudeDir = WorkerMcp.claudeDir(home: options.home, env: baseEnv())
    if r.startedAsResume != false, !r.gaveNewId, DialogMatcher.resumeMissing(rows),
      SessionTranscript.conversationEmpty(sessionId: sid, folder: r.entry.cwd, claudeDir: claudeDir)
    {
      rt[id]?.entry.retireSessionId()
      rt[id]?.gaveNewId = true
      audit("\(SessionTranscript.emptyNewIdEvent) thread=\(id) session=\(sid)")
      return true
    }
    return false
  }

  func release(_ id: String) {
    guard let r = rt[id] else { return }
    _ = run(tmux(id).killSession())  // by exact name, on our private socket: never a pane id that may have moved
    if r.pgid > 0 { signaller.release(r.pgid) }
    rt[id]?.pgid = 0
    rt[id]?.paneId = nil
    rt[id]?.enterOwed = false
    rt[id]?.stopDeadline = nil
    rt[id]?.stopAdopted = false
    rt[id]?.entry.pane_pid = 0
    rt[id]?.needsYouPrompt = nil
    rt[id]?.entry.turn_started_at = nil  // a turn with no pane has not finished: `last_turn_at` stays the last one that did
    rt[id]?.flaggedPrompt = nil
    rt[id]?.dialogSinceAwake = nil
    rt[id]?.dlg.reset()
    rt[id]?.promptWatch = PromptWatch()
    rt[id]?.heldPrompt = nil
    resetHolds(id)
    closeNoticeRecord(id)
    unlink(dir(id) + "/ready")
    unlink(dir(id) + "/nonce")
    unlink(dir(id) + "/launch.sh")
  }
}
