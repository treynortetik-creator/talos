import Foundation
import TalosDesktopCore

/// Option C: what a worker's pane says to the owner. A dialog on it (`noteScreen`), the one line the thread gets (`sendNotice`,
/// with its record `notice.json` and debounce), and a pointer held back by the owner's draft or by a pane with no input box
/// (`noteHeldPointer`). Split out of `WorkerManager` so neither file passes the size limit; nothing here is called from anywhere else.
extension WorkerManager {
  /// thread id → the dialog its pane showed at the last tick, for every worker waiting on the owner. Never waits for the queue.
  public func needsYou() -> [String: String] { published().needsYou }

  /// What a worker waits on the owner for: the dialog on its pane, or, after a while, text in its input box that holds the pointer
  /// or no input box on the pane at all.
  func waitingOn(_ r: Runtime) -> String? {
    if let p = r.needsYouPrompt { return p }
    if let since = r.draftSince, awake() - since >= options.draftNoticeAfter {
      return r.owed.leftover ? WorkerNotice.leftoverKind : WorkerNotice.draftKind
    }
    if let since = r.noBox.since, awake() - since >= options.readyTimeout { return WorkerNotice.noBoxKind }
    return nil
  }

  // MARK: dialogs on worker panes

  /// What the pane shows now: a dialog sets the worker's needs-you flag and posts one line into its thread; a screen without
  /// one clears the flag. Runs for every worker, in every state that has a pane. Nothing is typed into a dialog but the arrows and Enter of a tap answer (WorkerDialogAnswer.swift).
  func noteScreen(_ id: String, _ scr: DialogMatcher.Screen, settled: Bool) {
    guard var r = rt[id] else { return }
    guard scr.isDialog else {
      if !settled, r.needsYouPrompt != nil { return }  // held: only a settled screen without it says it is gone
      let hadFlag = r.needsYouPrompt != nil
      if hadFlag {
        r.needsYouPrompt = nil
        r.dialogSinceAwake = nil
        r.dlg.reset()
      }
      // A relaunch (or an adopt) forgets which dialog was open, but notice.json still says it was. The first look at this
      // worker's screen settles it: no dialog now, so no record stays open. Only a screen that has held still says so: a dialog
      // that was just redrawn reads as none for a moment.
      if hadFlag || (settled && !r.recordsChecked) {
        r.recordsChecked = true
        rt[id] = r
        closeNoticeRecord(id)
      } else {
        rt[id] = r
      }
      return
    }
    r.recordsChecked = true
    let prompt = WorkerNotice.promptName(scr)
    if r.needsYouPrompt != prompt {
      // a new dialog (or the first): one notice for it
      r.needsYouPrompt = prompt
      r.dialogSinceAwake = awake()  // a replaced dialog starts its own wait (`dialogLimit`)
      r.dlg.reset()
      rt[id] = r
      emit(.needsYou(thread: id, prompt: prompt))
    } else {
      rt[id] = r
    }
    if lineWaitsForCard(id) { return }  // offered to the bridge for a card: the line is the fallback, after the card wait
    sendNotice(id, \.dlg, kind: prompt, text: WorkerNotice.line(threadName: threadName(id), screen: scr))
  }

  /// A prompt nobody named (a tool permission, the agent's own question, any Select) is announced like a known dialog, once it has
  /// held still. `noteScreen` has the known four; this has the rest (`PromptDetector`), which answers nothing for those. Nothing is
  /// ever typed into either.
  func noteScreens(_ id: String, rows: [String], seen: DialogMatcher.Screen, settled: Bool) {
    syncOffer(id, rows: rows, seen: seen, settled: settled)
    let before = rt[id]?.promptWatch.current
    let found = seen.isDialog ? nil : PromptDetector.detect(rows)
    let hold = found != nil && before == nil && ownerIsTyping(id)
    let change = rt[id]?.promptWatch.observe(found, at: awake(), settle: options.dialogSettle, hold: hold, idle: PromptDetector.isIdle(rows)) ?? .none
    if case .appeared = change, before != nil {
      // another prompt in place of the one announced: its own notice
      rt[id]?.dlg.reset()
      closeNoticeRecord(id)
    }
    // A prompt the detector sees but that has not settled yet is not "no dialog": it must not close the record a relaunch found open.
    // A dialog's flag is held through repaints: an unsettled screen (a status line that repaints faster than `dialogSettle`) never clears
    // it. It clears when the settled screen has none, or when no dialog shape has been on the pane for `dialogSettle` running.
    let absent = found == nil && DialogMatcher.liveDialog(rows) == .none
    let gone = rt[id]?.dialogAbsence.gone(present: !absent, at: awake(), settle: options.dialogSettle) ?? false
    // Back to back: the held dialog's place taken by another whole dialog, the screen never still. It is a new dialog (its own notice).
    let live = DialogMatcher.liveDialog(rows)
    if !seen.isDialog, live.isDialog, let held = rt[id]?.needsYouPrompt, held != WorkerNotice.promptName(live) { return noteScreen(id, live, settled: false) }
    guard !seen.isDialog, let shown = rt[id]?.promptWatch.current else { return noteScreen(id, seen, settled: settled && found == nil || gone) }
    notePrompt(id, shown)
  }

  /// An attached client typed within `clientQuiet`: a picker the owner opened, or the owner at the keys. Unreadable says no.
  func ownerIsTyping(_ id: String) -> Bool {
    let c = run(tmux(id).listClientsActivity())
    guard c.ok, let last = TmuxCommands.parseClientActivity(c.out)?.max() else { return false }
    return now() - last < options.clientQuiet
  }

  /// Whether the owner has text in Claude's input box. The plain screen says so for the idle placeholder too (`❯` NBSP `Try "…"`,
  /// the same words a draft can have), so a plain "draft" is checked against the colours (`InputBoxAttributes`); a read that fails,
  /// or a box not found, leaves the plain answer: a pointer is never typed onto text that may be the owner's.
  func draftPresent(_ id: String, _ rows: [String]) -> Bool {
    guard PointerTyper.draftPresent(rows: rows) else { return false }
    let c = run(tmux(id).capturePaneEscaped())
    guard c.ok else { return true }
    return InputBoxAttributes.draftPresent(escapedRows: TmuxCommands.parseCapture(c.out)) ?? true
  }

  /// What the typing guard looks at: the known dialog by its shape, else a prompt nobody named as an unknown question. It does not
  /// wait for the screen to settle: a prompt just drawn must not get a line typed in.
  func guardShape(_ rows: [String]) -> DialogMatcher.Screen {
    let shape = DialogMatcher.liveDialog(rows)
    return shape == .none && PromptDetector.detect(rows) != nil ? .unknownSelection : shape
  }

  private func notePrompt(_ id: String, _ p: PromptDetector.Prompt) {
    guard var r = rt[id] else { return }
    r.recordsChecked = true
    let name = p.title ?? "prompt"
    if r.needsYouPrompt != name {
      r.needsYouPrompt = name
      if r.dialogSinceAwake == nil { r.dialogSinceAwake = awake() }
      r.dlg.reset()
      rt[id] = r
      emit(.needsYou(thread: id, prompt: name))
    } else {
      rt[id] = r
    }
    sendNotice(id, \.dlg, kind: "prompt: \(p.hash)", text: SupervisorNotice.workerPromptLine(threadName: threadName(id), prompt: p))
  }

  func threadName(_ id: String) -> String {
    let names = SessionSwitcher.names(fromConfig: FileManager.default.contents(atPath: configJson))
    return names[id] ?? id
  }

  // The notice record: `workers/<id>/notice.json`, kind → when it was sent (wall clock) and whether that dialog (or hold) is
  // still open. It makes a notice at-most-once per kind per `noticeDebounce`, and survives a relaunch: the same still-open
  // dialog is never announced twice.
  struct NoticeRecord: Codable { var at: Double; var open: Bool }

  func readNotices(_ id: String) -> [String: NoticeRecord] {
    FileManager.default.contents(atPath: dir(id) + "/notice.json").flatMap { try? JSONDecoder().decode([String: NoticeRecord].self, from: $0) } ?? [:]
  }

  func writeNotices(_ id: String, _ m: [String: NoticeRecord]) {
    guard let d = try? JSONEncoder().encode(m) else { return }
    try? AtomicFile.write(d, to: dir(id) + "/notice.json", mode: 0o600)
  }

  func closeNoticeRecord(_ id: String) {
    var m = readNotices(id)
    guard m.values.contains(where: \.open) else { return }
    for k in m.keys { m[k]?.open = false }
    writeNotices(id, m)
  }

  /// Removes one kind's record: the hold it announced is over, so the next one is a new hold and is announced again (a closed record
  /// would still silence it for `noticeDebounce`). Other kinds' records, a dialog's among them, stay as they are.
  func forgetNoticeRecord(_ id: String, kind: String) {
    var m = readNotices(id)
    guard m.removeValue(forKey: kind) != nil else { return }
    writeNotices(id, m)
  }

  /// Already announced: this kind is still open from before a relaunch, or one of this kind went out lately.
  func noticeSuppressed(_ id: String, kind: String, at t: Double) -> Bool {
    guard let rec = readNotices(id)[kind] else { return false }
    if rec.open { return true }
    // a prompt nobody named comes again and again (each tool asks); the stillness before it counts already guards a flap
    let window = kind.hasPrefix("prompt: ") ? options.promptDebounce : options.noticeDebounce
    return rec.at <= t + 60 && t - rec.at < window  // a clock set back does not hold a notice for ever
  }

  /// One line into the thread, once per episode (`state`), through `postNotice`. A clear failure is retried (three tries, then
  /// the Mac says so); a timeout is not (it may have been sent); a repeat of the same kind inside the debounce window is not sent.
  func sendNotice(_ id: String, _ state: WritableKeyPath<Runtime, NoticeState>, kind: String, text: String) {
    guard let r = rt[id], !r[keyPath: state].sent, !r[keyPath: state].inFlight, awake() >= r[keyPath: state].retryAt else { return }
    if noticeSuppressed(id, kind: kind, at: now()) {
      rt[id]?[keyPath: state].sent = true
      return
    }
    guard let post = postNotice else {
      rt[id]?[keyPath: state].sent = true
      return
    }
    rt[id]?[keyPath: state].inFlight = true
    // written before the post: a crash or relaunch in the middle can't make a second one
    var m = readNotices(id)
    m[kind] = NoticeRecord(at: now(), open: true)
    writeNotices(id, m)
    let episode = r[keyPath: state].episode
    // an own thread: a post is a child process that can take a while, and a busy dispatch pool (every blocked read holds one
    // of its threads) has been measured to hold a notice back for seconds
    Thread.detachNewThread { [weak self] in
      let outcome = post(id, text)
      self?.queue.async {
        guard let self else { return }
        // A clear failure sent nothing: the debounce slot is given back whether or not the episode has moved on, so the next
        // dialog of this kind isn't held back by a notice that never went.
        if outcome == .failed {
          var m = self.readNotices(id)
          m[kind] = nil
          self.writeNotices(id, m)
        }
        guard self.rt[id]?[keyPath: state].episode == episode else { return }  // answered or replaced meanwhile: nothing to track
        self.rt[id]?[keyPath: state].inFlight = false
        switch outcome {
        case .sent, .unknown:
          // a timeout may have been sent: not retried, so it can't go twice
          self.rt[id]?[keyPath: state].sent = true
        case .failed:
          let n = (self.rt[id]?[keyPath: state].attempts ?? 0) + 1
          self.rt[id]?[keyPath: state].attempts = n
          if n >= 3 {
            self.rt[id]?[keyPath: state].sent = true
            self.emit(.noticeFailed(thread: id))
          } else {
            self.rt[id]?[keyPath: state].retryAt = self.awake() + self.options.noticeRetry
          }
        }
      }
    }
  }

  /// Why the typing guard holds the pointer, as far as the notices go (`noteHeldPointer`).
  enum PointerHold { case none, draft, noBox }

  /// A pointer held back is not silent. By a draft in Claude's input box: after `draftNoticeAfter` the thread gets one line, and the
  /// Terminals window shows the thread as Needs you until the box is clear. By no input box on the pane (a blank pane, a banner, a
  /// dialog half drawn): the same, after `readyTimeout`, with its own kind. A dialog or prompt that is flagged has its own notice, so
  /// it is not also counted as a missing box.
  func noteHeldPointer(_ id: String, _ hold: PointerHold) {
    guard rt[id] != nil else { return }
    let hold = hold == .noBox && rt[id]?.needsYouPrompt != nil ? PointerHold.none : hold
    noteDraftHold(id, held: hold == .draft)
    noteNoBoxHold(id, held: hold == .noBox)
  }

  /// Both holds forgotten: the worker's pane is gone (its notice state and the clocks start over with the next one).
  func resetHolds(_ id: String) {
    rt[id]?.held.reset()
    rt[id]?.draftSince = nil
    rt[id]?.noBox.since = nil
    rt[id]?.noBox.notice.reset()
    rt[id]?.dialogAbsence.reset()
    endOffer(id)  // no pane, no dialog on it
  }

  private func noteDraftHold(_ id: String, held: Bool) {
    if !held {
      if rt[id]?.draftSince != nil {
        rt[id]?.draftSince = nil
        rt[id]?.held.reset()
        closeNoticeRecord(id)
      }
      return
    }
    if rt[id]?.draftSince == nil { rt[id]?.draftSince = awake() }
    guard let since = rt[id]?.draftSince, awake() - since >= options.draftNoticeAfter else { return }
    let left = rt[id]?.owed.leftover == true  // a line of ours that may be mixed with the owner's text, past its deadline
    sendNotice(
      id, \.held, kind: left ? WorkerNotice.leftoverKind : WorkerNotice.draftKind,
      text: left ? WorkerNotice.leftoverLine(threadName: threadName(id)) : WorkerNotice.draftLine(threadName: threadName(id)))
  }

  private func noteNoBoxHold(_ id: String, held: Bool) {
    if !held {
      if rt[id]?.noBox.since != nil {
        rt[id]?.noBox.since = nil
        rt[id]?.noBox.notice.reset()
        forgetNoticeRecord(id, kind: WorkerNotice.noBoxKind)
      }
      return
    }
    if rt[id]?.noBox.since == nil { rt[id]?.noBox.since = awake() }
    guard let since = rt[id]?.noBox.since, awake() - since >= options.readyTimeout else { return }
    sendNotice(id, \.noBox.notice, kind: WorkerNotice.noBoxKind, text: WorkerNotice.noBoxLine(threadName: threadName(id)))
  }
}

/// A pointer held back because Claude's input box is not on the pane: since when (awake clock), and its one notice.
struct NoBoxHold {
  var since: Double?
  var notice = WorkerManager.NoticeState()
}
