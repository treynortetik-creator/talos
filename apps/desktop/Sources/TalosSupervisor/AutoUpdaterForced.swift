import Foundation
import TalosDesktopCore

/// What an Update now knows about the thread agents: when it was pressed (awake), whether "Update now anyway" was pressed, and the
/// thread ids the last look named as busy (they get their turn sent again after the restart).
struct ForcedThreads {
  var pressedAt: Double?
  var skip = false
  var busy: [String] = []
  init(pressedAt: Double? = nil) { self.pressedAt = pressedAt }
}

/// The automatic path's view of Main's draft: its fingerprint and since when (awake) it has been the same (any change resets it), whether the
/// reason was logged, and whether the last look let the update go past it (a copy is saved right before the swap).
struct DraftWatch {
  var track: (fp: String, at: Double)?
  var said = false
  var overridden = false
}

/// The looks of an Update now while it waits (split from AutoUpdater.swift to keep that file under its size limit).
extension AutoUpdater {
  /// A look of the forced timer; it stops itself once the update is no longer forced (done, gave up, or postponed).
  func forcedTimerTick() {
    guard forced else {
      forcedTimer?.cancel()
      forcedTimer = nil
      return
    }
    tickLocked()
  }

  /// One look of a forced update while it waits (nothing has moved): a turn, a draft or background work, or a message of the owner's since
  /// the last look, is not quiet. `quietLooks` quiet looks in a row, then the prepare. 2 hours after the press it gives up.
  func forcedLook(_ ready: Ready, now: Double) {
    // the owner's ask overrides unsent text in Main's box (it is saved before the swap and put back); a turn, background work, a
    // key just pressed or a message still hold it. The automatic path never comes here, so it keeps waiting on a draft.
    let raw = hooks.look()
    let split = forcedSplit(raw, now: now)
    let why = split.hold
    let plan = raw.contains(AutoUpdate.mainDraftReason) ? hooks.draftPlan() : .none
    let ownerNow = hooks.ownerActivity()
    var quiet = why.isEmpty
    if let ownerNow, ownerNow != forcedOwner {
      quiet = false
      forcedOwner = ownerNow
    }
    switch forcedWait.look(quiet: quiet, now: now, cap: options.quietCap) {  // Update now keeps its hard 2 hours: a turn that keeps bouncing it must end the wait
    case .go:
      prepare(ready, owner: ownerNow)
    case .wait:
      let said = why.joined(separator: "; ") + "|" + (ownerNow != forcedOwner ? "owner" : "") + "|\(plan)"
      if said != forcedWhySaid {
        forcedWhySaid = said
        audit("update_now_waiting", ["version": ready.manifest.version, "why": why.isEmpty ? "quiet looks" : why.joined(separator: "; "), "draft": "\(plan)"])
      }
      // only thread agents left (Main is quiet): their limited wait is said, with the button that skips it; Main's own turn has none
      var threads: UpdateStatus.ThreadWait?
      if !split.threads.isEmpty, !why.contains(where: { !AutoUpdate.isThreadReason($0) }) {
        let names = split.threads.compactMap(AutoUpdate.threadId).map(hooks.threadName)
        threads = UpdateStatus.ThreadWait(names: names, minutes: max(1, Int((options.threadWait / 60).rounded(.up))))
      }
      setStatus(.waitingForTurn(version: ready.manifest.version, why: threads == nil ? why : [], draft: plan, threads: threads))
    case .gaveUp:
      audit("gave_up_waiting", ["version": ready.manifest.version, "why": "Update now: " + (why.isEmpty ? "not quiet" : why.joined(separator: "; "))])
      forced = false
      fail(AutoUpdate.busyLine(ready.manifest.version, old: options.appVersion ?? "this version"))
      phase = .waiting(ready, QuietWait(since: ready.readyAt), notBefore: now + options.postponeFor)
    }
  }

  /// A look's reasons, split for an Update now: `hold` is what still holds it (Main's reasons, and the thread agents' until their wait
  /// is over or was skipped), `threads` the thread agents' reasons that hold it now. Main's draft never holds it.
  func forcedSplit(_ raw: [String], now: Double) -> (hold: [String], threads: [String]) {
    let all = raw.filter { $0 != AutoUpdate.mainDraftReason }
    let theirs = all.filter(AutoUpdate.isThreadReason)
    let main = all.filter { !AutoUpdate.isThreadReason($0) }
    forcedThreads.busy = theirs.compactMap(AutoUpdate.threadId)
    let over = forcedThreads.skip || now - (forcedThreads.pressedAt ?? now) >= options.threadWait
    return over ? (main, []) : (main + theirs, theirs)
  }

  /// The automatic path on a draft: it still waits, until the text has been the same for `draftStaleAfter` (successive looks at the
  /// box; any change, or a box that cannot be read, starts the count again). Then the draft stops holding it, and a copy is saved right
  /// before the swap (`draftWatch.overridden`). Any other reason still holds it.
  func autoDraftFilter(_ why: [String], now: Double) -> [String] {
    draftWatch.overridden = false
    guard why.contains(AutoUpdate.mainDraftReason) else {
      draftWatch.track = nil
      draftWatch.said = false
      return why
    }
    guard let fp = hooks.draftFingerprint() else {
      draftWatch.track = nil
      return why
    }
    guard let t = draftWatch.track, t.fp == fp else {
      draftWatch.track = (fp, now)
      draftWatch.said = false
      return why
    }
    guard now - t.at >= options.draftStaleAfter else { return why }
    // the copy must be whole, and that is known HERE, before anything moves or is announced: a box that cannot be read, or shows only part
    // of the text, never lets the update go past it (else it would post its notice, install, and be undone every time)
    if hooks.draftPartial() {
      if !draftWatch.said {
        draftWatch.said = true
        audit("draft_not_kept", ["why": "partial_or_unreadable"])
      }
      return why
    }
    if !draftWatch.said {
      draftWatch.said = true
      audit("draft_unchanged", ["why": "draft unchanged for 2 hours; keeping a copy"])
    }
    draftWatch.overridden = true
    return why.filter { $0 != AutoUpdate.mainDraftReason }
  }

  /// How long the automatic path waits for quiet. While only a draft in Main's box blocks it, the cap is stretched so the draft's own
  /// 2 hours (counted from its first look) plus the quiet looks fit inside it; any other blocker keeps the plain cap.
  /// Two more rules, so a release never gives up at the moment the machine is quiet: a look that is quiet is never past the cap (it is
  /// the start of the quiet looks, and they get to finish), and a postponement (`notBefore`) stretches the cap to its end plus the time
  /// the quiet looks need. The 2 hours count from when the release was ready, a postponement included.
  func autoWaitCap(_ raw: [String], since: Double?, notBefore: Double, quiet: Bool) -> Double {
    if quiet { return .infinity }
    let looks = Double(AutoUpdate.quietLooks + 1) * options.quietPoll
    var cap = options.quietCap
    if let since { cap = max(cap, notBefore - since + looks) }
    guard !raw.isEmpty, raw.allSatisfy({ $0 == AutoUpdate.mainDraftReason }), let t = draftWatch.track, let since else { return cap }
    return max(cap, t.at - since + options.draftStaleAfter + looks)
  }

  /// Right before the swap: Update now, or an automatic update that went past a draft unchanged for 2 hours, saves the signed copy (and
  /// an Update now names the thread agents it did not wait for). False: the automatic path may not go, because the copy could not be
  /// kept whole (it failed, or the screen shows only part of the text); the draft is the owner's and is never lost silently there.
  func keepBeforeSwap(_ ready: Ready) -> Bool {
    guard forced || draftWatch.overridden else { return true }
    if !forced, draftWatch.overridden, hooks.draftPartial() {
      audit("draft_not_kept", ["why": "partial", "version": ready.manifest.version])
      return false
    }
    // saved as late as possible, so what the owner typed up to now is what comes back
    let kept = hooks.keepDraft(ready.manifest.version)
    audit("draft", ["result": "\(kept)"])
    if kept == .cannotKeep {
      if !forced {
        audit("draft_not_kept", ["why": "cannot_keep", "version": ready.manifest.version])
        return false
      }
      hooks.post(AutoUpdate.draftLostLine)
    }
    if forced { writeInterruptedMarker(ready.manifest.version, commit: ready.manifest.gitSha) }
    return true
  }

  /// Like a postponement, but its own wait starts now: the draft is already old enough, so the next window tries the copy again.
  func postponeForDraftCopy(_ ready: Ready) {
    audit("postponed", ["version": ready.manifest.version, "why": "a copy of the unsent text could not be kept whole"])
    phase = .waiting(ready, QuietWait(since: hooks.awake()), notBefore: hooks.awake() + options.postponeFor)
  }

  /// "Update now anyway": the rest of the thread agents' wait is skipped. Main's running turn is not: it still holds the update.
  public func skipThreadWait() {
    queue.async {
      guard self.forced, case .waiting = self.phase, !self.forcedThreads.skip else { return }
      self.forcedThreads.skip = true
      self.audit("update_now_anyway", [:])
      self.tickLocked()
    }
  }

  /// Right before the swap: the threads that were still busy are named for the bridge (`update-interrupted.json` in the Talos home), which
  /// sends a turn the update cut off once more (apps/bridge/src/router/update-resend.ts). No busy thread: no file, so a list left by an
  /// earlier update never applies to this one.
  func writeInterruptedMarker(_ version: String, commit: String) {
    // inside the updater's own folder (0700), as a 0600 file: the bridge accepts it from nowhere else
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir)
    let path = dir + "/update-interrupted.json"
    let ids = Array(Set(forcedThreads.busy)).sorted()
    guard !ids.isEmpty else {
      try? FileManager.default.removeItem(atPath: path)
      return
    }
    // bound to the release's commit (what the bridge runs), not to the version name
    let o: [String: Any] = ["v": 1, "at": ISOTime.string(hooks.wall()), "version": version, "commit": commit, "threads": ids]
    guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]) else { return }
    do {
      try AtomicFile.write(d, to: path, mode: 0o600)
      audit("update_interrupted", ["threads": ids.joined(separator: ",")])
    } catch {
      audit("update_interrupted", ["result": "not_written"])  // the update still goes: only the second send is lost, and it is said here
    }
  }
}
