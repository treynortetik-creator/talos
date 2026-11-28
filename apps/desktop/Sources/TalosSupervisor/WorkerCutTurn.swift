import Darwin
import Foundation
import TalosDesktopCore

/// Wave 0, 0.26: a thread session that dies in the middle of a turn is started again with the turn resumed (the rules are `CutTurn`,
/// pure, in TalosDesktopCore). Here: what is read from the screen, when a cut is written down, and the start that uses it. Every
/// failure is said in the audit log (`Options.auditLogPath`), never read as "nothing was cut".

/// What the manager keeps per thread about turns that may be cut (`Runtime.cut`). Memory only; the record itself is on disk.
struct CutTurnWatch {
  /// The last screen: plan mode, or an Esc under the newest prompt (`CutTurnScreen`).
  var planMode = false
  var escaped = false
  /// This launch was started to resume a cut turn, and that turn has not ended yet (a cut of it is a cut of a re-run).
  var rerunActive = false
  /// The re-run's turn has been seen running (Claude Code takes a moment to pick it up, and a quiet pane before then is not its end).
  var rerunSeenBusy = false
  /// Since when (awake clock) the pane has been quiet while a re-run waits to be seen running.
  var rerunQuietSince: Double?
  /// Where the running turn began (wall clock): the last quiet look before the pane went busy. Held across approval prompts (a pane
  /// waiting on the owner is quiet for as long as the owner takes), so the tools started before a prompt are still this turn's. It ends
  /// with the turn: an Esc, or a quiet pane that waits on nobody.
  var bound: Double?
  var lastQuietWall: Double?
  var quietSince: Double?
  /// The groups last written to `cut-groups.json` for this launch.
  var groups: GroupSnapshot?
  /// The pane's start, read at the first look that finds it: a pid that comes back with another start is not the pane.
  var paneStartUs: Int64?
  var groupsUnreadableSaid = false
}

/// A cut turn this start resumes, and how many of the dead launch's leftover processes were stopped for it.
struct CutTurnRerun {
  var cut: CutTurn.Cut
  var reaped: Int
}

/// What is known about a session at the moment it dies, read before `release` clears it (the nonce file goes with the launch).
struct CutTurnFacts {
  var sessionId: String?
  var midTurn: Bool
  var turnStartedAt: Double?
  var nonce: String?
  var planMode: Bool
  var escaped: Bool
}

extension WorkerManager {
  func cutPath(_ id: String) -> String { CutTurn.path(talosHome: options.talosHome, threadId: id) }

  func noteCutScreen(_ id: String, rows: [String]) {
    let read = CutTurnScreen.read(rows)
    rt[id]?.cut.planMode = read.planMode
    rt[id]?.cut.escaped = read.escaped
  }

  /// A pane that went quiet ends the turn. A re-run's turn is on file from its start, and is over only once it has been seen running.
  func noteTurnState(_ id: String, busy: Bool, now t: Double) {
    noteTurnBound(id, busy: busy, now: t)
    guard rt[id]?.cut.rerunActive == true else {
      if !busy { noteTurnEnded(id, now: t) }
      return
    }
    if busy {
      rt[id]?.cut.rerunSeenBusy = true
      rt[id]?.cut.rerunQuietSince = nil
      return
    }
    // seen running, now quiet: over. Never seen running: nothing was re-run, and the guard goes after the same quiet window busy itself
    // uses (a re-run that has not drawn yet on the first looks is still guarded); the Linux side's rule
    let quiet = rt[id]?.cut.rerunQuietSince ?? awake()
    rt[id]?.cut.rerunQuietSince = quiet
    guard let c = rt[id]?.cut, c.rerunSeenBusy || awake() - quiet >= options.busyWindow else { return }
    rt[id]?.cut.rerunActive = false
    saveCut(id, CutTurn.turnEnded(CutTurn.load(cutPath(id)).file))
    noteTurnEnded(id, now: t)
  }

  /// Where the running turn began (`CutTurnWatch.bound`): set at the quiet-to-busy edge, kept until the turn really ends.
  func noteTurnBound(_ id: String, busy: Bool, now t: Double) {
    guard var c = rt[id]?.cut else { return }
    if busy {
      c.quietSince = nil
      if c.bound == nil { c.bound = c.lastQuietWall ?? t }
    } else {
      c.lastQuietWall = t
      let since = c.quietSince ?? awake()
      c.quietSince = since
      let waiting = rt[id]?.needsYouPrompt != nil || rt[id]?.heldPrompt != nil  // a prompt that waits on the owner is not the turn's end
      if c.bound != nil, c.escaped || (!waiting && awake() - since >= options.dialogSettle + 1) { c.bound = nil }
    }
    rt[id]?.cut = c
  }

  /// What every look at a live pane keeps: the screen's marks, and the groups the session's descendants lead (`CutTurnGroups`).
  func noteCutLook(_ id: String, rows: [String]) {
    noteCutScreen(id, rows: rows)
    noteCutGroups(id)
  }

  func groupsPath(_ id: String) -> String { CutTurnGroups.path(talosHome: options.talosHome, threadId: id) }

  func launchNonce(_ id: String) -> String? {
    (try? String(contentsOfFile: dir(id) + "/nonce", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Written when it changes: after the death the session's own children are no longer found under it, and the table cannot be read
  /// back in time. A table that cannot be read leaves the last record as it is, and is said once.
  func noteCutGroups(_ id: String) {
    guard let r = rt[id], r.pgid > 1, WorkersFile.liveStates.contains(r.entry.state) || r.entry.state == "stopping" else { return }
    guard let table = CutTurnProcs.table(env: false) else {
      if !r.cut.groupsUnreadableSaid {
        rt[id]?.cut.groupsUnreadableSaid = true
        audit("cut_groups_unreadable thread=\(id) the process list could not be read: a cut turn's tools cannot be found by group")
      }
      return
    }
    let scan = CutTurnGroups.snapshot(rows: table, panePid: r.pgid, nonce: launchNonce(id), selfPgid: getpgrp())
    if r.cut.paneStartUs == nil { rt[id]?.cut.paneStartUs = table.first { $0.pid == r.pgid }?.startUs }
    // the pid is in use by another process (not the pane): its children are not the session's, so nothing is rescanned or written
    if table.contains(where: { $0.pid == r.pgid }), !CutTurnGroups.paneAlive(rows: table, panePid: r.pgid, startUs: rt[id]?.cut.paneStartUs) { return }
    // a pane that is dying already shows its tools under launchd while it still reads as alive: an empty scan keeps the groups whose leader is still there
    let snap = CutTurnGroups.recordAfter(scan: scan, last: r.cut.groups, rows: table)
    guard snap != r.cut.groups else { return }
    do {
      try CutTurnGroups.save(snap, to: groupsPath(id))
      rt[id]?.cut.groups = snap
    } catch { audit("cut_groups_save_failed thread=\(id) error=\(WorkerNotice.logValue("\(error)"))") }
  }

  func saveCut(_ id: String, _ file: CutTurnFile) {
    do { try CutTurn.save(file, to: cutPath(id)) } catch { audit("cut_turn_save_failed thread=\(id) error=\(WorkerNotice.logValue("\(error)"))") }
  }

  /// Read before the session is released.
  func cutFacts(_ id: String, midTurn forced: Bool = false) -> CutTurnFacts? {
    guard let r = rt[id] else { return nil }
    let nonce = (try? String(contentsOfFile: dir(id) + "/nonce", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    let busy = r.entry.state == "busy" || r.entry.turn_started_at != nil
    // the earliest start there is: the turn typed in, or the quiet look before the pane went busy
    let start = [r.entry.turn_started_at.flatMap(ISOTime.parse), r.cut.bound].compactMap { $0 }.min()
    return CutTurnFacts(
      sessionId: r.entry.session_id, midTurn: forced || busy, turnStartedAt: start, nonce: nonce, planMode: r.cut.planMode,
      escaped: r.cut.escaped)
  }

  /// Writes down (or clears) the cut turn for a session that is going away by a crash or a stop-limit restart.
  func recordCutTurn(_ id: String, _ f: CutTurnFacts?, why: CutTurn.Why, now t: Double) {
    guard let f else { return }
    let loaded = CutTurn.load(cutPath(id))
    if let problem = loaded.problem { audit("cut_turn_unreadable thread=\(id) \(WorkerNotice.logValue(problem))") }
    let death = CutTurn.Death(
      sessionId: f.sessionId, midTurn: f.midTurn, turnStartedAt: f.turnStartedAt, cutAt: t, nonce: f.nonce, why: why, planMode: f.planMode, escaped: f.escaped)
    let next = CutTurn.record(loaded.file, death)
    saveCut(id, next)
    if let c = next.pending {
      audit("cut_turn_recorded thread=\(id) session=\(c.session_id) why=\(c.why) from_rerun=\(c.from_rerun)")
    } else if f.midTurn {
      audit("cut_turn_not_recorded thread=\(id) why=\(why.rawValue) plan_mode=\(f.planMode) esc=\(f.escaped)")
    }
  }

  /// At a start: whether it resumes a cut turn. A yes reaps the dead launch's leftover tools first, and is a no when they cannot be
  /// looked for (a turn run twice is worse than a turn not resumed, and the owner is told which).
  func cutTurnPlan(_ id: String, sessionId: String, resumes: Bool, now t: Double) -> CutTurnRerun? {
    let loaded = CutTurn.load(cutPath(id))
    if let problem = loaded.problem {
      audit("cut_turn_unreadable thread=\(id) \(WorkerNotice.logValue(problem)): no turn is resumed")
      saveCut(id, CutTurnFile())  // said once, not at every start
      return nil
    }
    switch CutTurn.decide(loaded.file, sessionId: sessionId, resuming: resumes, now: t) {
    case .none:
      return nil
    case .skip(let why):
      saveCut(id, CutTurn.afterSkip(loaded.file))
      audit("cut_turn_skipped thread=\(id) why=\(WorkerNotice.logValue(why))")
      return nil
    case .rerun(let cut):
      // `decide` has checked that both are known; without them nothing is resumed (fails closed)
      guard let nonce = cut.nonce, let turnStart = cut.turn_started_at.flatMap(ISOTime.parse) else { return nil }
      let result = CutTurnReaper.reap(nonce: nonce, startedAfter: turnStart, snapshot: CutTurnGroups.load(groupsPath(id)))
      for why in result.skipped { audit("cut_turn_reap_skipped thread=\(id) why=\(WorkerNotice.logValue(why))") }
      // a turn run on top of its own leftovers is done twice: if the leftovers cannot be listed or will not stop, it is not run again
      if result.listingFailed || !result.notKilled.isEmpty {
        let why = result.listingFailed ? "the process list could not be read" : "pids \(result.notKilled.map(String.init).joined(separator: ",")) would not stop"
        audit("cut_turn_skipped thread=\(id) why=\(why), so the cut turn is not run again")
        saveCut(id, CutTurn.afterSkip(loaded.file))
        return nil
      }
      unlink(groupsPath(id))  // used up with the record
      return CutTurnRerun(cut: cut, reaped: result.killed.count)
    }
  }

  /// The start is made: the record is used up, the launch is remembered as a re-run, and its resumed turn is a turn in progress on file.
  func beginCutTurnRerun(_ r: inout Runtime, _ id: String, _ rerun: CutTurnRerun, nonce: String, now t: Double) {
    let cut = rerun.cut
    r.entry.turn_started_at = ISOTime.string(t)
    r.cut.rerunActive = true
    r.cut.rerunSeenBusy = false
    r.cut.rerunQuietSince = nil
    saveCut(id, CutTurn.afterConsume(CutTurn.load(cutPath(id)).file, cut: cut, newNonce: nonce))
    audit("cut_turn_rerun thread=\(id) session=\(cut.session_id) why=\(cut.why) reaped=\(rerun.reaped)")
  }
}

extension WorkerManager {
  /// A session that was running when the app went away and has died since (WorkerAdopt `notRunning`): a turn it was in the middle of
  /// is a cut, as the Linux side's `gone` records it. cut_at is its last activity (not this look), when that is in the past.
  func recordCutAtAdopt(_ id: String, _ e: WorkersFile.Entry, now t: Double) {
    let ownerStop = e.stopped_why == "owner"
    guard !ownerStop, e.state == "busy" || e.state == "stopping" || e.turn_started_at != nil else { return }
    let last = e.last_active_at.flatMap(ISOTime.parse)
    let facts = CutTurnFacts(
      sessionId: e.session_id, midTurn: true, turnStartedAt: e.turn_started_at.flatMap(ISOTime.parse), nonce: launchNonce(id),
      planMode: false, escaped: false)  // the screen is gone with the pane: plan mode and Esc are not known
    recordCutTurn(id, facts, why: .crash, now: last.map { $0 <= t ? $0 : t } ?? t)
  }

  /// A running session adopted after a relaunch that is the re-run the last copy started: its guard goes on (`CutTurn.Rerun`).
  func restoreCutRerun(_ r: inout Runtime, _ id: String) {
    guard let rr = CutTurn.load(cutPath(id)).file.rerun, let n = launchNonce(id), rr.nonce == n, rr.session_id == r.entry.session_id else { return }
    r.cut.rerunActive = true
    r.cut.rerunSeenBusy = false
    r.cut.rerunQuietSince = nil
  }
}
